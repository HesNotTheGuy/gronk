import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { act, createElement } from 'react'
import { flush, mount } from './helpers/render'
import { installFakeBridge } from './helpers/gronk-api'
import { __freshUserData } from './stubs/electron'
import type { MainToRendererEvent, SessionInfo } from '../shared/types'

/**
 * The hook under the kind of use a person actually produces, rather than the kind
 * a unit test does: clicking faster than anything resolves, opening more sessions
 * than anyone designed for, streaming for longer than a test usually bothers with,
 * and a bridge where every call throws.
 *
 * None of these failed when they were written, which is the point of keeping them:
 * they are the shapes that would not show up until somebody was using the app
 * heavily, and by then the report is "it got weird" rather than a stack trace. The
 * timing bounds are deliberately loose — they are there to catch an order of
 * magnitude, not to measure anything.
 */

beforeEach(() => {
  __freshUserData()
})

type Hook = Record<string, any>

async function mountHook(overrides: Record<string, unknown> = {}) {
  const bridge = installFakeBridge(overrides)
  const { useGronk } = await import('../src/hooks/useGronk')
  let latest: Hook = {}
  function Probe() {
    latest = useGronk() as unknown as Hook
    return null
  }
  const view = await mount(createElement(Probe))
  await flush()
  return { hook: () => latest, emit: bridge.emit, unmount: view.unmount, restore: bridge.restore }
}

const session = (id: string, cwd = '/work/alpha'): SessionInfo =>
  ({ id, cwd, title: id, createdAt: 1, updatedAt: 1, surface: 'project' }) as SessionInfo

const chunk = (sessionId: string, messageId: string, text: string): MainToRendererEvent =>
  ({ type: 'message-chunk', sessionId, messageId, text }) as MainToRendererEvent

test('IMPATIENT CLICKING: ten session switches with nothing awaited between them', async () => {
  const h = await mountHook()
  try {
    await act(async () => {
      for (let i = 0; i < 10; i++) void h.hook().selectSession(session(`s${i}`))
    })
    await flush()
    await flush()

    // Whatever it settles on, it must be ONE session and it must be usable.
    const id = h.hook().sessionId
    assert.ok(id, 'rapid switching left no session selected at all')
    assert.equal(h.hook().hydrating, false, 'left stuck in the loading state')
    assert.equal(h.hook().busy, false, 'left with the composer disabled')

    // And a later session must not be able to paint into it.
    const before = (h.hook().messages ?? []).length
    await act(async () => {
      h.emit(chunk('someone-else', 'm1', 'SHOULD NOT APPEAR'))
    })
    await flush()
    assert.equal((h.hook().messages ?? []).length, before, "another session's text landed here")
  } finally {
    h.unmount()
    h.restore()
  }
})

test('LOAD: a session with 4000 messages restores and stays responsive', async () => {
  const many = Array.from({ length: 4000 }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 ? 'assistant' : 'user',
    text: 'x'.repeat(400),
    createdAt: i
  }))
  const h = await mountHook({ getTranscript: async () => many })
  try {
    const started = Date.now()
    await act(async () => {
      void h.hook().selectSession(session('big'))
    })
    await flush()
    await flush()
    const elapsed = Date.now() - started
    assert.ok((h.hook().messages ?? []).length > 0, 'a large transcript painted nothing')
    assert.ok(elapsed < 10_000, `restoring 4000 messages took ${elapsed}ms`)
  } finally {
    h.unmount()
    h.restore()
  }
})

test('HEAVY USE: 2000 streamed chunks into one message', async () => {
  const h = await mountHook()
  try {
    await act(async () => {
      await h.hook().selectSession(session('s1'))
    })
    await flush()
    await flush()
    const id = h.hook().sessionId as string
    assert.ok(id, 'the fixture never settled into a session')

    const started = Date.now()
    await act(async () => {
      for (let i = 0; i < 2000; i++) h.emit(chunk(id, 'm1', 'word '))
    })
    await flush()
    const elapsed = Date.now() - started

    const painted = (h.hook().messages ?? []).find((m: Hook) => m.id === 'm1')
    assert.ok(painted, 'streaming produced no message')
    assert.equal(painted.text.length, 2000 * 5, 'chunks were lost or duplicated')
    assert.ok(elapsed < 15_000, `2000 chunks took ${elapsed}ms`)
  } finally {
    h.unmount()
    h.restore()
  }
})

test('MANY SESSIONS: opening fifty in a row leaves one usable session', async () => {
  const h = await mountHook()
  try {
    for (let i = 0; i < 50; i++) {
      await act(async () => {
        void h.hook().selectSession(session(`s${i}`, `/work/p${i % 7}`))
      })
    }
    await flush()
    await flush()
    assert.ok(h.hook().sessionId, 'no session selected after fifty opens')
    assert.equal(h.hook().hydrating, false)
    assert.equal(h.hook().busy, false)
  } finally {
    h.unmount()
    h.restore()
  }
})

test('A FAILING BRIDGE DOES NOT WEDGE THE UI', async () => {
  const boom = async () => {
    throw new Error('BOOM')
  }
  const h = await mountHook({ loadSession: boom, startAgent: boom, getTranscript: boom })
  try {
    await act(async () => {
      void h.hook().selectSession(session('s1'))
    })
    await flush()
    await flush()
    assert.ok(h.hook().error, 'a total bridge failure said nothing to the user')
    assert.equal(h.hook().hydrating, false, 'left showing a skeleton forever')
    assert.equal(h.hook().busy, false, 'left with the composer disabled forever')
  } finally {
    h.unmount()
    h.restore()
  }
})
