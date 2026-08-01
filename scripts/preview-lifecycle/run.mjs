/**
 * Bundles preview.ts, runs harness.js under real Electron, reports the checks.
 *
 * preview.ts cannot simply be required: it is TypeScript, and it imports sibling
 * modules by extensionless path. esbuild flattens both, leaving `electron`
 * external so the harness gets the real one rather than the node --test stub.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..')
const bin = (name) => path.join(repo, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name)

mkdirSync(here, { recursive: true })

// Electron needs a package.json to find its entry point. `type` is deliberately
// omitted so harness.js is CommonJS regardless of what the root package says.
writeFileSync(
  path.join(here, 'package.json'),
  `${JSON.stringify({ name: 'preview-lifecycle', private: true, main: 'harness.js' }, null, 2)}\n`
)

const bundle = spawnSync(
  bin('esbuild'),
  [
    path.join(repo, 'electron/main/preview.ts'),
    '--bundle',
    '--platform=node',
    '--format=cjs',
    '--external:electron',
    `--outfile=${path.join(here, 'preview.cjs')}`
  ],
  { stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32' }
)
if (bundle.status !== 0) {
  console.error('failed to bundle preview.ts')
  process.exit(1)
}

const run = spawnSync(bin('electron'), [here], {
  encoding: 'utf8',
  shell: process.platform === 'win32',
  env: process.env
})

const raw = String(run.stdout || '')
const marker = raw.indexOf('===RESULTS===')
if (marker === -1) {
  console.error('harness produced no results')
  console.error(raw.slice(-2000))
  console.error(String(run.stderr || '').slice(-2000))
  process.exit(1)
}

const results = JSON.parse(raw.slice(marker + '===RESULTS==='.length))
for (const r of results) {
  console.log(`${r.pass ? 'pass' : 'FAIL'}  ${r.name}${r.detail ? `  | ${r.detail}` : ''}`)
}
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length} checks, ${failed.length} failed`)
process.exit(failed.length ? 1 : 0)
