import { redactSecrets } from './redact'

/**
 * Keep the main process alive when something throws where nobody was catching.
 *
 * Node has made an unhandled rejection fatal since v15, and Electron's main
 * process is Node — so one missed `.catch()` anywhere in here does not log a
 * warning, it ends the app. That is the worst possible outcome for this app
 * specifically: the main process owns every running `grok agent stdio` child, so
 * it takes live agents down with it, mid-turn, with no window left to say why.
 * The user sees the app vanish.
 *
 * Staying up is the better trade here, and it is a trade rather than a free win.
 * A process that continues after an unexpected throw may be in a state nobody
 * designed, and swallowing failures can hide bugs. Two things make it the right
 * call anyway: transcripts are written as turns complete, so what is at risk is
 * the running turn rather than history, and the alternative — disappearing — is
 * both worse and undiagnosable. Nothing is silenced: every catch reports.
 */

export type CrashKind = 'unhandledRejection' | 'uncaughtException'

export interface CrashReport {
  kind: CrashKind
  /** Redacted, single line, capped. Safe to log and to show. */
  message: string
}

/** Longest message kept. A stack from a deep async chain is otherwise unbounded. */
const MAX_MESSAGE = 400

/**
 * Turn whatever was thrown into one reportable line.
 *
 * Anything can be thrown, including strings, `undefined`, and objects with a
 * getter that throws again — so this never touches a property it has not
 * guarded. Redacted because a rejection from a subprocess call can carry the
 * command that failed, and those carry tokens.
 */
export function describeCrash(kind: CrashKind, error: unknown): CrashReport {
  let said = ''
  try {
    if (error instanceof Error) said = error.message || String(error)
    else if (typeof error === 'string') said = error
    else if (error && typeof error === 'object') said = JSON.stringify(error)
    else said = String(error)
  } catch {
    said = '(threw while being described)'
  }
  const flat = redactSecrets(said).replace(/\s+/g, ' ').trim()
  const message = flat.length > MAX_MESSAGE ? `${flat.slice(0, MAX_MESSAGE)}…` : flat
  return { kind, message: message || '(no message)' }
}

/**
 * Should this be shown to the user, or only logged?
 *
 * A rejection nobody caught has already broken something the user was doing, so
 * it earns a banner. Repeats of the same message do not: a failing interval would
 * otherwise paint the same line forever, which is how a diagnostic becomes the
 * bug. First occurrence speaks, the rest are counted.
 */
export function makeCrashReporter(
  onReport: (report: CrashReport) => void
): (kind: CrashKind, error: unknown) => void {
  const seen = new Set<string>()
  return (kind, error) => {
    const report = describeCrash(kind, error)
    console.error(`[gronk] ${report.kind}:`, report.message)
    if (seen.has(report.message)) return
    seen.add(report.message)
    try {
      onReport(report)
    } catch {
      // Reporting must never be the thing that takes the process down.
    }
  }
}

/**
 * Install the guard. Returns a teardown so tests can install and remove it
 * without leaking listeners across cases.
 */
export function installCrashGuard(onReport: (report: CrashReport) => void): () => void {
  const report = makeCrashReporter(onReport)
  const onRejection = (reason: unknown): void => report('unhandledRejection', reason)
  const onException = (error: unknown): void => report('uncaughtException', error)
  process.on('unhandledRejection', onRejection)
  process.on('uncaughtException', onException)
  return () => {
    process.off('unhandledRejection', onRejection)
    process.off('uncaughtException', onException)
  }
}
