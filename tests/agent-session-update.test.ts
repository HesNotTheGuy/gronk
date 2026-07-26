import test from 'node:test'
import assert from 'node:assert/strict'
import {
  extractChunkText,
  routeSessionUpdate,
  upsertToolCall,
  type SessionUpdateContext
} from '../electron/main/agent/session-update'
import type { ToolCallInfo } from '../shared/types'

/** Live turn: not replaying, local transcript irrelevant. */
const LIVE: SessionUpdateContext = {
  sessionId: 's1',
  replayingHistory: false,
  suppressHistoryReplay: false
}

/** session/load replay with no local transcript — ACP is rebuilding the history. */
const REPLAY: SessionUpdateContext = {
  sessionId: 's1',
  replayingHistory: true,
  suppressHistoryReplay: false
}

/** session/load replay where the local transcript is already on screen. */
const REPLAY_SUPPRESSED: SessionUpdateContext = {
  sessionId: 's1',
  replayingHistory: true,
  suppressHistoryReplay: true
}

function route(update: Record<string, unknown>, context = LIVE) {
  return routeSessionUpdate({ sessionId: 's1', update }, context)
}

test('the CLI\'s three chunk shapes all yield the same text', () => {
  assert.equal(extractChunkText({ content: 'bare' }), 'bare')
  assert.equal(extractChunkText({ content: { text: 'nested' } }), 'nested')
  assert.equal(extractChunkText({ text: 'top level' }), 'top level')
  assert.equal(extractChunkText({}), '')
  assert.equal(extractChunkText({ content: {} }), '')
})

test('an update without its own session id falls back to the live session', () => {
  assert.equal(routeSessionUpdate({ update: { sessionUpdate: 'plan' } }, LIVE).sessionId, 's1')
  assert.equal(
    routeSessionUpdate({ sessionId: 'other', update: { sessionUpdate: 'plan' } }, LIVE).sessionId,
    'other'
  )
  assert.equal(
    routeSessionUpdate({ update: { sessionUpdate: 'plan' } }, { ...LIVE, sessionId: null })
      .sessionId,
    ''
  )
})

test('an update sent without the `update` envelope is read in place', () => {
  const routed = routeSessionUpdate(
    { sessionId: 's1', sessionUpdate: 'agent_message_chunk', content: { text: 'hi' } },
    LIVE
  )
  assert.deepEqual(routed.action, { type: 'text', text: 'hi' })
})

// turn_completed carries no content: opening an assistant message for it left an
// empty bubble behind in the replayed history.
test('turn_completed goes straight to accounting and opens no message', () => {
  const routed = route({ sessionUpdate: 'turn_completed', usage: { inputTokens: 1 } })
  assert.equal(routed.assistantScoped, false)
  assert.equal(routed.action.type, 'usage')
  assert.equal(
    routed.action.type === 'usage' ? routed.action.update.sessionUpdate : null,
    'turn_completed'
  )
})

// FIX-R7: the agent echoes the prompt back, and the live turn already has the
// user bubble from the renderer and from sendPrompt. This is the duplicated-
// message bug.
test('a user chunk on a live turn is dropped, not appended', () => {
  const routed = route({ sessionUpdate: 'user_message_chunk', content: { text: 'hello' } })
  assert.deepEqual(routed.action, { type: 'ignore' })
})

test('a user chunk is replayed only when no local transcript is authoritative', () => {
  const rebuilt = route({ sessionUpdate: 'user_message_chunk', content: { text: 'hello' } }, REPLAY)
  assert.deepEqual(rebuilt.action, {
    type: 'history-user-chunk',
    text: 'hello',
    messageId: undefined
  })

  const suppressed = route(
    { sessionUpdate: 'user_message_chunk', content: { text: 'hello' } },
    REPLAY_SUPPRESSED
  )
  assert.deepEqual(suppressed.action, { type: 'ignore' })
})

test('a replayed user chunk keeps whichever id the update carried', () => {
  const withMessageId = route(
    { sessionUpdate: 'user_message_chunk', text: 'x', messageId: 'm1', id: 'i1' },
    REPLAY
  )
  assert.equal(
    withMessageId.action.type === 'history-user-chunk' ? withMessageId.action.messageId : null,
    'm1'
  )

  const withBareId = route({ sessionUpdate: 'user_message_chunk', text: 'x', id: 'i1' }, REPLAY)
  assert.equal(
    withBareId.action.type === 'history-user-chunk' ? withBareId.action.messageId : null,
    'i1'
  )
})

test('an empty user chunk is dropped rather than opening a blank bubble', () => {
  assert.deepEqual(route({ sessionUpdate: 'user_message_chunk', content: {} }, REPLAY).action, {
    type: 'ignore'
  })
})

// The other half of the duplicated-history bug: with a local transcript on
// screen, the agent's replay of the same assistant turns must not be appended.
test('assistant and thought chunks are dropped while the local transcript wins', () => {
  for (const sessionUpdate of ['agent_message_chunk', 'agent_thought_chunk']) {
    const routed = route({ sessionUpdate, content: { text: 'x' } }, REPLAY_SUPPRESSED)
    assert.deepEqual(routed.action, { type: 'ignore' })
    assert.equal(routed.assistantScoped, false)
  }
})

test('tool calls and plans still arrive while the local transcript wins', () => {
  // They are not echoed as chat bubbles, so suppression does not apply to them.
  const tool = route(
    { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read' },
    REPLAY_SUPPRESSED
  )
  assert.equal(tool.action.type, 'tool-call')
  assert.equal(route({ sessionUpdate: 'plan' }, REPLAY_SUPPRESSED).action.type, 'plan')
})

test('message and thought chunks route to their own action', () => {
  assert.deepEqual(route({ sessionUpdate: 'agent_message_chunk', text: 'a' }).action, {
    type: 'text',
    text: 'a'
  })
  assert.deepEqual(route({ sessionUpdate: 'agent_thought_chunk', text: 'b' }).action, {
    type: 'thought',
    text: 'b'
  })
})

// An empty chunk still opens the assistant message: that is what groups a
// replayed turn, and the original dispatch resolved the id before looking at
// the text.
test('an empty assistant chunk still opens the message but emits nothing', () => {
  const routed = route({ sessionUpdate: 'agent_message_chunk', content: {} })
  assert.equal(routed.assistantScoped, true)
  assert.deepEqual(routed.action, { type: 'noop' })
})

// An unrecognised kind must not open an assistant message. It used to be
// assistant-scoped with a noop, which still resolved an assistant id and, during
// replay, left an empty bubble in restored history for every update type the CLI
// adds that this does not know about.
test('an unknown update kind is ignored, not assistant-scoped', () => {
  const routed = route({ sessionUpdate: 'available_commands_update' })
  assert.equal(routed.assistantScoped, false)
  assert.deepEqual(routed.action, { type: 'ignore' })
})

// A KNOWN kind carrying nothing still opens the bubble: an empty agent chunk
// means the assistant turn has started, even before any text arrives.
test('a known kind with an empty payload stays assistant-scoped', () => {
  const routed = route({ sessionUpdate: 'agent_message_chunk' })
  assert.equal(routed.assistantScoped, true)
  assert.deepEqual(routed.action, { type: 'noop' })
})

test('an explicit message id is passed through for the caller to adopt', () => {
  assert.equal(
    route({ sessionUpdate: 'agent_message_chunk', text: 'a', messageId: 'm9' }).explicitMessageId,
    'm9'
  )
  assert.equal(route({ sessionUpdate: 'agent_message_chunk', text: 'a' }).explicitMessageId, undefined)
})

test('tool_call and tool_call_update are told apart', () => {
  const initial = route({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read' })
  assert.equal(initial.action.type === 'tool-call' && initial.action.initial, true)

  const later = route({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' })
  assert.equal(later.action.type === 'tool-call' && later.action.initial, false)
})

test('the plan action carries the whole update, which is what the UI reads', () => {
  const routed = route({ sessionUpdate: 'plan', entries: [{ id: '1', content: 'do it' }] })
  assert.equal(routed.action.type, 'plan')
  assert.deepEqual(
    routed.action.type === 'plan' ? routed.action.plan.entries : null,
    [{ id: '1', content: 'do it' }]
  )
})

// ── upsertToolCall ─────────────────────────────────────────────────────────

function call(partial: Partial<ToolCallInfo>): ToolCallInfo {
  return { toolCallId: 't1', title: 'Tool', status: 'pending', ...partial }
}

test('a new tool call is appended and returned unchanged', () => {
  const { toolCalls, merged } = upsertToolCall([], call({ title: 'Read' }))
  assert.equal(toolCalls.length, 1)
  assert.equal(merged.title, 'Read')
})

test('a message with no tool calls yet still accepts the first one', () => {
  const { toolCalls } = upsertToolCall(undefined, call({ title: 'Read' }))
  assert.deepEqual(toolCalls.map((t) => t.title), ['Read'])
})

// Regression, twice shipped: the real identity arrives once, then status-only
// updates stream in. The emitted value must be the merged one, or the renderer
// gets the placeholder back and every card reads "TOOL".
test('a status-only update keeps the known identity, in the list and in the emit', () => {
  const existing = [call({ title: 'Read', kind: 'read', status: 'in_progress' })]
  const { toolCalls, merged } = upsertToolCall(existing, call({ status: 'completed' }))

  assert.equal(toolCalls.length, 1)
  assert.equal(toolCalls[0].title, 'Read')
  assert.equal(toolCalls[0].status, 'completed')
  assert.equal(merged.title, 'Read')
  assert.equal(merged.kind, 'read')
})

test('the caller\'s list is never mutated in place', () => {
  const existing = [call({ title: 'Read' })]
  const { toolCalls } = upsertToolCall(existing, call({ toolCallId: 't2', title: 'Bash' }))
  assert.equal(existing.length, 1)
  assert.equal(toolCalls.length, 2)
})

test('a second tool call in the same turn does not overwrite the first', () => {
  const { toolCalls } = upsertToolCall(
    [call({ toolCallId: 't1', title: 'Read' })],
    call({ toolCallId: 't2', title: 'Bash' })
  )
  assert.deepEqual(toolCalls.map((t) => t.toolCallId), ['t1', 't2'])
})
