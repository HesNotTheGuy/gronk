/**
 * When the error banner stops saying what it is saying.
 *
 * There is one banner and one string behind it, so every failure in the app
 * competes for the same line. Written as scattered `setError(null)` calls that
 * rule is unreadable: a reader has to find all of them to answer "does this
 * clear?", and a new failure path gets no clear at all, because nothing about
 * adding one prompts you to go looking.
 *
 * So the string carries the scope it is about, and the two ways an error can
 * end are separated:
 *
 * - **retire**: a new attempt is starting, and it supersedes what the banner
 *   says. Starting an agent replaces the whole conversation on screen, so it
 *   supersedes everything; exporting a transcript says nothing about whether
 *   the agent is up, so it supersedes only the last export.
 * - **resolve**: an attempt finished successfully. That is evidence about its
 *   own scope and about nothing else, which is why it is not the same function.
 *   A connection reaching `ready` proves the agent is up; it does not make
 *   "nothing to export yet" false.
 *
 * The distinction is the whole point. Collapsing the two into one "clear
 * everything" is how the banner ends up either lying or being wiped by a click
 * that proved nothing.
 */

/** What a banner error is about. */
export type ErrorScope = 'agent' | 'prompt' | 'export'

export interface AppError {
  message: string
  scope: ErrorScope
}

/**
 * What a starting attempt of each scope supersedes.
 *
 * `prompt` supersedes `agent` because a prompt cannot be sent unless the
 * connection is already ready, so an agent error still on screen at that moment
 * is describing a state the app has since left.
 */
const RETIRES: Record<ErrorScope, readonly ErrorScope[]> = {
  agent: ['agent', 'prompt', 'export'],
  prompt: ['agent', 'prompt', 'export'],
  export: ['export']
}

/**
 * An attempt of `scope` is committing to do work: drop what it supersedes.
 *
 * Call this at the point of no return, not on entry to the handler. The
 * difference matters where a handler can still be abandoned: `openProject`
 * opens a folder dialog first, and clearing before it means cancelling the
 * dialog silently discards an error that is still true.
 */
export function retire(current: AppError | null, scope: ErrorScope): AppError | null {
  if (!current) return null
  return RETIRES[scope].includes(current.scope) ? null : current
}

/** An attempt of `scope` failed. The newest failure always wins the banner. */
export function raise(scope: ErrorScope, message: string): AppError {
  return { message, scope }
}

/**
 * An attempt of `scope` succeeded: drop that scope's error and nothing else.
 *
 * Deliberately narrower than `retire`. Success is evidence about the thing that
 * succeeded, so it cannot speak for a failure in another scope.
 */
export function resolve(current: AppError | null, scope: ErrorScope): AppError | null {
  if (!current) return null
  return current.scope === scope ? null : current
}
