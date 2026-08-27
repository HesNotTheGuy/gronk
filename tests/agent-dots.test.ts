import test from 'node:test'
import assert from 'node:assert/strict'
import { agentDots, statusToDot, type DotTone } from '../src/lib/agent-dots'
import type { AgentUnit } from '../src/lib/agent-activity'

/**
 * The glance layer's decision: given a message's agent units, which dots show.
 *
 * Extracted from the component because the suite has no DOM, the same split as
 * scroll-stick.ts. What is NOT covered here is the rendering: that the dots have
 * CSS, that the accent reads as an accent, or that any of it is legible at 6px.
 * `tests/css-coverage.test.ts` proves the classes exist; the visual baselines are
 * the only thing that looks at them.
 */

function unit(id: string, status: AgentUnit['status']): AgentUnit {
  return { id, kind: 'subagent', label: id, status, source: id }
}

const tones = (units: AgentUnit[], demoteLive = false): DotTone[] =>
  agentDots(units, { demoteLive }).dots

test('a message that spawned no agents shows nothing at all', () => {
  // The whole point of attaching this to the message: most messages must gain
  // zero height. An empty row with a border would cost every turn in the
  // transcript something.
  const view = agentDots([])
  assert.deepEqual(view.dots, [])
  assert.equal(view.failed, 0)
  assert.equal(view.live, 0)
  assert.equal(view.label, '', 'nothing to announce either')
})

test('one dot per unit, in the order the message spawned them', () => {
  // Spawn order, not severity order. The tray sorts live and failed to the
  // front because it is a list you read; this is a strip you look at, where
  // position means when. A red dot is equally visible wherever it sits.
  assert.deepEqual(
    tones([
      unit('a', 'completed'),
      unit('b', 'failed'),
      unit('c', 'completed'),
      unit('d', 'in_progress')
    ]),
    ['done', 'failed', 'done', 'live']
  )
})

test('every status maps to one of exactly three tones', () => {
  assert.equal(statusToDot('completed'), 'done')
  assert.equal(statusToDot('failed'), 'failed')
  assert.equal(statusToDot('cancelled'), 'failed')
  assert.equal(statusToDot('in_progress'), 'live')
  assert.equal(statusToDot('pending'), 'live')
})

test('a cancelled agent is painted as a failure, not as a success', () => {
  // A judgement call worth pinning. Cancelled is not the same event as failed,
  // but the vocabulary has one accent by design and a cancelled agent did not
  // do its work. Filing it with the successes is the more misleading option,
  // and agentActivitySummary already buckets it this way, so the dots and the
  // tray count the same thing.
  const view = agentDots([unit('a', 'cancelled')])
  assert.deepEqual(view.dots, ['failed'])
  assert.equal(view.failed, 1)
})

test('an unknown status fails quiet rather than crying wolf', () => {
  // The accent is the single signal this row carries. Spending it on a status
  // nobody has thought about would teach the reader to ignore red.
  assert.equal(statusToDot('something-new' as AgentUnit['status']), 'done')
})

test('an older turn does not pulse forever', () => {
  // Same rule as ToolActivity's demoteLive: a turn that is no longer the newest
  // should not animate because a tool call was never marked done. Without this
  // a restored transcript would have live dots scattered through its history.
  const units = [unit('a', 'in_progress'), unit('b', 'pending'), unit('c', 'failed')]
  assert.deepEqual(tones(units, false), ['live', 'live', 'failed'])
  assert.deepEqual(tones(units, true), ['done', 'done', 'failed'])
})

test('demoting a live turn never hides a failure', () => {
  // The one thing demoteLive must not do. An old turn stops pulsing; it does
  // not stop reporting that something broke.
  const view = agentDots([unit('a', 'in_progress'), unit('b', 'failed')], { demoteLive: true })
  assert.equal(view.live, 0)
  assert.equal(view.failed, 1, 'a demoted turn still shows its failure')
})

test('counts follow the tones, not the raw statuses', () => {
  const view = agentDots([
    unit('a', 'completed'),
    unit('b', 'failed'),
    unit('c', 'cancelled'),
    unit('d', 'in_progress'),
    unit('e', 'pending')
  ])
  assert.equal(view.dots.length, 5)
  assert.equal(view.failed, 2, 'cancelled counts with failed')
  assert.equal(view.live, 2, 'pending counts with in_progress')
})

test('the row says out loud what the colours say', () => {
  // The dots carry no visible label by design, so this string is the only thing
  // a screen reader gets. It has to name the failure.
  assert.equal(agentDots([unit('a', 'completed')]).label, '1 agent, all finished')
  assert.equal(
    agentDots([unit('a', 'completed'), unit('b', 'completed')]).label,
    '2 agents, all finished'
  )
  assert.equal(
    agentDots([unit('a', 'in_progress'), unit('b', 'failed'), unit('c', 'completed')]).label,
    '3 agents: 1 running, 1 failed'
  )
  assert.equal(agentDots([unit('a', 'failed')]).label, '1 agent: 1 failed')
})

test('nothing is truncated and no overflow marker appears', () => {
  // "+12" is exactly the kind of thing that has to be read, which is what this
  // layer exists to avoid. The row wraps instead.
  const many = Array.from({ length: 40 }, (_, i) => unit(`u${i}`, i === 39 ? 'failed' : 'completed'))
  const view = agentDots(many)
  assert.equal(view.dots.length, 40, 'every unit gets a dot')
  assert.equal(view.dots[39], 'failed', 'including the last one')
  assert.equal(view.failed, 1)
})

test('THE STRIP SAYS NOTHING WHEN THERE IS NOTHING TO SAY', () => {
  // Reported: the squares "seem like normal UI instead of indicators". They were —
  // one per unit regardless of state, so a turn that ran a dozen background
  // commands to completion painted a dozen identical marks.
  const allDone = agentDots(
    [unit('a', 'completed'), unit('b', 'completed'), unit('c', 'completed')],
    {}
  )
  assert.equal(allDone.live, 0)
  assert.equal(allDone.failed, 0)

  // A failure still has to be visible without reading anything, and live work
  // still has to pulse — those are the two cases the strip exists for.
  assert.equal(agentDots([unit('a', 'completed'), unit('b', 'failed')], {}).failed, 1)
  assert.equal(agentDots([unit('a', 'in_progress')], {}).live, 1)
})

test('THE COMPONENT HIDES THE ALL-DONE STRIP, AND ONLY THAT ONE', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/components/AgentDots.tsx', import.meta.url), 'utf8')
  // Read from source: the suite has no DOM for this component, and the rule is one
  // line that is easy to drop.
  assert.match(src, /view\.live === 0 && view\.failed === 0\) return null/)
})
