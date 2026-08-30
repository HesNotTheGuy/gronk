/**
 * Relative-time labels on Home / Project / Chat cards ("3d ago") must stay
 * stable in the visual harness. Issue #111: session fixtures were pinned to the
 * heatmap's fixed NOW, so labels walked 3w → 4w as the real calendar moved.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { frequencyLabel, sessionFrequencyLabel } from '../src/lib/activity'
import type { SessionInfo } from '../shared/types'

const HOUR = 3600_000
const DAY = 24 * HOUR
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('a three-day-old session stays "3d ago" against the same clock', () => {
  const now = new Date('2026-08-30T12:00:00').getTime()
  const label = frequencyLabel(now - 3 * DAY, 5, 0.5, now)
  assert.match(label, /3d ago/)
})

test('the same pinned instant reads as weeks later against a later clock', () => {
  // Documents the #111 failure mode: heatmap NOW vs capture Date.now().
  const pinned = new Date('2026-08-02T12:00:00').getTime()
  const fourWeeksLater = pinned + 28 * DAY
  const label = frequencyLabel(pinned, 5, 0.5, fourWeeksLater)
  assert.match(label, /4w ago/)
})

test('sessionFrequencyLabel honours an injected clock', () => {
  const now = new Date('2026-08-30T12:00:00').getTime()
  const session = {
    id: 's',
    cwd: '/tmp/p',
    title: 't',
    createdAt: now - 2 * DAY,
    updatedAt: now - 26 * HOUR,
    surface: 'project' as const,
    messageCount: 1,
    userTurns: 4
  } satisfies SessionInfo
  assert.match(sessionFrequencyLabel(session, now), /1d ago/)
})

test('visual session ages are offsets from LIVE, not the heatmap NOW', () => {
  const shots = fs.readFileSync(path.join(ROOT, 'src/__shots.tsx'), 'utf8')
  assert.match(shots, /const LIVE = Date\.now\(\)/)
  assert.match(shots, /updatedAt: LIVE -/)
  assert.match(shots, /createdAt: LIVE -/)
  // Session cards read updatedAt for "Nd ago". Message timestamps may stay on NOW.
  assert.doesNotMatch(shots, /updatedAt: NOW -/)
})
