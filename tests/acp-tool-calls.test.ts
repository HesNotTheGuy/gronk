import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isAllowedGrokBasename,
  mergeToolCall,
  parseToolCallFromUpdate
} from '../electron/main/acp/client'
import type { ToolCallInfo } from '../shared/types'

function call(partial: Partial<ToolCallInfo>): ToolCallInfo {
  return { toolCallId: 't1', title: 'Tool', status: 'pending', ...partial }
}

// Regression guard for the "every tool card says TOOL" bug: xAI sends the real
// identity once, then streams status-only updates whose generic title/kind used
// to clobber the good values.
test('a later status-only update never downgrades a known tool identity', () => {
  const first = call({ title: 'Read', kind: 'read', status: 'in_progress' })
  const statusOnly = call({ title: 'Tool', status: 'completed' })
  const merged = mergeToolCall(first, statusOnly)

  assert.equal(merged.title, 'Read')
  assert.equal(merged.kind, 'read')
  assert.equal(merged.status, 'completed')
})

test('a real title still overwrites a placeholder one', () => {
  const merged = mergeToolCall(call({ title: 'Tool' }), call({ title: 'Bash', kind: 'execute' }))
  assert.equal(merged.title, 'Bash')
  assert.equal(merged.kind, 'execute')
})

test('both generic spellings of the placeholder title are treated as empty', () => {
  for (const generic of ['Tool', 'tool', '']) {
    const merged = mergeToolCall(call({ title: 'Edit' }), call({ title: generic }))
    assert.equal(merged.title, 'Edit')
  }
})

test('merging onto nothing returns the incoming call', () => {
  const next = call({ title: 'Read' })
  assert.equal(mergeToolCall(undefined, next), next)
})

test('later payload fields win but never overwrite with undefined', () => {
  const prev = call({ rawInput: { a: 1 }, content: 'old', error: 'boom' })
  const merged = mergeToolCall(prev, call({ content: 'new' }))
  assert.deepEqual(merged.rawInput, { a: 1 })
  assert.equal(merged.content, 'new')
  assert.equal(merged.error, 'boom')
})

test('a blank incoming id keeps the previous one', () => {
  assert.equal(mergeToolCall(call({ toolCallId: 'keep' }), call({ toolCallId: '' })).toolCallId, 'keep')
})

// The identity lives in _meta["x.ai/tool"], not in the ACP-standard fields.
test('tool identity is read from the xAI _meta block', () => {
  const parsed = parseToolCallFromUpdate({
    sessionUpdate: 'tool_call',
    toolCallId: 'abc',
    status: 'in_progress',
    _meta: { 'x.ai/tool': { name: 'read_file', label: 'Read', kind: 'read' } }
  })
  assert.ok(parsed)
  assert.equal(parsed.toolCallId, 'abc')
  assert.equal(parsed.title, 'Read')
  assert.equal(parsed.kind, 'read')
  assert.equal(parsed.status, 'in_progress')
})

test('the legacy xai/tool meta key is accepted too', () => {
  const parsed = parseToolCallFromUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'abc',
    _meta: { 'xai/tool': { name: 'bash' } }
  })
  assert.equal(parsed?.title, 'bash')
})

// Regression: a top-level placeholder title used to beat the real name in _meta.
test('a placeholder top-level title loses to the _meta identity', () => {
  const parsed = parseToolCallFromUpdate({
    sessionUpdate: 'tool_call',
    toolCallId: 'abc',
    title: 'Tool',
    _meta: { 'x.ai/tool': { label: 'Edit' } }
  })
  assert.equal(parsed?.title, 'Edit')
})

test('updates that are not tool calls are ignored', () => {
  assert.equal(parseToolCallFromUpdate({ sessionUpdate: 'agent_message_chunk' }), null)
  assert.equal(parseToolCallFromUpdate({}), null)
})

test('an update with no identity at all still falls back to the placeholder', () => {
  const parsed = parseToolCallFromUpdate({ sessionUpdate: 'tool_call', toolCallId: 'x' })
  assert.equal(parsed?.title, 'Tool')
  assert.equal(parsed?.kind, undefined)
})

// Binary allow-list: only `grok`/`grok.exe` may be spawned, whatever the override says.
test('grok binary basename allow-list', () => {
  assert.ok(isAllowedGrokBasename('C:/Users/x/.grok/bin/grok.exe'))
  assert.ok(isAllowedGrokBasename('/usr/local/bin/grok'))
  assert.ok(!isAllowedGrokBasename('/usr/local/bin/evil.sh'))
  assert.ok(!isAllowedGrokBasename('C:/x/grok.exe.bat'))
})
