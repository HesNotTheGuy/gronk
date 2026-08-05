import test from 'node:test'
import assert from 'node:assert/strict'
import { act, createElement } from 'react'
import { flush, mount } from './helpers/render'
import { installFakeBridge } from './helpers/gronk-api'
import type { ChatMessage, MainToRendererEvent, SessionInfo } from '../shared/types'

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

interface Saved {
  sessionId: string
  messages: ChatMessage[]
}

interface Harness {
  hook: () => Record<string, unknown>
  reads: string[]
  loads: string[]
  saves: Saved[]
  emit: (event: MainToRendererEvent) => void
  unmount: () => void
  restore: () => void
}

async function mountHook(opts: { onRead?: (id: string) => void } = {}): Promise<Harness> {
  const reads: string[] = []
  const loads: string[] = []
  const saves: Saved[] = []
  const bridge = installFakeBridge({
    getAuthStatus: async () => ({ authenticated: true, hasAuthFile: true, message: '' }),
    getChatWorkspacePath: async () => '/data/chat-workspace',
    getTranscript: async (id: string) => {
      reads.push(id)
      // The hook paints on the very next statement after this resolves, so this
      // is the hook a test uses to hold the frame that carries the head.
      opts.onRead?.(id)
      return TRANSCRIPTS[id] ?? []
    },
    loadSession: async (id: string) => {
      loads.push(id)
      return { sessionId: id, restored: true }
    },
    saveTranscript: async (sessionId: string, messages: ChatMessage[]) => {
      saves.push({ sessionId, messages })
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
    saves,
    emit: bridge.emit,
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
  await selectWithoutSettling(h, id)
  await flush()
  await flush()
}

/** The same, stopping while the deferred half of the paint is still pending. */
async function selectWithoutSettling(h: Harness, id: string): Promise<void> {
  await act(async () => {
    await (h.hook().selectSession as (s: SessionInfo) => Promise<void>)(session(id))
  })
}

/**
 * Hold the ONE frame that carries the head, for one session.
 *
 * Exactly one, and only the first after that session's transcript is read.
 * `paintTranscript` schedules it on the statement after the read, so that frame
 * is the head and every other frame belongs to something else. Holding more
 * deadlocks the next restore, because `yieldPaint` awaits two frames before it
 * reads anything at all, and a held `yieldPaint` never resolves.
 */
function holdFrames(sessionId: string) {
  const real = globalThis.requestAnimationFrame
  const held: FrameRequestCallback[] = []
  let arming = false
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    if (arming) {
      arming = false
      held.push(cb)
      return held.length
    }
    return real(cb)
  }) as typeof globalThis.requestAnimationFrame
  return {
    onRead: (id: string) => {
      if (id === sessionId) arming = true
    },
    /** Put the real scheduler back. The held frame is dropped, never replayed. */
    restore: () => {
      arming = false
      globalThis.requestAnimationFrame = real
    }
  }
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

test('A TURN COMPLETING MID-RESTORE SAVES THE WHOLE TRANSCRIPT, not the tail', async () => {
  /*
   * The one that costs data. `message-done` writes to the store immediately
   * rather than on the 400ms debounce, so it is the reader most likely to land
   * inside the window where the head has not arrived. If it reads what is on
   * screen, thirty messages go over the whole stored conversation and the rest
   * is gone.
   *
   * It is reachable on purpose rather than in theory: the composer stays live
   * during a restore (PR #25), the head lands inside a transition React may
   * defer, and the load that makes a restore slow is the same load that defers
   * it. Prompt into a long transcript and the turn can finish first.
   *
   * The head is held by capturing the frame it is scheduled on, from the moment
   * the transcript is read. Everything before that, including the two frames
   * `yieldPaint` waits on, runs normally, so the restore itself is not stalled.
   */
  const holder = holdFrames('a')
  const h = await mountHook({ onRead: holder.onRead })
  try {
    await selectWithoutSettling(h, 'a')
    assert.equal(
      (h.hook().messages as ChatMessage[]).length,
      30,
      'the head landed anyway, so this test proves nothing'
    )

    // The reply the user prompted for, arriving while the head is still pending.
    await act(async () => {
      h.emit({ type: 'message-chunk', sessionId: 'a', messageId: 'live-1', text: 'partial' })
    })
    await act(async () => {
      h.emit({ type: 'message-done', sessionId: 'a', messageId: 'live-1' })
    })
    await flush()

    const written = h.saves.at(-1)
    assert.ok(written, 'the completed turn was never saved')
    assert.equal(written.sessionId, 'a')
    assert.equal(
      written.messages.length,
      201,
      'the stored transcript was truncated to the tail plus the live turn'
    )
    assert.deepEqual(
      written.messages.map((m) => m.id),
      [...TRANSCRIPTS.a.map((m) => m.id), 'live-1'],
      'the restored history and the new turn are not in the order they happened'
    )
    // The mapping this save exists for still lands on the finished message.
    assert.equal(written.messages.at(-1)?.streaming, false)
  } finally {
    holder.restore()
    h.unmount()
    h.restore()
  }
})

test('the debounced save mid-restore also writes the whole transcript', async () => {
  // The second of the three readers. Slower to reach than message-done, and the
  // same loss if it lands first: this one is on a 400ms timer, so the test pays
  // that wait rather than pretending the timer is not there.
  const holder = holdFrames('a')
  const h = await mountHook({ onRead: holder.onRead })
  try {
    await selectWithoutSettling(h, 'a')
    assert.equal((h.hook().messages as ChatMessage[]).length, 30)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 450))
    })
    const written = h.saves.at(-1)
    assert.ok(written, 'nothing was persisted at all')
    assert.equal(written.messages.length, 200, 'the stored transcript was truncated to the tail')
  } finally {
    holder.restore()
    h.unmount()
    h.restore()
  }
})

test('a session left mid-restore is cached whole, not as the tail', async () => {
  // The third reader. A truncated cache entry is worse than a truncated save in
  // one way: it is handed back on the next visit and then persisted from there,
  // so the loss survives even though the store was fine at the time.
  const holder = holdFrames('a')
  const h = await mountHook({ onRead: holder.onRead })
  try {
    await selectWithoutSettling(h, 'a')
    assert.equal((h.hook().messages as ChatMessage[]).length, 30)
    // Leaving 'a' is what writes it into the cache.
    await select(h, 'b')
    holder.restore()
    await select(h, 'a')
    assert.deepEqual(h.reads, ['a', 'b'], 'the cache was not used, so this proves nothing')
    assert.equal(
      (h.hook().messages as ChatMessage[]).length,
      200,
      'a truncated transcript was cached and handed back'
    )
  } finally {
    holder.restore()
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
