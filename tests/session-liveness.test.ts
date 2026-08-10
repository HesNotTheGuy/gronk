import test from 'node:test'
import assert from 'node:assert/strict'
import { act, createElement } from 'react'
import { flush, mount } from './helpers/render'
import { installFakeBridge } from './helpers/gronk-api'
import { SessionRow } from '../src/components/SessionRow'
import type { ChatMessage, MainToRendererEvent, SessionInfo } from '../shared/types'

/**
 * A second session running while you look at another one.
 *
 * Two halves, tested separately because they fail differently. The hook half is
 * about attribution: a background session's liveness has to arrive while its
 * conversation does not. The row half is about whether a person can tell what a
 * session is doing and act on it without opening it.
 */

type Hook = Record<string, any>

const session = (id: string): SessionInfo =>
  ({ id, cwd: '/work/alpha', title: id, createdAt: 0, updatedAt: 0, surface: 'project' }) as SessionInfo

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
  return { hook: () => latest, emit: bridge.emit, calls: bridge.calls, unmount: view.unmount, restore: bridge.restore }
}

const transcript = (h: { hook: () => Hook }): string =>
  (h.hook().messages as ChatMessage[]).map((m) => m.text ?? '').join('')

// ── The signal reaches the sidebar without reaching the transcript ──────────

test('A BACKGROUND SESSION REPORTS WHAT IT IS DOING', async () => {
  const h = await mountHook()
  try {
    await act(async () => {
      await h.hook().selectSession(session('s1'))
    })
    await flush()

    await act(async () => {
      h.emit({ type: 'session-liveness', sessionId: 'other', liveness: 'working' })
    })
    await flush()

    assert.equal(h.hook().sessionLiveness.other, 'working')
  } finally {
    h.unmount()
    h.restore()
  }
})

test('LIVENESS IS READ BEFORE THE FOCUS GATE, or a background session is silent', async () => {
  // Every other event is dropped unless it belongs to the conversation on
  // screen. Liveness is the one thing that is ABOUT the sessions that are not,
  // so if it were read after that gate the sidebar could only ever describe the
  // session you are already looking at.
  const h = await mountHook()
  try {
    await act(async () => {
      await h.hook().selectSession(session('s1'))
    })
    await flush()

    const before = transcript(h)
    await act(async () => {
      h.emit({ type: 'session-liveness', sessionId: 'other', liveness: 'blocked' })
      h.emit({ type: 'message-chunk', sessionId: 'other', messageId: 'm1', text: 'BACKGROUND WORK' })
    })
    await flush()

    assert.equal(h.hook().sessionLiveness.other, 'blocked', 'the row did not learn anything')
    assert.equal(transcript(h), before, "the background session's reply reached this transcript")
  } finally {
    h.unmount()
    h.restore()
  }
})

test('a session that stops is no longer reported as live', async () => {
  const h = await mountHook()
  try {
    await act(async () => {
      h.emit({ type: 'session-liveness', sessionId: 'other', liveness: 'working' })
    })
    await flush()
    assert.equal(h.hook().sessionLiveness.other, 'working')

    await act(async () => {
      h.emit({ type: 'session-liveness', sessionId: 'other', liveness: null })
    })
    await flush()

    assert.equal('other' in h.hook().sessionLiveness, false, 'a stopped session still shows as live')
  } finally {
    h.unmount()
    h.restore()
  }
})

test('STOPPING A BACKGROUND SESSION NAMES IT', async () => {
  // Unnamed would stop whichever session is on screen, which is the opposite of
  // what the control is for.
  const stopped: unknown[] = []
  const h = await mountHook({
    stopAgent: async (id: unknown) => {
      stopped.push(id)
    }
  })
  try {
    await act(async () => {
      await h.hook().selectSession(session('s1'))
    })
    await flush()

    await act(async () => {
      await h.hook().stopSession('other')
    })
    await flush()

    assert.deepEqual(stopped, ['other'])
  } finally {
    h.unmount()
    h.restore()
  }
})

test('MAIN IS TOLD WHICH SESSION IS ON SCREEN WHEN ITS OWN ANSWER WOULD BE WRONG', async () => {
  // Main routes connection events by the focused session and answers
  // `getCwd()` from it, so the two have to agree. It normally needs no telling:
  // `start` and `loadSession` focus the session they resolve before returning,
  // which is why the renderer no longer asks after every switch — that second
  // ask repeated a full transcript repaint.
  //
  // One case is left where main's own answer is wrong. Click a session that has
  // to boot, then click another before it finishes: main focuses the slow one
  // last, so it ends up narrating a conversation nobody is looking at. The
  // abandoned switch is what puts main back.
  const focused: unknown[] = []
  let releaseSlow = (): void => {}
  let announceParked = (): void => {}
  // Resolves once the load is actually parked, which is several awaits into the
  // switch. Released before then, nothing is released and the wait never ends.
  const parked = new Promise<void>((r) => (announceParked = r))
  const h = await mountHook({
    focusSession: async (id: unknown) => {
      focused.push(id)
    },
    loadSession: async (id?: unknown) => {
      if (id === 'slow') {
        await new Promise<void>((resolve) => {
          releaseSlow = resolve
          announceParked()
        })
      }
      return { sessionId: (id as string) ?? 's1', restored: true }
    }
  })
  try {
    // One act scope: two overlapping ones deadlock.
    await act(async () => {
      const pending = h.hook().selectSession(session('slow'))
      await parked
      // The user gives up on it and opens one that is already running.
      await h.hook().selectSession(session('quick'))
      await flush()
      assert.deepEqual(focused, [], 'nothing to correct while only the fast one has landed')
      releaseSlow()
      await pending
    })
    await flush()
    await flush()

    assert.deepEqual(focused, ['quick'], 'main was put back on the session being shown')
  } finally {
    h.unmount()
    h.restore()
  }
})

test('answering a permission names the session that asked', async () => {
  // Request ids are chosen per CLI child and start at one, so two live sessions
  // use the same numbers for different requests.
  const answered: unknown[][] = []
  const h = await mountHook({
    respondPermission: async (...args: unknown[]) => {
      answered.push(args)
    }
  })
  try {
    await act(async () => {
      h.emit({
        type: 'permission-request',
        sessionId: 's1',
        request: { requestId: 1, sessionId: 's1', title: 'Write', kind: 'write' } as never
      })
    })
    await flush()
    assert.ok(h.hook().permission, 'the fixture did not raise a request')

    await act(async () => {
      await h.hook().respondPermission('allow-once')
    })
    await flush()

    assert.deepEqual(answered, [[1, 'allow-once', 's1']])
  } finally {
    h.unmount()
    h.restore()
  }
})

// ── The row ─────────────────────────────────────────────────────────────────

/**
 * The actions menu renders through a portal, so its items are in the document
 * rather than inside the mounted container.
 */
function menuLabels(): string[] {
  return [...document.querySelectorAll('.menu-pop [role="option"]')].map(
    (el) => el.querySelector('.menu-pop-name')?.textContent ?? el.textContent ?? ''
  )
}

const rowProps = {
  session: session('s1'),
  active: false,
  authenticated: true,
  meta: 'yesterday',
  onSelect: () => {},
  onRename: () => {},
  onArchive: () => {},
  onExport: () => {},
  onDelete: () => {}
}

test('A ROW SAYS WHICH OF THE THREE THINGS IT IS DOING', async () => {
  for (const [liveness, label] of [
    ['working', 'Working'],
    ['blocked', 'Needs you'],
    ['idle', 'Running']
  ] as const) {
    const view = await mount(createElement(SessionRow, { ...rowProps, liveness }))
    try {
      const dot = view.query(`.session-live-${liveness}`)
      assert.ok(dot, `${liveness} rendered no indicator`)
      assert.equal(dot?.getAttribute('aria-label'), label, `${liveness} is unreadable without sight`)
    } finally {
      view.unmount()
    }
  }
})

test('WORKING AND NEEDS-YOU ARE NOT THE SAME MARK', async () => {
  // The cost of blocking a background session is that it looks busy while it is
  // actually stuck. If these two rendered alike, the indicator would hide
  // exactly the state it exists to surface.
  const working = await mount(createElement(SessionRow, { ...rowProps, liveness: 'working' }))
  const blocked = await mount(createElement(SessionRow, { ...rowProps, liveness: 'blocked' }))
  try {
    assert.equal(working.query('.session-live-blocked'), null)
    assert.equal(blocked.query('.session-live-working'), null)
    assert.notEqual(
      working.query('.session-live')?.className,
      blocked.query('.session-live')?.className
    )
  } finally {
    working.unmount()
    blocked.unmount()
  }
})

test('a session that is not running shows no indicator at all', async () => {
  const view = await mount(createElement(SessionRow, { ...rowProps, liveness: null }))
  try {
    assert.equal(view.query('.session-live'), null)
  } finally {
    view.unmount()
  }
})

test('STOP IS OFFERED ONLY WHERE THERE IS SOMETHING TO STOP', async () => {
  const stops: number[] = []
  const live = await mount(
    createElement(SessionRow, { ...rowProps, liveness: 'working', onStop: () => stops.push(1) })
  )
  try {
    const menu = live.query('.menu-btn')
    assert.ok(menu, 'no actions menu on the row')
    await live.click(menu!)
    const labels = menuLabels()
    assert.ok(
      labels.some((l) => l.includes('Stop session')),
      `expected a stop item, got ${JSON.stringify(labels)}`
    )
  } finally {
    live.unmount()
  }

  const dead = await mount(createElement(SessionRow, { ...rowProps, liveness: null, onStop: () => {} }))
  try {
    const menu = dead.query('.menu-btn')
    await dead.click(menu!)
    const labels = menuLabels()
    assert.equal(
      labels.some((l) => l.includes('Stop session')),
      false,
      'a session with no agent offered to stop one'
    )
  } finally {
    dead.unmount()
  }
})

test('delete stays the last item once stop is added', async () => {
  // Stop sits above it so the destructive action keeps the position people
  // have learned.
  const view = await mount(
    createElement(SessionRow, { ...rowProps, liveness: 'idle', onStop: () => {} })
  )
  try {
    await view.click(view.query('.menu-btn')!)
    const labels = menuLabels().filter((l) => l.includes('Stop session') || l.includes('Delete'))
    assert.deepEqual(
      labels.map((l) => (l.includes('Stop') ? 'stop' : 'delete')),
      ['stop', 'delete']
    )
  } finally {
    view.unmount()
  }
})

test('A SWITCH STILL IN FLIGHT IS NOT RE-FOCUSED ON ITS BEHALF', async () => {
  // The abandoned switch puts main back on the session being shown, but only once
  // the newer switch has settled. One still in flight focuses main itself when it
  // lands, so asking on its behalf only repaints a transcript it is about to paint.
  const focused: unknown[] = []
  const held: Record<string, () => void> = {}
  const announce: Record<string, () => void> = {}
  const parked: Record<string, Promise<void>> = {}
  for (const id of ['slow', 'alsoSlow']) {
    parked[id] = new Promise<void>((r) => (announce[id] = r))
  }
  const h = await mountHook({
    focusSession: async (id: unknown) => {
      focused.push(id)
    },
    loadSession: async (id?: unknown) => {
      const sid = (id as string) ?? 's1'
      if (sid in parked) {
        await new Promise<void>((r) => {
          held[sid] = r
          announce[sid]()
        })
      }
      return { sessionId: sid, restored: true }
    }
  })
  try {
    await act(async () => {
      const first = h.hook().selectSession(session('slow'))
      await parked.slow
      const second = h.hook().selectSession(session('alsoSlow'))
      await parked.alsoSlow

      // The abandoned one finishes while the newer switch is STILL open.
      held.slow()
      await first
      assert.deepEqual(focused, [], 'the switch in flight was left to focus itself')

      held.alsoSlow()
      await second
    })
    await flush()
    await flush()
  } finally {
    h.unmount()
    h.restore()
  }
})
