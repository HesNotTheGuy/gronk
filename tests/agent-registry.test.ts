import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { AgentRegistry, type ManagedSession } from '../electron/main/agent-manager'
import { livenessOf, mayForward } from '../electron/main/agent/session-liveness'
import type {
  ChatMessage,
  ConnectionState,
  MainToRendererEvent,
  PermissionDecision,
  SessionLiveness
} from '../shared/types'

/**
 * Keeping a session alive while you look at another one.
 *
 * This is the half of the feature a user sees, and it was the half nothing
 * could reach: a real session owns a CLI child, so no test can construct one.
 * The registry takes a factory for that reason, and what is driven here is the
 * orchestration: who is stopped, who is told what, and which events get out.
 */

interface Fake extends ManagedSession {
  readonly id: string
  stopped: number
  loads: number
  reemitted: number
  /** What this session holds, the way the real one holds `liveMessages`. */
  messages: ChatMessage[]
  emit(event: MainToRendererEvent): void
  /** Append a message and emit it, the way a streaming reply arrives. */
  say(text: string): void
  setState(state: ConnectionState): void
  setPending(pending: boolean): void
  setTurn(open: boolean): void
  /** Change the turn without emitting, the way the real session clears it. */
  setTurnSilently(open: boolean): void
}

function fakeSession(id: string, cwd = '/work/alpha'): Fake {
  let sink: ((event: MainToRendererEvent) => void) | null = null
  let state: ConnectionState = 'idle'
  let pending = false
  let turn = false
  let started = false

  const self: Fake = {
    id,
    stopped: 0,
    loads: 0,
    reemitted: 0,
    messages: [],
    emit: (event) => sink?.(event),
    say: (text) => {
      const messageId = `${id}-${self.messages.length}`
      self.messages.push({ id: messageId, role: 'assistant', text, createdAt: self.messages.length })
      sink?.({ type: 'message-chunk', sessionId: id, messageId, text })
    },
    setState: (next) => {
      state = next
      sink?.({ type: 'connection', state: next, ...(started ? { sessionId: id } : {}) })
    },
    setPending: (value) => {
      pending = value
      sink?.({ type: 'connection', state, sessionId: id })
    },
    setTurn: (value) => {
      turn = value
      sink?.({ type: 'connection', state, sessionId: id })
    },
    setTurnSilently: (value) => {
      turn = value
    },
    setWindow: () => {},
    setEmitSink: (next) => {
      sink = next
    },
    getConnectionState: () => state,
    getSessionId: () => (started ? id : null),
    getCwd: () => cwd,
    getSurface: () => 'project',
    getCurrentModel: () => undefined,
    getPermissionMode: () => 'default',
    livenessNow: () => livenessOf({ state, hasPendingPermission: pending, hasOpenTurn: turn }),
    reemitFrontPermission: () => {
      self.reemitted += 1
    },
    reemitViewState: () => {
      sink?.({
        type: 'session-resync',
        sessionId: id,
        messages: self.messages,
        usage: null,
        plan: null,
        source: 'local',
        hasOpenTurn: false,
        permissionMode: 'default'
      })
    },
    start: async () => {
      started = true
      state = 'ready'
      sink?.({ type: 'connection', state: 'ready', sessionId: id })
      return { sessionId: id }
    },
    loadSession: async () => {
      self.loads += 1
      started = true
      state = 'ready'
      sink?.({ type: 'connection', state: 'ready', sessionId: id })
      return { sessionId: id, restored: true }
    },
    stop: async () => {
      self.stopped += 1
      state = 'idle'
    },
    sendPrompt: async () => ({ messageId: 'm1' }),
    cancelPrompt: async () => {},
    respondPermission: () => {}
  }
  return self
}

/** A registry handing out the given sessions in order, and what reached the renderer. */
function harness(...sessions: Fake[]) {
  let i = 0
  const registry = new AgentRegistry(() => sessions[i++])
  const sent: MainToRendererEvent[] = []
  registry.setWindow({
    isDestroyed: () => false,
    webContents: { send: (_c: string, event: MainToRendererEvent) => sent.push(event) }
  } as never)
  return { registry, sent, sessions }
}

/**
 * Let the registry look at liveness again.
 *
 * It recomputes on a microtask rather than while an event is being emitted,
 * because a session emits the end of a turn and then clears it, and reading in
 * between sees the turn still open.
 */
const settle = () => Promise.resolve()

const liveness = (sent: MainToRendererEvent[]) =>
  sent.filter((e): e is Extract<MainToRendererEvent, { type: 'session-liveness' }> =>
    e.type === 'session-liveness'
  )

// ── The thing this whole branch is for ──────────────────────────────────────

test('STARTING A SECOND SESSION DOES NOT STOP THE FIRST', async () => {
  // The bug: clicking another session ended the work you walked away from.
  const a = fakeSession('a', '/work/alpha')
  const b = fakeSession('b', '/work/beta')
  const { registry } = harness(a, b)

  await registry.start('/work/alpha', { surface: 'project' })
  await registry.start('/work/beta', { surface: 'project' })

  assert.equal(a.stopped, 0, 'the session left behind was stopped')
  assert.equal(b.stopped, 0)
})

test('opening a session that is already live focuses it rather than reloading', async () => {
  // Reloading would tear down the running turn, which is the same loss by
  // another route.
  const a = fakeSession('a')
  const { registry } = harness(a)
  await registry.start('/work/alpha', { surface: 'project' })

  const before = a.loads
  const result = await registry.loadSession('a')

  assert.deepEqual(result, { sessionId: 'a', restored: true })
  assert.equal(a.stopped, 0)
  assert.equal(a.loads, before, 'a live session was reloaded, losing the turn in flight')
})

test('a second start for the same folder returns to the session already running', async () => {
  const a = fakeSession('a', '/work/alpha')
  const b = fakeSession('b', '/work/alpha')
  const { registry } = harness(a, b)

  const first = await registry.start('/work/alpha', { surface: 'project' })
  const second = await registry.start('/work/alpha', { surface: 'project' })

  assert.equal(second.sessionId, first.sessionId)
  assert.equal(b.stopped, 0, 'a second session was built and thrown away')
})

// ── Whose narration reaches the renderer ────────────────────────────────────

test('A BACKGROUND SESSION DOES NOT NARRATE OVER THE ONE ON SCREEN', async () => {
  // Connection events drive whether the composer is usable, and the renderer
  // accepts an unattributed one (which is what boot produces) unconditionally.
  const a = fakeSession('a', '/work/alpha')
  const b = fakeSession('b', '/work/beta')
  const { registry, sent } = harness(a, b)

  await registry.start('/work/alpha', { surface: 'project' })
  await registry.start('/work/beta', { surface: 'project' })
  registry.focus('a')
  sent.length = 0

  b.setState('starting')

  const connections = sent.filter((e) => e.type === 'connection')
  assert.deepEqual(connections, [], "a background session's connection state reached the renderer")
})

test('the focused session still narrates', async () => {
  const a = fakeSession('a')
  const { registry, sent } = harness(a)
  await registry.start('/work/alpha', { surface: 'project' })
  registry.focus('a')
  sent.length = 0

  a.setState('loading')

  assert.ok(
    sent.some((e) => e.type === 'connection' && e.state === 'loading'),
    'the session on screen went quiet'
  )
})

// ── Liveness ────────────────────────────────────────────────────────────────

test('a session reports what it is doing, and only when it changes', async () => {
  const a = fakeSession('a')
  const { registry, sent } = harness(a)
  await registry.start('/work/alpha', { surface: 'project' })

  sent.length = 0
  a.setTurn(true)
  a.setTurn(true)
  await settle()

  const reports = liveness(sent)
  assert.deepEqual(
    reports.map((r) => r.liveness),
    ['working'],
    'the same answer was reported twice'
  )
})

test('WAITING ON A PERSON IS NOT REPORTED AS WORKING', async () => {
  const a = fakeSession('a')
  const { registry, sent } = harness(a)
  await registry.start('/work/alpha', { surface: 'project' })
  a.setTurn(true)
  sent.length = 0

  a.setPending(true)
  await settle()

  assert.deepEqual(
    liveness(sent).map((r) => r.liveness),
    ['blocked']
  )
})

test('a stopped session is reported as no longer live', async () => {
  const a = fakeSession('a')
  const { registry, sent } = harness(a)
  await registry.start('/work/alpha', { surface: 'project' })
  a.setTurn(true)
  await settle()
  sent.length = 0

  await registry.stop('a')

  assert.ok(
    liveness(sent).some((r) => r.sessionId === 'a' && r.liveness === null),
    'the row would still show it as running'
  )
})

// ── Stopping, and what a blocked background session needs ───────────────────

test('STOPPING A NAMED SESSION LEAVES THE OTHERS ALONE', async () => {
  const a = fakeSession('a', '/work/alpha')
  const b = fakeSession('b', '/work/beta')
  const { registry, sent } = harness(a, b)
  await registry.start('/work/alpha', { surface: 'project' })
  await registry.start('/work/beta', { surface: 'project' })
  registry.focus('a')

  sent.length = 0
  await registry.stop('b')

  assert.equal(b.stopped, 1)
  assert.equal(a.stopped, 0, 'stopping a background session took the foreground down')

  // Every connection event the stop produced has to name the session it is
  // about. An unattributed one is accepted by whatever is on screen, so it
  // would read as the FOREGROUND going idle.
  const unnamed = sent.filter((e) => e.type === 'connection' && !e.sessionId)
  assert.deepEqual(unnamed, [], 'a stop emitted a connection state with nothing naming it')
  assert.ok(
    sent.some((e) => e.type === 'connection' && e.sessionId === 'b' && e.state === 'idle'),
    'nothing told the renderer that b had stopped'
  )
})

test('FOCUSING A BLOCKED SESSION PUTS ITS REQUEST BACK ON SCREEN', async () => {
  // A permission raised while the session was in the background was emitted and
  // dropped, because the renderer only accepts what belongs to the conversation
  // being shown. Without re-raising it, the agent waits forever behind a dialog
  // nobody can reach. Nothing is answered on the user's behalf; the same request
  // is simply asked again.
  const a = fakeSession('a', '/work/alpha')
  const b = fakeSession('b', '/work/beta')
  const { registry } = harness(a, b)
  await registry.start('/work/alpha', { surface: 'project' })
  await registry.start('/work/beta', { surface: 'project' })
  registry.focus('a')
  b.setPending(true)

  const before = b.reemitted
  registry.focus('b')

  assert.equal(b.reemitted, before + 1, 'a blocked background session stayed unreachable')
})

test('quitting stops every session, not just the one on screen', async () => {
  const a = fakeSession('a', '/work/alpha')
  const b = fakeSession('b', '/work/beta')
  const { registry } = harness(a, b)
  await registry.start('/work/alpha', { surface: 'project' })
  await registry.start('/work/beta', { surface: 'project' })

  await registry.stopAll()

  assert.equal(a.stopped, 1)
  assert.equal(b.stopped, 1)
})

test('A DATA MOVE IS REFUSED WHILE ANY SESSION IS LIVE, not just the focused one', async () => {
  // The question is whether a child process still has these files open, and a
  // background session holds them just as firmly. Driven with the FOCUSED
  // session idle, so answering for the focused one alone gives the wrong answer.
  const a = fakeSession('a', '/work/alpha')
  const b = fakeSession('b', '/work/beta')
  const { registry } = harness(a, b)
  await registry.start('/work/alpha', { surface: 'project' })
  await registry.start('/work/beta', { surface: 'project' })
  registry.focus('a')
  a.setState('idle')

  assert.equal(registry.isAnyBusy(), true, 'a live background session was not counted')

  await registry.stopAll()
  assert.equal(registry.isAnyBusy(), false)
})

// ── The two states where "the foreground session" stops having an answer ────

test('A SESSION THAT FINISHES A TURN GOES BACK TO IDLE', async () => {
  // A session emits the end of a turn and THEN clears it, both synchronously.
  // Reading liveness during that emit sees a turn still open, and if nothing
  // looks again the row says working for the rest of the session's life, which
  // leaves one of the two states unreachable and makes a blocked row impossible
  // to pick out.
  const a = fakeSession('a')
  const { registry, sent } = harness(a)
  await registry.start('/work/alpha', { surface: 'project' })
  a.setTurn(true)
  await settle()
  sent.length = 0

  // Exactly the order the real session uses.
  a.emit({ type: 'message-done', sessionId: 'a', messageId: 'm1' })
  a.setTurnSilently(false)
  await settle()

  assert.deepEqual(
    liveness(sent).map((r) => r.liveness),
    ['idle'],
    'the session stayed reported as working after its turn ended'
  )
})

test('STOPPING THE SESSION ON SCREEN DOES NOT WIDEN WHAT MAY BE LISTED', async () => {
  // getCwd() answers "which folder is the app looking at". A null from it means
  // "no project open" to the project-file listing, which reads that as
  // permission to enumerate anywhere, which is right while the folder picker is
  // choosing a project, and wrong once a session has been stopped with its
  // project still on screen. Stopping used to be impossible, so the two states
  // never had to be told apart.
  const a = fakeSession('a', '/work/alpha')
  const { registry } = harness(a)
  await registry.start('/work/alpha', { surface: 'project' })
  registry.focus('a')
  assert.equal(registry.getCwd(), '/work/alpha')

  await registry.stop('a')

  assert.equal(
    registry.getCwd(),
    '/work/alpha',
    'stopping the focused session left no folder to confine anything to'
  )
})

test('a renderer that has opened nothing still reports no folder', async () => {
  // The other half: the folder picker genuinely runs before any project exists,
  // and narrowing that would break opening one at all.
  const { registry } = harness(fakeSession('a'))
  assert.equal(registry.getCwd(), null)
})

// ── The two pure rules ──────────────────────────────────────────────────────

test('liveness is null unless the agent is actually up', () => {
  for (const state of ['idle', 'starting', 'error', 'stopped'] as ConnectionState[]) {
    assert.equal(
      livenessOf({ state, hasPendingPermission: true, hasOpenTurn: true }),
      null,
      `${state} reported as live`
    )
  }
})

test('BLOCKED BEATS WORKING, because only one of them needs a person', () => {
  const blocked: SessionLiveness | null = livenessOf({
    state: 'ready',
    hasPendingPermission: true,
    hasOpenTurn: true
  })
  assert.equal(blocked, 'blocked')
  assert.equal(
    livenessOf({ state: 'ready', hasPendingPermission: false, hasOpenTurn: true }),
    'working'
  )
  assert.equal(
    livenessOf({ state: 'ready', hasPendingPermission: false, hasOpenTurn: false }),
    'idle'
  )
})

test('only connection events are withheld from a background session', () => {
  const chunk: MainToRendererEvent = {
    type: 'message-chunk',
    sessionId: 'b',
    messageId: 'm',
    text: 'x'
  }
  // Everything else already names its session and the renderer drops what is
  // not its own, so withholding it here would be a second place to get the same
  // rule wrong.
  assert.equal(mayForward(chunk, false), true)
  assert.equal(mayForward({ type: 'connection', state: 'ready', sessionId: 'b' }, false), false)
  assert.equal(mayForward({ type: 'connection', state: 'ready', sessionId: 'b' }, true), true)
})

const _decision: PermissionDecision = 'allow-once'
void _decision

// ── #66: coming back to a session shows what it says ────────────────────────

test('RETURNING TO A BACKGROUND SESSION SHOWS ITS REPLY, NOT WHAT WAS ON SCREEN WHEN YOU LEFT', async () => {
  // The bug: the renderer drops events for a session it is not showing, which is
  // right, and focus() re-sent the connection state and any pending permission
  // but never the messages. So a reply that arrived while you were in another tab
  // was on disk and in memory and simply not on screen — an empty assistant
  // bubble that never filled until the app was restarted.
  const a = fakeSession('a', '/work/alpha')
  const b = fakeSession('b', '/work/beta')
  const { registry, sent } = harness(a, b)

  await registry.start('/work/alpha', { surface: 'project' })
  a.say('half a thought')

  await registry.start('/work/beta', { surface: 'project' })
  b.say('something else entirely')

  // Back to A. Its reply finished while B was in front.
  a.say('half a thought, finished')
  sent.length = 0
  await registry.loadSession('a', '/work/alpha')

  const replaced = sent.filter(
    (e): e is Extract<MainToRendererEvent, { type: 'session-resync' }> =>
      e.type === 'session-resync'
  )
  assert.equal(replaced.length, 1, 'focusing a live session re-sends its transcript')
  assert.equal(replaced[0].sessionId, 'a')
  assert.deepEqual(
    replaced[0].messages.map((m) => m.text),
    ['half a thought', 'half a thought, finished'],
    "A's transcript, not B's, and not the half-painted version from the moment of the switch"
  )
})

// Nothing here asserts that the session is not restarted to resync it: the early
// return that guarantees it is already covered by 'opening a session that is
// already live focuses it rather than reloading' above, and a second copy of that
// assertion would only look like extra coverage.

// ── A composer lock a person cannot undo ────────────────────────────────────

test('THE RESYNC REPORTS A TURN ONLY WHILE A PROMPT IS ACTUALLY OUTSTANDING', async () => {
  // `hasOpenTurn` came from `activeMessageId`, which answers a looser question:
  // any chunk with no message id of its own adopts it, so a chunk arriving after
  // a turn has settled leaves it set with nothing left to clear it. The sidebar's
  // working dot recovers on the next turn. The composer does not: the resync turns
  // that flag straight into a disabled Send with no turn coming to re-enable it.
  //
  // This pins the field the two now read, not the wiring — nothing in the suite
  // constructs an AgentManager, so the wiring is checked by reading it.
  const source = readFileSync(new URL('../electron/main/agent-manager.ts', import.meta.url), 'utf8')

  const resync = source.slice(source.indexOf('reemitViewState()'))
  const resyncBody = resync.slice(0, resync.indexOf('\n  }'))
  assert.match(resyncBody, /hasOpenTurn: this\.promptInFlight/)
  assert.doesNotMatch(resyncBody, /hasOpenTurn: this\.activeMessageId/)

  // Every field comes off the session. The fake in this file supplies its own
  // reemitViewState, so the assertions elsewhere prove the registry CALLS this and
  // nothing about what it sends; reading the body is the only check there is.
  for (const field of [
    /messages: this\.liveMessages/,
    /usage: this\.usage\.snapshot\(\)/,
    /plan: this\.lastPlan/,
    /source: this\.lastHistorySource/
  ]) {
    assert.match(resyncBody, field)
  }

  // Set with the prompt, cleared on both the way a turn ends and the way it fails,
  // and again wherever the process is torn down. Four, or one of them strands it.
  assert.equal((source.match(/this\.promptInFlight = false/g) ?? []).length, 4)
  assert.equal((source.match(/this\.promptInFlight = true/g) ?? []).length, 1)
})
// Nothing here pins the order of the assignment and the lookup in `focus`. A
// stopped session left as `focusedId` was raised in review as widening what the
// renderer may list, and it does not: `lastFocusedCwd` is held past a session's
// death for exactly that reason, with the reasoning written above it, so
// `getCwd()` never goes null and nothing reads it as "no project is open".


test('STARTING AND RESUMING BOTH HAND THE RENDERER THE SESSION THEY RESOLVED', async () => {
  // The renderer stopped asking main to focus after a switch, because start and
  // loadSession focus what they resolve before returning. Nothing pinned that, so
  // deleting either focus left the renderer with no transcript and no test to say
  // so.
  const a = fakeSession('a', '/work/alpha')
  const b = fakeSession('b', '/work/beta')
  const { registry, sent } = harness(a, b)

  await registry.start('/work/alpha', { surface: 'project' })
  assert.ok(
    sent.some((e) => e.type === 'session-resync' && e.sessionId === 'a'),
    'starting focused the session it resolved'
  )

  sent.length = 0
  await registry.loadSession('b', '/work/beta')
  assert.ok(
    sent.some((e) => e.type === 'session-resync' && e.sessionId === 'b'),
    'resuming focused the session it resolved'
  )
})

test('A FAILED RESUME PUTS THE CONVERSATION BACK BEFORE ANYTHING READS IT', async () => {
  // When session/load fails, the fallback restarts the agent so the session stays
  // usable — and `start` empties the in-memory transcript. Without putting it back,
  // the resync on focus hands the renderer an empty conversation under a banner
  // promising the history is still there, and every re-click empties it again.
  //
  // Read rather than driven: nothing in the suite constructs an AgentManager, so
  // this pins the line's presence and its position relative to the banner it makes
  // true. Deleting it leaves every other test in the suite green.
  const source = readFileSync(new URL('../electron/main/agent-manager.ts', import.meta.url), 'utf8')
  const fallback = source.slice(source.indexOf('// Fall back: start new live session'))
  const body = fallback.slice(0, fallback.indexOf('} catch (err2)'))

  const restore = body.indexOf('this.liveMessages = plan.messages')
  const banner = body.indexOf('Your chat history is still shown here')
  assert.notEqual(restore, -1, 'the fallback restores the cached conversation')
  assert.notEqual(banner, -1, 'the banner this makes true is still here')
  assert.ok(restore < banner, 'and the restore happens before it')
})
