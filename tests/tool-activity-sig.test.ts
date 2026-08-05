import test from 'node:test'
import assert from 'node:assert/strict'
import { toolActivitySignature } from '../src/lib/tool-activity-sig'
import type { ChatMessage } from '../shared/types'

function msg(
  partial: Partial<ChatMessage> & Pick<ChatMessage, 'id'>
): ChatMessage {
  return {
    role: 'assistant',
    text: partial.text ?? '',
    createdAt: 1,
    ...partial
  }
}

test('text-only token does not change the tool activity signature', () => {
  const tools = [
    { toolCallId: 't1', title: 'spawn_subagent', status: 'completed' as const }
  ]
  const base: ChatMessage[] = [
    msg({ id: '1', text: 'hello', toolCalls: tools }),
    msg({ id: '2', text: 'stream', streaming: true })
  ]
  const afterToken: ChatMessage[] = [
    base[0],
    { ...base[1], text: base[1].text + ' more' }
  ]
  assert.equal(toolActivitySignature(base), toolActivitySignature(afterToken))
})

test('tool status change does change the signature', () => {
  const a: ChatMessage[] = [
    msg({
      id: '1',
      toolCalls: [{ toolCallId: 't1', title: 'x', status: 'in_progress' }]
    })
  ]
  const b: ChatMessage[] = [
    msg({
      id: '1',
      toolCalls: [{ toolCallId: 't1', title: 'x', status: 'completed' }]
    })
  ]
  assert.notEqual(toolActivitySignature(a), toolActivitySignature(b))
})

test('messages without tools share an empty signature', () => {
  const a = [msg({ id: '1', text: 'a' }), msg({ id: '2', text: 'b' })]
  const b = [msg({ id: '1', text: 'a!' }), msg({ id: '2', text: 'b!' })]
  assert.equal(toolActivitySignature(a), '')
  assert.equal(toolActivitySignature(b), '')
})
