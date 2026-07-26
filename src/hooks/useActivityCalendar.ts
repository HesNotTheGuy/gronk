import { useCallback, useEffect, useState } from 'react'
import type { ActivityCalendar } from '../../shared/types'

/** A year of squares — the window the main process defaults to. */
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
 * A hook of its own rather than another field on useGronk(): building the
 * calendar re-reads every stored transcript, and folding it into refreshMeta
 * would pay that cost on every settings change, session rename and login — for a
 * panel that is only on screen on Home. Mounting the panel is the event that
 * needs the data, so mounting the panel is what fetches it.
 */
export function useActivityCalendar(days: number = ACTIVITY_CALENDAR_DAYS): ActivityCalendarState {
  const [calendar, setCalendar] = useState<ActivityCalendar | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setCalendar(await window.gronk.getActivityCalendar(days))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [days])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { calendar, loading, error, refresh }
}
