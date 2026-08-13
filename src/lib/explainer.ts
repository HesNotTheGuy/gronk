import type { SessionInfo } from '../../shared/types'

/**
 * Has this person got going, so the app can stop explaining itself?
 *
 * Derived from their own sessions rather than stored as a flag, and that is the whole design.
 * A stored "seen" flag has to survive an update or the explanation comes back on every
 * release; it has to not be resettable by accident; and it needs a migration the day the
 * shape changes. A completed turn already satisfies all three, because it is a fact about
 * their data rather than a note about their state.
 *
 * The signal is a turn, not a session. Opening a project creates a session before anything
 * has been said in it, so a session count says "clicked around" where this says "used it".
 * An explicit dismiss was the other option and it is worse: it adds a control to the thing
 * whose entire problem is taking up room.
 *
 * Somebody who deletes every session sees the explanation again. That is the correct answer
 * to a state that looks like a fresh install.
 */
export function hasGotGoing(sessions: SessionInfo[]): boolean {
  return sessions.some((s) => (s.userTurns ?? 0) > 0)
}
