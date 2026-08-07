import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NO_FOCUS,
  beginSwitch,
  belongsToFocus,
  confirmSwitch,
  sessionIdOf
} from '../src/lib/session-focus'
import type { MainToRendererEvent } from '../shared/types'

/**
 * Which session an event belongs to.
 *
 * The rule is only interesting in the window where the answer is unknown, so
 * most of this is about what happens between asking for a session and being
 * told which one you got.
 */

test('an event that names no session is always the app talking', () => {
  const settled = confirmSwitch(beginSwitch('a'), 'a')
  assert.equal(belongsToFocus(settled, undefined), true)
})

test('a settled focus accepts its own session and refuses another', () => {
  const settled = confirmSwitch(beginSwitch('a'), 'a')
  assert.equal(belongsToFocus(settled, 'a'), true)
  assert.equal(belongsToFocus(settled, 'b'), false)
})

test('THE SWITCH WINDOW ACCEPTS ANYTHING, because the id is not known yet', () => {
  // The failure this exists to prevent: a load can resolve to a different id
  // than the one clicked, and the history events naming it arrive before the
  // answer does. A plain equality test drops exactly the events that paint the
  // conversation.
  const switching = beginSwitch('a')
  assert.equal(belongsToFocus(switching, 'a'), true)
  assert.equal(belongsToFocus(switching, 'something-else-entirely'), true)
})

test('confirming closes the window', () => {
  const settled = confirmSwitch(beginSwitch('a'), 'a')
  assert.equal(belongsToFocus(settled, 'b'), false, 'the window stayed open after an answer')
})

test('THE REQUESTED ID SURVIVES A LOAD THAT RESOLVES TO A DIFFERENT ONE', () => {
  // Both are the conversation on screen. Events naming the clicked id can
  // already be in flight, and the id the agent settled on does not make them
  // stop belonging.
  const settled = confirmSwitch(beginSwitch('clicked'), 'resolved')
  assert.equal(belongsToFocus(settled, 'clicked'), true)
  assert.equal(belongsToFocus(settled, 'resolved'), true)
  assert.equal(belongsToFocus(settled, 'other'), false)
})

test('a switch with no id yet still closes when one is confirmed', () => {
  // Opening a project starts an agent whose session id only exists after boot.
  const settled = confirmSwitch(beginSwitch(null), 'booted')
  assert.equal(belongsToFocus(settled, 'booted'), true)
  assert.equal(belongsToFocus(settled, 'other'), false)
})

test('CONFIRMING NOTHING STILL CLOSES THE WINDOW, so a failure cannot leave it open', () => {
  // A start that throws has no id coming. Left open, the switch would go on
  // accepting every session's events for the rest of the session.
  const failed = confirmSwitch(beginSwitch('a'), null)
  assert.equal(failed.awaiting, false)
  assert.equal(belongsToFocus(failed, 'a'), true, 'the requested id is still the one on screen')
  assert.equal(belongsToFocus(failed, 'b'), false)
})

test('a failed start with no requested id falls back to accepting, not rejecting', () => {
  // Nothing was ever established, so there is no conversation on screen for a
  // stray event to be mistaken for.
  const failed = confirmSwitch(beginSwitch(null), null)
  assert.equal(belongsToFocus(failed, 'anything'), true)
})

test('A RENDERER THAT HAS SELECTED NOTHING ACCEPTS EVERYTHING', () => {
  // Not the same as one that has selected something else. A window recreated
  // while main still has a live agent keeps receiving that agent's stream, and
  // it is the only conversation there is; rejecting by default would blank it.
  assert.equal(belongsToFocus(NO_FOCUS, 'a'), true)
  assert.equal(belongsToFocus(NO_FOCUS, undefined), true)
})

test('confirming the same id twice does not duplicate it', () => {
  const once = confirmSwitch(beginSwitch('a'), 'a')
  const twice = confirmSwitch(once, 'a')
  assert.deepEqual(twice.ids, ['a'])
})

test('a new switch replaces the previous focus rather than adding to it', () => {
  const first = confirmSwitch(beginSwitch('a'), 'a')
  const second = confirmSwitch(beginSwitch('b'), 'b')
  assert.equal(belongsToFocus(second, 'a'), false, 'the session left behind is still accepted')
  assert.equal(belongsToFocus(second, 'b'), true)
  assert.deepEqual(first.ids, ['a'], 'the previous focus was mutated')
})

// ── Reading the id off an event ─────────────────────────────────────────────

test('the session id is read from whichever events carry one', () => {
  const chunk: MainToRendererEvent = {
    type: 'message-chunk',
    sessionId: 's1',
    messageId: 'm1',
    text: 'hi'
  }
  assert.equal(sessionIdOf(chunk), 's1')
})

test('connection and permission events now carry one, and are undefined before a session exists', () => {
  assert.equal(sessionIdOf({ type: 'connection', state: 'ready', sessionId: 's1' }), 's1')
  assert.equal(sessionIdOf({ type: 'connection', state: 'starting' }), undefined)
  assert.equal(sessionIdOf({ type: 'permission-request', request: null, sessionId: 's1' }), 's1')
  assert.equal(sessionIdOf({ type: 'permission-request', request: null }), undefined)
})

test('app-wide events have no session id at all', () => {
  assert.equal(sessionIdOf({ type: 'models', models: [] }), undefined)
  assert.equal(
    sessionIdOf({ type: 'preview-status', running: false, url: null, cwd: null }),
    undefined
  )
})
