import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { flush, mount } from './helpers/render'
import { installFakeBridge } from './helpers/gronk-api'
import { __freshUserData } from './stubs/electron'
import { parseSetModelResult } from '../electron/main/acp/client'
import type { SessionInfo } from '../shared/types'

/**
 * Changing the model from inside a conversation must keep the conversation:
 * `session/set_model` switches the running session in place, and a restart —
 * which is always a new, empty session — must never be the mechanism.
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
  return { hook: () => latest, calls: bridge.calls, unmount: view.unmount, restore: bridge.restore }
}

const session = (id: string, cwd = '/work/alpha'): SessionInfo =>
  ({ id, cwd, title: id, createdAt: 1, updatedAt: 1, surface: 'project' }) as SessionInfo

test('SWITCHING MODEL IN A LIVE SESSION DOES NOT START A NEW ONE', async () => {
  const h = await mountHook()
  try {
    await h.hook().selectSession(session('s1'))
    await flush()
    const before = h.hook().sessionId
    assert.ok(before, 'no session to switch inside of')

    const mark = h.calls.length
    await h.hook().changeModel('grok-4.5')
    await flush()
    const after = h.calls.slice(mark)

    assert.ok(after.includes('setModel'), `the model was not switched in place: ${after}`)
    // The regression, stated as itself: a restart is forceNew, so this call appearing
    // here IS the conversation being replaced.
    assert.ok(!after.includes('startAgent'), `the agent was restarted: ${after}`)
    assert.equal(h.hook().sessionId, before, 'the session changed underneath the switch')
  } finally {
    h.unmount()
    h.restore()
  }
})

test('THE PICKER FOLLOWS THE MODEL THE AGENT SETTLED ON', async () => {
  // Not the one that was asked for. The agent resolves what it is handed, and the
  // fake answers the way the CLI does — with the id it actually applied.
  const h = await mountHook({ setModel: async () => ({ model: 'grok-4.6' }) })
  try {
    await h.hook().selectSession(session('s1'))
    await flush()
    await h.hook().changeModel('grok-4.5')
    await flush()

    assert.equal(h.hook().sessionModel, 'grok-4.6')
  } finally {
    h.unmount()
    h.restore()
  }
})

test('SWITCHING A CONVERSATION DOES NOT REPIN THE APP', async () => {
  // How an install ends up on a model the CLI stopped defaulting to: one switch inside
  // one chat writes `settings.model`, every session after that is started with `-m`
  // naming it, and nothing ever says so. The switch is about this conversation.
  const h = await mountHook()
  try {
    await h.hook().selectSession(session('s1'))
    await flush()

    const mark = h.calls.length
    await h.hook().changeModel('grok-4.5')
    await flush()
    const after = h.calls.slice(mark)

    assert.ok(after.includes('setModel'), `the session was not switched: ${after}`)
    assert.ok(!after.includes('setSettings'), `the switch wrote the stored default: ${after}`)
  } finally {
    h.unmount()
    h.restore()
  }
})

test('WITH NOTHING RUNNING THERE IS NOTHING TO SWITCH', async () => {
  const h = await mountHook()
  try {
    const mark = h.calls.length
    await h.hook().changeModel('grok-4.5')
    await flush()
    const after = h.calls.slice(mark)

    assert.ok(!after.includes('setModel'), `it tried to switch a session that is not there: ${after}`)
  } finally {
    h.unmount()
    h.restore()
  }
})

test('THE STORED DEFAULT IS SET AND CLEARED FROM SETTINGS, AND TOUCHES NO SESSION', async () => {
  // Cleared is the shipped state and the escape from a pin: no `-m` is sent at all, so
  // the CLI uses its own default and a newer model arrives without anyone doing anything.
  const stored: unknown[] = []
  const h = await mountHook({
    setSettings: async (patch: Record<string, unknown>) => {
      stored.push(patch)
      return { permissionMode: 'default', alwaysApprove: false, alwaysApproveAck: false, theme: 'dark', ...patch }
    }
  })
  try {
    await h.hook().selectSession(session('s1'))
    await flush()

    const mark = h.calls.length
    await h.hook().setDefaultModel('grok-4.5')
    await h.hook().setDefaultModel('')
    await flush()

    assert.deepEqual(stored.slice(-2), [{ model: 'grok-4.5' }, { model: '' }])
    assert.ok(
      !h.calls.slice(mark).includes('setModel'),
      'changing the default reached into the running conversation'
    )
  } finally {
    h.unmount()
    h.restore()
  }
})

test('A REFUSED SWITCH IS NOT REPORTED AS ONE THAT HAPPENED', async () => {
  // The CLI can decline — an incompatible agent type, a failed harness rebuild. What
  // must not happen is the picker moving anyway, which would leave it naming a model
  // the conversation is not running on.
  const h = await mountHook({
    setModel: async () => {
      throw new Error('MODEL_SWITCH_REBUILD_FAILED')
    }
  })
  try {
    await h.hook().selectSession(session('s1'))
    await flush()
    await h.hook().changeModel('grok-4.5').catch(() => {})
    await flush()

    assert.notEqual(h.hook().sessionModel, 'grok-4.5', 'the picker moved on a refused switch')
  } finally {
    h.unmount()
    h.restore()
  }
})

/**
 * The reply shape is a serde-serialized Rust `Result` under `_meta.model`. Reading the
 * arm rather than assuming success is what makes the refusal test above possible at all.
 */
test('THE AGENT SAYS WHICH MODEL IT SETTLED ON, AND WHEN IT DID NOT', () => {
  assert.deepEqual(parseSetModelResult({ _meta: { model: { Ok: 'grok-4.5' } } }), {
    ok: true,
    modelId: 'grok-4.5'
  })

  const err = parseSetModelResult({ _meta: { model: { Err: 'agent type mismatch' } } })
  assert.equal(err.ok, false)
  assert.match(err.ok === false ? err.message : '', /agent type mismatch/)

  const nested = parseSetModelResult({ _meta: { model: { Err: { message: 'rebuild failed' } } } })
  assert.equal(nested.ok, false)
  assert.match(nested.ok === false ? nested.message : '', /rebuild failed/)

  // An empty Ok is not an answer, and neither is a reply with no model in it at all.
  for (const shape of [{ _meta: { model: { Ok: '' } } }, { _meta: {} }, {}, null, 'ok']) {
    assert.equal(parseSetModelResult(shape).ok, false, `accepted ${JSON.stringify(shape)}`)
  }
})
