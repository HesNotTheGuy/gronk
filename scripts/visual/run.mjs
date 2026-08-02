/**
 * Starts the shots dev server, renders every app state, compares against the
 * committed baseline, and fails if anything moved.
 *
 * `npm run test:visual`         check against the baseline
 * `npm run test:visual:update`  accept the current rendering as the new baseline
 *
 * Needs a display, so it is not wired into CI. Baselines are rendered by a
 * specific machine's font stack; comparing them on a different OS reports
 * differences that are not regressions. Run it locally before cutting a release.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import http from 'node:http'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..')
const isWin = process.platform === 'win32'
const bin = (name) => path.join(repo, 'node_modules', '.bin', isWin ? `${name}.cmd` : name)
// A flag, not just an env var: `UPDATE_BASELINE=1 npm run ...` does not work on
// Windows, where npm runs scripts through cmd.exe.
const UPDATE = process.argv.includes('--update') || process.env.UPDATE_BASELINE === '1'
const PORT = 5178

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function ping(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 1500 }, (res) => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
  })
}

const shotsUrl = `http://localhost:${PORT}/__shots.html`

// Reuse an already-running server rather than fighting it for the port.
let server = null
if (!(await ping(shotsUrl))) {
  server = spawn(bin('vite'), ['--config', 'vite.shots.config.ts'], {
    cwd: repo,
    stdio: 'ignore',
    shell: isWin,
    detached: !isWin
  })

  let up = false
  for (let i = 0; i < 40 && !up; i++) {
    await wait(500)
    up = await ping(shotsUrl)
  }
  if (!up) {
    server.kill()
    console.error(`shots server never came up on ${shotsUrl}`)
    process.exit(1)
  }
}

function stopServer() {
  if (!server || server.killed) return
  if (isWin) spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' })
  else {
    try {
      process.kill(-server.pid, 'SIGTERM')
    } catch {
      server.kill('SIGTERM')
    }
  }
}

const run = spawnSync(bin('electron'), [path.join(here, 'capture.js')], {
  encoding: 'utf8',
  shell: isWin,
  env: { ...process.env, UPDATE_BASELINE: UPDATE ? '1' : '' },
  cwd: repo
})

stopServer()

const raw = String(run.stdout || '')
const marker = raw.indexOf('===RESULTS===')
if (marker === -1) {
  console.error('capture produced no results')
  console.error(raw.slice(-2000))
  console.error(String(run.stderr || '').slice(-2000))
  process.exit(1)
}

const report = JSON.parse(raw.slice(marker + '===RESULTS==='.length))

const changed = report.filter((r) => r.status === 'changed')
const missing = report.filter((r) => r.status === 'no-baseline')
const errored = report.filter((r) => r.status === 'error' || (r.steps && r.steps.length))
const written = report.filter((r) => r.status === 'baseline-written')

for (const r of report) {
  const pct = typeof r.fraction === 'number' ? ` ${(r.fraction * 100).toFixed(3)}%` : ''
  const detail = r.error || r.reason || ''
  console.log(`${(r.status || '?').padEnd(16)} ${r.name}${pct}${detail ? `  ${detail}` : ''}`)
  for (const s of r.steps || []) console.log(`    step did not find: ${s.step || s.wanted}`)
}

if (UPDATE) {
  console.log(`\nbaseline updated: ${written.length} images`)
  process.exit(errored.length ? 1 : 0)
}

console.log(
  `\n${report.length} scenarios: ${changed.length} changed, ${missing.length} without a baseline, ${errored.length} errored`
)

if (missing.length) {
  console.log('\nNo baseline for: ' + missing.map((r) => r.name).join(', '))
  console.log('Review tests/visual/current/, then run: npm run test:visual:update')
}

if (changed.length) {
  console.log('\nChanged. Look at the magenta regions in tests/visual/diff/:')
  for (const r of changed) console.log(`  tests/visual/diff/${r.name}.png`)
  console.log('\nIf the change is intended: npm run test:visual:update')
}

process.exit(changed.length || errored.length || missing.length ? 1 : 0)
