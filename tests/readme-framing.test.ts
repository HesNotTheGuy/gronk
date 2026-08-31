/**
 * The README front matter is what a new user believes about how finished this is,
 * and the download table is what they go looking for on the releases page.
 *
 * Both go stale silently. "0.2.0 is the first full release" sat there for three
 * minors. The filename patterns named a `-windows-x64-setup.exe`, a
 * `-macos-universal.dmg` and a `-linux-x86_64.AppImage`, none of which any
 * release has ever carried — a reader looking for "portable" found nothing and
 * could not tell the two Windows executables apart.
 *
 * So these pin the two failure modes rather than the current wording: no version
 * number frozen into the prose, and no filename pattern that no release produces.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
  version: string
}

test('the README does not frame an old version as the current one', () => {
  assert.doesNotMatch(readme, /is the first full release/i)
})

test('the README pins no version line at all, so a bump cannot make it lie', () => {
  // The trap this replaces asserted the CURRENT line was named, which turns the
  // next ordinary minor bump into a red CI job on a file nobody edited.
  assert.doesNotMatch(
    readme,
    /\b\d+\.\d+ line\b/,
    'naming a release line here means editing the README on every minor'
  )
})

test('no download filename is written out with a version baked into it', () => {
  // `Gronk.Setup.0.5.2.exe` in prose is wrong the day 0.5.3 ships. The table uses
  // a <version> placeholder for the same reason.
  const bare = new RegExp(`Gronk[.\-]${pkg.version.replace(/\./g, '\\.')}`)
  assert.doesNotMatch(readme, bare)
})

test('the download table names files that releases actually produce', () => {
  // The names as they appear on the release page. electron-builder uses its
  // defaults (no artifactName override) and GitHub renders the spaces as dots on
  // upload, which is why the Windows entries are dotted and the others hyphenated.
  for (const pattern of [
    'Gronk.Setup.<version>.exe',
    'Gronk.<version>.exe',
    'Gronk-<version>-universal.dmg',
    'Gronk-<version>.AppImage',
    'gronk_<version>_amd64.deb'
  ]) {
    assert.ok(readme.includes(pattern), `the download table no longer names ${pattern}`)
  }
})

test('the README still warns that installers are unsigned', () => {
  assert.match(readme, /Installers are unsigned/)
  assert.match(readme, /SHA256SUMS\.txt/)
})
