import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { __freshUserData } from './stubs/electron'
import {
  buildActivityCalendar,
  clampCalendarDays,
  computeStreaks,
  dayKeyRange,
  getActivityCalendar,
  localDayKey,
  usableCount,
  usableTimestamp,
  type SessionActivity
} from '../electron/main/activity'
import {
  calendarSummary,
  dayClassName,
  dayTooltip,
  formatDayLabel,
  intensityLevel,
  INTENSITY_LEVELS,
  monthLabels,
  toWeekColumns,
  weekdayIndex
} from '../src/lib/calendar'
import { saveTranscript, upsertSession } from '../electron/main/store'
import type { ChatMessage, DayActivity } from '../shared/types'

/**
 * Local wall-clock time, whatever zone the machine running the suite is in.
 * `new Date(2025, 6, 14, 23, 59)` is 23:59 for that user; `Date.parse` of an ISO
 * string is not, and would make these assertions pass or fail by geography.
 */
function at(year: number, month: number, day: number, hour = 12, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime()
}

// Only the store-backed tests at the bottom touch disk, but the directory is
// swapped for every case so nothing can leak into the developer's real store.
beforeEach(() => {
  __freshUserData()
})

function userMsg(ts: number): { role: string; createdAt: number } {
  return { role: 'user', createdAt: ts }
}

function assistantMsg(ts: number): { role: string; createdAt: number } {
  return { role: 'assistant', createdAt: ts }
}

/** Session whose turns all land on the given local days. */
function sessionOn(id: string, days: number[][]): SessionActivity {
  return {
    id,
    messages: days.map(([y, m, d]) => userMsg(at(y, m, d, 10)))
  }
}

function day(calendar: { days: DayActivity[] }, date: string): DayActivity {
  const found = calendar.days.find((d) => d.date === date)
  assert.ok(found, `expected ${date} to be present in the calendar`)
  return found
}

// ── Local-day bucketing ─────────────────────────────────────────────

test('timestamps either side of local midnight land on different local days', () => {
  // UTC bucketing puts 23:59 on the next day west of Greenwich, and 00:01 on the
  // previous day east of it — so this fails in either hemisphere if the module
  // ever goes back to toISOString().
  const before = at(2025, 7, 14, 23, 59)
  const after = at(2025, 7, 15, 0, 1)
  assert.equal(localDayKey(before), '2025-07-14')
  assert.equal(localDayKey(after), '2025-07-15')

  const calendar = buildActivityCalendar(
    [{ id: 's1', messages: [userMsg(before), userMsg(after)] }],
    { now: at(2025, 7, 20, 10), days: 30 }
  )
  assert.equal(day(calendar, '2025-07-14').userTurns, 1)
  assert.equal(day(calendar, '2025-07-15').userTurns, 1)
})

test('the window is contiguous, zero-filled and ends on today', () => {
  const calendar = buildActivityCalendar([], { now: at(2025, 7, 20, 9), days: 10 })
  assert.equal(calendar.days.length, 10)
  assert.equal(calendar.from, '2025-07-11')
  assert.equal(calendar.to, '2025-07-20')
  assert.deepEqual(
    calendar.days.map((d) => d.date),
    [
      '2025-07-11',
      '2025-07-12',
      '2025-07-13',
      '2025-07-14',
      '2025-07-15',
      '2025-07-16',
      '2025-07-17',
      '2025-07-18',
      '2025-07-19',
      '2025-07-20'
    ]
  )
  assert.ok(calendar.days.every((d) => d.userTurns === 0 && d.messages === 0 && d.sessions === 0))
})

test('a full-year window has no duplicate or missing day, across DST', () => {
  // 366 consecutive local days cross every transition the host zone has. Adding
  // 86_400_000 ms per step instead of stepping the calendar date emits a
  // duplicate on one of them and skips a day on the other.
  const keys = dayKeyRange(at(2025, 7, 20, 3), 366)
  assert.equal(keys.length, 366)
  assert.equal(new Set(keys).size, 366)
  assert.deepEqual([...keys].sort(), keys, 'keys must already be in ascending order')
})

test('a window longer than a year is clamped instead of allocating it', () => {
  assert.equal(clampCalendarDays(1e9), 366)
  assert.equal(clampCalendarDays(0), 1)
  assert.equal(clampCalendarDays(-5), 1)
  assert.equal(clampCalendarDays(30.9), 30)
  assert.equal(clampCalendarDays('365'), 365, 'a non-number falls back to the default')
  assert.equal(clampCalendarDays(undefined), 365)
  assert.equal(clampCalendarDays(Number.NaN), 365)
})

// ── Counting ────────────────────────────────────────────────────────

test('peak comes from userTurns, not from the assistant messages around them', () => {
  const chatty = at(2025, 7, 15, 9)
  const working = at(2025, 7, 17, 9)
  const calendar = buildActivityCalendar(
    [
      {
        id: 's1',
        messages: [
          userMsg(chatty),
          ...Array.from({ length: 9 }, () => assistantMsg(chatty)),
          userMsg(working),
          userMsg(working),
          userMsg(working),
          assistantMsg(working)
        ]
      }
    ],
    { now: at(2025, 7, 20, 9), days: 10 }
  )

  assert.equal(day(calendar, '2025-07-15').messages, 10)
  assert.equal(day(calendar, '2025-07-15').userTurns, 1)
  assert.equal(day(calendar, '2025-07-17').userTurns, 3)
  assert.equal(calendar.peak, 3, 'ten messages must not outrank three prompts')
  assert.equal(calendar.totalUserTurns, 4)
})

test('distinct sessions touched on a day are counted once each', () => {
  const when = at(2025, 7, 18, 14)
  const calendar = buildActivityCalendar(
    [
      { id: 's1', messages: [userMsg(when), userMsg(when)] },
      { id: 's2', messages: [userMsg(when)] }
    ],
    { now: at(2025, 7, 20, 9), days: 10 }
  )
  assert.equal(day(calendar, '2025-07-18').sessions, 2)
  assert.equal(day(calendar, '2025-07-18').userTurns, 3)
})

test('a session with no stored transcript falls back to its row counters', () => {
  const calendar = buildActivityCalendar(
    [{ id: 's1', updatedAt: at(2025, 7, 16, 20), messageCount: 12, userTurns: 5 }],
    { now: at(2025, 7, 20, 9), days: 10 }
  )
  assert.equal(day(calendar, '2025-07-16').userTurns, 5)
  assert.equal(day(calendar, '2025-07-16').messages, 12)
  assert.equal(day(calendar, '2025-07-16').sessions, 1)
})

test('a readable transcript wins over the row even when it falls outside the window', () => {
  const calendar = buildActivityCalendar(
    [
      {
        id: 's1',
        updatedAt: at(2025, 7, 18, 20),
        messageCount: 40,
        userTurns: 20,
        messages: [userMsg(at(2025, 5, 1, 9))]
      }
    ],
    { now: at(2025, 7, 20, 9), days: 10 }
  )
  assert.equal(calendar.totalUserTurns, 0, 'old work must not be re-dated onto updatedAt')
})

// ── Hostile data ────────────────────────────────────────────────────

test('missing, non-numeric, negative and absurd-future timestamps are skipped', () => {
  const now = at(2025, 7, 20, 9)
  assert.equal(usableTimestamp(undefined, now), null)
  assert.equal(usableTimestamp(null, now), null)
  assert.equal(usableTimestamp('2025-07-15', now), null)
  assert.equal(usableTimestamp(Number.NaN, now), null)
  assert.equal(usableTimestamp(Number.POSITIVE_INFINITY, now), null)
  assert.equal(usableTimestamp(-1, now), null)
  assert.equal(usableTimestamp(0, now), null)
  assert.equal(usableTimestamp(now + 400 * 24 * 60 * 60 * 1000, now), null)
  assert.equal(usableTimestamp(now, now), now)
})

test('a transcript full of garbage produces a calendar instead of an exception', () => {
  const now = at(2025, 7, 20, 9)
  const build = (): ReturnType<typeof buildActivityCalendar> =>
    buildActivityCalendar(
      [
        {
          id: 's1',
          updatedAt: 'whenever',
          messages: [
            { role: 'user' },
            { role: 'user', createdAt: null },
            { role: 'user', createdAt: 'yesterday' },
            { role: 'user', createdAt: Number.NaN },
            { role: 'user', createdAt: -17 },
            { role: 'user', createdAt: now + 10 * 365 * 24 * 60 * 60 * 1000 },
            { role: 'user', createdAt: at(2025, 7, 19, 11) }
          ]
        },
        { id: '', messages: [userMsg(at(2025, 7, 19, 11))] },
        // A row is not a session without an id; a whole missing entry must not throw.
        undefined as unknown as SessionActivity
      ],
      { now, days: 10 }
    )

  assert.doesNotThrow(build)
  const calendar = build()

  assert.equal(calendar.days.length, 10)
  assert.equal(calendar.totalUserTurns, 1, 'only the one readable timestamp counts')
  assert.equal(day(calendar, '2025-07-19').userTurns, 1)
  assert.ok(
    calendar.days.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date)),
    'no bogus day key may reach the grid'
  )
})

test('nonsense row counters cannot set the peak', () => {
  assert.equal(usableCount('12'), 0)
  assert.equal(usableCount(-4), 0)
  assert.equal(usableCount(Number.NaN), 0)
  assert.equal(usableCount(Number.POSITIVE_INFINITY), 0)
  assert.equal(usableCount(7.9), 7)
  assert.equal(usableCount(1e9), 10_000, 'capped, so one damaged row cannot flatten the ramp')
})

test('an empty store still yields a contiguous calendar with a usable scale', () => {
  const calendar = buildActivityCalendar([], { now: at(2025, 7, 20, 9), days: 365 })
  assert.equal(calendar.days.length, 365)
  assert.equal(calendar.totalUserTurns, 0)
  assert.equal(calendar.currentStreak, 0)
  assert.equal(calendar.longestStreak, 0)
  assert.equal(calendar.peak, 1, 'peak is floored so the renderer never divides by zero')
  assert.ok(calendar.days.every((d) => intensityLevel(d.userTurns, calendar.peak) === 0))
})

// ── Streaks ─────────────────────────────────────────────────────────

test('the current streak counts back from today and stops at a gap', () => {
  const calendar = buildActivityCalendar(
    [
      sessionOn('s1', [
        [2025, 7, 20],
        [2025, 7, 19],
        [2025, 7, 18],
        // 17th is a gap
        [2025, 7, 16],
        [2025, 7, 15],
        [2025, 7, 14],
        [2025, 7, 13]
      ])
    ],
    { now: at(2025, 7, 20, 21), days: 14 }
  )
  assert.equal(calendar.currentStreak, 3)
  assert.equal(calendar.longestStreak, 4)
})

test('a today with no work yet does not break the streak, but a finished empty day does', () => {
  const days = (dates: number[]): DayActivity[] =>
    ['2025-07-17', '2025-07-18', '2025-07-19', '2025-07-20'].map((date, i) => ({
      date,
      userTurns: dates[i],
      messages: dates[i],
      sessions: dates[i] > 0 ? 1 : 0
    }))

  // Nothing done today: yesterday's run is still alive — today is not over.
  assert.equal(computeStreaks(days([1, 1, 1, 0]), '2025-07-20').currentStreak, 3)
  // Yesterday is over and was empty; the streak is genuinely broken.
  assert.equal(computeStreaks(days([1, 1, 0, 0]), '2025-07-20').currentStreak, 0)
  // Worked today after a break: the streak restarts at one.
  assert.equal(computeStreaks(days([1, 1, 0, 1]), '2025-07-20').currentStreak, 1)
  assert.equal(computeStreaks(days([0, 0, 0, 0]), '2025-07-20').longestStreak, 0)
  assert.equal(computeStreaks(days([1, 1, 1, 1]), '2025-07-20').longestStreak, 4)
})

// ── Grid layout (src/lib/calendar.ts) ───────────────────────────────

test('week columns are seven deep and padded so each row is one weekday', () => {
  const calendar = buildActivityCalendar([], { now: at(2025, 7, 20, 9), days: 40 })
  const weeks = toWeekColumns(calendar.days)

  assert.ok(weeks.length >= 6)
  for (const week of weeks) {
    assert.equal(week.length, 7)
    week.forEach((cell, row) => {
      if (cell) assert.equal(weekdayIndex(cell.date), row, `${cell.date} belongs in row ${row}`)
    })
  }

  const flat = weeks.flat().filter((d): d is DayActivity => d !== null)
  assert.equal(flat.length, calendar.days.length, 'no day may be lost or duplicated')
  assert.deepEqual(
    flat.map((d) => d.date),
    calendar.days.map((d) => d.date)
  )

  // 2025-06-11 is a Wednesday, so the first column carries three padding slots.
  assert.equal(calendar.from, '2025-06-11')
  assert.deepEqual(weeks[0].slice(0, 3), [null, null, null])
  assert.equal(weeks[0][3]?.date, '2025-06-11')
})

test('an empty day list produces no columns rather than an empty column', () => {
  assert.deepEqual(toWeekColumns([]), [])
  assert.equal(weekdayIndex('not-a-date'), -1)
  assert.equal(weekdayIndex('2025-13-40'), -1)
})

test('intensity is a level class, clamped and never NaN', () => {
  assert.equal(intensityLevel(0, 10), 0)
  assert.equal(intensityLevel(-3, 10), 0)
  assert.equal(intensityLevel(1, 10), 1)
  assert.equal(intensityLevel(10, 10), INTENSITY_LEVELS)
  assert.equal(intensityLevel(99, 10), INTENSITY_LEVELS, 'above peak still clamps to the top step')
  assert.equal(intensityLevel(4, 0), INTENSITY_LEVELS, 'a zero peak must not divide by zero')
  assert.equal(intensityLevel(4, Number.NaN), INTENSITY_LEVELS)

  assert.equal(
    dayClassName({ date: '2025-07-14', userTurns: 5, messages: 9, sessions: 1 }, 10),
    'calendar-day level-2'
  )
  assert.equal(dayClassName(null, 10), 'calendar-day calendar-day-pad')
})

test('month captions mark the first column of each new month', () => {
  const calendar = buildActivityCalendar([], { now: at(2025, 7, 20, 9), days: 70 })
  const labels = monthLabels(toWeekColumns(calendar.days))
  assert.deepEqual(
    labels.map((l) => l.label),
    ['May', 'Jun', 'Jul']
  )
  assert.ok(
    labels.every((l, i) => i === 0 || l.column > labels[i - 1].column),
    'captions must advance across the grid'
  )
})

// ── Labels ──────────────────────────────────────────────────────────

test('day labels and tooltips read as sentences and pluralise correctly', () => {
  assert.equal(formatDayLabel('2025-07-14'), 'Mon 14 Jul 2025')
  assert.equal(formatDayLabel('nonsense'), 'nonsense')
  assert.equal(
    dayTooltip({ date: '2025-07-14', userTurns: 1, messages: 1, sessions: 1 }),
    '1 prompt on Mon 14 Jul 2025 · 1 message · 1 session'
  )
  assert.equal(
    dayTooltip({ date: '2025-07-14', userTurns: 3, messages: 12, sessions: 2 }),
    '3 prompts on Mon 14 Jul 2025 · 12 messages · 2 sessions'
  )
  assert.equal(
    dayTooltip({ date: '2025-07-14', userTurns: 0, messages: 0, sessions: 0 }),
    'No activity on Mon 14 Jul 2025'
  )
})

test('the summary states the window, the streak and the best run', () => {
  const empty = buildActivityCalendar([], { now: at(2025, 7, 20, 9), days: 365 })
  assert.equal(calendarSummary(empty), 'No prompts in the last 365 days yet')

  const worked = buildActivityCalendar(
    [
      sessionOn('s1', [
        [2025, 7, 20],
        [2025, 7, 19]
      ])
    ],
    { now: at(2025, 7, 20, 9), days: 365 }
  )
  assert.equal(
    calendarSummary(worked),
    '2 prompts in the last 365 days · 2-day streak · best 2 days'
  )
})

// ── Store shim ──────────────────────────────────────────────────────

test('getActivityCalendar reads the real store and dates today\'s work to today', () => {
  const now = Date.now()
  upsertSession({ id: 'live', cwd: 'C:/work/app', createdAt: now, updatedAt: now })
  const messages: ChatMessage[] = [
    { id: 'm1', role: 'user', text: 'hello', createdAt: now },
    { id: 'm2', role: 'assistant', text: 'hi', createdAt: now }
  ]
  saveTranscript('live', messages)

  const calendar = getActivityCalendar(30)
  assert.equal(calendar.days.length, 30)
  assert.equal(calendar.to, localDayKey(now))
  assert.equal(day(calendar, localDayKey(now)).userTurns, 1)
  assert.equal(day(calendar, localDayKey(now)).messages, 2)
  assert.equal(day(calendar, localDayKey(now)).sessions, 1)
  assert.equal(calendar.currentStreak, 1)
})

test('getActivityCalendar on a fresh install is empty but well formed', () => {
  const calendar = getActivityCalendar()
  assert.equal(calendar.days.length, 365)
  assert.equal(calendar.totalUserTurns, 0)
  assert.equal(calendar.peak, 1)
  assert.equal(calendar.from, dayKeyRange(Date.now(), 365)[0])
})
