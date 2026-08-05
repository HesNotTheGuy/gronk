/**
 * Local-calendar day matching for session lists.
 *
 * The activity heatmap buckets work by local `YYYY-MM-DD` (see electron/main
 * activity.ts and src/lib/calendar.ts). Day-click filtering must use the same
 * day boundary: UTC slice of an ISO string would put an evening session on the
 * wrong square for anyone west of Greenwich.
 *
 * The renderer only has SessionInfo (updatedAt / createdAt), not per-message
 * timestamps. Matching on `updatedAt` is intentional — "last touched this local
 * day" is what the sidebar can answer without expanding the calendar payload
 * with session ids. Multi-day sessions that were last edited later will not
 * appear under earlier days; that is the trade-off for keeping the payload thin.
 */

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/

/**
 * `YYYY-MM-DD` in the local zone for a unix-ms timestamp.
 * Never `toISOString().slice(0, 10)` — that is UTC.
 */
export function localDayKey(ts: number): string {
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = d.getMonth() + 1
  const day = d.getDate()
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** True when `dayKey` is a plausible local calendar day string. */
export function isLocalDayKey(dayKey: string): boolean {
  if (!DAY_KEY.test(dayKey)) return false
  const [y, m, d] = dayKey.split('-').map(Number)
  // Reject impossible months/days without accepting Date's rollover (e.g. 02-31).
  const dt = new Date(y, m - 1, d)
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d
}

/**
 * Does this session's last activity fall on the given local day?
 * Non-finite updatedAt never matches.
 */
export function sessionMatchesLocalDay(
  session: { updatedAt: number },
  dayKey: string
): boolean {
  if (!isLocalDayKey(dayKey)) return false
  if (!Number.isFinite(session.updatedAt)) return false
  return localDayKey(session.updatedAt) === dayKey
}

/**
 * Filter sessions to those last updated on `dayKey`.
 * `null` / empty / invalid day returns the list unchanged (no silent empty).
 */
export function filterSessionsByLocalDay<T extends { updatedAt: number }>(
  sessions: readonly T[],
  dayKey: string | null | undefined
): T[] {
  if (dayKey == null || dayKey === '' || !isLocalDayKey(dayKey)) {
    return sessions.slice()
  }
  return sessions.filter((s) => sessionMatchesLocalDay(s, dayKey))
}
