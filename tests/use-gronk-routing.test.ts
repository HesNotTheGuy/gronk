import test from 'node:test'
import assert from 'node:assert/strict'
import { act, createElement } from 'react'
import { flush, mount } from './helpers/render'
import { installFakeBridge } from './helpers/gronk-api'
import type { ChatMessage, MainToRendererEvent, SessionInfo } from '../shared/types'

/**
 * The wiring behind `session-focus`: does the hook actually ask, and does the
 * answer survive a session switch.
 *
 * The rule being right is no use if the handler never consults it, and the
 * dangerous direction is not "a stray event got through" but "the events that
 * paint the conversation were dropped". A switch is the window where that
 * happens, so most of this drives one.
 */

type Hook = Record<string, any>

interface Harness {
  hook: () => Hook
  emit: (event: MainToRendererEvent) => void
  unmount: () => void
  restore: () => void
}

const session = (id: string): SessionInfo =>
  ({
    id,
    cwd: '/work/alpha',
    title: id,
    createdAt: 0,
    updatedAt: 0,
    surface: 'project'
  }) as SessionInfo

async function mountHook(overrides: Record<string, unknown> = {}): Promise<Harness> {
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

/** Settle the hook into session `id` the way the app does. */
async function selectInto(h: Harness, id: string): Promise<void> {
  await act(async () => {
    await h.hook().selectSession(session(id))
  })
  await flush()
  await flush()
}

function chunk(sessionId: string, text: string, messageId = 'm1'): MainToRendererEvent {
  return { type: 'message-chunk', sessionId, messageId, text }
}

const transcript = (h: Harness): string =>
  (h.hook().messages as ChatMessage[]).map((m) => m.text ?? '').join('')

test('THE STREAM OF THE SESSION ON SCREEN STILL ARRIVES', async () => {
  const h = await mountHook()
  try {
    await selectInto(h, 's1')
    await act(async () => {
      h.emit(chunk('s1', 'hello from the session I am looking at'))
    })
    await flush()
    assert.match(transcript(h), /hello from the session I am looking at/)
  } finally {
    h.unmount()
    h.restore()
  }
})

test('ANOTHER SESSION S REPLY DOES NOT LAND IN THIS TRANSCRIPT', async () => {
  // The whole point. Today there is one agent so this cannot happen; the moment
  // a second can run, an unfiltered handler appends its reply here.
  const h = await mountHook()
  try {
    await selectInto(h, 's1')
    const before = transcript(h)
    await act(async () => {
      h.emit(chunk('other-session', 'BACKGROUND WORK'))
    })
    await flush()
    assert.equal(transcript(h), before)
    assert.doesNotMatch(transcript(h), /BACKGROUND WORK/)
  } finally {
    h.unmount()
    h.restore()
  }
})

test('A LOAD THAT RESOLVES TO A DIFFERENT ID STILL PAINTS ITS HISTORY', async () => {
  // The regression this change could most easily have introduced. The renderer
  // sets its session optimistically from the click, and `loadSession` can come
  // back with a different id; the history events naming that id arrive before
  // the answer does. A strict equality filter drops them and the conversation
  // renders empty.
  const restored: ChatMessage[] = [
    { id: 'r1', role: 'user', text: 'RESTORED HISTORY', createdAt: 1 } as ChatMessage
  ]
  let emit: ((event: MainToRendererEvent) => void) | null = null
  const h = await mountHook({
    loadSession: async () => {
      // Main emits under the id it actually loaded, before the call resolves.
      emit?.({ type: 'history-replace', sessionId: 'resolved-elsewhere', messages: restored })
      emit?.({ type: 'history-done', sessionId: 'resolved-elsewhere', source: 'local' })
      return { sessionId: 'resolved-elsewhere', restored: true }
    }
  })
  emit = h.emit
  try {
    await selectInto(h, 'clicked')
    assert.match(transcript(h), /RESTORED HISTORY/, 'the restored history was dropped')
  } finally {
    h.unmount()
    h.restore()
  }
})

test('after such a load, BOTH ids are still the conversation on screen', async () => {
  const h = await mountHook({
    loadSession: async () => ({ sessionId: 'resolved-elsewhere', restored: true })
  })
  try {
    await selectInto(h, 'clicked')
    await act(async () => {
      h.emit(chunk('clicked', 'ARRIVED LATE UNDER THE OLD ID'))
    })
    await flush()
    assert.match(transcript(h), /ARRIVED LATE UNDER THE OLD ID/)
  } finally {
    h.unmount()
    h.restore()
  }
})

test('THE SWITCH CLOSES ON THE FIRST SIGNAL, not only when the call returns', async () => {
  // Two things can name the session: the `session` event and the value
  // `loadSession` resolves with. The event is the earlier of the two, and while
  // the switch is open every session's events are accepted, so closing at the
  // first answer rather than the last is what keeps that window short.
  let emit: ((event: MainToRendererEvent) => void) | null = null
  const h = await mountHook({
    loadSession: async () => {
      emit?.({ type: 'session', sessionId: 'clicked', cwd: '/work/alpha' })
      // Arrives after the answer but before this call resolves.
      emit?.(chunk('intruder', 'SHOULD NOT APPEAR'))
      return { sessionId: 'clicked', restored: false }
    }
  })
  emit = h.emit
  try {
    await selectInto(h, 'clicked')
    assert.doesNotMatch(
      transcript(h),
      /SHOULD NOT APPEAR/,
      'the switch was still open after main had already named the session'
    )
  } finally {
    h.unmount()
    h.restore()
  }
})

test('a renderer that has selected nothing still shows a live agent', async () => {
  // A window recreated while main still has an agent running receives its
  // stream without ever having asked for it. There is no other conversation for
  // it to be confused with, so it is shown.
  const h = await mountHook()
  try {
    await act(async () => {
      h.emit(chunk('already-running', 'STREAM FROM BEFORE THIS WINDOW'))
    })
    await flush()
    assert.match(transcript(h), /STREAM FROM BEFORE THIS WINDOW/)
  } finally {
    h.unmount()
    h.restore()
  }
})

test('A FAILED START DOES NOT LEAVE THE SWITCH OPEN FOREVER', async () => {
  // While a switch is in flight everything is accepted, because the id is not
  // known yet. If a failure left that state in place, every later session's
  // events would land here for the rest of the run.
  const h = await mountHook({
    startAgent: async () => {
      throw new Error('SPAWN FAILED')
    }
  })
  try {
    await act(async () => {
      await h.hook().openChat()
    })
    await flush()
    assert.equal(h.hook().error, 'SPAWN FAILED')

    await selectInto(h, 's1')
    const before = transcript(h)
    await act(async () => {
      h.emit(chunk('some-other-session', 'SHOULD NOT APPEAR'))
    })
    await flush()
    assert.equal(transcript(h), before, 'the switch was still accepting everything')
  } finally {
    h.unmount()
    h.restore()
  }
})

test('reselecting the session already open does not reopen the switch', async () => {
  // needsSessionReload skips the work for a healthy current session. Opening a
  // switch before that check would leave one open with nothing to close it.
  const h = await mountHook()
  try {
    await selectInto(h, 's1')
    await act(async () => {
      h.emit({ type: 'connection', state: 'ready', sessionId: 's1' })
    })
    await flush()
    await selectInto(h, 's1')

    const before = transcript(h)
    await act(async () => {
      h.emit(chunk('a-third-session', 'SHOULD NOT APPEAR'))
    })
    await flush()
    assert.equal(transcript(h), before)
  } finally {
    h.unmount()
    h.restore()
  }
})

test("a background session's connection trouble does not disturb this one", async () => {
  const h = await mountHook()
  try {
    await selectInto(h, 's1')
    await act(async () => {
      h.emit({ type: 'connection', state: 'ready', sessionId: 's1' })
    })
    await flush()
    assert.equal(h.hook().connection, 'ready')

    await act(async () => {
      h.emit({ type: 'connection', state: 'error', error: 'THEIR PROBLEM', sessionId: 'other' })
    })
    await flush()

    assert.equal(h.hook().connection, 'ready', 'another session took the composer down')
    assert.equal(h.hook().error, null, 'another session put its error on this banner')
  } finally {
    h.unmount()
    h.restore()
  }
})

test('a connection event from before any session exists is still honoured', async () => {
  // Agent boot has no session to name yet, and these events drive the composer.
  const h = await mountHook()
  try {
    await selectInto(h, 's1')
    await act(async () => {
      h.emit({ type: 'connection', state: 'starting' })
    })
    await flush()
    assert.equal(h.hook().connection, 'starting')
  } finally {
    h.unmount()
    h.restore()
  }
})

test("a background session's permission prompt does not appear over this one", async () => {
  const h = await mountHook()
  try {
    await selectInto(h, 's1')
    await act(async () => {
      h.emit({
        type: 'permission-request',
        sessionId: 'other',
        request: {
          requestId: 1,
          title: 'THEIR REQUEST',
          kind: 'other'
        } as never
      })
    })
    await flush()
    assert.equal(h.hook().permission, null)
  } finally {
    h.unmount()
    h.restore()
  }
})
