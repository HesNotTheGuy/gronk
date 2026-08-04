import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ARRIVED_EPS,
  isScrollbarClick,
  keyIntent,
  nextStick,
  touchIntent,
  wheelIntent,
  type StickCause
} from '../src/lib/scroll-stick'

/**
 * Whether the transcript stays pinned to the bottom while a reply streams.
 *
 * The bug these exist for, reported from real use: with a reply streaming,
 * scroll up about 40px and the next token drags you back to the bottom. Scrolling
 * up 300px behaved correctly, which is why 0.1.8 was believed to have fixed it.
 * One threshold of 120px was used for both leaving and returning, so a 40px
 * scroll still counted as "near the bottom" and got re-pinned.
 *
 * The decision lives in a pure function because the hook that owns it needs a
 * DOM and `node --test` has none, the same split as context-menu-items.ts. What
 * is NOT covered here is the wiring: which listeners are attached, and that the
 * flag reaches the effect that moves the viewport. Only the decision is.
 */

/** Reads as the sentence being asserted, since every case is the same shape. */
function decide(cause: StickCause, distanceFromBottom: number, sticking: boolean): boolean {
  return nextStick({ cause, distanceFromBottom, sticking })
}

test('a small scroll up near the bottom detaches, which is the reported bug', () => {
  // The exact case: pinned, streaming, user scrolls up roughly 40px. Under the
  // old shared 120px threshold this stayed true and the next token yanked back.
  assert.equal(decide('gesture-up', 0, true), false, 'the gesture itself must detach')
  assert.equal(decide('scroll', 40, true), false, 'and 40px from the end is not the end')
})

test('the gesture is honoured before the viewport has moved', () => {
  // An intent event fires BEFORE the scroll, so at that instant the distance
  // still describes where the user was. Consulting it is what made the old
  // version ignore every scroll that started from the bottom.
  for (const distance of [0, 1, 40, 119, 500]) {
    assert.equal(
      decide('gesture-up', distance, true),
      false,
      `a gesture at ${distance}px from the bottom must detach`
    )
  }
})

test('a large scroll up detaches too, which is all 0.1.8 ever fixed', () => {
  assert.equal(decide('gesture-up', 0, true), false)
  assert.equal(decide('scroll', 300, true), false)
})

test('scrolling toward the end never detaches on its own', () => {
  // A wheel flick downward while already at the bottom produces no scroll event,
  // so nothing would ever restore the flag. Detaching here would stop
  // auto-scroll from a gesture that moved nothing: the same bug, new hat.
  assert.equal(decide('gesture-down', 0, true), true)
  assert.equal(decide('gesture-down', 500, true), true)
  // It does not re-attach either. Arriving is the scroll handler's to decide.
  assert.equal(decide('gesture-down', 0, false), false)
})

test('keyboard scrolling counts, at any distance', () => {
  // Before this, PageUp fired neither wheel nor touchmove, so the only handler
  // that saw it was the one that re-pinned. Keyboard users were fought at every
  // distance rather than only under 120px.
  assert.equal(keyIntent('PageUp', false), 'gesture-up')
  assert.equal(keyIntent('Home', false), 'gesture-up')
  assert.equal(keyIntent('ArrowUp', false), 'gesture-up')
  assert.equal(keyIntent('PageDown', false), 'gesture-down')
  assert.equal(keyIntent('End', false), 'gesture-down')
  assert.equal(keyIntent('ArrowDown', false), 'gesture-down')

  // Space pages down, and up with shift held.
  assert.equal(keyIntent(' ', false), 'gesture-down')
  assert.equal(keyIntent(' ', true), 'gesture-up')

  const decision = keyIntent('PageUp', false)
  assert.ok(decision)
  assert.equal(decide(decision, 5, true), false, 'PageUp from 5px out must still detach')
})

test('keys that do not scroll are not scroll intent', () => {
  // The listener sits on the transcript. Reading every key as intent would
  // detach on a copy shortcut or on find-in-page.
  for (const key of ['a', 'Enter', 'Escape', 'Tab', 'Control', 'F5', 'c']) {
    assert.equal(keyIntent(key, false), null, `${key} is not a scrolling key`)
    assert.equal(keyIntent(key, true), null, `shift+${key} is not a scrolling key`)
  }
})

test('arriving at the bottom re-attaches, and being close to it does not', () => {
  assert.equal(decide('scroll', 0, false), true, 'arrival re-attaches')
  assert.equal(decide('scroll', ARRIVED_EPS, false), true, 'the epsilon is inclusive')
  assert.equal(decide('scroll', ARRIVED_EPS + 1, false), false, 'just outside is not arrival')
  // The old threshold, kept as a case on purpose: this is what "near enough"
  // used to mean and it is the whole reason the bug existed.
  assert.equal(decide('scroll', 119, false), false, 'near the bottom is not at the bottom')
})

test('the epsilon is rounding tolerance, not a comfort zone', () => {
  // Every pixel here is a distance a user can deliberately scroll and be dragged
  // back from. Fractional layout means it cannot be zero; it must stay far below
  // anything a person can aim at.
  assert.ok(ARRIVED_EPS > 0, 'sub-pixel layout means an exact zero is not reachable')
  assert.ok(ARRIVED_EPS <= 4, `ARRIVED_EPS is ${ARRIVED_EPS}, large enough to swallow a real scroll`)
})

test('a programmatic scroll must NOT be mistaken for the user arriving', () => {
  // The trap. `el.scrollTop = el.scrollHeight` fires a scroll event of its own,
  // and it always lands at distance zero. Answering from the distance would let
  // every stream tick re-pin a transcript the user had scrolled away from,
  // rebuilding the same race with different numbers.
  assert.equal(decide('programmatic', 0, false), false, 'the app moving the viewport is not consent')
  assert.equal(decide('programmatic', 0, true), true, 'and it does not detach an already pinned one')
  assert.equal(decide('programmatic', 400, false), false)
})

test('a detached transcript stays detached across a whole stream', () => {
  // The sequence the user actually performs, run end to end: pinned, one gesture
  // up, then tokens keep arriving. Each tick is a programmatic scroll attempt
  // that the effect skips while detached, plus the scroll events around it.
  let sticking = true
  sticking = decide('gesture-up', 0, sticking)
  assert.equal(sticking, false)
  for (let tick = 0; tick < 10; tick++) {
    // Content grows above, so the gap widens rather than closing.
    sticking = decide('scroll', 40 + tick * 12, sticking)
    assert.equal(sticking, false, `re-pinned on tick ${tick}`)
  }
  // Only deliberately scrolling back to the end restores it.
  assert.equal(decide('scroll', 0, sticking), true)
})

test('wheel direction is read from the sign of deltaY', () => {
  assert.equal(wheelIntent(-1), 'gesture-up')
  assert.equal(wheelIntent(-240), 'gesture-up')
  assert.equal(wheelIntent(1), 'gesture-down')
  assert.equal(wheelIntent(240), 'gesture-down')
  // A zero delta moves nothing, so it must not detach.
  assert.equal(wheelIntent(0), 'gesture-down')
})

test('a finger dragging down pulls earlier messages into view', () => {
  // Content follows the finger, so the screen-space direction is inverted
  // against the document one. Getting this backwards would detach on exactly
  // the gesture that means "take me to the end".
  assert.equal(touchIntent(100, 160), 'gesture-up', 'finger down is content up')
  assert.equal(touchIntent(160, 100), 'gesture-down')
  assert.equal(touchIntent(100, 100), 'gesture-down', 'no movement is not intent to leave')
})

test('a scrollbar drag counts, a click on a message does not', () => {
  // clientWidth excludes the scrollbar, so an offset past it is the gutter.
  // Without the distinction every click inside the transcript, including the
  // copy button on a code block, would stop auto-scroll.
  assert.equal(isScrollbarClick(812, 800), true, 'in the gutter')
  assert.equal(isScrollbarClick(801, 800), true)
  assert.equal(isScrollbarClick(800, 800), false, 'the last content pixel is content')
  assert.equal(isScrollbarClick(40, 800), false, 'a click on a message')
  assert.equal(isScrollbarClick(0, 800), false)
})

test('an unknown cause changes nothing', () => {
  // Fail closed on a cause nobody has thought about: leave the user's last
  // decision alone rather than guessing at it.
  assert.equal(nextStick({ cause: 'nonsense' as StickCause, distanceFromBottom: 0, sticking: false }), false)
  assert.equal(nextStick({ cause: 'nonsense' as StickCause, distanceFromBottom: 999, sticking: true }), true)
})
