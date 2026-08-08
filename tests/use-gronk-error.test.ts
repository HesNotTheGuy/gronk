import test from 'node:test'
import assert from 'node:assert/strict'
import { act, createElement } from 'react'
import { flush, mount } from './helpers/render'
import { installFakeBridge } from './helpers/gronk-api'
import type { MainToRendererEvent, SessionInfo } from '../shared/types'

/**
 * Whether the error banner is telling the truth right now.
 *
 * `app-error.test.ts` covers the rule. This covers the half that was actually
 * wrong: a handler that never asks the rule is a handler with no rule, and
 * TypeScript cannot see the difference. Every case here is driven through the
 * real hook, because the wiring is the thing under test.
 *
 * The app cannot be launched from an agent seat, so this is the only evidence
 * any of it runs.
 */

type Hook = Record<string, any>

interface Harness {
  hook: () => Hook
  emit: (event: MainToRendererEvent) => void
  unmount: () => void
  restore: () => void
}

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
  return {
    hook: () => latest,
    emit: bridge.emit,
    unmount: view.unmount,
    restore: bridge.restore
  }
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

/** Put an agent error on screen, with the connection up so sends are allowed. */
async function withAgentError(h: Harness): Promise<void> {
  await act(async () => {
    h.emit({ type: 'connection', state: 'ready' })
  })
  await act(async () => {
    h.emit({ type: 'error', message: 'AGENT BOOM' })
  })
  await flush()
  assert.equal(h.hook().error, 'AGENT BOOM', 'the fixture failed to put an error on screen')
}

async function run(h: Harness, fn: (g: Hook) => Promise<void> | void): Promise<void> {
  await act(async () => {
    await fn(h.hook())
  })
  await flush()
  await flush()
}

// ── A resolved failure stops being displayed ────────────────────────────────

test('A RESOLVED FAILURE STOPS BEING DISPLAYED: a good export takes the failed one down', async () => {
  // The reported bug, end to end. Exporting a session with no transcript puts
  // "nothing to export yet" on the banner. Exporting one that works used to
  // leave that message up next to the success banner naming the file it had
  // just written, so the window showed a failure and its own contradiction.
  let mode: 'empty' | 'ok' = 'empty'
  const h = await mountHook({
    exportTranscript: async () =>
      mode === 'empty' ? { ok: false, reason: 'empty' } : { ok: true, path: '/out/t.md' }
  })
  try {
    await run(h, (g) => g.exportSession('s1', 'md'))
    assert.match(h.hook().error, /Nothing to export yet/)

    mode = 'ok'
    await run(h, (g) => g.exportSession('s2', 'md'))

    assert.equal(h.hook().error, null, 'the failed export is still on screen after a good one')
    assert.deepEqual(
      h.hook().exportNotice,
      { path: '/out/t.md', format: 'md' },
      'the success banner should still be reporting where the file went'
    )
  } finally {
    h.unmount()
    h.restore()
  }
})

test('a second export attempt retires the first complaint even when the user cancels it', async () => {
  let mode: 'empty' | 'cancelled' = 'empty'
  const h = await mountHook({
    exportTranscript: async () =>
      mode === 'empty' ? { ok: false, reason: 'empty' } : { ok: false, reason: 'cancelled' }
  })
  try {
    await run(h, (g) => g.exportSession('s1', 'md'))
    assert.match(h.hook().error, /Nothing to export yet/)
    mode = 'cancelled'
    await run(h, (g) => g.exportSession('s2', 'md'))
    // The old message was about a different attempt, and a cancel is silent by
    // design, so the banner ends up empty rather than stale.
    assert.equal(h.hook().error, null)
  } finally {
    h.unmount()
    h.restore()
  }
})

// ── An error that is still true is not cleared by an unrelated click ────────

test('CANCELLING THE FOLDER DIALOG LEAVES THE ERROR UP: nothing superseded it', async () => {
  // The same rule from the other side, and the direction this used to get
  // wrong. `openProject` cleared on entry, so opening the picker and pressing
  // Escape silently discarded a failure that was still true and still the only
  // thing on screen explaining why nothing worked.
  const h = await mountHook({ selectFolder: async () => null })
  try {
    await withAgentError(h)
    await run(h, (g) => g.openProject())
    assert.equal(h.hook().error, 'AGENT BOOM', 'an abandoned attempt must not clear the banner')
  } finally {
    h.unmount()
    h.restore()
  }
})

test('choosing a folder does supersede it', async () => {
  const h = await mountHook({ selectFolder: async () => '/work/beta' })
  try {
    await withAgentError(h)
    await run(h, (g) => g.openProject())
    assert.equal(h.hook().error, null)
  } finally {
    h.unmount()
    h.restore()
  }
})

test('an export succeeding is not evidence the agent recovered', async () => {
  const h = await mountHook({
    exportTranscript: async () => ({ ok: true, path: '/out/t.md' })
  })
  try {
    await withAgentError(h)
    await run(h, (g) => g.exportSession('s1', 'md'))
    assert.equal(
      h.hook().error,
      'AGENT BOOM',
      'writing a transcript to disk says nothing about the agent'
    )
  } finally {
    h.unmount()
    h.restore()
  }
})

test('the agent coming up is not evidence the last export worked', async () => {
  const h = await mountHook({ exportTranscript: async () => ({ ok: false, reason: 'empty' }) })
  try {
    await run(h, (g) => g.exportSession('s1', 'md'))
    assert.match(h.hook().error, /Nothing to export yet/)
    await act(async () => {
      h.emit({ type: 'connection', state: 'ready' })
    })
    await flush()
    assert.match(
      h.hook().error,
      /Nothing to export yet/,
      'a connection reaching ready cleared an export failure'
    )
  } finally {
    h.unmount()
    h.restore()
  }
})

test('navigating away does not clear an error, because going Home fixes nothing', async () => {
  for (const [name, go] of [
    ['goHome', (g: Hook) => g.goHome()],
    ['goChat', (g: Hook) => g.goChat()],
    ['goProjects', (g: Hook) => g.goProjects()]
  ] as const) {
    const h = await mountHook()
    try {
      await withAgentError(h)
      await run(h, go)
      assert.equal(h.hook().error, 'AGENT BOOM', `${name} cleared an error it did not supersede`)
    } finally {
      h.unmount()
      h.restore()
    }
  }
})

// ── The four actions the banner is supposed to follow ───────────────────────

test('starting, restoring, chatting and sending all supersede an agent error', async () => {
  const cases: [string, (g: Hook) => Promise<void>][] = [
    ['sendPrompt', (g) => g.sendPrompt('hello')],
    ['selectSession', (g) => g.selectSession(session('s1'))],
    ['openChat', (g) => g.openChat()],
    ['openProject', (g) => g.openProject('/work/beta')]
  ]
  for (const [name, fn] of cases) {
    const h = await mountHook()
    try {
      await withAgentError(h)
      await run(h, fn)
      assert.equal(h.hook().error, null, `${name} left a superseded error on screen`)
    } finally {
      h.unmount()
      h.restore()
    }
  }
})

test('a failed send replaces the agent error rather than queueing behind it', async () => {
  const h = await mountHook({
    sendPrompt: async () => {
      throw new Error('SEND FAILED')
    }
  })
  try {
    await withAgentError(h)
    await run(h, (g) => g.sendPrompt('hello'))
    assert.equal(h.hook().error, 'SEND FAILED', 'the older error was still on the banner')
  } finally {
    h.unmount()
    h.restore()
  }
})

test('two errors close together leave only the newer one', async () => {
  const h = await mountHook()
  try {
    await act(async () => {
      h.emit({ type: 'error', message: 'FIRST' })
    })
    await act(async () => {
      h.emit({ type: 'error', message: 'SECOND' })
    })
    await flush()
    assert.equal(h.hook().error, 'SECOND')
  } finally {
    h.unmount()
    h.restore()
  }
})

test('an attempt refused before it starts supersedes nothing', async () => {
  // sendPrompt returns early when the connection is not ready. That guard runs
  // before the banner is touched on purpose: refusing to send is not an attempt.
  const h = await mountHook()
  try {
    await act(async () => {
      h.emit({ type: 'connection', state: 'error', error: 'AGENT DOWN' })
    })
    await flush()
    assert.equal(h.hook().error, 'AGENT DOWN')
    await run(h, (g) => g.sendPrompt('hello'))
    assert.equal(h.hook().error, 'AGENT DOWN', 'a refused send cleared the banner')
  } finally {
    h.unmount()
    h.restore()
  }
})

test('a failed sign-in reports itself and is not swallowed by the attempt it blocks', async () => {
  const h = await mountHook({
    getAuthStatus: async () => ({
      state: 'signed-out',
      authenticated: false,
      method: 'none',
      message: 'PLEASE SIGN IN'
    })
  })
  try {
    await run(h, (g) => g.openChat())
    assert.equal(h.hook().error, 'PLEASE SIGN IN')
  } finally {
    h.unmount()
    h.restore()
  }
})

test('Dismiss empties the banner whatever the error was about', async () => {
  const h = await mountHook({ exportTranscript: async () => ({ ok: false, reason: 'empty' }) })
  try {
    await run(h, (g) => g.exportSession('s1', 'md'))
    assert.match(h.hook().error, /Nothing to export yet/)
    await run(h, (g) => g.setError(null))
    assert.equal(h.hook().error, null)
  } finally {
    h.unmount()
    h.restore()
  }
})

test('the banner is a plain string, so the scope never reaches a component', async () => {
  const h = await mountHook()
  try {
    await withAgentError(h)
    assert.equal(typeof h.hook().error, 'string')
    await run(h, (g) => g.setError(null))
    assert.equal(h.hook().error, null)
  } finally {
    h.unmount()
    h.restore()
  }
})
