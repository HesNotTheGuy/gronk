/**
 * Should the transcript stay pinned to the bottom?
 *
 * Split out of useGronk.ts, which owns the listeners and the element, for the
 * same reason as context-menu-items.ts and ipc-guard.ts: the decision has
 * branches worth pinning and the code around it needs a DOM, so `node --test`
 * cannot reach it in place. Everything here is arithmetic on numbers and
 * strings, so all of it is testable.
 *
 * The rule the whole file exists to express: leaving the bottom and returning to
 * it are not symmetric. Leaving is a decision the user makes and must be honoured
 * the instant they make it, at any distance. Returning is a fact about where the
 * viewport is, and only counts once they have actually arrived.
 *
 * One shared threshold cannot do both. The version this replaces used 120px for
 * each direction, so a 40px scroll up read as "still near the bottom, re-pin",
 * and the next streamed token undid the scroll.
 *
 * The second rule, which the first version missed entirely: the distance answers
 * "where is the viewport", never "did the reader move it". Twice now the viewport
 * has arrived at the bottom without anybody asking, once because the app set
 * scrollTop and once because the document got shorter and the browser clamped.
 * Both look identical to a distance check, and both need a fact from outside it.
 * A third of these will turn up; the shape to look for is a scroll nobody made.
 */

/**
 * How close to the bottom counts as arrived.
 *
 * Rounding tolerance, not a comfort zone. `scrollHeight`, `scrollTop` and
 * `clientHeight` are fractional under browser zoom and non-integer device pixel
 * ratios, so an exact zero is not reliably reachable and "at the bottom" needs
 * some slack to ever be true.
 *
 * Keep it tiny. Every pixel of slack here is a distance the user can deliberately
 * scroll and be dragged back from, which is the bug this file was written for. At
 * 8 a nudge of 5px would be overridden; at 2 nothing a person can aim at is.
 */
export const ARRIVED_EPS = 2

/**
 * What moved the viewport, as far as the decision is concerned.
 *
 * `gesture-up` and `gesture-down` are the user's input, named by direction
 * rather than by device, because direction is the only part the decision cares
 * about and a wheel, a key and a finger all supply it.
 */
export type StickCause =
  /** The user is moving away from the end: wheel up, PageUp, a drag downward. */
  | 'gesture-up'
  /** The user is moving toward the end. Cannot detach anything on its own. */
  | 'gesture-down'
  /** The element reported a scroll, whoever caused it. */
  | 'scroll'
  /** The app set scrollTop itself. Not evidence about what the user wants. */
  | 'programmatic'

export interface StickInput {
  cause: StickCause
  /** `scrollHeight - scrollTop - clientHeight`, in CSS pixels. */
  distanceFromBottom: number
  /** Whether the transcript is pinned right now. */
  sticking: boolean
  /** `scrollHeight` as of this measurement. */
  scrollHeight: number
  /** `scrollHeight` as of the previous one, to tell a reflow from a scroll. */
  previousScrollHeight: number
  /**
   * Did the user touch anything between the previous measurement and this one?
   *
   * This is the whole discriminator for the shrink case below, so it has to mean
   * "since the last measurement" and not "ever". The hook clears it every time it
   * measures.
   */
  gestureSinceMeasure: boolean
}

/**
 * The next value of the stick flag.
 *
 * `gesture-up` deliberately does not consult the distance. An intent event fires
 * *before* the viewport moves, so at that moment the distance still describes
 * where the user was, not where they are going. Reading it is what made the old
 * version ignore every scroll that started from near the bottom.
 *
 * `gesture-down` returns the current value rather than `false` for the mirror
 * reason. A wheel flick downward while already at the end produces no scroll at
 * all, so nothing would ever restore the flag, and auto-scroll would stop dead
 * from a gesture that moved nothing. That is the same bug wearing a different
 * hat.
 */
export function nextStick({
  cause,
  distanceFromBottom,
  sticking,
  scrollHeight,
  previousScrollHeight,
  gestureSinceMeasure
}: StickInput): boolean {
  switch (cause) {
    case 'gesture-up':
      return false
    case 'gesture-down':
      return sticking
    case 'scroll':
      // The document got shorter and the user did nothing, so this scroll is the
      // browser clamping scrollTop into a range that just moved, not a person
      // arriving anywhere. Reading the distance here is what snapped a reader
      // back the moment a reply finished: the turn ends, the live summary line
      // and the streaming caret stop rendering, the content under a reader who
      // had scrolled up gets shorter than their scrollTop, and the clamp reports
      // distance zero. From the distance alone they ARE at the bottom. They just
      // never moved.
      //
      // Same shape as 'programmatic' below, which exists for the same reason: a
      // cause the distance cannot distinguish. The difference is only who moved
      // the viewport, the app there and the browser here.
      //
      // The gesture check is what keeps this from swallowing a real arrival. A
      // reader who scrolls down to the end while the content happens to be
      // shrinking must still re-attach, or one bug is traded for a transcript
      // that never follows again.
      if (scrollHeight < previousScrollHeight && !gestureSinceMeasure) return sticking
      return distanceFromBottom <= ARRIVED_EPS
    case 'programmatic':
      // The app just moved the viewport to the bottom, so the distance says
      // "arrived" no matter what the user wanted. Answering from it would let
      // every stream tick re-pin a transcript the user had scrolled away from.
      return sticking
    default:
      return sticking
  }
}

/** Wheel and trackpad. Negative deltaY is toward the top of the document. */
export function wheelIntent(deltaY: number): StickCause {
  return deltaY < 0 ? 'gesture-up' : 'gesture-down'
}

/**
 * A finger drag. Content follows the finger, so a finger moving DOWN the screen
 * pulls earlier messages into view, which is `gesture-up` here.
 */
export function touchIntent(startY: number, currentY: number): StickCause {
  return currentY > startY ? 'gesture-up' : 'gesture-down'
}

/**
 * Keys that scroll, or null for every other key.
 *
 * Null matters: the listener sits on the transcript, and a key that is not a
 * scrolling key must not be read as scroll intent. Space is the awkward one,
 * paging down on its own and up with shift held.
 */
export function keyIntent(key: string, shiftKey: boolean): StickCause | null {
  switch (key) {
    case 'PageUp':
    case 'Home':
    case 'ArrowUp':
      return 'gesture-up'
    case 'PageDown':
    case 'End':
    case 'ArrowDown':
      return 'gesture-down'
    case ' ':
    // Older engines report the space bar under this name; harmless to accept.
    case 'Spacebar':
      return shiftKey ? 'gesture-up' : 'gesture-down'
    default:
      return null
  }
}

/**
 * Did a mousedown land on the vertical scrollbar rather than on content?
 *
 * `clientWidth` excludes the scrollbar, so an offset past it is the gutter. This
 * is what separates "started dragging the scrollbar" from "clicked a button in a
 * message", and without the distinction every click inside the transcript would
 * read as scroll intent.
 *
 * Only meaningful when the event target is the scrolling element itself: a click
 * on a child reports an offset relative to that child.
 */
export function isScrollbarClick(offsetX: number, clientWidth: number): boolean {
  return offsetX > clientWidth
}
