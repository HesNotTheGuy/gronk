import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPromptPayload,
  buildTurnMessages,
  sessionTitleFromPrompt
} from '../electron/main/agent/prompt'
import type { PromptAttachment } from '../shared/types'

function file(path: string): PromptAttachment {
  return { id: path, kind: 'file', name: path, path }
}

function image(data: string, mimeType?: string): PromptAttachment {
  return { id: data, kind: 'image', name: 'shot.png', data, mimeType }
}

test('a plain prompt becomes one text block', () => {
  const payload = buildPromptPayload('  explain this  ')
  assert.deepEqual(payload.blocks, [{ type: 'text', text: 'explain this' }])
  assert.equal(payload.text, 'explain this')
})

// Files go as paths, not contents: the agent reads them with its own tools,
// under the permission gate, instead of having the bodies pasted into the turn.
test('attached files are listed as paths under the prompt', () => {
  const payload = buildPromptPayload('what changed?', [file('/a.ts'), file('/b.ts')])
  assert.equal(payload.text, 'what changed?\n\nAttached files:\n- /a.ts\n- /b.ts')
  assert.equal(payload.blocks.length, 1)
})

test('files with no prompt text get an instruction of their own', () => {
  const payload = buildPromptPayload('   ', [file('/a.ts')])
  assert.equal(payload.text, 'Please inspect these files:\n- /a.ts')
})

test('a file attachment with no path is ignored', () => {
  assert.throws(
    () => buildPromptPayload('', [{ id: 'x', kind: 'file', name: 'x.ts' }]),
    /Empty prompt/
  )
})

test('images become image blocks after the text, with a default mime type', () => {
  const payload = buildPromptPayload('look', [image('AAAA'), image('BBBB', 'image/jpeg')])
  assert.deepEqual(payload.blocks, [
    { type: 'text', text: 'look' },
    { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    { type: 'image', data: 'BBBB', mimeType: 'image/jpeg' }
  ])
})

test('an image with no payload is not sent as an empty block', () => {
  assert.throws(
    () => buildPromptPayload('', [{ id: 'x', kind: 'image', name: 'shot.png' }]),
    /Empty prompt/
  )
})

// An empty session/prompt spends a turn to say nothing.
test('a submission with nothing in it is refused', () => {
  assert.throws(() => buildPromptPayload('   '), /Empty prompt/)
  assert.throws(() => buildPromptPayload('', []), /Empty prompt/)
})

test('an image-only submission is a valid prompt', () => {
  const payload = buildPromptPayload('', [image('AAAA')])
  assert.equal(payload.blocks.length, 1)
  assert.equal(payload.text, '')
})

test('a turn opens with the user message and an empty streaming assistant one', () => {
  const { user, assistant } = buildTurnMessages({
    userId: 'u1',
    assistantId: 'a1',
    text: 'hello',
    rawText: 'hello',
    attachments: [],
    now: 1234
  })

  assert.deepEqual(user, {
    id: 'u1',
    role: 'user',
    text: 'hello',
    createdAt: 1234,
    attachments: []
  })
  assert.deepEqual(assistant, {
    id: 'a1',
    role: 'assistant',
    text: '',
    thought: '',
    toolCalls: [],
    createdAt: 1234,
    streaming: true
  })
})

// The base64 is already on its way to the agent; a copy per attachment would
// grow the on-disk transcript for nothing the UI cannot re-derive.
test('image payloads are dropped from the stored user message', () => {
  const { user } = buildTurnMessages({
    userId: 'u1',
    assistantId: 'a1',
    text: 'look',
    rawText: 'look',
    attachments: [image('a-very-long-base64-string'), file('/a.ts')],
    now: 1
  })

  assert.equal(user.attachments?.[0].data, undefined)
  assert.equal(user.attachments?.[0].kind, 'image')
  // Name and mime type stay: the UI still renders the chip.
  assert.equal(user.attachments?.[0].name, 'shot.png')
  assert.equal(user.attachments?.[1].path, '/a.ts')
})

test('an attachment-only turn still shows text in the transcript', () => {
  const { user } = buildTurnMessages({
    userId: 'u1',
    assistantId: 'a1',
    text: 'Please inspect these files:\n- /a.ts',
    rawText: '',
    attachments: [file('/a.ts')],
    now: 1
  })
  assert.equal(user.text, 'Please inspect these files:\n- /a.ts')
})

test('an image-only turn falls back to the raw text the user typed', () => {
  const { user } = buildTurnMessages({
    userId: 'u1',
    assistantId: 'a1',
    text: '',
    rawText: '   ',
    attachments: [image('AAAA')],
    now: 1
  })
  assert.equal(user.text, '   ')
})

test('the seeded session title is a short prefix, or the folder name', () => {
  assert.equal(sessionTitleFromPrompt('short question', 'app'), 'short question')
  assert.equal(sessionTitleFromPrompt('x'.repeat(100), 'app').length, 60)
  assert.equal(sessionTitleFromPrompt('', 'app'), 'app')
})
