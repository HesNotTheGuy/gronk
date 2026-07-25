/**
 * Single-flight + short-TTL memoization for CLI probes.
 *
 * Several probes (`grok models` for the auth check, and again for the model list)
 * spawn a process AND make an authenticated network call to xAI. They had no
 * caching and no de-duplication, so opening the app fired three concurrent copies
 * of the same probe, and every session-restore click fired another. Nothing here
 * is billed as inference, but it is an unthrottled request on a hot path — the
 * kind of thing that trips a provider rate limit and then looks like an auth bug.
 *
 * Single-flight is the more important half: the app's startup path runs its
 * probes inside one `Promise.all`, so they are concurrent, and de-duplication
 * collapses them without any staleness at all.
 *
 * Deliberately dependency-free and pure so it can be unit tested — the clock is
 * injected rather than read from Date.now().
 */

export interface CachedProbeOptions {
  /** How long a resolved value stays fresh, in milliseconds. */
  ttlMs: number
  /** Injectable clock. Defaults to Date.now; tests pass their own. */
  now?: () => number
}

export interface CachedProbe<T> {
  /** Run the probe, or return a fresh cached value, or join an in-flight call. */
  get: () => Promise<T>
  /** Drop any cached value. Call after an action that changes the answer. */
  invalidate: () => void
}

/**
 * Wrap an async probe so that concurrent callers share one execution and
 * repeated callers reuse the result until it goes stale.
 *
 * A rejected probe is never cached — a transient failure must not pin an error
 * for the whole TTL — but it IS single-flighted, so a burst of callers during an
 * outage still produces one attempt rather than one per caller.
 */
export function cachedProbe<T>(fn: () => Promise<T>, options: CachedProbeOptions): CachedProbe<T> {
  const now = options.now ?? Date.now
  const ttlMs = Math.max(0, options.ttlMs)

  let value: T | undefined
  let storedAt = 0
  let hasValue = false
  let inFlight: Promise<T> | null = null

  function invalidate(): void {
    hasValue = false
    value = undefined
    storedAt = 0
  }

  async function get(): Promise<T> {
    if (hasValue && now() - storedAt < ttlMs) return value as T
    if (inFlight) return inFlight

    const run = (async () => {
      try {
        const result = await fn()
        value = result
        storedAt = now()
        hasValue = true
        return result
      } finally {
        // Cleared in `finally` so a rejection also releases the slot; otherwise
        // one failed probe would wedge every later caller onto a dead promise.
        inFlight = null
      }
    })()

    inFlight = run
    return run
  }

  return { get, invalidate }
}
