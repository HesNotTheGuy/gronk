import { useMemo, useState } from 'react'
import type { ActivityCalendarState } from '../hooks/useActivityCalendar'
import {
  ACTIVITY_SCOPES,
  calendarSummary,
  dayClassName,
  dayTooltip,
  INTENSITY_LEVELS,
  monthLabels,
  scopedDay,
  toWeekColumns,
  WEEKDAY_LABELS,
  type ActivityScope
} from '../lib/calendar'

/** Weekday rows that carry a caption; the rest stay blank so the column reads cleanly. */
const LABELLED_WEEKDAYS = new Set([1, 3, 5])

const LEGEND_STEPS = Array.from({ length: INTENSITY_LEVELS + 1 }, (_, i) => i)

interface Props {
  /** Lifted above Home so leaving the surface does not wipe the painted grid. */
  state: ActivityCalendarState
  /** Local `YYYY-MM-DD` currently filtering the sidebar, if any. */
  selectedDay?: string | null
  /** Day click — host owns filter state and any surface switch. */
  onSelectDay?: (dayKey: string) => void
}

/**
 * Contribution-style heatmap of the user's own work in Gronk.
 *
 * Every colour, size and gap belongs to `src/styles.css`. Intensity travels as a
 * `level-N` class rather than as a computed style so the palette can be replaced
 * without touching this file.
 *
 * Data comes from a parent-owned `useActivityCalendar` so the grid survives
 * Home unmount. Days are buttons when `onSelectDay` is provided; selection is
 * paint only — filtering lives in the host.
 *
 * The scope filter is one chart over one dataset. Chat and Build are counted
 * per day by the main process, so switching scope re-reads nothing and, more to
 * the point, does not move the scale: `calendar.peak` stays the divisor for
 * every scope, so a square of a given shade means the same amount of work
 * whichever filter is on.
 */
export function ActivityCalendar({ state, selectedDay = null, onSelectDay }: Props) {
  const { calendar, loading, error, refresh } = state
  const [scope, setScope] = useState<ActivityScope>('all')

  const weeks = useMemo(
    () => (calendar ? toWeekColumns(calendar.days.map((d) => scopedDay(d, scope))) : []),
    [calendar, scope]
  )
  const months = useMemo(() => {
    const byColumn = new Map<number, string>()
    for (const label of monthLabels(weeks)) byColumn.set(label.column, label.label)
    return byColumn
  }, [weeks])

  const summary = calendar ? calendarSummary(calendar, scope) : ''
  const selectable = typeof onSelectDay === 'function'

  return (
    <section className="calendar-panel">
      <div className="browse-panel-head">
        <div className="section-label">Activity</div>
        {calendar ? (
          <div className="calendar-head-right">
            <div className="calendar-summary">{summary}</div>
            <div className="calendar-scope" role="group" aria-label="Show activity for">
              {ACTIVITY_SCOPES.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={`calendar-scope-btn ${scope === option.id ? 'active' : ''}`}
                  aria-pressed={scope === option.id}
                  onClick={() => setScope(option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {error ? (
        <div className="calendar-error">
          <span>Could not read your activity: {error}</span>
          <button type="button" className="btn-mini" onClick={() => void refresh()}>
            Try again
          </button>
        </div>
      ) : null}

      {!calendar ? (
        <div className="calendar-empty">
          {loading ? 'Reading your history…' : 'No activity to show yet.'}
        </div>
      ) : (
        <>
          <div className="calendar-scroll">
            <div className="calendar-chart">
              {/* One slot per week column so the captions line up with the grid
                  below without any hard-coded widths. */}
              <div className="calendar-months" aria-hidden>
                {weeks.map((_week, column) => (
                  <span key={`month-${column}`} className="calendar-month">
                    {months.get(column) ?? ''}
                  </span>
                ))}
              </div>

              <div className="calendar-weekdays" aria-hidden>
                {WEEKDAY_LABELS.map((label, row) => (
                  <span key={label} className="calendar-weekday">
                    {LABELLED_WEEKDAYS.has(row) ? label : ''}
                  </span>
                ))}
              </div>

              {/* One image with one description: a screen reader reading 365
                  squares aloud is noise, and the summary is the actual content.
                  Individual day buttons still get a title for pointer users. */}
              <div className="calendar-grid" role="img" aria-label={summary}>
                {weeks.map((week, column) => (
                  <div key={`week-${column}`} className="calendar-week">
                    {week.map((day, row) => {
                      if (!day) {
                        return (
                          <div
                            key={`pad-${column}-${row}`}
                            className={dayClassName(null, calendar.peak)}
                          />
                        )
                      }
                      const classes = [
                        dayClassName(day, calendar.peak),
                        day.date === calendar.to ? 'calendar-day-today' : '',
                        selectedDay === day.date ? 'calendar-day-selected' : ''
                      ]
                        .filter(Boolean)
                        .join(' ')
                      const tip = dayTooltip(day)
                      if (!selectable) {
                        return (
                          <div key={day.date} className={classes} title={tip} />
                        )
                      }
                      return (
                        <button
                          key={day.date}
                          type="button"
                          className={classes}
                          title={`${tip} · show sessions from this day`}
                          aria-pressed={selectedDay === day.date}
                          onClick={() => onSelectDay(day.date)}
                        />
                      )
                    })}
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="calendar-legend" aria-hidden>
            <span className="calendar-legend-label">Less</span>
            {LEGEND_STEPS.map((level) => (
              <span key={level} className={`calendar-day level-${level}`} />
            ))}
            <span className="calendar-legend-label">More</span>
          </div>
        </>
      )}
    </section>
  )
}
