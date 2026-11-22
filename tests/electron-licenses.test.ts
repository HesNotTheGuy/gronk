/**
 * The macOS pack path ships Chromium/Electron notices from build/licenses/, not
 * from node_modules (CI never populates the latter). Those files must track the
 * same Electron version as package.json's pin, or one release ships two sets of
 * notices: the previous version's on macOS, the current on Windows/Linux.
 *
 * Content hash against dist is not asserted here: CI installs with
 * --ignore-scripts, so the electron binary tree is empty on the only job that
 * runs this suite. Version agreement is what a test can still catch.
 */
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const LICENSES = path.join(ROOT, 'build', 'licenses')

function readPackageElectron(): string {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
    devDependencies?: { electron?: string }
  }
  const pin = pkg.devDependencies?.electron
  assert.ok(typeof pin === 'string' && pin.length > 0, 'package.json must pin devDependencies.electron')
  // Exact pin only — a range would mean the committed notices and the installed
  // binary can disagree without this test noticing.
  assert.ok(/^\d+\.\d+\.\d+$/.test(pin), `electron pin must be an exact x.y.z, got ${pin}`)
  return pin
}

function parseExact(version: string): [number, number, number] {
  const parts = version.split('.').map((p) => Number(p))
  assert.equal(parts.length, 3, `expected x.y.z, got ${version}`)
  assert.ok(parts.every((n) => Number.isInteger(n) && n >= 0), `non-integer in ${version}`)
  return [parts[0], parts[1], parts[2]]
}

function atLeast(version: string, floor: [number, number, number]): boolean {
  const v = parseExact(version)
  for (let i = 0; i < 3; i++) {
    if (v[i] > floor[i]) return true
    if (v[i] < floor[i]) return false
  }
  return true
}

/**
 * Floors from Electron's own release notes, not from this repo's pin:
 * - eMudhra emSign G3 intermediate block: 43.8.1, 44.9.1, 45.0.0-beta.6
 *   (GHSA-jr5w-w6x2-84p9, 43.8.1 / 44.9.1 notes)
 * - October 2026 Node.js security release is Node 24.22.1. Electron first
 *   ships that as 43.8.4 and 44.10.0.
 */
function includesCertBlockAndOct2026Node(version: string): boolean {
  const [major] = parseExact(version)
  if (major === 43) return atLeast(version, [43, 8, 4])
  if (major === 44) return atLeast(version, [44, 10, 0])
  return major >= 45
}

describe('build/licenses tracks the Electron pin', () => {
  it('ELECTRON-VERSION matches package.json devDependencies.electron', () => {
    const versionPath = path.join(LICENSES, 'ELECTRON-VERSION')
    assert.ok(existsSync(versionPath), 'build/licenses/ELECTRON-VERSION is missing')
    const recorded = readFileSync(versionPath, 'utf8').trim()
    assert.equal(recorded, readPackageElectron())
  })

  it('both licence files are present for the mac extraResources path', () => {
    assert.ok(existsSync(path.join(LICENSES, 'LICENSE.electron.txt')))
    assert.ok(existsSync(path.join(LICENSES, 'LICENSES.chromium.html')))
  })

  it('the pin includes the eMudhra cert block and the October 2026 Node.js security fixes', () => {
    const pin = readPackageElectron()
    assert.ok(
      includesCertBlockAndOct2026Node(pin),
      `devDependencies.electron ${pin} is below 43.8.4 / 44.10.0 (eMudhra block + Node 24.22.1)`
    )
  })
})

describe('electron security floor helper', () => {
  it('rejects the previous pin and the cert-only 43.8.1 / 44.9.1 cuts', () => {
    assert.equal(includesCertBlockAndOct2026Node('36.4.0'), false)
    assert.equal(includesCertBlockAndOct2026Node('43.8.1'), false)
    assert.equal(includesCertBlockAndOct2026Node('44.9.1'), false)
  })

  it('accepts the first Node 24.22.1 cuts and later patches', () => {
    assert.equal(includesCertBlockAndOct2026Node('43.8.4'), true)
    assert.equal(includesCertBlockAndOct2026Node('43.8.12'), true)
    assert.equal(includesCertBlockAndOct2026Node('44.10.0'), true)
    assert.equal(includesCertBlockAndOct2026Node('44.11.5'), true)
    assert.equal(includesCertBlockAndOct2026Node('45.0.0'), true)
  })
})
