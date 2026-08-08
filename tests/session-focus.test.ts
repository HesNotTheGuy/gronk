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
  assert.equal(failed.state, 'settled')
  assert.equal(belongsToFocus(failed, 'a'), true, 'the requested id is still the one on screen')
  assert.equal(belongsToFocus(failed, 'b'), false)
})

test('A FAILED START HOLDS NO IDS AND REFUSES ANYWAY', () => {
  // The pair below is the whole reason `settled` is a state rather than the
  // absence of `switching`. Both focuses hold an empty id list and they get
  // opposite answers.
  //
  // Opening a chat that throws leaves nothing on screen. Another session's
  // stream arriving would paint a conversation the user never opened and make
  // the failure look like it had worked.
  const failed = confirmSwitch(beginSwitch(null), null)
  assert.deepEqual(failed.ids, [])
  assert.equal(belongsToFocus(failed, 'anything'), false)
})

test('a renderer that has never chosen holds no ids and accepts', () => {
  // Same empty list, opposite answer. A window recreated while main still has a
  // live agent keeps receiving that agent's stream, and it is the only
  // conversation there is; refusing would leave the window blank beside a
  // working agent.
  assert.deepEqual(NO_FOCUS.ids, [])
  assert.equal(belongsToFocus(NO_FOCUS, 'a'), true)
  assert.equal(belongsToFocus(NO_FOCUS, undefined), true)
})

test('emptiness is never the thing being read', () => {
  // Guards the shape rather than one case: if the decision ever goes back to
  // asking whether the list is empty, these two stop disagreeing and the
  // failed-start hole reopens silently.
  const failed = confirmSwitch(beginSwitch(null), null)
  assert.equal(failed.ids.length, NO_FOCUS.ids.length)
  assert.notEqual(
    belongsToFocus(failed, 'x'),
    belongsToFocus(NO_FOCUS, 'x'),
    'two focuses holding no ids were treated the same'
  )
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
