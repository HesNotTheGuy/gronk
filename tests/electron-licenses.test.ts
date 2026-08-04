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
})
