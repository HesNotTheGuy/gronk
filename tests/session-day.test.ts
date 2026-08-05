import test from 'node:test'
import assert from 'node:assert/strict'
import {
  filterSessionsByLocalDay,
  isLocalDayKey,
  localDayKey,
  sessionMatchesLocalDay
} from '../src/lib/session-day'
import type { SessionInfo } from '../shared/types'

/**
 * Local wall-clock, same pattern as tests/activity.test.ts: never ISO parse.
 */
function at(year: number, month: number, day: number, hour = 12, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime()
}

function session(
  partial: Partial<SessionInfo> & Pick<SessionInfo, 'id' | 'updatedAt'>
): SessionInfo {
  return {
    cwd: partial.cwd ?? '/proj',
    createdAt: partial.createdAt ?? partial.updatedAt - 1000,
    title: partial.title ?? partial.id,
    ...partial
  }
}

test('localDayKey uses the local zone, not UTC', () => {
  // Evening and just after midnight on either side of a local day boundary.
  const evening = at(2025, 7, 14, 23, 30)
  const afterMidnight = at(2025, 7, 15, 0, 15)
  assert.equal(localDayKey(evening), '2025-07-14')
  assert.equal(localDayKey(afterMidnight), '2025-07-15')
})

test('sessionMatchesLocalDay: evening work stays on that local day', () => {
  const s = session({ id: 'eve', updatedAt: at(2025, 7, 14, 23, 45) })
  assert.equal(sessionMatchesLocalDay(s, '2025-07-14'), true)
  assert.equal(sessionMatchesLocalDay(s, '2025-07-15'), false)
})

test('sessionMatchesLocalDay: just after local midnight is the new day', () => {
  const s = session({ id: 'am', updatedAt: at(2025, 7, 15, 0, 5) })
  assert.equal(sessionMatchesLocalDay(s, '2025-07-15'), true)
  assert.equal(sessionMatchesLocalDay(s, '2025-07-14'), false)
})

test('filterSessionsByLocalDay: empty day returns no sessions', () => {
  const sessions = [
    session({ id: 'a', updatedAt: at(2025, 7, 14, 10) }),
    session({ id: 'b', updatedAt: at(2025, 7, 16, 10) })
  ]
  assert.deepEqual(
    filterSessionsByLocalDay(sessions, '2025-07-15').map((s) => s.id),
    []
  )
})

test('filterSessionsByLocalDay: multi-project day keeps every match', () => {
  const sessions = [
    session({
      id: 'api',
      cwd: '/home/dev/orbital-api',
      updatedAt: at(2025, 7, 14, 9)
    }),
    session({
      id: 'ui',
      cwd: '/home/dev/flux-dashboard',
      updatedAt: at(2025, 7, 14, 18)
    }),
    session({
      id: 'other',
      cwd: '/home/dev/other',
      updatedAt: at(2025, 7, 13, 12)
    })
  ]
  assert.deepEqual(
    filterSessionsByLocalDay(sessions, '2025-07-14').map((s) => s.id),
    ['api', 'ui']
  )
})

test('filterSessionsByLocalDay: null day is a no-op (identity filter)', () => {
  const sessions = [session({ id: 'a', updatedAt: at(2025, 7, 14, 10) })]
  const out = filterSessionsByLocalDay(sessions, null)
  assert.deepEqual(
    out.map((s) => s.id),
    ['a']
  )
  // Returns a shallow copy, not the same array reference, so callers can mutate.
  assert.notEqual(out, sessions)
})

test('filterSessionsByLocalDay: invalid day key is a no-op, not empty', () => {
  const sessions = [session({ id: 'a', updatedAt: at(2025, 7, 14, 10) })]
  assert.deepEqual(
    filterSessionsByLocalDay(sessions, 'not-a-day').map((s) => s.id),
    ['a']
  )
  assert.deepEqual(
    filterSessionsByLocalDay(sessions, '2025-02-31').map((s) => s.id),
    ['a']
  )
})

test('isLocalDayKey rejects garbage and impossible dates', () => {
  assert.equal(isLocalDayKey('2025-07-14'), true)
  assert.equal(isLocalDayKey('2025-2-14'), false)
  assert.equal(isLocalDayKey('2025-02-31'), false)
  assert.equal(isLocalDayKey(''), false)
})

test('non-finite updatedAt never matches a day', () => {
  const s = session({ id: 'bad', updatedAt: Number.NaN })
  assert.equal(sessionMatchesLocalDay(s, '2025-07-14'), false)
})
