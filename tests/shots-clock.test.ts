/**
 * The screenshot harness reads one clock, and it is not the wall clock.
 *
 * A session card renders a relative age ("3d ago") and an absolute stamp
 * (`toLocaleString()`, down to the second) from the same `updatedAt`, and the
 * heat bar's length is a function of recency. Fixtures frozen at a literal while
 * the app read `Date.now()` made the relative half walk as the calendar moved —
 * the suite went red on a schedule with nobody having changed anything, which
 * trains whoever runs it to re-record without reading the diff (issue #111).
 *
 * Pinning the fixtures to a live clock instead fixes the relative half and breaks
 * the absolute half on every single run, which is worse. One frozen clock makes
 * every derived string a function of the same literal.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** Source with comments removed: this file's own prose discusses the rules it pins. */
function code(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
}

const shots = code(fs.readFileSync(path.join(ROOT, 'src/__shots.tsx'), 'utf8'))

test('THE HARNESS FREEZES THE CLOCK TO ITS FIXED INSTANT', () => {
  assert.match(shots, /Date\.now = \(\) => NOW/)
})

test('IT FREEZES BEFORE ANYTHING RENDERS', () => {
  // A freeze after mount leaves the first paint reading the wall clock, which is
  // the same drift wearing a disguise.
  const frozen = shots.indexOf('Date.now = () => NOW')
  const mounted = shots.indexOf('createRoot(')
  assert.ok(frozen > 0 && mounted > 0)
  assert.ok(frozen < mounted, 'the clock is frozen after the app mounts')
})

test('THE FIXED INSTANT IS STILL A LOCAL DATE-TIME LITERAL', () => {
  // A date-only string parses as UTC midnight and shifts the heatmap a column
  // west of Greenwich. Freezing the clock does not make that safe.
  assert.match(shots, /const NOW = new Date\('\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}'\)\.getTime\(\)/)
})

test('NOTHING IN THE RENDERER READS A CLOCK THE FREEZE CANNOT REACH', () => {
  // `Date.now` is overridable; `new Date()` with no arguments is not reached by
  // that override, so one anywhere in src/ silently reopens the drift.
  const offenders: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.tsx?$/.test(entry.name)) {
        // Comments discuss this rule, so strip them: a scan that reads prose
        // reports the sentence explaining the rule as a violation of it.
        if (/new Date\(\s*\)/.test(code(fs.readFileSync(full, 'utf8')))) {
          offenders.push(path.relative(ROOT, full))
        }
      }
    }
  }
  walk(path.join(ROOT, 'src'))
  assert.deepEqual(
    offenders,
    [],
    `argless new Date() bypasses the harness clock: ${offenders.join(', ')}`
  )
})
