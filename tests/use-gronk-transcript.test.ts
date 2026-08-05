import test from 'node:test'
import assert from 'node:assert/strict'
import { act, createElement } from 'react'
import { flush, mount } from './helpers/render'
import { installFakeBridge } from './helpers/gronk-api'
import type { ChatMessage, SessionInfo } from '../shared/types'

/**
 * Switching sessions: what actually reaches the store, and what does not.
 *
 * The pure halves are covered in `transcript-mount` and `transcript-cache`.
 * What only a mounted hook can answer is whether the transcript that ends up on
 * screen is still the whole transcript after being painted in two pieces, and
 * whether the second visit to a session really skips the read.
 *
 * The app cannot be launched from an agent seat, so this is the only evidence
 * the wiring runs.
 */

function transcript(prefix: string, n: number): ChatMessage[] {
  return Array.from(
    { length: n },
    (_, i) =>
      ({
        id: `${prefix}-${i}`,
        role: i % 2 ? 'assistant' : 'user',
        text: `${prefix} message ${i}`,
        createdAt: i
      }) as ChatMessage
  )
}

function session(id: string, cwd = '/work/alpha'): SessionInfo {
  return {
    id,
    cwd,
    title: id,
    createdAt: 0,
    updatedAt: 0,
    surface: 'project'
  } as SessionInfo
}

const TRANSCRIPTS: Record<string, ChatMessage[]> = {
  a: transcript('a', 200),
  b: transcript('b', 12)
}

interface Harness {
  hook: () => Record<string, unknown>
  reads: string[]
  loads: string[]
  unmount: () => void
  restore: () => void
}

async function mountHook(): Promise<Harness> {
  const reads: string[] = []
  const loads: string[] = []
  const bridge = installFakeBridge({
    getAuthStatus: async () => ({ authenticated: true, hasAuthFile: true, message: '' }),
    getChatWorkspacePath: async () => '/data/chat-workspace',
    getTranscript: async (id: string) => {
      reads.push(id)
      return TRANSCRIPTS[id] ?? []
    },
    loadSession: async (id: string) => {
      loads.push(id)
      return { sessionId: id, restored: true }
    }
  })
  const { useGronk } = await import('../src/hooks/useGronk')
  let latest: Record<string, unknown> = {}
  function Probe() {
    latest = useGronk() as unknown as Record<string, unknown>
    return null
  }
  const view = await mount(createElement(Probe))
  await flush()
  return {
    hook: () => latest,
    reads,
    loads,
    unmount: view.unmount,
    restore: bridge.restore
  }
}

/**
 * Drive a session selection and let the deferred half of the paint land.
 *
 * Inside `act` because selectSession is a whole restore, not one setState: the
 * tail lands during the await and the head a frame later, and React counts
 * anything outside act as an update the test did not admit to.
 */
async function select(h: Harness, id: string): Promise<void> {
  await act(async () => {
    await (h.hook().selectSession as (s: SessionInfo) => Promise<void>)(session(id))
  })
  await flush()
  await flush()
}

test('THE SPLIT PAINT LOSES NOTHING: all 200 messages are on screen afterwards', async () => {
  const h = await mountHook()
  try {
    await select(h, 'a')
    const messages = h.hook().messages as ChatMessage[]
    assert.equal(messages.length, 200, 'the transcript was left truncated')
    assert.deepEqual(
      messages.map((m) => m.id),
      TRANSCRIPTS.a.map((m) => m.id),
      'the transcript came back in a different order'
    )
  } finally {
    h.unmount()
    h.restore()
  }
})

test('a transcript short enough to paint whole still arrives whole', async () => {
  const h = await mountHook()
  try {
    await select(h, 'b')
    assert.equal((h.hook().messages as ChatMessage[]).length, 12)
  } finally {
    h.unmount()
    h.restore()
  }
})

test('GOING BACK TO A SESSION DOES NOT RE-READ IT', async () => {
  const h = await mountHook()
  try {
    await select(h, 'a')
    await select(h, 'b')
    await select(h, 'a')
    assert.deepEqual(h.reads, ['a', 'b'], 'the second visit went back to the store')
    // ...and it is the same conversation, not a stale or partial one.
    assert.equal((h.hook().messages as ChatMessage[]).length, 200)
  } finally {
    h.unmount()
    h.restore()
  }
})

test('THE CACHE NEVER STANDS IN FOR THE LOAD: the agent is told every time', async () => {
  // Skipping loadSession would leave the agent on a different session from the
  // one on screen, which is worse than the read it saves.
  const h = await mountHook()
  try {
    await select(h, 'a')
    await select(h, 'b')
    await select(h, 'a')
    assert.deepEqual(h.loads, ['a', 'b', 'a'], 'a session was swapped in without loading it')
  } finally {
    h.unmount()
    h.restore()
  }
})

test('a deleted session is forgotten, not handed back from memory', async () => {
  const h = await mountHook()
  try {
    await select(h, 'a')
    await select(h, 'b')
    await act(async () => {
      await (h.hook().deleteSession as (id: string) => Promise<void>)('a')
    })
    await flush()
    await select(h, 'a')
    assert.deepEqual(h.reads, ['a', 'b', 'a'], 'a deleted session was served from the cache')
  } finally {
    h.unmount()
    h.restore()
  }
})

test('a renamed session is forgotten too', async () => {
  // Stricter than it has to be: renaming changes no message. The rule stays
  // simple rather than carrying an exception nobody will remember.
  const h = await mountHook()
  try {
    await select(h, 'a')
    await select(h, 'b')
    await act(async () => {
      await (h.hook().renameSession as (id: string, title: string) => Promise<void>)('a', 'new')
    })
    await flush()
    await select(h, 'a')
    assert.deepEqual(h.reads, ['a', 'b', 'a'])
  } finally {
    h.unmount()
    h.restore()
  }
})

test('an archived session is forgotten', async () => {
  const h = await mountHook()
  try {
    await select(h, 'a')
    await select(h, 'b')
    await act(async () => {
      await (h.hook().archiveSession as (id: string) => Promise<void>)('a')
    })
    await flush()
    await select(h, 'a')
    assert.deepEqual(h.reads, ['a', 'b', 'a'])
  } finally {
    h.unmount()
    h.restore()
  }
})
