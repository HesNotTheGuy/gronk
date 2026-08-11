/**
 * Which session the renderer is showing, and whether an event belongs to it.
 *
 * Every conversation event already names its session. The renderer never
 * looked, because with one agent every event necessarily belonged to the only
 * session there was. The moment a second one can run, an unfiltered handler
 * appends a background session's reply to the transcript on screen.
 *
 * The comparison is trivial. What is not is that "I hold no session ids" means
 * four different things, and they do not all get the same answer. An empty list
 * represents all of them unless it is made not to, so the state is named
 * explicitly rather than inferred from the list being empty:
 *
 * - **unchosen**: nothing has ever been selected in this renderer. ACCEPT. A
 *   window recreated while main still has a live agent goes on receiving that
 *   agent's stream, and it is the only conversation there is; refusing would
 *   leave a blank window next to a working agent.
 * - **switching**: a session was asked for and main has not said which one it
 *   is on. ACCEPT, because the answer genuinely is not knowable yet. Selecting
 *   sets the id the user clicked, but a load can come back having resolved a
 *   DIFFERENT id, which is why the renderer sets its session twice; between the
 *   click and that answer the history events name an id never seen before. A
 *   plain equality test drops exactly the events that paint the conversation.
 * - **settled, with ids**: REFUSE anything else. This is the ordinary case.
 * - **settled, with none**: an attempt to choose that failed. REFUSE. This is
 *   the one that looks like `unchosen` and is not: there is no conversation on
 *   screen, so another session's stream arriving would paint one the user never
 *   opened and make a failed start look like it had worked.
 *
 * The last two are why `settled` is a state rather than the absence of
 * `switching`. Reading emptiness as permission is the mistake this file exists
 * to not make.
 *
 * Which way to resolve the ones that cannot be known: accepting a stray event
 * costs a wrong line in a transcript, which the user can see and reload away.
 * Refusing a real one costs a conversation that never paints, with nothing on
 * screen saying why. So the two unknowable states accept, and every state where
 * the answer IS known refuses.
 *
 * **Every attempt to change session ends settled, including the ones that
 * fail.** `switching` accepts everything, so it is a state to pass through
 * rather than rest in, and a failure that leaves it in place accepts every
 * session's events for the rest of the run. A failure that instead leaves the
 * focus untouched is just as wrong in the other direction: it reads afterwards
 * as `unchosen`, which also accepts everything, and "I never chose" is not what
 * happened.
 *
 * Two consequences for callers. A switch is opened past the last route out,
 * never before handing off to another function that has early returns of its
 * own, because the opener has already returned by then and cannot close it. And
 * every refusal before that point settles, so a failed attempt is recorded as a
 * failed attempt rather than as nothing at all.
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

/**
 * `unchosen` before anything is selected, `switching` while an answer is
 * outstanding, `settled` once one has arrived or the attempt has failed.
 */
export type FocusState = 'unchosen' | 'switching' | 'settled'

export interface SessionFocus {
  readonly state: FocusState
  /** Ids whose events are the conversation on screen. */
  readonly ids: readonly string[]
}

/** Nothing has been selected in this renderer yet. */
export const NO_FOCUS: SessionFocus = { state: 'unchosen', ids: [] }

/**
 * A switch has been requested.
 *
 * `requestedId` is what the user clicked when that is known, and null when it is
 * not: opening a project starts an agent whose session id only exists once it
 * has booted.
 */
export function beginSwitch(requestedId: string | null): SessionFocus {
  return { state: 'switching', ids: requestedId ? [requestedId] : [] }
}

/**
 * The switch is over: main named a session, or nothing is coming.
 *
 * `id` is null for a start that threw. That settles with whatever was requested,
 * which for a project or chat is nothing at all. A settled focus holding no ids
 * refuses every named event, which is the point. Leaving it `switching`
 * would keep accepting every session's events for the rest of the run.
 *
 * The requested id is KEPT rather than replaced. Events naming it can already be
 * in flight, and a load that resolves to a different id does not make the events
 * that arrived under the clicked one stop belonging to this conversation.
 */
export function confirmSwitch(focus: SessionFocus, id: string | null): SessionFocus {
  if (!id) return { state: 'settled', ids: focus.ids }
  return {
    state: 'settled',
    ids: focus.ids.includes(id) ? focus.ids : [...focus.ids, id]
  }
}

/**
 * May this session speak for the whole view?
 *
 * Some events do not add to a conversation, they REPLACE what is on screen: the
 * transcript, the session id, the folder, whether the view follows the end. Accepted
 * for the wrong session, those repaint the conversation being read as a different
 * one — and the save timer then writes it to disk under the id the renderer believes
 * it is showing.
 *
 * `belongsToFocus` is deliberately looser: while a switch is open it accepts any
 * named session, because a load can resolve to an id the renderer has not heard yet
 * and the events naming it arrive first. That latitude is right for an event that
 * appends a line and wrong for one that replaces everything.
 *
 * An unnamed switch has to accept a name from anyone, though. Opening a project or a
 * chat starts one with no id at all — the id only exists once the agent has booted,
 * and main announcing it is how the renderer finds out. So: name an unclaimed switch,
 * never rename a claimed one.
 *
 * What this does not cover: two unnamed switches in flight at once, where the first
 * name to arrive wins and could be the abandoned one. That window closes the moment
 * either is named, and closing it properly needs main to echo back which switch it is
 * answering.
 */
export function mayReplaceView(focus: SessionFocus, sessionId: string | undefined): boolean {
  if (!sessionId) return true
  return focus.ids.length === 0 || focus.ids.includes(sessionId)
}

/** Does this event belong to the conversation on screen? */
export function belongsToFocus(focus: SessionFocus, sessionId: string | undefined): boolean {
  // No session named: agent boot, or an event about the app rather than a
  // conversation. There is nothing to attribute it to and dropping it would
  // lose the connection states that drive the composer.
  if (!sessionId) return true
  if (focus.ids.includes(sessionId)) return true
  // Known answer, and it is no. Both unknowable states fall through to accept;
  // this is the only line that has to distinguish them from a failed choice.
  return focus.state !== 'settled'
}
