import { useMemo } from 'react'
import { useActivityCalendar } from '../hooks/useGronk'
import {
  calendarSummary,
  dayClassName,
  dayTooltip,
  INTENSITY_LEVELS,
  monthLabels,
  toWeekColumns,
  WEEKDAY_LABELS
} from '../lib/calendar'

/** Weekday rows that carry a caption; the rest stay blank so the column reads cleanly. */
const LABELLED_WEEKDAYS = new Set([1, 3, 5])

const LEGEND_STEPS = Array.from({ length: INTENSITY_LEVELS + 1 }, (_, i) => i)

/**
 * Contribution-style heatmap of the user's own work in Gronk.
 *
 * Every colour, size and gap belongs to `src/styles.css`. Intensity travels as a
 * `level-N` class rather than as a computed style so the palette can be replaced
 * without touching this file — see the class list in the styling notes.
 *
 * Self-contained on purpose: it fetches its own data through
 * `useActivityCalendar`, so mounting it anywhere costs the host component no
 * props and no plumbing.
 */
export function ActivityCalendar() {
  const { calendar, loading, error, refresh } = useActivityCalendar()

  const weeks = useMemo(() => (calendar ? toWeekColumns(calendar.days) : []), [calendar])
  const months = useMemo(() => {
    const byColumn = new Map<number, string>()
    for (const label of monthLabels(weeks)) byColumn.set(label.column, label.label)
    return byColumn
  }, [weeks])

  const summary = calendar ? calendarSummary(calendar) : ''

  return (
    <section className="calendar-panel">
      <div className="browse-panel-head">
        <div className="section-label">Activity</div>
        {calendar ? <div className="calendar-summary">{summary}</div> : null}
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
                  squares aloud is noise, and the summary is the actual content. */}
              <div className="calendar-grid" role="img" aria-label={summary}>
                {weeks.map((week, column) => (
                  <div key={`week-${column}`} className="calendar-week">
                    {week.map((day, row) => (
                      <div
                        key={day ? day.date : `pad-${column}-${row}`}
                        className={
                          day && day.date === calendar.to
                            ? `${dayClassName(day, calendar.peak)} calendar-day-today`
                            : dayClassName(day, calendar.peak)
                        }
                        title={day ? dayTooltip(day) : undefined}
                      />
                    ))}
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
