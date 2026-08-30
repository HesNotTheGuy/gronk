/**
 * The README front matter is what new users believe about how mature the app is.
 * Leaving "0.2.0 is the first full release" up after several minors undervalues
 * the project and contradicts the release badge.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')

test('README no longer frames 0.2.0 as the current first full release', () => {
  assert.doesNotMatch(readme, /0\.2\.0 is the first full release/i)
})

test('README states the current line is 0.5', () => {
  assert.match(readme, /0\.5 line/)
})

test('README still warns that installers are unsigned', () => {
  assert.match(readme, /Installers are unsigned/)
})
