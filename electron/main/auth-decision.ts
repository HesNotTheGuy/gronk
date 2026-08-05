import type { AuthStatus } from '../../shared/types'

/**
 * Given what a probe observed, is this machine signed in?
 *
 * Split from auth.ts, which spawns the CLI and reads the disk, for the same
 * reason as scroll-stick.ts and context-menu-items.ts: the decision is a table
 * worth pinning and the code around it needs a process and a filesystem. Nothing
 * here spawns, reads or imports anything but a type.
 *
 * THE RULE THIS FILE EXISTS FOR: a successful `grok models` is not evidence of
 * an account.
 *
 * The version this replaces treated `grok models` exiting 0 with a models-shaped
 * list as proof of usable credentials, and said so in its own comment:
 * "Successful models list is approximately usable credentials". It is not. The
 * model list is answerable without an account, so a machine that has never been
 * signed in reads as SIGNED IN, and signing out flips straight back because
 * `grok models` still exits 0 the moment the probe re-runs. A mac tester caught
 * all three states in one frame: sidebar saying signed in, composer knowing
 * better, and agent boot failing with the CLI's own "Authentication required"
 * string, which appears nowhere in this codebase.
 *
 * So the CLI answering is necessary and not sufficient. Something has to
 * positively indicate an account: a label the CLI printed, credentials it cached,
 * or a key in the environment. Absent all three, the honest answer is "not signed
 * in" even though the command worked.
 */

export interface ProbeFacts {
  /** Exit code of `grok models`, or null if the child was killed. */
  code: number | null
  /** Account label the CLI named, already sanitised by parseLoginLabel. */
  label: string | undefined
  /** Did stdout look like a model list at all. */
  modelsListed: boolean
  /** Did the output say, in the CLI's own words, that we are not signed in. */
  saysUnauthenticated: boolean
  /**
   * `~/.grok/auth.json` exists. EXISTENCE ONLY. This flag is the entire
   * permitted contact with that file: it is never read, parsed or forwarded,
   * because it holds a live session token.
   */
  filePresent: boolean
  /** XAI_API_KEY is set and non-empty. Presence only; the value never leaves env. */
  envKey: boolean
}

/**
 * Does anything positively indicate an account?
 *
 * These three are not equally strong and the order below reflects that. A label
 * is the CLI telling us who it thinks it is. A cached credentials file is the
 * CLI having stored something for itself. An env key is the operator asserting
 * one. Any of them beats a bare model list, which is what a stranger gets.
 */
export function hasCredentialEvidence(facts: ProbeFacts): boolean {
  return !!facts.label || facts.filePresent || facts.envKey
}

function methodFor(facts: ProbeFacts): AuthStatus['method'] {
  if (facts.label) return 'session'
  // An env key with no cached file is unambiguous: nothing else could be
  // answering. With a file present the file is the more specific explanation.
  if (facts.envKey && !facts.filePresent) return 'api_key_env'
  if (facts.filePresent) return 'session'
  if (facts.envKey) return 'api_key_env'
  return 'unknown'
}

function authenticatedMessage(facts: ProbeFacts, method: AuthStatus['method']): string {
  if (facts.label) return `Signed in via ${facts.label}`
  if (method === 'api_key_env') {
    // Said explicitly because of the sign-out path. Clearing a browser session
    // while XAI_API_KEY is set leaves the machine authenticated, and the button
    // looks broken unless the UI names the thing still answering.
    return 'Authenticated by XAI_API_KEY from the environment, not by a signed-in session.'
  }
  return 'Signed in with credentials cached by the Grok CLI.'
}

export function decideAuth(facts: ProbeFacts): AuthStatus {
  const { code, label, modelsListed, saysUnauthenticated, filePresent, envKey } = facts
  const cliAnswered = code === 0 && (!!label || modelsListed)

  if (cliAnswered && hasCredentialEvidence(facts)) {
    const method = methodFor(facts)
    return {
      state: 'authenticated',
      authenticated: true,
      method,
      accountLabel: label || (method === 'api_key_env' ? 'API key (environment)' : 'Signed in'),
      hasAuthFile: filePresent,
      hasEnvApiKey: envKey,
      message: authenticatedMessage(facts, method)
    }
  }

  if (cliAnswered) {
    // The whole bug, in one branch. The command worked and told us nothing about
    // an account, which is precisely the never-signed-in machine and precisely
    // the state right after a successful sign-out. Reporting it as signed in is
    // what let agent boot get as far as the CLI's own auth error.
    return {
      state: 'unauthenticated',
      authenticated: false,
      method: 'none',
      hasAuthFile: false,
      hasEnvApiKey: false,
      message:
        'The Grok CLI answered, but nothing on this machine shows an account: no session, no cached credentials, and no XAI_API_KEY. Listing models does not need one. Sign in to continue.'
    }
  }

  if (saysUnauthenticated || code !== 0) {
    if (envKey && !filePresent) {
      return {
        state: 'unauthenticated',
        authenticated: false,
        method: 'api_key_env',
        hasAuthFile: false,
        hasEnvApiKey: true,
        message:
          'XAI_API_KEY is set but the CLI rejected it (or network failed). Fix the key or sign in with browser login.'
      }
    }
    return {
      state: 'unauthenticated',
      authenticated: false,
      method: 'none',
      hasAuthFile: filePresent,
      hasEnvApiKey: envKey,
      message: filePresent
        ? 'Cached credentials look invalid or expired. Sign in again.'
        : 'Not signed in. Sign in with your own Grok account to continue.'
    }
  }

  return {
    state: 'unknown',
    authenticated: false,
    method: 'none',
    hasAuthFile: filePresent,
    hasEnvApiKey: envKey,
    message: 'Could not determine auth status'
  }
}

/**
 * Should a window-focus event trigger a fresh probe?
 *
 * Focus fires on every alt-tab, and a probe spawns the CLI and makes a network
 * call, so an unthrottled refresh turns window switching into request traffic.
 * The interval only has to be short enough that "I just installed the CLI" or
 * "I just signed in elsewhere" self-heals when the user comes back.
 */
export function shouldRefreshOnFocus(
  lastRefreshAt: number | null,
  now: number,
  minIntervalMs: number
): boolean {
  if (lastRefreshAt === null) return true
  return now - lastRefreshAt >= minIntervalMs
}
