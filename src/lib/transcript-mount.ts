/**
 * Painting a restored transcript end first.
 *
 * A restore used to set the whole transcript in one update, so the first thing
 * on screen cost the full render of every message in it. The reader is at the
 * bottom, which is where `stickToBottom` puts them, so almost all of that work
 * is for content nobody is looking at yet.
 *
 * The split here is the last N messages, painted immediately, and everything
 * before them, appended afterwards. Nothing is dropped and nothing is
 * reordered: `head.concat(tail)` is the original array, which is the property
 * the tests hold on to.
 *
 * The interesting half is the append, because the transcript can move while the
 * head is still waiting. `prependHead` refuses rather than guesses, and the
 * anchor is what makes that decision possible.
 */

import type { ChatMessage } from '../../shared/types'

/**
 * How much of the end is painted first.
 *
 * Enough to fill any window the app can be resized to, so the reader never sees
 * the transcript end above the fold and then jump. Above roughly this the
 * messages are off screen and their render is pure latency.
 */
export const MOUNT_TAIL = 30

export interface MountSplit {
  /** Painted now. */
  tail: ChatMessage[]
  /** Painted after, or empty when the whole transcript already fits. */
  head: ChatMessage[]
  /**
   * The id `prependHead` matches against later. Null when there is no head, and
   * therefore nothing to schedule.
   */
  anchorId: string | null
}

/**
 * Split a transcript into what to paint now and what to append after.
 *
 * A transcript that already fits reports no head at all rather than an empty
 * one, so the caller schedules nothing: a second update with nothing in it is
 * still a second render of the list.
 */
export function splitForMount(messages: ChatMessage[], tailSize = MOUNT_TAIL): MountSplit {
  if (tailSize <= 0 || messages.length <= tailSize) {
    return { tail: messages, head: [], anchorId: null }
  }
  const cut = messages.length - tailSize
  const tail = messages.slice(cut)
  return { tail, head: messages.slice(0, cut), anchorId: tail[0]?.id ?? null }
}

/**
 * Put the head back on, unless the transcript has moved on without it.
 *
 * The head arrives a frame or more late, and by then the list on screen may
 * belong to a different session, may have been cleared, or may already be
 * whole. The one thing that is true in every case worth appending to is that
 * the list still STARTS with the message the tail started with. An id is unique
 * per message, so a different session cannot match it, and a list that has
 * already had its head restored starts with the head instead.
 *
 * Messages ADDED since the split are fine and are kept: a prompt sent while the
 * head was still pending sits at the end, and the head belongs in front of all
 * of it.
 */
export function prependHead(
  current: ChatMessage[],
  head: ChatMessage[],
  anchorId: string | null
): ChatMessage[] {
  if (!head.length || !anchorId) return current
  if (current[0]?.id !== anchorId) return current
  return [...head, ...current]
}
