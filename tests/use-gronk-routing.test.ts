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

test('THE DELEGATED OPEN DOES NOT LEAVE THE WINDOW OPEN', async () => {
  // Opening a project with history hands off to selectSession to resume the
  // latest one. selectSession has early returns that never reach its own
  // beginSwitch, and openProject has already returned by then, so a switch
  // opened before the handoff has nothing left that can close it.
  //
  // Driven through the auth path, because that is the one that reaches the
  // handoff and then refuses inside it.
  let authed = true
  const h = await mountHook({
    getAuthStatus: async () =>
      authed
        ? { state: 'authenticated', authenticated: true, method: 'session', accountLabel: 'x' }
        : { state: 'signed-out', authenticated: false, method: 'none', message: 'SIGN IN' },
    listSessions: async () => [session('latest')]
  })
  try {
    // The sign-in goes stale between opening the project and resuming into it.
    authed = true
    await act(async () => {
      const open = h.hook().openProject('/work/alpha')
      authed = false
      await open
    })
    await flush()
    await flush()

    const before = transcript(h)
    await act(async () => {
      h.emit(chunk('a-completely-different-session', 'SHOULD NOT APPEAR'))
    })
    await flush()

    assert.equal(
      transcript(h),
      before,
      'the delegated open left the window accepting every session'
    )
  } finally {
    h.unmount()
    h.restore()
  }
})

test('a project that resumes its latest session still paints it', async () => {
  // The other side of the same handoff: the ordinary path must keep working.
  const h = await mountHook({ listSessions: async () => [session('latest')] })
  try {
    await act(async () => {
      await h.hook().openProject('/work/alpha')
    })
    await flush()
    await flush()
    await act(async () => {
      h.emit(chunk('latest', 'RESUMED CONVERSATION'))
    })
    await flush()
    assert.match(transcript(h), /RESUMED CONVERSATION/)
  } finally {
    h.unmount()
    h.restore()
  }
})

test('NO FAILING ENTRY POINT LEAVES THE SWITCH OPEN', async () => {
  // Three routes open a switch and three can throw, so each is driven rather
  // than trusting that they look alike. While a switch is open every session's
  // events are accepted; a failure that does not close it leaves that state in
  // place for the rest of the run.
  const routes: [string, (g: Hook) => Promise<unknown>][] = [
    ['openChat', (g) => g.openChat()],
    ['openProject', (g) => g.openProject('/work/beta')],
    ['selectSession', (g) => g.selectSession(session('s1'))]
  ]

  for (const [name, run] of routes) {
    const boom = async () => {
      throw new Error('BOOM')
    }
    const h = await mountHook({ startAgent: boom, loadSession: boom })
    try {
      await act(async () => {
        await run(h.hook())
      })
      await flush()
      await flush()
      assert.equal(h.hook().error, 'BOOM', `${name} did not fail as the fixture intended`)

      const before = transcript(h)
      await act(async () => {
        h.emit(chunk('some-other-session', 'SHOULD NOT APPEAR'))
      })
      await flush()
      assert.equal(
        transcript(h),
        before,
        `after ${name} failed the switch was still accepting every session`
      )
    } finally {
      h.unmount()
      h.restore()
    }
  }
})

test('AN AWAIT OUTSIDE THE TRY CANNOT LEAVE THE SWITCH OPEN', async () => {
  // selectSession resolves the chat workspace path before the try, so a
  // rejection there escapes to a caller that does not catch it, and the switch
  // has to not be open yet when that happens.
  //
  // Narrow on purpose, and the fixture has to work for it. The lookup
  // short-circuits once the path is in state, so the only window is the first
  // session click after mount: the first call returns empty so nothing is
  // cached, and the click's call is the one that throws.
  let calls = 0
  const h = await mountHook({
    getChatWorkspacePath: async () => {
      calls += 1
      if (calls === 1) return ''
      throw new Error('CHAT PATH FAILED')
    }
  })
  try {
    await act(async () => {
      await h.hook().selectSession(session('s1')).catch(() => {})
    })
    await flush()
    assert.ok(calls > 1, 'the fixture never reached the call that throws')

    const before = transcript(h)
    await act(async () => {
      h.emit(chunk('some-other-session', 'SHOULD NOT APPEAR'))
    })
    await flush()
    assert.equal(
      transcript(h),
      before,
      'a rejection before the try left the switch accepting every session'
    )
  } finally {
    h.unmount()
    h.restore()
  }
})

test('A REFUSED SIGN-IN IS A FAILED ATTEMPT, NOT AN ABSENT ONE', async () => {
  // Every entry point checks the sign-in and returns before it would open a
  // switch. Doing nothing to the focus there is wrong in the quieter direction:
  // afterwards it reads as "nothing was ever chosen", which accepts every
  // session's events, and something was chosen and refused.
  const routes: [string, (g: Hook) => Promise<unknown>][] = [
    ['openChat', (g) => g.openChat()],
    ['openProject', (g) => g.openProject('/work/beta')],
    ['selectSession', (g) => g.selectSession(session('s1'))]
  ]

  for (const [name, run] of routes) {
    const h = await mountHook({
      getAuthStatus: async () => ({
        state: 'signed-out',
        authenticated: false,
        method: 'none',
        message: 'SIGN IN'
      })
    })
    try {
      await act(async () => {
        await run(h.hook())
      })
      await flush()
      assert.equal(h.hook().error, 'SIGN IN', `${name} did not refuse as the fixture intended`)

      const before = transcript(h)
      await act(async () => {
        h.emit(chunk('some-other-session', 'SHOULD NOT APPEAR'))
      })
      await flush()
      assert.equal(
        transcript(h),
        before,
        `after ${name} was refused the renderer accepted another session's stream`
      )
    } finally {
      h.unmount()
      h.restore()
    }
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

    // Checked here, with nothing in between. An intervening successful switch
    // settles the focus by itself and hides whether the failure closed it.
    const before = transcript(h)
    await act(async () => {
      h.emit(chunk('some-other-session', 'SHOULD NOT APPEAR'))
    })
    await flush()
    assert.equal(transcript(h), before, 'the switch was still accepting everything')

    // And the failure is not a dead end: choosing again still works.
    await selectInto(h, 's1')
    await act(async () => {
      h.emit(chunk('s1', 'BACK IN BUSINESS'))
    })
    await flush()
    assert.match(transcript(h), /BACK IN BUSINESS/)
  } finally {
    h.unmount()
    h.restore()
  }
})

test('A COMPLETED SWITCH NEVER LEAVES THE COMPOSER DISABLED', async () => {
  // `busy` is raised at the top of selectSession and lowered by exactly three
  // events: history-done, message-done and error. Nothing on the success path
  // lowers it, so a switch whose history-done never arrives would leave the
  // composer disabled for a session that is otherwise perfectly usable, with no
  // way back except switching again. `hydrating` is raised and lowered by the
  // same event and has had a safety net here for longer; this asserts the pair
  // stays even, because the one without the net is the one whose failure the
  // user cannot see a cause for.
  //
  // The fake bridge resolves loadSession without emitting history-done, which is
  // exactly the shape being guarded against, so this drives it by construction.
  const h = await mountHook()
  try {
    await selectInto(h, 's1')
    assert.equal(h.hook().busy, false, 'the session opened with its composer disabled')
    assert.equal(h.hook().hydrating, false, 'the session opened stuck on its skeleton')
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

// ── #66: what a resync hands over, and what it must not undo ────────────────

const resync = (
  sessionId: string,
  messages: ChatMessage[],
  extra: Partial<Extract<MainToRendererEvent, { type: 'session-resync' }>> = {}
): MainToRendererEvent => ({
  type: 'session-resync',
  sessionId,
  messages,
  usage: null,
  plan: null,
  source: 'local',
  hasOpenTurn: false,
  ...extra
})

const streaming = (id: string, text: string): ChatMessage =>
  ({ id, role: 'assistant', text, createdAt: 0, streaming: true }) as ChatMessage

test('A RESYNC PAINTS WHAT THE SESSION HOLDS', async () => {
  const h = await mountHook()
  try {
    await selectInto(h, 's1')
    await act(async () => {
      h.emit(resync('s1', [streaming('m1', 'the reply that arrived while you were away')]))
    })
    await flush()
    assert.match(transcript(h), /arrived while you were away/)
  } finally {
    h.unmount()
    h.restore()
  }
})

test('A TURN STILL RUNNING SURVIVES THE RESYNC AND KEEPS STREAMING INTO THE SAME MESSAGE', async () => {
  // The trap in this fix. `history-replace` stamps every message finished, which
  // is right for a conversation restored from disk and wrong here: the chunks
  // still to come would append to a message the UI has already drawn as done,
  // so the text would keep growing with no sign it was still being written.
  const h = await mountHook()
  try {
    await selectInto(h, 's1')
    await act(async () => {
      h.emit(resync('s1', [streaming('m1', 'half a ')]))
    })
    await flush()

    const mid = (h.hook().messages as ChatMessage[]).find((m) => m.id === 'm1')
    assert.equal(mid?.streaming, true, 'still streaming after the resync')

    await act(async () => {
      h.emit(chunk('s1', 'thought', 'm1'))
    })
    await flush()

    const after = h.hook().messages as ChatMessage[]
    assert.equal(after.length, 1, 'the chunk continued the message rather than starting a new one')
    assert.equal(after[0].text, 'half a thought')
  } finally {
    h.unmount()
    h.restore()
  }
})

test('A RESYNC CARRIES THE TOKEN COUNT AND PLAN, IT DOES NOT LEAVE THEM CLEARED', async () => {
  // Half of this bug is a correct transcript sitting next to the previous
  // conversation's numbers. Clearing them instead would swap one wrong answer
  // for a blank one, so the resync carries all three or it has not finished.
  const h = await mountHook()
  try {
    await selectInto(h, 's1')
    await act(async () => {
      h.emit(
        resync('s1', [streaming('m1', 'hello')], {
          usage: { sessionId: 's1', turns: 3, totals: { inputTokens: 12, outputTokens: 34 } } as never,
          plan: { messageId: 'm1', plan: { entries: [{ content: 'ship it', status: 'in_progress' }] } }
        })
      )
    })
    await flush()

    assert.equal((h.hook().usage as { turns: number } | null)?.turns, 3)
    const plan = h.hook().activePlan as { sessionId: string; entries: unknown[] } | null
    assert.equal(plan?.sessionId, 's1')
    assert.ok(plan && plan.entries.length > 0, 'the plan came back with the conversation')
  } finally {
    h.unmount()
    h.restore()
  }
})

test('A RESYNC FOR A SESSION THAT IS NOT ON SCREEN IS DROPPED', async () => {
  // The severe failure this event makes possible. It carries a WHOLE transcript,
  // so one accepted for the wrong session does not add a stray line — it replaces
  // the conversation the user is reading with a different one.
  const h = await mountHook()
  try {
    await selectInto(h, 's1')
    await act(async () => {
      h.emit(chunk('s1', 'the conversation I am reading'))
    })
    await flush()
    const before = transcript(h)

    await act(async () => {
      h.emit(resync('background-session', [streaming('bg1', 'SOMEBODY ELSE ENTIRELY')]))
    })
    await flush()

    assert.equal(transcript(h), before)
    assert.doesNotMatch(transcript(h), /SOMEBODY ELSE/)
  } finally {
    h.unmount()
    h.restore()
  }
})

test('A TURN STILL RUNNING COMES BACK AS RUNNING, SO IT CAN BE STOPPED', async () => {
  // Without this the reply streams in while the composer says nothing is
  // happening: no way to abort, and a second prompt accepted into a session that
  // already has a turn open.
  const h = await mountHook()
  try {
    await selectInto(h, 's1')
    assert.equal(h.hook().busy, false, 'nothing running to begin with')

    await act(async () => {
      h.emit(resync('s1', [streaming('m1', 'still writing')], { hasOpenTurn: true }))
    })
    await flush()
    assert.equal(h.hook().busy, true, 'the open turn came back with the transcript')

    await act(async () => {
      h.emit(resync('s1', [streaming('m1', 'still writing')], { hasOpenTurn: false }))
    })
    await flush()
    assert.equal(h.hook().busy, false, 'and a finished one does not leave it stuck')
  } finally {
    h.unmount()
    h.restore()
  }
})

test('THE RENDERER DOES NOT ASK MAIN TO FOCUS A SESSION MAIN JUST FOCUSED', async () => {
  // It used to, and the second ask was the problem: it landed after this switch
  // was confirmed, so a switch the user had abandoned mid-boot could still have
  // its transcript painted over the one on screen. Main focuses the session it
  // resolves before start/loadSession return, so there is nothing left to ask.
  let asked = 0
  const h = await mountHook({ focusSession: async () => void (asked += 1) })
  try {
    await selectInto(h, 's1')
    assert.equal(asked, 0)
  } finally {
    h.unmount()
    h.restore()
  }
})

// ── An abandoned switch commits nothing ─────────────────────────────────────

test('A SWITCH THE USER GAVE UP ON DOES NOT TAKE OVER THE ONE THEY OPENED', async () => {
  // Click a session that has to boot, lose patience, click one that is already
  // running. The slow one finishes a moment later and used to overwrite the
  // answer: `sessionId` became the session nobody was looking at, so the next
  // prompt went there while the folder and the transcript stayed here.
  //
  // `session-resync` made it worse than a mismatched id. It carries a whole
  // transcript, so the abandoned switch could repaint the conversation on screen
  // as a different one.
  let releaseSlow = (): void => {}
  const h = await mountHook({
    loadSession: async (id: unknown) => {
      if (id === 'slow') await new Promise<void>((resolve) => (releaseSlow = resolve))
      return { sessionId: id as string, restored: true }
    }
  })
  try {
    const slow = act(async () => {
      await h.hook().selectSession(session('slow'))
    })
    await flush()
    await act(async () => {
      await h.hook().selectSession(session('quick'))
    })
    await flush()
    await flush()
    await act(async () => {
      h.emit(chunk('quick', 'the conversation I opened'))
    })
    await flush()

    releaseSlow()
    await slow
    await flush()
    await flush()
    // Everything the abandoned switch would have committed, arriving late.
    await act(async () => {
      h.emit(resync('slow', [streaming('s1', 'THE ONE I GAVE UP ON')]))
      h.emit(chunk('slow', 'AND ITS REPLY'))
    })
    await flush()

    assert.equal(h.hook().sessionId, 'quick', 'the id stayed with the session on screen')
    assert.match(transcript(h), /the conversation I opened/)
    assert.doesNotMatch(transcript(h), /GAVE UP ON/)
    assert.doesNotMatch(transcript(h), /AND ITS REPLY/)
  } finally {
    h.unmount()
    h.restore()
  }
})
