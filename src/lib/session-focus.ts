/**
 * Which session the renderer is showing, and whether an event belongs to it.
 *
 * Every conversation event already names its session. The renderer never
 * looked, because with one agent every event necessarily belonged to the only
 * session there was. The moment a second one can run, an unfiltered handler
 * appends a background session's reply to the transcript on screen.
 *
 * The hard part is not the comparison, it is the window where the answer is not
 * known yet. Selecting a session sets the id the user clicked, but the agent
 * can come back having loaded a DIFFERENT id, which is why the renderer sets
 * its session twice. Between the click and that answer, events arrive naming an
 * id the renderer has never seen. A plain equality test drops exactly the
 * history events that paint the conversation.
 *
 * So the focus is deliberately permissive for that one window and closed
 * everywhere else:
 *
 * - a switch has been asked for and not yet confirmed: accept everything, since
 *   the renderer cannot yet tell which id is its own;
 * - confirmed: accept only the ids belonging to this switch;
 * - an event with no session id at all: accept, because it predates any session
 *   (agent boot) and is about the switch in progress or about the app.
 *
 * The window is short and it closes on the first confirmation. What it must not
 * do is stay open, which is why `confirm` is called on both routes that learn an
 * id: the `session` event and the value the start/load call returns.
 */

import type { MainToRendererEvent } from '../../shared/types'

/**
 * The session an event names, or undefined when it names none.
 *
 * Several events have no such field at all: models, auth and the preview pair
 * are about the app rather than a conversation. Undefined is the same answer for
 * those as for an event that arrives before a session exists, and both are
 * accepted, so the two cases do not need telling apart here.
 */
export function sessionIdOf(event: MainToRendererEvent): string | undefined {
  return 'sessionId' in event ? event.sessionId : undefined
}

export interface SessionFocus {
  /** Ids whose events are the conversation on screen. */
  readonly ids: readonly string[]
  /**
   * A switch was requested and no id has been confirmed for it yet.
   *
   * True means "accept anything", so it has to be a state the code leaves
   * rather than one it can settle in.
   */
  readonly awaiting: boolean
}

/** Nothing selected: only events that name no session are the app's own. */
export const NO_FOCUS: SessionFocus = { ids: [], awaiting: false }

/**
 * A switch has been requested.
 *
 * `requestedId` is what the user clicked when that is known, and null when it is
 * not: opening a project starts an agent whose session id only exists once it
 * has booted.
 */
export function beginSwitch(requestedId: string | null): SessionFocus {
  return { ids: requestedId ? [requestedId] : [], awaiting: true }
}

/**
 * Main has named the session it is actually on.
 *
 * The requested id is KEPT rather than replaced. Events naming it can already be
 * in flight, and a load that resolves to a different id does not make the events
 * that arrived under the clicked one stop belonging to this conversation.
 */
export function confirmSwitch(focus: SessionFocus, id: string | null): SessionFocus {
  if (!id) return { ids: focus.ids, awaiting: false }
  return {
    ids: focus.ids.includes(id) ? focus.ids : [...focus.ids, id],
    awaiting: false
  }
}

/** Does this event belong to the conversation on screen? */
export function belongsToFocus(focus: SessionFocus, sessionId: string | undefined): boolean {
  // No session named: agent boot, or an event about the app rather than a
  // conversation. There is nothing to attribute it to and dropping it would
  // lose the connection states that drive the composer.
  if (!sessionId) return true
  if (focus.ids.includes(sessionId)) return true

  // Nothing to compare against, in one of two ways, and both accept.
  //
  // `awaiting` is a switch in flight whose id is not known yet. An empty focus
  // is a renderer that has never selected anything, which is not the same as
  // one that has selected something else: a window recreated while main still
  // has a live agent goes on receiving that agent's stream, and it is the only
  // conversation there is. Rejecting by default would blank it.
  return focus.awaiting || focus.ids.length === 0
}
