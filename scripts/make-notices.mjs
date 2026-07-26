/**
 * Collects licence text for every dependency that ends up inside the shipped
 * bundle, into THIRD-PARTY-NOTICES.md.
 *
 * Why this is needed: React and the markdown stack are compiled into
 * out/renderer, so the app *distributes* them. MIT (and BSD, and ISC) all
 * require the copyright notice to travel with the code. electron-builder already
 * ships LICENSE.electron.txt and LICENSES.chromium.html for the runtime, but
 * nothing covers the npm packages we bundle ourselves.
 *
 * Only runtime dependencies are walked. devDependencies build the app but are
 * not part of it, so they carry no distribution obligation.
 *
 * Zero dependencies, per SECURITY.md. Run with `npm run notices`.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const MODULES = path.join(ROOT, 'node_modules')

const LICENSE_FILENAMES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'LICENCE.md', 'COPYING']

function readPackage(name) {
  const file = path.join(MODULES, name, 'package.json')
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function readLicenseText(name) {
  const dir = path.join(MODULES, name)
  for (const candidate of LICENSE_FILENAMES) {
    const file = path.join(dir, candidate)
    if (existsSync(file)) {
      try {
        return readFileSync(file, 'utf8').trim()
      } catch {
        /* keep looking */
      }
    }
  }
  return null
}

/** Walk runtime dependencies transitively from the app's direct ones. */
function collectRuntimeDeps() {
  const root = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const seen = new Set()
  const queue = Object.keys(root.dependencies || {})

  while (queue.length) {
    const name = queue.shift()
    if (seen.has(name)) continue
    const pkg = readPackage(name)
    if (!pkg) continue
    seen.add(name)
    // Only `dependencies` propagate into a bundle; a package's own devDeps and
    // optional peers do not get compiled in.
    queue.push(...Object.keys(pkg.dependencies || {}))
  }
  return [...seen].sort()
}

const names = collectRuntimeDeps()
const missing = []
const sections = []

for (const name of names) {
  const pkg = readPackage(name)
  if (!pkg) continue
  const license = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type || 'UNKNOWN'
  const text = readLicenseText(name)
  if (!text) missing.push(`${name} (${license})`)
  sections.push(
    [
      `## ${name}@${pkg.version || '?'}`,
      '',
      `License: ${license}`,
      pkg.homepage ? `Homepage: ${pkg.homepage}` : null,
      '',
      '```',
      text || `No licence file was shipped with this package. Declared license: ${license}.`,
      '```'
    ]
      .filter((line) => line !== null)
      .join('\n')
  )
}

const header = [
  '# Third-party notices',
  '',
  'Gronk bundles the packages below into the application it distributes, and',
  'reproduces their licence text as those licences require.',
  '',
  'The Electron runtime and Chromium ship their own notices inside the packaged',
  'application (`LICENSE.electron.txt`, `LICENSES.chromium.html`).',
  '',
  'The Grok CLI is **not** bundled or redistributed. Gronk launches whatever copy',
  'the user installed themselves, as a separate process, and is not affiliated',
  'with or endorsed by xAI.',
  '',
  'Regenerate with `npm run notices`.',
  '',
  `${names.length} runtime packages.`,
  '',
  '---',
  ''
].join('\n')

writeFileSync(path.join(ROOT, 'THIRD-PARTY-NOTICES.md'), `${header}${sections.join('\n\n')}\n`, 'utf8')

console.log(`THIRD-PARTY-NOTICES.md — ${names.length} runtime packages`)
if (missing.length) {
  console.log(`\nNo licence file found for ${missing.length} package(s); declared license recorded instead:`)
  for (const m of missing) console.log(`  ${m}`)
}
