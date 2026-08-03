/**
 * Whether a dollar figure means money, and how to label it if it does not.
 *
 * The Grok CLI reports `costUsdTicks` on every turn regardless of how you signed
 * in, so the number is always available. But what it MEANS depends entirely on
 * the credential:
 *
 * - `api_key_env` (XAI_API_KEY): metered, prepaid API credit really is draining,
 *   per token. The figure is money, it is actionable, and it can be checked
 *   against the balance on the account page.
 * - `session` (grok.com login): a subscription. Nothing is billed per token. The
 *   same figure is a notional "what this would have cost at API rates", spent
 *   against quota that was already paid for.
 *
 * Showing `~$0.28 est.` at a glance to a subscriber asserts a charge that will
 * never appear on any statement. That is worse than showing nothing: someone can
 * throttle their own usage over it, or conclude the app is spending their money.
 * So the glanceable summary states dollars only when they are real, while the
 * expanded panel keeps the value under a label that says what it actually is.
 *
 * Token counts, by contrast, are true in every mode and are always shown.
 */

import type { AuthStatus } from '../../shared/types'

/** True only when tokens draw down prepaid API credit. */
export function isBilledPerToken(auth: AuthStatus | null | undefined): boolean {
  return auth?.method === 'api_key_env'
}

/**
 * `null` when the cost must not appear in the glanceable summary bar.
 *
 * Deliberately not "hide it everywhere": the detail panel is opened on purpose,
 * and a clearly-labelled equivalent is useful there.
 */
export function summaryCostLabel(auth: AuthStatus | null | undefined): string | null {
  return isBilledPerToken(auth) ? 'est.' : null
}

/** Row label in the expanded panel, which always shows the figure. */
export function detailCostLabel(auth: AuthStatus | null | undefined): string {
  return isBilledPerToken(auth) ? 'Est. cost' : 'At API rates'
}

/** Explanation attached to whichever figure is on screen. */
export function costNote(auth: AuthStatus | null | undefined): string {
  // Reads directly after "Reported by the Grok CLI." in the panel footer, so it
  // must not restate that.
  if (isBilledPerToken(auth)) {
    return (
      'You are signed in with an API key, so these tokens draw down prepaid ' +
      'credit. Check your xAI account for the authoritative balance.'
    )
  }
  return (
    'What these tokens would cost at API rates. You are signed in with a Grok ' +
    'account, so nothing is billed per token. This usage counts against your ' +
    "plan's quota instead. Shown for scale, not as a charge."
  )
}
