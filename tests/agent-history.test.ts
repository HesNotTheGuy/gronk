import test from 'node:test'
import assert from 'node:assert/strict'
import {
  canAppendHistoryUserChunk,
  historySource,
  needsAgentBoot,
  planHistoryReplay,
  toHistoryMessages
} from '../electron/main/agent/history'
import type { ChatMessage } from '../shared/types'

function message(partial: Partial<ChatMessage> = {}): ChatMessage {
  return { id: 'm1', role: 'assistant', text: 'hi', createdAt: 1, ...partial }
}

test('restored messages are marked as settled history, never as mid-stream', () => {
  const restored = toHistoryMessages([
    message({ id: 'm1', streaming: true }),
    message({ id: 'm2', role: 'user', text: 'q' })
  ])
  assert.deepEqual(restored.map((m) => m.streaming), [false, false])
  assert.deepEqual(restored.map((m) => m.fromHistory), [true, true])
})

test('restoring copies rather than aliasing the cached messages', () => {
  const cached = [message({ streaming: true })]
  toHistoryMessages(cached)
  assert.equal(cached[0].streaming, true)
})

// The duplicated-history bug: with a local transcript on screen, the agent
// replays the same turns over session/load and they were appended again.
test('a local transcript suppresses the agent\'s replay of the same turns', () => {
  const plan = planHistoryReplay([message({ id: 'm1' })])
  assert.equal(plan.suppressHistoryReplay, true)
  assert.equal(plan.messages.length, 1)
})

test('with no local transcript the agent replay is the only source', () => {
  const plan = planHistoryReplay([])
  assert.equal(plan.suppressHistoryReplay, false)
  assert.deepEqual(plan.messages, [])
})

test('the reported source names whichever side actually produced the messages', () => {
  assert.equal(historySource(3, 3), 'local')
  // Local was empty, so anything in the transcript came over ACP.
  assert.equal(historySource(0, 4), 'acp')
  assert.equal(historySource(0, 0), 'empty')
})

test('a healthy agent already in the same folder is reused', () => {
  assert.equal(
    needsAgentBoot({
      hasClient: true,
      state: 'ready',
      currentCwd: '/work/app',
      targetCwd: '/work/app'
    }),
    false
  )
})

// An ACP session belongs to the cwd it was created under: loading one into a
// process rooted elsewhere resolves its paths against the wrong tree.
test('a different project folder always forces a fresh process', () => {
  assert.equal(
    needsAgentBoot({
      hasClient: true,
      state: 'ready',
      currentCwd: '/work/other',
      targetCwd: '/work/app'
    }),
    true
  )
})

test('a dead, missing or unstarted agent forces a fresh process', () => {
  const base = { currentCwd: '/work/app', targetCwd: '/work/app' } as const
  assert.equal(needsAgentBoot({ ...base, hasClient: false, state: 'ready' }), true)
  for (const state of ['error', 'idle', 'stopped'] as const) {
    assert.equal(needsAgentBoot({ ...base, hasClient: true, state }), true)
  }
  assert.equal(
    needsAgentBoot({ hasClient: true, state: 'ready', currentCwd: null, targetCwd: '/work/app' }),
    true
  )
})

test('a replayed user chunk extends only an open history user bubble', () => {
  assert.equal(
    canAppendHistoryUserChunk(message({ role: 'user', fromHistory: true })),
    true
  )
  assert.equal(canAppendHistoryUserChunk(undefined), false)
  // The assistant is speaking: a user chunk starts a new turn.
  assert.equal(canAppendHistoryUserChunk(message({ fromHistory: true })), false)
  // Live message, not part of the replay.
  assert.equal(canAppendHistoryUserChunk(message({ role: 'user' })), false)
  // Already settled by the store — appending would rewrite a turn already read.
  assert.equal(
    canAppendHistoryUserChunk(message({ role: 'user', fromHistory: true, streaming: false })),
    false
  )
})

// ── A turn that failed before the agent said anything ───────────────────────

test('AN ASSISTANT TURN THAT PRODUCED NOTHING IS NOT WORTH KEEPING', async () => {
  // The shell is created before the agent answers so the caret has somewhere to appear.
  // When the call fails immediately, that shell is all there is, and keeping it wrote an
  // empty bubble to disk — one per failed attempt, permanently. Seen for real: two blanks
  // from one retry, on a plan whose weekly limit had run out.
  const { assistantSaidNothing } = await import('../electron/main/agent/history')

  assert.equal(assistantSaidNothing({}), true)
  assert.equal(assistantSaidNothing({ text: '' }), true)
  assert.equal(assistantSaidNothing({ text: '   \n ' }), true, 'whitespace is not content')
  assert.equal(assistantSaidNothing({ parts: [], toolCalls: [] }), true)

  // Anything it managed to say before failing is worth more than a tidy transcript.
  assert.equal(assistantSaidNothing({ text: 'half a sen' }), false)
  assert.equal(assistantSaidNothing({ thought: 'considering' }), false, 'a thought is output')
  assert.equal(assistantSaidNothing({ toolCalls: [{ id: 't1' }] }), false, 'a tool call is output')
  assert.equal(assistantSaidNothing({ parts: [{ kind: 'text' }] }), false)
})
