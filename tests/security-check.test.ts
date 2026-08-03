import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * `scripts/security-check.mjs` is the supply-chain gate: `npm run setup` refuses
 * to fetch the Electron binary until it passes, and CI runs it against the
 * resolved lockfile versions.
 *
 * Its only check on the dataset used to be the HTTP status. A 200 carrying `{}`,
 * a truncated body or a rewritten schema would print `Dataset entries: 0`, miss
 * every lookup, print OK and exit zero, which is byte for byte what a clean run
 * looks like. A guard that cannot fail reads as coverage while providing none.
 *
 * The script cannot be imported without performing a fetch and calling
 * process.exit, so these run it for real in a child process with `fetch` stubbed,
 * the way tests/setup-shell.test.ts spawns the failure it is describing rather
 * than asserting it in a comment. Nothing here touches the network.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = path.join(ROOT, 'scripts/security-check.mjs')
const SOURCE = fs.readFileSync(SCRIPT, 'utf8')

/**
 * Stands in for the dataset host. The script reads exactly two members off the
 * response, so the stub provides those two and nothing else; anything richer
 * would be testing undici rather than the floor.
 */
const PROBE = `import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const [, , payloadPath, scriptPath] = process.argv
const payload = JSON.parse(readFileSync(payloadPath, 'utf8'))

globalThis.fetch = async () => ({ ok: true, json: async () => payload })

await import(pathToFileURL(scriptPath).href)
`

/** Runs the real script against `payload` in place of the fetched dataset. */
function scanWith(payload: unknown): { status: number | null; stdout: string; stderr: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gronk-scanner-'))
  try {
    const probePath = path.join(dir, 'probe.mjs')
    const payloadPath = path.join(dir, 'payload.json')
    fs.writeFileSync(probePath, PROBE)
    fs.writeFileSync(payloadPath, JSON.stringify(payload))

    const result = spawnSync(process.execPath, [probePath, payloadPath, SCRIPT], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** A dataset shaped like the real one, with `count` entries none of which we use. */
function syntheticDataset(count: number): Record<string, string[]> {
  const manifest: Record<string, string[]> = {}
  for (let i = 0; i < count; i++) manifest[`gronk-scanner-fixture-${i}`] = ['0.0.1']
  return manifest
}

/** The floor as the script actually declares it, so the tests cannot drift from it. */
function declaredFloor(): number {
  const match = /const MIN_DATASET_ENTRIES\s*=\s*([0-9_]+)/.exec(SOURCE)
  assert.ok(match, 'MIN_DATASET_ENTRIES not found in scripts/security-check.mjs')
  return Number(match[1].replace(/_/g, ''))
}

test('the script still has the shape these tests are checking', () => {
  // Vacuity guard. If the fetch is restructured or the constant renamed, every
  // test below would otherwise pass over the wrong code and report a floor that
  // is no longer there.
  assert.match(SOURCE, /async function fetchDataset\(/, 'fetchDataset() not found')
  assert.ok(
    /function fetchDataset\([\s\S]*?MIN_DATASET_ENTRIES/.test(SOURCE),
    'the floor must be applied inside fetchDataset(), before the manifest reaches the scan'
  )

  const floor = declaredFloor()
  assert.ok(
    floor >= 1000,
    `the floor is ${floor}, low enough that a gutted dataset would pass. ` +
      'It exists to be far above zero; lowering it to quiet a failing run defeats it.'
  )
})

test('an empty dataset fails the scan instead of reporting a clean one', () => {
  // The exact bug. HTTP 200, valid JSON, every lookup misses.
  const { status, stdout, stderr } = scanWith({})

  assert.equal(status, 1, `expected a failing exit, got ${status}\n${stdout}\n${stderr}`)
  assert.match(stderr, /Could not check the dataset/)
  assert.match(stderr, /0 entries/)
  assert.ok(!/\bOK\b/.test(stdout), 'a scan that never happened must not print OK')
})

test('a dataset just under the floor fails', () => {
  const floor = declaredFloor()
  const { status, stderr } = scanWith(syntheticDataset(floor - 1))

  assert.equal(status, 1, 'a truncated dataset must fail closed')
  assert.match(stderr, new RegExp(`${floor - 1} entries`))
})

test('a dataset of the wrong shape fails rather than counting its keys', () => {
  // An array of 46,000 samples would clear a bare length check while every
  // hasOwnProperty lookup missed.
  const asArray = Object.keys(syntheticDataset(declaredFloor() + 1))
  assert.equal(scanWith(asArray).status, 1, 'an array is not a name-to-versions map')
  assert.equal(scanWith(null).status, 1, 'null is not a dataset')
  assert.equal(scanWith('nope').status, 1, 'a bare string is not a dataset')
})

test('a dataset at the floor scans normally and passes', () => {
  // The other half. A floor that failed a healthy run would just get deleted.
  const { status, stdout } = scanWith(syntheticDataset(declaredFloor()))

  assert.equal(status, 0, 'a dataset at the floor must not be rejected')
  assert.match(stdout, /No installed version matched a known-malicious release/)
  assert.match(stdout, /\nOK/)
})

test('a matching malicious release is still caught through the floor', () => {
  // Proves the stub reaches the real comparison rather than short-circuiting on
  // the new check, so a green suite above means the scan runs, not that it was
  // skipped.
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'))
  const installed = Object.entries(lock.packages ?? {})
    .filter(([key, entry]) => key && (entry as { version?: string })?.version)
    .map(([key, entry]) => [key.split('node_modules/').pop() as string, (entry as { version: string }).version])
  assert.ok(installed.length > 0, 'no versioned packages found in package-lock.json')

  const [name, version] = installed[0]
  const manifest: Record<string, string[]> = syntheticDataset(declaredFloor())
  manifest[name] = [version]

  const { status, stderr } = scanWith(manifest)
  assert.equal(status, 1, `${name}@${version} is installed and listed, so the scan must fail`)
  assert.match(stderr, /INSTALLED VERSION MATCHES A KNOWN-MALICIOUS RELEASE/)
  assert.match(stderr, new RegExp(`${name}@${version.replace(/\./g, '\\.')}`))
})
