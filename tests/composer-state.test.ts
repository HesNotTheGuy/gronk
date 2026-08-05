import test from 'node:test'
import assert from 'node:assert/strict'
import { composerPermissions, composerPlaceholder } from '../src/lib/composer-state'
import type { ConnectionState } from '../shared/types'

/**
 * What the composer permits at each connection state.
 *
 * The reported problem was that reopening a session felt broken because you
 * could not type. It was not slowness: `disabled={connection !== 'ready'}`
 * reached the textarea, so restoring a session switched the keyboard off on
 * purpose.
 *
 * The decision pinned here is that typing and sending are different acts. These
 * tests exist to stop the next person collapsing them back into one flag, which
 * is what the code looked like before and reads as tidier.
 */

const base = { connection: 'ready' as ConnectionState, hydrating: false, busy: false, hasContent: true }
const at = (over: Partial<typeof base> = {}) => composerPermissions({ ...base, ...over })

const RESTORING: ConnectionState[] = ['starting', 'loading']
const DOWN: ConnectionState[] = ['error', 'stopped']

test('THE BUG: a session restoring does not switch the keyboard off', () => {
  for (const connection of RESTORING) {
    assert.equal(at({ connection }).canType, true, `${connection} blocked typing`)
  }
  assert.equal(at({ connection: 'ready', hydrating: true }).canType, true, 'hydrating blocked typing')
})

test('typing is allowed even when the agent is down, so you can compose a retry', () => {
  for (const connection of DOWN) {
    assert.equal(at({ connection }).canType, true, `${connection} blocked typing`)
  }
})

test('idle is the one state with nowhere to type', () => {
  // No session open and none opening. The placeholder is the only thing telling
  // the user to sign in or pick a session, so the box stays off.
  assert.equal(at({ connection: 'idle' }).canType, false)
  // ...unless a restore has started but the connection has not moved yet, which
  // is exactly the window the user is trying to type in.
  assert.equal(at({ connection: 'idle', hydrating: true }).canType, true)
})

test('send stays gated everywhere typing is newly allowed', () => {
  // The other half of the decision. Loosening typing must not loosen sending:
  // there is nothing to send to yet.
  for (const connection of [...RESTORING, ...DOWN]) {
    assert.equal(at({ connection }).canSend, false, `${connection} allowed send`)
  }
  assert.equal(at({ connection: 'ready', hydrating: true }).canSend, false, 'hydrating allowed send')
})

test('attach and the agent settings stay gated with send, not with typing', () => {
  // Attach reads files for a prompt that cannot go. Model and permission mode
  // are agent boot arguments: switching model restarts the agent and changing
  // the mode rewrites the argv the CLI is launched with, so doing either
  // mid-restore races the boot it would be reconfiguring.
  for (const connection of [...RESTORING, ...DOWN]) {
    const p = at({ connection })
    assert.equal(p.canAttach, false, `${connection} allowed attach`)
    assert.equal(p.canChangeAgentSettings, false, `${connection} allowed a settings change`)
  }
})

test('when ready, everything is on', () => {
  const p = at()
  assert.deepEqual(p, { canType: true, canSend: true, canAttach: true, canChangeAgentSettings: true })
})

test('send still respects busy and an empty box', () => {
  // Pre-existing behaviour that the rewrite must not drop: these were part of
  // the old inline expression on the Send button.
  assert.equal(at({ busy: true }).canSend, false, 'sent while a turn was in flight')
  assert.equal(at({ hasContent: false }).canSend, false, 'sent an empty prompt')
  // ...and neither of them touches typing.
  assert.equal(at({ busy: true, hasContent: false }).canType, true)
})

test('the placeholder says why send is grey while the box accepts text', () => {
  // Without this the composer just looks broken in a new way: you can type and
  // nothing happens on Enter, with no explanation on screen.
  const restoring = composerPermissions({ ...base, connection: 'loading', hydrating: true })
  assert.match(
    composerPlaceholder(restoring, { hydrating: true, cwd: '/p' }),
    /restoring/i
  )
  assert.match(
    composerPlaceholder(restoring, { hydrating: true, cwd: '/p' }),
    /typing/i,
    'does not tell the user they may type'
  )
})

test('the idle placeholder still asks the user to sign in', () => {
  const idle = composerPermissions({ ...base, connection: 'idle' })
  assert.match(composerPlaceholder(idle, { hydrating: false, cwd: null }), /Sign in/i)
})

test('the ready placeholder still names the surface', () => {
  const ready = composerPermissions(base)
  assert.match(composerPlaceholder(ready, { hydrating: false, cwd: '/p' }), /project agent/i)
  assert.match(composerPlaceholder(ready, { hydrating: false, cwd: null }), /Message Grok/i)
})
