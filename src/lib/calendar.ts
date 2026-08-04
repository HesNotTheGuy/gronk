/**
 * Pure view helpers for the activity heatmap: grid layout, intensity steps and
 * label text. No React and no colours. The component only arranges what these
 * functions return, and the palette lives entirely in CSS (see the `level-N`
 * classes below), so a theme change never touches this file.
 *
 * Kept in `.ts` rather than inside the component because Node's test runner can
 * strip types but not JSX (tests/ts-loader.mjs), the same reason src/lib/* holds
 * every other testable renderer helper.
 */

import type { ActivityCalendar, DayActivity } from '../../shared/types'

/**
 * Filled intensity steps, on top of `level-0` for a day with no prompts.
 *
 * Four, because that is how many a single-hue ramp can actually separate at the
 * size of a calendar square. Two or three collapses "a normal day" into "a heavy
 * day", which is the one comparison the heatmap exists to make; five or more
 * produces neighbouring shades a reader cannot tell apart without the tooltip,
 * so the extra step is decoration that costs contrast. The empty day is a
 * separate class rather than the bottom of the ramp because "no work" is a
 * different statement from "a little work", and it must never look like a shade.
 */
export const INTENSITY_LEVELS = 4

/** Sunday-first, matching `Date.getDay()`. */
const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec'
] as const

/**
 * Fixed English names rather than `toLocaleDateString`. The rest of the app's
 * copy is English, and Intl output shifts with the host's ICU data and default
 * locale, which would make these labels, and the tests that pin them, differ
 * per machine.
 */
export const WEEKDAY_LABELS: readonly string[] = WEEKDAY_NAMES

/** A grid column: one week, index 0..6 by weekday. `null` is padding, not a zero day. */
export type WeekColumn = readonly (DayActivity | null)[]

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/

interface ParsedDay {
  year: number
  month: number
  day: number
}

function parseDayKey(date: string): ParsedDay | null {
  const match = DAY_KEY.exec(date)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return { year, month, day }
}

/**
 * Weekday of a `YYYY-MM-DD` key, 0 = Sunday, or -1 when it is unreadable.
 *
 * Built through the local-time Date constructor, never `new Date('2025-07-14')`:
 * the string form is parsed as UTC midnight, which lands on the previous day
 * for every user west of Greenwich and would shift the whole grid by a column.
 */
export function weekdayIndex(date: string): number {
  const parsed = parseDayKey(date)
  if (!parsed) return -1
  return new Date(parsed.year, parsed.month - 1, parsed.day).getDay()
}

/**
 * Flat day list → week columns, each 7 slots deep.
 *
 * The first and last columns are padded with `null` so every row is one weekday
 * all the way across; without that the grid reads as a wall of squares whose
 * rows mean nothing. Padding is `null` rather than a synthetic zero day so the
 * component can render it as empty space instead of as "a day with no work".
 */
export function toWeekColumns(days: readonly DayActivity[], weekStartsOn = 0): WeekColumn[] {
  const start = ((Math.trunc(weekStartsOn) % 7) + 7) % 7
  const columns: (DayActivity | null)[][] = []
  let current: (DayActivity | null)[] | null = null

  for (const day of days) {
    const weekday = weekdayIndex(day.date)
    if (weekday < 0) continue
    const row = (weekday - start + 7) % 7
    if (!current || row === 0) {
      current = [null, null, null, null, null, null, null]
      columns.push(current)
    }
    current[row] = day
  }

  return columns
}

/**
 * A day's `userTurns` → 0..INTENSITY_LEVELS.
 *
 * `peak` is a divisor supplied by the main process, so it is re-guarded here:
 * this function is called once per square and a single NaN would take out the
 * whole grid's class names.
 */
export function intensityLevel(userTurns: number, peak: number): number {
  if (!Number.isFinite(userTurns) || userTurns <= 0) return 0
  const scale = Number.isFinite(peak) && peak > 0 ? peak : userTurns
  const ratio = Math.min(1, userTurns / scale)
  return Math.min(INTENSITY_LEVELS, Math.max(1, Math.ceil(ratio * INTENSITY_LEVELS)))
}

/** Class list for one square. Intensity is a class, never a computed colour. */
export function dayClassName(day: DayActivity | null, peak: number): string {
  if (!day) return 'calendar-day calendar-day-pad'
  return `calendar-day level-${intensityLevel(day.userTurns, peak)}`
}

/** "Mon 14 Jul 2025", or the raw key when it cannot be parsed. */
export function formatDayLabel(date: string): string {
  const parsed = parseDayKey(date)
  if (!parsed) return date
  const weekday = weekdayIndex(date)
  const name = weekday >= 0 ? `${WEEKDAY_NAMES[weekday]} ` : ''
  return `${name}${parsed.day} ${MONTH_NAMES[parsed.month - 1]} ${parsed.year}`
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`
}

/** Hover/`title` text for one square. */
export function dayTooltip(day: DayActivity): string {
  const when = formatDayLabel(day.date)
  if (day.userTurns <= 0) {
    return day.messages > 0
      ? `No prompts on ${when} · ${plural(day.messages, 'message')}`
      : `No activity on ${when}`
  }
  return (
    `${plural(day.userTurns, 'prompt')} on ${when} · ` +
    `${plural(day.messages, 'message')} · ${plural(day.sessions, 'session')}`
  )
}

/** One-line summary above the grid. */
export function calendarSummary(calendar: ActivityCalendar): string {
  const window = `the last ${plural(calendar.days.length, 'day')}`
  if (calendar.totalUserTurns <= 0) {
    return `No prompts in ${window} yet`
  }
  return (
    `${plural(calendar.totalUserTurns, 'prompt')} in ${window} · ` +
    `${calendar.currentStreak}-day streak · best ${plural(calendar.longestStreak, 'day')}`
  )
}

/** A month name and the grid column it starts in, for the strip above the grid. */
export interface MonthLabel {
  /** Index into the week-column array. */
  column: number
  label: string
}

/**
 * Month captions, placed on the first column whose top-most day belongs to a new
 * month.
 *
 * Keyed off the column's first day rather than off "the column containing the
 * 1st": a month that begins mid-week is still mostly the NEXT column, so
 * labelling the column it technically starts in puts the caption above squares
 * that belong to the month before it.
 */
export function monthLabels(weeks: readonly WeekColumn[]): MonthLabel[] {
  const out: MonthLabel[] = []
  let previousMonth = -1
  weeks.forEach((week, column) => {
    const first = week.find((d): d is DayActivity => d !== null)
    if (!first) return
    const parsed = parseDayKey(first.date)
    if (!parsed || parsed.month === previousMonth) return
    previousMonth = parsed.month
    out.push({ column, label: MONTH_NAMES[parsed.month - 1] })
  })
  return out
}
