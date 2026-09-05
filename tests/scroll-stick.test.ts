import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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

/**
 * Reads as the sentence being asserted, since every case is the same shape.
 *
 * `reflow` defaults to a document that did not change height and a reader who
 * did nothing, which is the ordinary case and leaves every assertion written
 * before it meaning exactly what it meant then.
 */
function decide(
  cause: StickCause,
  distanceFromBottom: number,
  sticking: boolean,
  reflow?: {
    scrollHeight: number
    previousScrollHeight: number
    gestureSinceMeasure?: boolean
  }
): boolean {
  return nextStick({
    cause,
    distanceFromBottom,
    sticking,
    scrollHeight: reflow?.scrollHeight ?? 4000,
    previousScrollHeight: reflow?.previousScrollHeight ?? 4000,
    gestureSinceMeasure: reflow?.gestureSinceMeasure ?? false
  })
}

/** The document got shorter, which is what the end of a turn does. */
const shrank = (gestureSinceMeasure = false) => ({
  scrollHeight: 3800,
  previousScrollHeight: 4000,
  gestureSinceMeasure
})

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
  assert.equal(decide('nonsense' as StickCause, 0, false), false)
  assert.equal(decide('nonsense' as StickCause, 999, true), true)
})

/*
 * The turn-end snap-back, found using 0.2.0.
 *
 * Scrolling up mid-reply holds, which is what the first fix was for. But when the
 * reply FINISHES the transcript jumps back to the bottom. The turn ending stops
 * the live summary line and the streaming caret rendering, so the document gets
 * shorter; a reader who had scrolled up now has a scrollTop past the new maximum,
 * the browser clamps it, and that clamp is dispatched as an ordinary scroll at
 * distance zero.
 *
 * Nothing above could have caught it. Every case above hands the function one
 * measurement and asks what it means, and from one measurement the reader really
 * is at the bottom. The tell is only visible across two: the content moved, not
 * the reader.
 */

test('content shrinking under a reader who scrolled away does NOT re-stick', () => {
  // The bug, as reported. Reader is detached and has not touched anything; the
  // reply finishes, the document shortens, the browser clamps to the new bottom.
  assert.equal(decide('scroll', 0, false, shrank()), false)
})

test('the clamp is refused however close to the bottom it lands', () => {
  // The clamp reports whatever the new maximum happens to be. None of these are
  // the reader arriving, so none of them may re-attach.
  for (const distance of [0, 1, 2, 40, 300]) {
    assert.equal(
      decide('scroll', distance, false, shrank()),
      false,
      `a reflow landing at ${distance}px re-stuck the transcript`
    )
  }
})

test('content shrinking under a reader already at the bottom leaves them stuck', () => {
  // The mirror, and the reason this holds the previous value rather than
  // returning false. Most turns end with the reader at the bottom watching, and
  // detaching them there would break the ordinary case to fix the rare one.
  assert.equal(decide('scroll', 0, true, shrank()), true)
})

test('a real arrival during a shrink still re-attaches', () => {
  // The inverse the fix must not trade away. The reader scrolled down to the end
  // while a turn happened to be finishing, so they DID move and the distance is
  // the honest answer. Without the gesture check this returns false and the
  // transcript never follows again.
  assert.equal(decide('scroll', 0, false, shrank(true)), true)
})

test('a gesture during a shrink that does not reach the end still does not stick', () => {
  // The other half of that: the gesture only says "read the distance", it does
  // not say "attach". A reader who scrolls down a little and stops is still away.
  assert.equal(decide('scroll', 300, false, shrank(true)), false)
})

test('content growing is read normally, which is every streaming tick', () => {
  // Growth is the common case and must not touch the new branch. A token arrives,
  // the document gets taller, and whether to stick is still purely the distance.
  const grew = { scrollHeight: 4200, previousScrollHeight: 4000 }
  assert.equal(decide('scroll', 0, false, grew), true, 'arriving during growth attaches')
  assert.equal(decide('scroll', 300, true, grew), false, 'leaving during growth detaches')
})

test('an unchanged height is read normally', () => {
  // Equal heights are not a shrink. Strictly-less is what distinguishes them, and
  // an off-by-one here would swallow every ordinary scroll in a still document.
  const same = { scrollHeight: 4000, previousScrollHeight: 4000 }
  assert.equal(decide('scroll', 0, false, same), true)
  assert.equal(decide('scroll', 300, true, same), false)
})

test('the shrink rule is scoped to scroll, not to gestures', () => {
  // A shrink happening to coincide with a gesture must not change what the
  // gesture means. Leaving is still unconditional, and toward-the-end still
  // cannot attach on its own.
  assert.equal(decide('gesture-up', 0, true, shrank()), false, 'a shrink cannot rescue a detach')
  assert.equal(decide('gesture-down', 0, false, shrank()), false)
  assert.equal(decide('programmatic', 0, false, shrank()), false)
})

test('a whole turn ending under a reader who scrolled up, end to end', () => {
  // The sequence from the report, run as one story: scroll up mid-reply, keep
  // streaming, then let the turn end. The reader must still be where they put
  // themselves.
  let sticking = true
  let height = 4000

  sticking = decide('gesture-up', 0, sticking)
  assert.equal(sticking, false, 'the scroll up detaches')

  // Tokens keep arriving: the document grows, and none of it re-attaches.
  for (let tick = 0; tick < 5; tick++) {
    const next = height + 120
    sticking = decide('scroll', 400, sticking, {
      scrollHeight: next,
      previousScrollHeight: height
    })
    height = next
    assert.equal(sticking, false, `re-pinned on tick ${tick}`)
  }

  // The turn ends. The live line and the caret stop rendering, the document
  // shortens under them, and the browser clamps to the new bottom.
  sticking = decide('scroll', 0, sticking, {
    scrollHeight: height - 200,
    previousScrollHeight: height
  })
  assert.equal(sticking, false, 'the turn ending snapped the reader back')
})

// ── #76: a restore that finishes must not override the reader ────────────────

test('ONLY A DELIBERATE MOVE RE-ATTACHES THE TRANSCRIPT TO THE END', async () => {
  // Reported: scrolling was not interrupted while scrolling, but stopping snapped the
  // view down to the newest thing. The cause was not the arrival check in this file — it
  // was `history-done` assigning the follow flag directly, which overrode a reader who
  // had scrolled up during a restore. On a large session the restore is long enough to
  // read during, and typing and scrolling there are deliberately allowed.
  //
  // Read from source rather than driven: the flag is a ref inside the hook and the pin
  // needs a real scroll box, neither of which this suite can reach. Comments are stripped
  // first — an earlier version of this test matched the comment that explains the fix,
  // and passed for it.
  const raw = readFileSync(new URL('../src/hooks/useGronk.ts', import.meta.url), 'utf8')
  const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

  const assignments = source.split('stickToBottom.current = true').length - 1
  assert.equal(
    assignments,
    6,
    'the set of events that re-attach the transcript to the end changed. Every one has ' +
      'to be something the user just asked for — opening a session (Gronk or terminal), ' +
      'going somewhere, sending a prompt. If this moved, name the event and say why a ' +
      'person would expect to be taken to the end by it'
  )

  // The two that must never: finishing a restore, and the bulk paint before it. Both
  // happen while the reader may already be somewhere they chose.
  for (const event of ['history-done', 'history-replace']) {
    const from = source.slice(source.indexOf(`case '${event}':`))
    const body = from.slice(0, from.indexOf('break'))
    assert.ok(body.length > 0, `${event} is no longer handled`)
    assert.doesNotMatch(
      body,
      /stickToBottom\.current = true/,
      `${event} re-attaches the view, which yanks a reader who scrolled up during a restore`
    )
  }

  // And the delayed pins still ask before moving anything.
  const done = source.slice(source.indexOf("case 'history-done':"))
  const doneBody = done.slice(0, done.indexOf('break'))
  assert.match(doneBody, /if \(el && stickToBottom\.current\) pinToBottom\(el\)/)
  assert.match(doneBody, /if \(again && stickToBottom\.current\) pinToBottom\(again\)/)
})
