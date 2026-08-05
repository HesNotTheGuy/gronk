/**
 * Per-day activity for the contribution-style heatmap on Home.
 *
 * Split the way plugins-map.ts and cli-version.ts are: every date, bucketing and
 * streak decision below is pure and covered by tests/activity.test.ts, and
 * `getActivityCalendar` is a thin shim that reads the store and hands the rows to
 * those functions. Nothing here calls `Date.now()` except that shim — "now" is a
 * parameter, so a test never has to wait for midnight to reproduce a bug.
 *
 * The data is the user's own transcript store: a JSON file they can edit, that a
 * crash can truncate, and that older builds wrote with fields this one has never
 * seen. Every timestamp and count is therefore validated rather than trusted, and
 * anything unreadable is skipped instead of throwing — a corrupt row must cost
 * one square, not the whole calendar.
 */

import { getTranscript, listSessions } from './store'
import type { ActivityCalendar, AgentSurface, DayActivity, DayCounts } from '../../shared/types'

/** A year of squares, the same window GitHub shows. */
export const DEFAULT_CALENDAR_DAYS = 365

/** One leap year. Beyond this the grid stops fitting and the store has nothing left to show. */
const MAX_CALENDAR_DAYS = 366

/**
 * A transcript message as it sits on disk. Deliberately looser than ChatMessage:
 * the declared types describe what THIS build writes, and the file may hold what
 * an older one wrote, what a hand edit left behind, or what a half-finished write
 * truncated. `createdAt` is `unknown` because that is the honest type for it.
 */
export interface TranscriptEntry {
  role?: string
  createdAt?: unknown
}

/** One session's contribution to the calendar, as read off the store. */
export interface SessionActivity {
  id: string
  /**
   * Which half of the app this session belongs to, for the heatmap's scope
   * filter. Anything that is not `chat` counts as Build, including a row from
   * an older build that never wrote the field: the store resolves a missing
   * surface to `project` on read, and guessing Chat for an unreadable value
   * would put work with a folder behind it in the column that means "no folder".
   */
  surface?: unknown
  /**
   * Newest activity on the session row. Only used when the transcript is gone —
   * see `buildActivityCalendar` for why that fallback exists.
   */
  updatedAt?: unknown
  messageCount?: unknown
  userTurns?: unknown
  /** The stored transcript, when the store still has one for this session. */
  messages?: readonly TranscriptEntry[]
}

export interface CalendarOptions {
  /** Epoch ms treated as "now". A parameter, never read from the clock here. */
  now: number
  /** Window length in days, inclusive of today. Clamped. */
  days: number
}

/**
 * A clock reading far enough ahead of `now` to be a bad value rather than a
 * clock skew. A day of tolerance covers a machine whose clock is a little fast
 * and a transcript synced from one that was; anything further would put work in
 * the user's future, where the window cannot show it anyway.
 */
const FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000

/**
 * Ceiling on a count taken off a session row. The store caps a transcript at 200
 * messages, so a row claiming more than this is damaged — and a damaged row must
 * not be able to set `peak` and flatten every real day to level 1.
 */
const MAX_ROW_COUNT = 10_000

/** Requested window → one this module will actually build. */
export function clampCalendarDays(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_CALENDAR_DAYS
  return Math.min(MAX_CALENDAR_DAYS, Math.max(1, Math.floor(value)))
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/**
 * `YYYY-MM-DD` in the LOCAL zone.
 *
 * Deliberately not `toISOString().slice(0, 10)`, which is UTC: a user in UTC-6
 * working at 20:00 would see that session on tomorrow's square, and a heatmap
 * whose day boundary the user does not recognise reads as a broken app rather
 * than as a timezone choice.
 */
export function localDayKey(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getFullYear()).padStart(4, '0')}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/**
 * The window's day keys, oldest first, ending on the local day of `now`.
 *
 * Built by stepping the local calendar date rather than by adding 86_400_000 ms:
 * a DST transition makes a day 23 or 25 hours long, and fixed-width arithmetic
 * across one silently emits a duplicate or skips a day — a hole the grid cannot
 * lay out.
 */
export function dayKeyRange(now: number, days: number): string[] {
  const span = clampCalendarDays(days)
  const cursor = new Date(now)
  cursor.setHours(0, 0, 0, 0)
  cursor.setDate(cursor.getDate() - (span - 1))
  const keys: string[] = []
  for (let i = 0; i < span; i++) {
    keys.push(localDayKey(cursor.getTime()))
    cursor.setDate(cursor.getDate() + 1)
  }
  return keys
}

/** A timestamp we are willing to place on the calendar, or null to skip it. */
export function usableTimestamp(value: unknown, now: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  // <= 0 covers missing, negative and the 1970 sentinel a dropped field leaves.
  if (value <= 0) return null
  if (value > now + FUTURE_TOLERANCE_MS) return null
  return value
}

/** A count off a session row, or 0 when it is missing or nonsense. */
export function usableCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return Math.min(MAX_ROW_COUNT, Math.floor(value))
}

interface DayBucket {
  userTurns: number
  messages: number
  sessions: Set<string>
  chat: ScopeBucket
  build: ScopeBucket
}

interface ScopeBucket {
  userTurns: number
  messages: number
  sessions: Set<string>
}

function emptyScope(): ScopeBucket {
  return { userTurns: 0, messages: 0, sessions: new Set<string>() }
}

function counts(bucket: ScopeBucket): DayCounts {
  return { userTurns: bucket.userTurns, messages: bucket.messages, sessions: bucket.sessions.size }
}

/** Chat only when the row says so. See SessionActivity.surface for why. */
function scopeOf(surface: unknown): 'chat' | 'build' {
  return (surface as AgentSurface) === 'chat' ? 'chat' : 'build'
}

/**
 * Consecutive worked days ending today, and the longest such run in the window.
 *
 * A day counts as worked when the user sent at least one prompt — assistant
 * messages are the machine's output, not the user's, and a session that streamed
 * a long reply is not a second day of work.
 *
 * THE FORGIVENESS RULE: an empty TODAY does not break the current streak; the
 * count simply starts at yesterday. Today is still in progress, so treating "has
 * not worked yet this morning" as a broken streak would show every user a zero
 * until they open the app, which is both wrong and the exact discouragement the
 * widget exists to avoid. A gap of a COMPLETED day does break it — that day is
 * over and nothing was done in it. This is what GitHub does, for this reason.
 */
export function computeStreaks(
  days: readonly DayActivity[],
  todayKey: string
): { currentStreak: number; longestStreak: number } {
  let longest = 0
  let run = 0
  for (const day of days) {
    run = day.userTurns > 0 ? run + 1 : 0
    if (run > longest) longest = run
  }

  let index = days.length - 1
  // The window ends on today by construction; the lookup keeps the function
  // honest for a caller that hands over some other range.
  const todayIndex = days.findIndex((d) => d.date === todayKey)
  if (todayIndex >= 0) index = todayIndex
  if (index >= 0 && days[index].userTurns === 0) index--

  let current = 0
  for (let i = index; i >= 0 && days[i].userTurns > 0; i--) current++

  return { currentStreak: current, longestStreak: longest }
}

/**
 * Fold session transcripts into one square per local day.
 *
 * Every day in the window is emitted, zero-filled — a heatmap with holes cannot
 * be laid out as a grid, and "no work" is a fact worth a square of its own.
 *
 * A session with a readable transcript is bucketed by its message timestamps.
 * One WITHOUT falls back to the session row's `updatedAt` plus its stored
 * counters: the store keeps 50 session rows but only 40 transcripts, so the
 * alternative is a heavy user's older months quietly emptying out. The fallback
 * lands the whole session on its last-active day, which is approximate for a
 * session spanning several — approximate and visible beats accurate and missing.
 * A session that HAS timestamps never takes this path, even when they all fall
 * outside the window: the transcript is the truth about when that work happened.
 */
export function buildActivityCalendar(
  sessions: readonly SessionActivity[],
  options: CalendarOptions
): ActivityCalendar {
  const { now } = options
  const keys = dayKeyRange(now, options.days)
  const buckets = new Map<string, DayBucket>()
  for (const key of keys) {
    buckets.set(key, {
      userTurns: 0,
      messages: 0,
      sessions: new Set<string>(),
      chat: emptyScope(),
      build: emptyScope()
    })
  }

  for (const session of sessions ?? []) {
    const id = typeof session?.id === 'string' ? session.id : ''
    if (!id) continue

    const scope = scopeOf(session.surface)

    let placed = false
    for (const message of session.messages ?? []) {
      const ts = usableTimestamp(message?.createdAt, now)
      if (ts === null) continue
      placed = true
      const bucket = buckets.get(localDayKey(ts))
      if (!bucket) continue
      bucket.messages++
      bucket[scope].messages++
      if (message?.role === 'user') {
        bucket.userTurns++
        bucket[scope].userTurns++
      }
      bucket.sessions.add(id)
      bucket[scope].sessions.add(id)
    }
    if (placed) continue

    const ts = usableTimestamp(session.updatedAt, now)
    if (ts === null) continue
    const bucket = buckets.get(localDayKey(ts))
    if (!bucket) continue
    const rowTurns = usableCount(session.userTurns)
    // A user turn IS a message, so a row claiming more prompts than messages is
    // inconsistent; the larger of the two is the only reading that keeps
    // `messages >= userTurns` true for every square.
    const rowMessages = Math.max(usableCount(session.messageCount), rowTurns)
    if (!rowMessages) continue
    bucket.messages += rowMessages
    bucket.userTurns += rowTurns
    bucket.sessions.add(id)
    bucket[scope].messages += rowMessages
    bucket[scope].userTurns += rowTurns
    bucket[scope].sessions.add(id)
  }

  const days: DayActivity[] = keys.map((date) => {
    const bucket = buckets.get(date)!
    return {
      date,
      userTurns: bucket.userTurns,
      messages: bucket.messages,
      sessions: bucket.sessions.size,
      chat: counts(bucket.chat),
      build: counts(bucket.build)
    }
  })

  let peak = 0
  let totalUserTurns = 0
  for (const day of days) {
    if (day.userTurns > peak) peak = day.userTurns
    totalUserTurns += day.userTurns
  }

  const todayKey = localDayKey(now)
  const { currentStreak, longestStreak } = computeStreaks(days, todayKey)

  return {
    days,
    from: days[0].date,
    to: days[days.length - 1].date,
    // Floored at 1 because this value is a DIVISOR in the renderer's intensity
    // ramp. On an install with no work yet the honest peak is 0, and every scale
    // built from it is a division by zero; 1 says the same thing ("no day beat
    // one prompt") and cannot produce NaN squares.
    peak: Math.max(1, peak),
    totalUserTurns,
    currentStreak,
    longestStreak
  }
}

// ── Store shim ──────────────────────────────────────────────────────

/**
 * Read the store and build the calendar. The only impure function in this file.
 *
 * One `getTranscript` call per session, each of which re-reads the store file —
 * bounded by the store's own 50-session cap and paid on a Home render, not per
 * frame. Worth it to keep store.ts untouched rather than reaching into its
 * internals for a bulk read.
 */
export function getActivityCalendar(days: unknown = DEFAULT_CALENDAR_DAYS): ActivityCalendar {
  // Archived and chat sessions are included on purpose: this is a record of the
  // user's own work in the app, and hiding a conversation from a list does not
  // un-happen the afternoon spent on it.
  const sessions: SessionActivity[] = listSessions().map((s) => {
    let messages: readonly TranscriptEntry[] = []
    try {
      messages = getTranscript(s.id)
    } catch {
      /* one unreadable transcript falls back to the session row below */
    }
    return {
      id: s.id,
      surface: s.surface,
      updatedAt: s.updatedAt,
      messageCount: s.messageCount,
      userTurns: s.userTurns,
      messages
    }
  })
  return buildActivityCalendar(sessions, { now: Date.now(), days: clampCalendarDays(days) })
}
