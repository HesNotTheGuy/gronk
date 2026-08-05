import test from 'node:test'
import assert from 'node:assert/strict'
import { isLiveUnit, nextRetained } from '../src/lib/agent-retention'
import { needsSessionReload } from '../src/lib/session-nav'
import type { AgentUnit } from '../src/lib/agent-activity'
import type { ConnectionState } from '../shared/types'

/**
 * What the agents tray keeps showing, and when reselecting a session is a no-op.
 *
 * Reopening a session showed AGENTS 50: every unit it had ever run, presented as
 * current work and mostly red. Nothing was wrong. A wall of red failure dots on
 * reopen reads as something being badly wrong, which is the part that matters
 * more than the count.
 *
 * The rule these pin is that "seen this session" is not "seen in the
 * transcript". A smaller scan window cannot express that, because restore still
 * scans whatever window is chosen.
 */

function unit(id: string, status: AgentUnit['status']): AgentUnit {
  return { id, kind: 'subagent', label: id, status, source: id }
}

const HISTORY = [
  unit('old-1', 'completed'),
  unit('old-2', 'failed'),
  unit('old-3', 'cancelled'),
  unit('old-4', 'completed')
]

test('THE BUG: restoring a transcript full of finished units shows none of them', () => {
  const kept = nextRetained({ prev: [], incoming: HISTORY, isRestoreSnapshot: true })
  assert.deepEqual(kept, [], 'a session history was resurrected as current work')
})

test('a unit still running at restore is kept, because it really is running', () => {
  const kept = nextRetained({
    prev: [],
    incoming: [...HISTORY, unit('live-1', 'in_progress'), unit('live-2', 'pending')],
    isRestoreSnapshot: true
  })
  assert.deepEqual(
    kept.map((u) => u.id),
    ['live-1', 'live-2']
  )
})

test('a fresh session with nothing in it retains nothing', () => {
  assert.deepEqual(nextRetained({ prev: [], incoming: [], isRestoreSnapshot: true }), [])
})

test('work finishing mid-session stays visible, which is why retention exists', () => {
  // The original problem retention was added for: a 16-message scan window meant
  // finishing work scrolled out of range and the AGENTS tab vanished as though
  // nothing had run. This is the property that must survive the fix.
  let retained = nextRetained({ prev: [], incoming: [], isRestoreSnapshot: true })
  retained = nextRetained({ prev: retained, incoming: [unit('a', 'in_progress')], isRestoreSnapshot: false })
  assert.deepEqual(retained.map((u) => u.id), ['a'])

  // It finishes.
  retained = nextRetained({ prev: retained, incoming: [unit('a', 'completed')], isRestoreSnapshot: false })
  assert.deepEqual(retained.map((u) => u.id), ['a'])
  assert.equal(retained[0].status, 'completed', 'the later status must win')

  // Its tool call scrolls out of the scan window entirely.
  retained = nextRetained({ prev: retained, incoming: [], isRestoreSnapshot: false })
  assert.deepEqual(retained.map((u) => u.id), ['a'], 'an empty scan dropped live-session work')
})

test('a unit that fails during the session is kept, unlike a failure from history', () => {
  // The distinction the whole module exists for, stated as one comparison.
  const duringSession = nextRetained({
    prev: [],
    incoming: [unit('x', 'failed')],
    isRestoreSnapshot: false
  })
  const fromTranscript = nextRetained({
    prev: [],
    incoming: [unit('x', 'failed')],
    isRestoreSnapshot: true
  })
  assert.equal(duringSession.length, 1, 'this session own failure was hidden')
  assert.equal(fromTranscript.length, 0, 'a historical failure was resurrected')
})

test('a restore snapshot ignores what the previous session left behind', () => {
  // Switching sessions must not carry the old one's units across. Merging here
  // is how the tray came to show work from a session the user had already left.
  const kept = nextRetained({
    prev: [unit('previous-session', 'completed'), unit('previous-live', 'in_progress')],
    incoming: HISTORY,
    isRestoreSnapshot: true
  })
  assert.deepEqual(kept, [])
})

test('isLiveUnit is the whole of the live test, and cancelled is not live', () => {
  assert.equal(isLiveUnit(unit('a', 'in_progress')), true)
  assert.equal(isLiveUnit(unit('a', 'pending')), true)
  assert.equal(isLiveUnit(unit('a', 'completed')), false)
  assert.equal(isLiveUnit(unit('a', 'failed')), false)
  assert.equal(isLiveUnit(unit('a', 'cancelled')), false)
})

/*
 * Reselecting the session you are already in.
 */

const sel = {
  requestedId: 's1',
  activeId: 's1' as string | null,
  connection: 'ready' as ConnectionState,
  error: null as string | null,
  hydrating: false
}

test('clicking the healthy session you are already in does no work', () => {
  assert.equal(needsSessionReload(sel), false)
})

test('a different session always reloads', () => {
  assert.equal(needsSessionReload({ ...sel, requestedId: 's2' }), true)
  assert.equal(needsSessionReload({ ...sel, activeId: null }), true)
})

test('THE RETRY CASE: a failed session reloads even though the id matches', () => {
  // Guarding on the id alone would make the retry click do nothing, which is a
  // worse bug than the one being fixed and much more confusing.
  assert.equal(needsSessionReload({ ...sel, error: 'Agent failed to start' }), true)
  for (const connection of ['error', 'stopped', 'idle', 'starting', 'loading'] as ConnectionState[]) {
    assert.equal(
      needsSessionReload({ ...sel, connection }),
      true,
      `${connection} was treated as healthy and the retry did nothing`
    )
  }
})

test('a restore already in flight is not skipped', () => {
  // Otherwise a second click during a slow restore looks like a dead button.
  assert.equal(needsSessionReload({ ...sel, hydrating: true }), true)
})
