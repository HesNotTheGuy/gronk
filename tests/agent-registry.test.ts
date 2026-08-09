import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentRegistry, type ManagedSession } from '../electron/main/agent-manager'
import { livenessOf, mayForward } from '../electron/main/agent/session-liveness'
import type {
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
  emit(event: MainToRendererEvent): void
  setState(state: ConnectionState): void
  setPending(pending: boolean): void
  setTurn(open: boolean): void
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
    emit: (event) => sink?.(event),
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
    setWindow: () => {},
    setEmitSink: (next) => {
      sink = next
    },
    getConnectionState: () => state,
    getSessionId: () => (started ? id : null),
    getCwd: () => cwd,
    getSurface: () => 'project',
    getCurrentModel: () => undefined,
    livenessNow: () => livenessOf({ state, hasPendingPermission: pending, hasOpenTurn: turn }),
    reemitFrontPermission: () => {
      self.reemitted += 1
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
