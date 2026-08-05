/**
 * The last few transcripts the renderer already had, kept in memory.
 *
 * Going back to a session you just left re-read it from the store and rebuilt
 * every message, and the renderer had the exact same array a moment earlier.
 * This keeps a handful of them so the swap back is a render rather than a
 * round trip.
 *
 * What this is NOT, and the reason the cache is deliberately small and dumb:
 *
 * - **It never stands in for `loadSession`.** The agent still has to be told
 *   which session it is on; this only saves re-reading a transcript the
 *   renderer already loaded. A cache that skipped the load would show you a
 *   conversation the agent is not in.
 * - **It holds loaded local transcripts only.** Nothing is invented here and
 *   nothing is merged. An entry is a snapshot of what the renderer was showing.
 * - **It is bounded and drops the oldest.** Transcripts are capped at 200
 *   messages each and hold tool payloads; keeping every session ever visited
 *   would grow with the session list rather than with what the user is moving
 *   between.
 *
 * Entries are most-recently-used first, so re-remembering a session moves it
 * back to the front rather than ageing it out while it is the one in use.
 */

import type { ChatMessage } from '../../shared/types'

export interface CachedTranscript {
  sessionId: string
  messages: ChatMessage[]
}

/**
 * How many transcripts are kept.
 *
 * Three covers the movement this exists for: the session you are in, the one
 * you came from, and the one before that. Beyond that the cost is paid on
 * everything a person opened once and did not come back to.
 */
export const TRANSCRIPT_CACHE_LIMIT = 3

/** What the renderer was showing for this session, or null if it is not held. */
export function cachedTranscript(
  cache: CachedTranscript[],
  sessionId: string | null
): ChatMessage[] | null {
  if (!sessionId) return null
  return cache.find((entry) => entry.sessionId === sessionId)?.messages ?? null
}

/**
 * Remember a transcript, most recent first.
 *
 * An empty transcript is not remembered and does not evict anything. A session
 * with nothing in it costs nothing to re-read, and caching the empty state of a
 * session that simply had not finished loading would hand that back later as
 * though it were the answer.
 */
export function rememberTranscript(
  cache: CachedTranscript[],
  sessionId: string | null,
  messages: ChatMessage[],
  limit = TRANSCRIPT_CACHE_LIMIT
): CachedTranscript[] {
  if (!sessionId || !messages.length || limit <= 0) return cache
  const rest = cache.filter((entry) => entry.sessionId !== sessionId)
  return [{ sessionId, messages }, ...rest].slice(0, limit)
}

/**
 * Drop a session, for when what is held can no longer be trusted to be it:
 * deleted, archived out of the lists, or renamed.
 *
 * Renaming does not change a single message, so this is stricter than it has to
 * be. It stays that way because the alternative is a cache whose invalidation
 * rule is "everything except the one case I reasoned about", and the cost of
 * being wrong is showing somebody a conversation that is not there any more.
 */
export function forgetTranscript(
  cache: CachedTranscript[],
  sessionId: string
): CachedTranscript[] {
  return cache.filter((entry) => entry.sessionId !== sessionId)
}
