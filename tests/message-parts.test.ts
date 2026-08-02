import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { act, createElement } from 'react'
import { mount, flush, type Mounted } from './helpers/render'
import { installFakeBridge } from './helpers/gronk-api'
import { __freshUserData } from './stubs/electron'
import { getTranscript, saveTranscript, upsertSession } from '../electron/main/store'
import { MessageList, buildMessageSegments } from '../src/components/MessageList'
import {
  appendTextPart,
  appendToolPart,
  type ChatMessage,
  type MainToRendererEvent,
  type MessagePart,
  type ToolCallInfo
} from '../shared/types'

/**
 * A turn is an ORDERED list of text runs and tool calls.
 *
 * Reported against v0.1.6 with a screenshot: Grok edited an image in three
 * steps, narrating once before each tool call and once after, and the app drew
 * all three narrations as a single paragraph BELOW both tool cards, with the
 * sentences run together at the joins ("...regenerating.Editing..."). Every
 * introduction sat under the call it introduced, and the reader could not tell
 * where one message ended and the next began.
 *
 * The cause was the shape, not the rendering: ChatMessage carried `text: string`
 * and `toolCalls: ToolCallInfo[]` as two parallel fields, so the order between
 * them was simply not representable. `parts` records it.
 *
 * These tests cover the fold (chunks into parts), the renderer's live stream
 * (events into state), and the drawing (state into DOM), because the bug needed
 * all three to be right and only the last one was visible.
 */

/** The three messages from the report, verbatim. */
const NARRATION = [
  "I'll clean up noise and artifacts while keeping the same composition. Loading image-edit guidance first, then regenerating.",
  'Editing the image to reduce noise and artifacts while preserving composition and detail.',
  "Here's a cleaned-up version of the image with noise and compression artifacts reduced, while keeping the same scene and composition."
]

function tool(id: string, title: string): ToolCallInfo {
  return { toolCallId: id, title, kind: 'other', status: 'completed' }
}

function assistant(partial: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'a1',
    role: 'assistant',
    text: '',
    createdAt: 1000,
    ...partial
  }
}

// ── Folding chunks into parts ──────────────────────────────────────────────
// Both sides of the IPC boundary call these: the main process to build the
// transcript it saves, the renderer to build what is on screen. They have to
// produce the same list from the same stream, which is why there is one
// implementation and not one per side.

test('text, then a tool, then text is three parts in that order', () => {
  let parts = appendTextPart(undefined, NARRATION[0])
  parts = appendToolPart(parts, 'skill-1')
  parts = appendTextPart(parts, NARRATION[1])

  assert.deepEqual(parts, [
    { kind: 'text', text: NARRATION[0] },
    { kind: 'tool', toolCallId: 'skill-1' },
    { kind: 'text', text: NARRATION[1] }
  ])
})

// Without this a streamed sentence becomes one part per token, and the fix would
// have replaced one run-on paragraph with forty single-word bubbles.
test('consecutive chunks extend the open run instead of starting a part', () => {
  let parts: MessagePart[] | undefined
  for (const chunk of ['Editing ', 'the ', 'image ', 'to ', 'reduce ', 'noise.']) {
    parts = appendTextPart(parts, chunk)
  }

  assert.equal(parts?.length, 1)
  assert.deepEqual(parts, [{ kind: 'text', text: 'Editing the image to reduce noise.' }])
})

test('a run is only closed by something that is not text', () => {
  let parts = appendTextPart(undefined, 'one ')
  parts = appendTextPart(parts, 'run.')
  parts = appendToolPart(parts, 't1')
  parts = appendTextPart(parts, 'second ')
  parts = appendTextPart(parts, 'run.')

  assert.deepEqual(parts.map((p) => (p.kind === 'text' ? p.text : `[${p.toolCallId}]`)), [
    'one run.',
    '[t1]',
    'second run.'
  ])
})

// Grok announces a call once and then streams status updates for the same id,
// and a permission prompt announces it again. Placing it per update would draw
// the same card once per status change.
test('a tool call takes one slot however many updates it sends', () => {
  let parts = appendToolPart(undefined, 't1')
  parts = appendToolPart(parts, 't1')
  parts = appendTextPart(parts, 'in between')
  parts = appendToolPart(parts, 't1')

  assert.deepEqual(parts, [
    { kind: 'tool', toolCallId: 't1' },
    { kind: 'text', text: 'in between' }
  ])
})

test('an empty chunk adds nothing and does not close the open run', () => {
  let parts = appendTextPart(undefined, 'open')
  parts = appendTextPart(parts, '')
  parts = appendTextPart(parts, ' still open')

  assert.deepEqual(parts, [{ kind: 'text', text: 'open still open' }])
  assert.deepEqual(appendTextPart(undefined, ''), [])
})

test('the caller\'s list is never mutated in place', () => {
  const original = appendTextPart(undefined, 'a')
  const extended = appendToolPart(original, 't1')

  assert.equal(original.length, 1)
  assert.equal(extended.length, 2)
})

// ── The renderer's live stream ─────────────────────────────────────────────

/** Mount useGronk, push events at it as the main process would, read messages. */
async function streamTurn(events: MainToRendererEvent[]): Promise<ChatMessage[]> {
  const bridge = installFakeBridge()
  const { useGronk } = await import('../src/hooks/useGronk')
  let captured: ChatMessage[] = []

  function Probe() {
    captured = useGronk().messages
    return null
  }

  const view = await mount(createElement(Probe))
  await flush()
  try {
    for (const event of events) {
      await act(async () => {
        bridge.emit(event)
      })
    }
    await flush()
    return captured
  } finally {
    view.unmount()
    bridge.restore()
  }
}

function chunk(text: string): MainToRendererEvent {
  return { type: 'message-chunk', sessionId: 's1', messageId: 'a1', text }
}

function call(id: string, title: string): MainToRendererEvent {
  return { type: 'tool-call', sessionId: 's1', messageId: 'a1', toolCall: tool(id, title) }
}

/** The reported turn, as the events that produced it. */
const REPORTED_TURN: MainToRendererEvent[] = [
  chunk(NARRATION[0]),
  call('skill-1', 'Skill: image-edit'),
  chunk(NARRATION[1]),
  call('edit-1', 'image_edit'),
  chunk(NARRATION[2])
]

test('three narrations around two tool calls keep their order', async () => {
  const messages = await streamTurn(REPORTED_TURN)

  assert.equal(messages.length, 1)
  assert.deepEqual(messages[0].parts, [
    { kind: 'text', text: NARRATION[0] },
    { kind: 'tool', toolCallId: 'skill-1' },
    { kind: 'text', text: NARRATION[1] },
    { kind: 'tool', toolCallId: 'edit-1' },
    { kind: 'text', text: NARRATION[2] }
  ])
})

// `parts` is an index over the old fields, never a replacement for them: an
// older build reading this transcript, and every export, still wants `text`.
test('the ordered turn still carries the whole prose and every tool call', async () => {
  const messages = await streamTurn(REPORTED_TURN)

  assert.equal(messages[0].text, NARRATION.join(''))
  assert.deepEqual(messages[0].toolCalls?.map((t) => t.toolCallId), ['skill-1', 'edit-1'])
})

test('a sentence streamed token by token is one part, not one per token', async () => {
  const messages = await streamTurn([
    chunk('Here'),
    chunk("'s a "),
    chunk('cleaned-up version.'),
    call('edit-1', 'image_edit')
  ])

  assert.deepEqual(messages[0].parts, [
    { kind: 'text', text: "Here's a cleaned-up version." },
    { kind: 'tool', toolCallId: 'edit-1' }
  ])
})

// A gated call reaches the renderer as a tool-call-update while the permission
// prompt is open, before any tool-call arrives. It has to claim its slot there
// or the card jumps to the end of the turn once the real event lands.
test('a call first seen as a status update is placed where it was seen', async () => {
  const messages = await streamTurn([
    chunk('Writing the file.'),
    {
      type: 'tool-call-update',
      sessionId: 's1',
      messageId: 'a1',
      toolCallId: 'write-1',
      patch: { title: 'Write file', status: 'pending' }
    },
    chunk('Done.'),
    {
      type: 'tool-call-update',
      sessionId: 's1',
      messageId: 'a1',
      toolCallId: 'write-1',
      patch: { status: 'completed' }
    }
  ])

  assert.deepEqual(messages[0].parts, [
    { kind: 'text', text: 'Writing the file.' },
    { kind: 'tool', toolCallId: 'write-1' },
    { kind: 'text', text: 'Done.' }
  ])
})

// ── Turning a message into blocks ──────────────────────────────────────────

test('a message with no parts is drawn the way it always was', () => {
  const segments = buildMessageSegments(
    assistant({ text: 'All done.', toolCalls: [tool('t1', 'Read'), tool('t2', 'Bash')] })
  )

  assert.deepEqual(segments, [
    { kind: 'tools', tools: [tool('t1', 'Read'), tool('t2', 'Bash')] },
    { kind: 'text', text: 'All done.' }
  ])
})

test('consecutive calls share one card, a narration between them splits it', () => {
  const tools = [tool('t1', 'Read'), tool('t2', 'Read'), tool('t3', 'Bash')]
  const segments = buildMessageSegments(
    assistant({
      text: 'Reading.Running.',
      toolCalls: tools,
      parts: [
        { kind: 'text', text: 'Reading.' },
        { kind: 'tool', toolCallId: 't1' },
        { kind: 'tool', toolCallId: 't2' },
        { kind: 'text', text: 'Running.' },
        { kind: 'tool', toolCallId: 't3' }
      ]
    })
  )

  assert.deepEqual(
    segments.map((s) => (s.kind === 'text' ? s.text : s.tools.map((t) => t.toolCallId).join('+'))),
    ['Reading.', 't1+t2', 'Running.', 't3']
  )
})

// The two lists are written by different events, so they can disagree. Losing a
// tool card is worse than drawing it late.
test('a tool call no part points at is still drawn', () => {
  const segments = buildMessageSegments(
    assistant({
      text: 'Hi.',
      toolCalls: [tool('t1', 'Read'), tool('orphan', 'Bash')],
      parts: [
        { kind: 'text', text: 'Hi.' },
        { kind: 'tool', toolCallId: 't1' }
      ]
    })
  )

  assert.deepEqual(
    segments.map((s) => (s.kind === 'text' ? s.text : s.tools.map((t) => t.toolCallId).join('+'))),
    ['Hi.', 't1', 'orphan']
  )
})

test('a part pointing at a call that is gone draws nothing extra', () => {
  const segments = buildMessageSegments(
    assistant({
      text: 'Hi.',
      parts: [
        { kind: 'tool', toolCallId: 'vanished' },
        { kind: 'text', text: 'Hi.' }
      ]
    })
  )

  assert.deepEqual(segments, [{ kind: 'text', text: 'Hi.' }])
})

test('a run of pure whitespace does not become an empty bubble', () => {
  const segments = buildMessageSegments(
    assistant({
      text: 'Hi.\n\n',
      toolCalls: [tool('t1', 'Read')],
      parts: [
        { kind: 'text', text: 'Hi.' },
        { kind: 'text', text: '\n\n' },
        { kind: 'tool', toolCallId: 't1' }
      ]
    })
  )

  assert.deepEqual(
    segments.map((s) => s.kind),
    ['text', 'tools']
  )
})

// ── What actually reaches the screen ───────────────────────────────────────

/** Class-level shape of one message: the blocks it drew, in document order. */
function blocks(view: Mounted): string[] {
  return view
    .queryAll('.message > .bubble, .message > .tool-activity')
    .map((el) => (el.classList.contains('bubble') ? 'bubble' : 'tools'))
}

async function draw(messages: ChatMessage[]): Promise<Mounted> {
  const view = await mount(createElement(MessageList, { messages }))
  await flush()
  return view
}

test('every transcript already on disk renders exactly as before', async () => {
  // No `parts` anywhere: this is the shape of every saved conversation written
  // before ordering existed, and the point of keeping the field optional.
  const bridge = installFakeBridge()
  const view = await draw([
    { id: 'u1', role: 'user', text: 'clean this up', createdAt: 1 },
    assistant({
      text: NARRATION.join(''),
      toolCalls: [tool('skill-1', 'Skill'), tool('edit-1', 'image_edit')]
    })
  ])
  try {
    assert.deepEqual(blocks(view), ['bubble', 'tools', 'bubble'])
    assert.match(view.text(), /regenerating\.Editing/)
    assert.equal(view.queryAll('.tool-activity').length, 1)
  } finally {
    view.unmount()
    bridge.restore()
  }
})

test('each narration is drawn above the call it introduces', async () => {
  const bridge = installFakeBridge()
  const messages = await streamTurn(REPORTED_TURN)
  const view = await draw(messages)
  try {
    // user bubble is absent here: the turn under test is the assistant's.
    assert.deepEqual(blocks(view), ['bubble', 'tools', 'bubble', 'tools', 'bubble'])

    const bubbles = view.queryAll('.bubble').map((el) => el.textContent ?? '')
    assert.equal(bubbles.length, 3)
    assert.equal(bubbles[0].trim(), NARRATION[0])
    assert.equal(bubbles[1].trim(), NARRATION[1])
    assert.equal(bubbles[2].trim(), NARRATION[2])

    // The joins that gave the bug away. Nothing may run two messages together.
    assert.doesNotMatch(view.text(), /regenerating\.Editing/)
    assert.doesNotMatch(view.text(), /detail\.Here's/)
  } finally {
    view.unmount()
    bridge.restore()
  }
})

test('a live turn still shows one caret, on whatever it produced last', async () => {
  const bridge = installFakeBridge()
  const withText = await draw([
    assistant({
      streaming: true,
      text: 'Editing.',
      toolCalls: [tool('t1', 'image_edit')],
      parts: [
        { kind: 'tool', toolCallId: 't1' },
        { kind: 'text', text: 'Editing.' }
      ]
    })
  ])
  try {
    assert.deepEqual(blocks(withText), ['tools', 'bubble'])
    assert.equal(withText.queryAll('.streaming-caret').length, 1)
  } finally {
    withText.unmount()
  }

  // Mid tool call, nothing typed yet: the caret needs a bubble of its own or
  // the turn looks finished.
  const midTool = await draw([
    assistant({
      streaming: true,
      text: 'Editing.',
      toolCalls: [tool('t1', 'image_edit')],
      parts: [
        { kind: 'text', text: 'Editing.' },
        { kind: 'tool', toolCallId: 't1' }
      ]
    })
  ])
  try {
    assert.deepEqual(blocks(midTool), ['bubble', 'tools', 'bubble'])
    assert.equal(midTool.queryAll('.streaming-caret').length, 1)
  } finally {
    midTool.unmount()
    bridge.restore()
  }
})

// ── Persistence ────────────────────────────────────────────────────────────

test('the store keeps parts, and leaves a message without them alone', () => {
  __freshUserData()
  upsertSession({ id: 's1', cwd: 'C:/work/app', createdAt: 1, updatedAt: 1 })

  const ordered = assistant({
    id: 'a1',
    text: 'one two',
    toolCalls: [tool('t1', 'Read')],
    parts: [
      { kind: 'text', text: 'one ' },
      { kind: 'tool', toolCallId: 't1' },
      { kind: 'text', text: 'two' }
    ]
  })
  const legacy = assistant({ id: 'a2', text: 'saved by an older build' })

  saveTranscript('s1', [ordered, legacy])
  const [restored, untouched] = getTranscript('s1')

  assert.deepEqual(restored.parts, ordered.parts)
  assert.equal(restored.text, 'one two')
  assert.equal(untouched.parts, undefined, 'a message with no parts must not gain any')
})

// ── The transcript the main process saves ──────────────────────────────────
//
// The renderer rebuilds parts from the event stream and the main process folds
// the same chunks into the transcript it writes to disk, and only the second one
// survives a restart. If main stops recording the order, the bug comes back the
// moment a session is reopened, with nothing on screen to hint at it while the
// turn is live. There is no seam to call: handleSessionUpdate is private to a
// manager that owns a child process, so this reads the source, the way
// store.test.ts pins the permission fold.
test('the main process records order for both text and tool calls', () => {
  const source = fs.readFileSync(
    fileURLToPath(new URL('../electron/main/agent-manager.ts', import.meta.url)),
    'utf8'
  )

  assert.ok(
    source.includes('appendTextPart(m.parts, action.text)'),
    'the text branch must extend the message parts'
  )
  assert.ok(
    source.includes('appendToolPart(m.parts, merged.toolCallId)'),
    'the tool-call branch must place the call in the message parts'
  )
  assert.ok(
    source.includes('text: m.text + action.text'),
    'text must still accumulate: transcripts on disk and every export read it'
  )
})
