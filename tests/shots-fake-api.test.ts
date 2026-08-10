import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The screenshot harness's fake bridge implements every method the app calls.
 *
 * `src/__shots.tsx` mounts the real `<App/>` against a hand-written fake of
 * `window.gronk`, and it is the only way anyone sees the app without launching
 * it — the visual baselines are rendered from it. It is a second fake of the same
 * interface, kept by hand, next to `tests/helpers/gronk-api.ts`, and the two drift
 * independently.
 *
 * They drifted. #56 added `getSessionLiveness`, updated the test helper and the
 * preload, and left this one behind. The app calls it on mount, so the harness
 * rendered a blank page — and because the harness does not wrap `<App/>` in the
 * ErrorBoundary that `main.tsx` uses, there was nothing on screen to say why.
 * Anyone regenerating the baselines would have photographed black rectangles.
 *
 * A missing method is a blank screen with no message, so this is checked rather
 * than remembered.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const read = (p: string) => fs.readFileSync(path.join(here, '..', p), 'utf8')

/** Method names declared on the `GronkApi` interface in shared/types.ts. */
function apiMethodNames(): string[] {
  const src = read('shared/types.ts')
  const start = src.indexOf('export interface GronkApi')
  assert.ok(start > 0, 'GronkApi is not declared where this test expects it')
  // The interface ends at the first line that is exactly a closing brace.
  const end = src.indexOf('\n}', start)
  assert.ok(end > start, 'could not find the end of GronkApi')
  const body = src.slice(start, end)
  const names = [...body.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1])
  assert.ok(names.length > 40, `only found ${names.length} methods, so this test proves nothing`)
  return names
}

test('THE SHOTS HARNESS FAKE IMPLEMENTS EVERY GronkApi METHOD', () => {
  const shots = read('src/__shots.tsx')
  const missing = apiMethodNames().filter((name) => !new RegExp(`\\b${name}\\s*:`).test(shots))
  assert.deepEqual(
    missing,
    [],
    `src/__shots.tsx is missing ${missing.length} method(s), so the harness renders a blank page: ${missing.join(', ')}`
  )
})

test('the test helper fake implements every GronkApi method too', () => {
  const helper = read('tests/helpers/gronk-api.ts')
  const missing = apiMethodNames().filter((name) => !new RegExp(`\\b${name}\\s*:`).test(helper))
  assert.deepEqual(missing, [], `tests/helpers/gronk-api.ts is missing: ${missing.join(', ')}`)
})

test('the harness renders App inside an ErrorBoundary, so a gap says so', () => {
  const shots = read('src/__shots.tsx')
  assert.match(
    shots,
    /ErrorBoundary/,
    'without it, a missing bridge method is a black screen with nothing to read'
  )
})
