/**
 * Checks every package this project resolves against DataDog's public dataset of
 * known-malicious npm packages, plus scopes that have been compromised before.
 *
 * Ported from PowerShell so it runs on all three platforms and so a reviewer can
 * actually read it. The previous version was invoked with
 * `-ExecutionPolicy Bypass`, which is indistinguishable from how malware runs
 * PowerShell, and asked strangers to trust 233 unaudited lines before they could
 * install. A security tool nobody reads is not a security tool.
 *
 * Zero dependencies. Exits 1 on a confirmed match, 0 otherwise.
 *
 *   node scripts/security-check.mjs [--offline]
 */
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const OFFLINE = process.argv.includes('--offline')

const DATASET_URL =
  'https://raw.githubusercontent.com/DataDog/malicious-software-packages-dataset/main/samples/npm/manifest.json'

/**
 * Scopes hit by the Shai-Hulud worm waves. A package here is not malicious, but
 * it earns a closer look at the version you resolved.
 */
const RISKY_SCOPES = [
  '@ctrl/',
  '@tanstack/',
  '@bitwarden/',
  '@antv/',
  '@redhat-cloud-services/',
  '@ensdomains/',
  '@crowdstrike/',
  '@asyncapi/'
]

/**
 * Every package actually installed, with the exact version resolved, as
 * `name -> Set(versions)`. A worm arrives as somebody else's transitive
 * dependency, so the lockfile is the only honest list.
 *
 * Versions matter as much as names: the dataset records malicious *releases*,
 * not malicious packages. `debug` is listed at 4.4.2 because that one version
 * was compromised in September 2025; every other version of debug is fine, and
 * matching on the name alone flags half the ecosystem.
 */
function resolvedPackages() {
  const found = new Map()
  const add = (name, version) => {
    if (!name) return
    if (!found.has(name)) found.set(name, new Set())
    if (version) found.get(name).add(version)
  }

  const lockPath = path.join(ROOT, 'package-lock.json')
  if (existsSync(lockPath)) {
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
    for (const [key, entry] of Object.entries(lock.packages || {})) {
      if (!key) continue
      // Keys look like "node_modules/foo" or "node_modules/a/node_modules/b";
      // the real name is whatever follows the LAST node_modules segment.
      add(key.split('node_modules/').pop(), entry?.version)
    }
  }

  // Declared names without a lockfile entry still get checked, versionless.
  const pkgPath = path.join(ROOT, 'package.json')
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const name of Object.keys(pkg[field] || {})) add(name, null)
    }
  }

  return found
}

async function fetchDataset() {
  const response = await fetch(DATASET_URL, { signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`dataset request failed: HTTP ${response.status}`)
  return response.json()
}

const resolved = resolvedPackages()
console.log(`Resolved packages to check: ${resolved.size}`)

let failed = false

if (OFFLINE) {
  console.log('Offline mode: skipping the malicious-package dataset.')
} else {
  try {
    // Shape is { "package-name": ["1.2.3", ...] }, listing the malicious
    // RELEASES of that package. A null value means no versions are recorded.
    const manifest = await fetchDataset()
    console.log(`Dataset entries: ${Object.keys(manifest).length}`)

    const hits = []
    const nearMisses = []

    for (const [name, versions] of resolved) {
      if (!Object.prototype.hasOwnProperty.call(manifest, name)) continue
      const badVersions = Array.isArray(manifest[name]) ? manifest[name] : []
      const matched = [...versions].filter((v) => badVersions.includes(v))
      if (matched.length) {
        hits.push(`${name}@${matched.join(', ')}`)
      } else {
        // Worth surfacing, not worth failing on: this package had a compromised
        // release, and you are not on it. Staying quiet would hide a package
        // worth watching; failing would cry wolf over half the ecosystem.
        nearMisses.push(`${name}@${[...versions].join(', ') || '?'} (flagged: ${badVersions.join(', ') || 'unspecified'})`)
      }
    }

    if (hits.length) {
      failed = true
      console.error('\nINSTALLED VERSION MATCHES A KNOWN-MALICIOUS RELEASE:')
      for (const hit of hits) console.error(`  ${hit}`)
      console.error('\nDo not build or run. Remove node_modules and package-lock.json, then investigate.')
    } else {
      console.log('No installed version matched a known-malicious release.')
    }

    if (nearMisses.length) {
      console.log(`\nPackages with a compromised release elsewhere in their history (${nearMisses.length}):`)
      for (const note of nearMisses.sort()) console.log(`  ${note}`)
      console.log('Your versions are not the flagged ones. Listed so a future bump gets a second look.')
    }
  } catch (err) {
    // Fail closed. A scanner that silently passes when it cannot reach its data
    // is worse than no scanner, because it reports safety it never checked.
    failed = true
    console.error(`\nCould not check the dataset: ${err instanceof Error ? err.message : err}`)
    console.error('Refusing to report "clean" without having checked. Re-run, or pass --offline.')
  }
}

const risky = [...resolved.keys()].filter((name) => RISKY_SCOPES.some((scope) => name.startsWith(scope)))
if (risky.length) {
  console.log(`\nPackages in historically compromised scopes (${risky.length}) — verify the versions:`)
  for (const name of risky.sort()) console.log(`  ${name}`)
}

console.log(failed ? '\nFAILED' : '\nOK')
process.exit(failed ? 1 : 0)
