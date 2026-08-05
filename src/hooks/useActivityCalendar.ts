import { useCallback, useRef, useState } from 'react'
import type { ActivityCalendar } from '../../shared/types'

/** A year of squares: the window the main process defaults to. */
export const ACTIVITY_CALENDAR_DAYS = 365

export interface ActivityCalendarState {
  calendar: ActivityCalendar | null
  loading: boolean
  /** Set only when the read failed; the panel says so instead of showing nothing. */
  error: string | null
  refresh: () => Promise<void>
}

/**
 * Per-day activity for the Home heatmap.
 *
 * Kept out of useGronk / refreshMeta on purpose: building the calendar re-reads
 * every stored transcript (up to 50 sessions — see activity.ts getActivityCalendar),
 * and that cost is justified as paid on a Home visit, not per frame and not on
 * every completed turn.
 *
 * The hook lives above the Home surface switch so navigating away does not
 * unmount it and wipe the painted grid. It does **not** auto-fetch on session
 * catalog changes. The host calls `refresh()` when Home becomes visible; soft
 * refresh keeps the last calendar painted while the next one loads.
 */
export function useActivityCalendar(
  days: number = ACTIVITY_CALENDAR_DAYS
): ActivityCalendarState {
  const [calendar, setCalendar] = useState<ActivityCalendar | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const calendarRef = useRef<ActivityCalendar | null>(null)
  calendarRef.current = calendar

  const refresh = useCallback(async () => {
    // Soft refetch: only the empty first paint shows "Reading…". Returning to
    // Home must not blank the grid while the next calendar arrives.
    if (!calendarRef.current) setLoading(true)
    try {
      setCalendar(await window.gronk.getActivityCalendar(days))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [days])

  return { calendar, loading, error, refresh }
}
