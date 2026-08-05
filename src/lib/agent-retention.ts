import type { AgentUnit } from './agent-activity'

/**
 * Which agent units the tray should still be showing.
 *
 * Extracted for the same reason as agent-dots.ts: the suite has no DOM, and this
 * is the rule that decides whether reopening a session greets you with a wall of
 * red.
 *
 * THE DISTINCTION THIS FILE EXISTS TO DRAW: "seen this session" is not "seen in
 * the transcript."
 *
 * Retention was added for a real problem. The tray scanned a 16-message window,
 * so finishing work scrolled out of range and the AGENTS tab vanished mid-session
 * as if nothing had run. The fix was a sticky list that never drops an entry.
 *
 * Reopening a session then turned that into its own problem. Restore scans the
 * whole transcript, every agent unit the session ever ran lands in the sticky
 * list at once, and the tray presents a session's entire history as current
 * work: AGENTS 50, mostly red. Nothing is wrong, and it reads as everything
 * being wrong.
 *
 * A smaller scan window does not fix it. Restore still scans whatever window is
 * picked, so it still resurrects whatever falls inside it; a 12-message window
 * just makes the wall shorter. The window is the wrong axis.
 *
 * The axis that works is WHEN a unit was first seen:
 *
 * - At the restore snapshot, keep only what is still running. A unit that was
 *   already finished before this session was opened is history, and history
 *   belongs in the transcript where its tool call already is.
 * - After that, keep everything. A unit that appears while the session is open
 *   is this session's work, and it stays visible when it finishes. That is the
 *   property retention was introduced for and it is untouched.
 */

/** Still doing something, as opposed to finished, failed or cancelled. */
export function isLiveUnit(unit: AgentUnit): boolean {
  return unit.status === 'in_progress' || unit.status === 'pending'
}

export interface RetentionInput {
  /** What the tray is currently showing. */
  prev: AgentUnit[]
  /** What this scan of the transcript found. */
  incoming: AgentUnit[]
  /**
   * True for the first scan after a session was opened or restored.
   *
   * The caller knows this and the merge cannot infer it: a restore snapshot and
   * a live update are the same shape, which is exactly why the old merge could
   * not tell them apart.
   */
  isRestoreSnapshot: boolean
}

export function nextRetained({ prev, incoming, isRestoreSnapshot }: RetentionInput): AgentUnit[] {
  if (isRestoreSnapshot) {
    // Deliberately ignores `prev`. A restore is a new session on screen, and
    // carrying the previous one's units across is how the tray came to show
    // work from a session the user had already left.
    return incoming.filter(isLiveUnit)
  }

  // Never drop on an empty scan: a unit whose tool call has scrolled out of the
  // scan window is still this session's work.
  if (incoming.length === 0) return prev

  const byId = new Map(prev.map((u) => [u.id, u]))
  for (const u of incoming) byId.set(u.id, u)
  return [...byId.values()]
}
