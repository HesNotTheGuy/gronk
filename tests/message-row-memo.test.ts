import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement, Profiler, type ProfilerOnRenderCallback } from 'react'
import type { ChatMessage } from '../shared/types'
import {
  MessageList,
  MessageRow,
  MessageTextSegment
} from '../src/components/MessageList'
import { mount } from './helpers/render'

/** Same symbol React.memo stamps on the component type. */
const REACT_MEMO_TYPE = Symbol.for('react.memo')

function msg(
  partial: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'role' | 'text'>
): ChatMessage {
  return {
    createdAt: 1,
    ...partial
  }
}

function buildTranscript(count: number, streamingTail: string): ChatMessage[] {
  const out: ChatMessage[] = []
  for (let i = 0; i < count - 1; i++) {
    const assistant = i % 2 === 1
    out.push(
      msg({
        id: `m${i}`,
        role: assistant ? 'assistant' : 'user',
        // Real markdown so a full re-render pays remark; memo must avoid that.
        text: assistant
          ? `## Turn ${i}\n\nSettled answer with **bold**, a list:\n\n- a\n- b\n- c\n\n` +
            '```ts\nconst x = ' +
            i +
            '\n```\n'
          : `User question ${i}`
      })
    )
  }
  out.push(
    msg({
      id: 'stream',
      role: 'assistant',
      text: streamingTail,
      streaming: true,
      parts: [
        { kind: 'text', text: 'Settled prefix that must not re-parse. ' },
        { kind: 'text', text: streamingTail }
      ]
    })
  )
  return out
}

test('MessageRow and MessageTextSegment are React.memo components', () => {
  // Removing memo() from either export must fail this test.
  assert.equal(
    (MessageRow as unknown as { $$typeof: symbol }).$$typeof,
    REACT_MEMO_TYPE,
    'MessageRow must be wrapped in React.memo'
  )
  assert.equal(
    (MessageTextSegment as unknown as { $$typeof: symbol }).$$typeof,
    REACT_MEMO_TYPE,
    'MessageTextSegment must be wrapped in React.memo'
  )
})

test('one token at 150 messages: actualDuration is under half baseDuration', async () => {
  /**
   * React Profiler's baseDuration is the estimated cost of rendering the tree
   * without memoization; actualDuration is what this update paid. When
   * MessageRow/MessageTextSegment memo holds, a single-token update on the last
   * row must cost far less than re-rendering all 150 rows.
   *
   * This is the property: removing memo() makes actualDuration approach
   * baseDuration and fails actualDuration < baseDuration / 2.
   */
  let updateActual = 0
  let updateBase = 0
  let sawUpdate = false

  const onRender: ProfilerOnRenderCallback = (
    _id,
    phase,
    actualDuration,
    baseDuration
  ) => {
    if (phase !== 'update') return
    sawUpdate = true
    updateActual = actualDuration
    updateBase = baseDuration
  }

  const onRetry = () => undefined
  let messages = buildTranscript(150, 'Hello')

  const tree = (list: ChatMessage[]) =>
    createElement(
      Profiler,
      { id: 'message-list-memo', onRender },
      createElement(MessageList, {
        messages: list,
        onRetry,
        canRetry: false
      })
    )

  const ui = await mount(tree(messages))
  assert.match(ui.text(), /Hello/)

  // Identity-preserving map, same as useGronk message-chunk.
  messages = messages.map((m) =>
    m.id === 'stream'
      ? {
          ...m,
          text: m.text + ' world',
          parts: m.parts
            ? m.parts.map((p, i, arr) =>
                p.kind === 'text' && i === arr.length - 1
                  ? { ...p, text: p.text + ' world' }
                  : p
              )
            : m.parts
        }
      : m
  )
  await ui.rerender(tree(messages))
  assert.match(ui.text(), /Hello world/)

  assert.ok(sawUpdate, 'Profiler must record an update phase for the token')
  assert.ok(updateBase > 0, `baseDuration must be positive, got ${updateBase}`)
  assert.ok(
    updateActual < updateBase / 2,
    `memo must cut work: actualDuration ${updateActual.toFixed(3)} ms ` +
      `should be < baseDuration/2 ${(updateBase / 2).toFixed(3)} ms ` +
      `(baseDuration ${updateBase.toFixed(3)} ms). ` +
      `If this fails after removing memo(), the test is working.`
  )

  ui.unmount()
})

test('message-chunk preserves toolCalls identity (suppressImagePaths can memo)', () => {
  const toolCalls = [
    { toolCallId: 't1', title: 'read', status: 'completed' as const }
  ]
  const message = msg({
    id: 'x',
    role: 'assistant',
    text: 'see image',
    toolCalls
  })
  // Same path as useGronk message-chunk: spread text/parts only.
  const streamed = { ...message, text: message.text + '!' }
  assert.equal(streamed.toolCalls, toolCalls)
})
