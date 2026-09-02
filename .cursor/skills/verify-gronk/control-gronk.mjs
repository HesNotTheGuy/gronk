#!/usr/bin/env node
/**
 * Drive an isolated Gronk `npm run dev` instance over CDP.
 *
 * Does not talk to the Grok CLI, does not store tokens, does not add IPC.
 * Cleanup kills only the pid recorded at launch and deletes only the scratch
 * dir. Evidence under artifacts/verify-gronk/ is left alone.
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..', '..')
const DEFAULT_CDP = 9333
const LAUNCH_WAIT_MS = 90_000

export function defaultUserData() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'gronk')
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'gronk')
  }
  return path.join(os.homedir(), '.config', 'gronk')
}

export function scratchDir() {
  return process.env.GRONK_VERIFY_DIR || path.join(os.tmpdir(), 'gronk-verify')
}

export function evidenceDir() {
  return path.join(repo, 'artifacts', 'verify-gronk')
}

export function instancePath() {
  return path.join(scratchDir(), 'instance.json')
}

export function isSharedUserData(userData) {
  const resolved = path.resolve(userData)
  const banned = [defaultUserData(), path.join(os.homedir(), '.config', 'grocky')]
  if (process.platform === 'darwin') {
    banned.push(path.join(os.homedir(), 'Library', 'Application Support', 'grocky'))
  }
  if (process.platform === 'win32') {
    const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    banned.push(path.join(roaming, 'grocky'))
  }
  return banned.some((p) => path.resolve(p) === resolved)
}

function usage() {
  return `Drive an isolated Gronk Electron window over CDP.

Usage:
  node .cursor/skills/verify-gronk/control-gronk.mjs <command> [flags]

Commands:
  --help              this text
  paths               print default userData, scratch, evidence, cdp port
  launch              start npm run dev with disposable userData + CDP
  doctor              read-only: is this instance ours and worth driving?
  info                print the instance file (no page probe)
  wait --text TEXT    wait until document.body contains TEXT
  click --text TEXT [--within CSS]
  click --selector CSS
  press --key KEY     e.g. [
  eval --js CODE      read-only inspect after a user action
  snapshot [--path FILE]
  screenshot [--path FILE]
  cleanup             kill what launch started; keep artifacts/verify-gronk/

Flags:
  --cdp PORT          attach to this port (launch also accepts it; default 9333)
  --timeout MS        for wait (default 20000)

Never pass a userData path that is the default Gronk directory.
`
}

function parseArgs(argv) {
  const out = { cmd: '', flags: {}, rest: [] }
  const args = [...argv]
  if (args[0] === '--help' || args[0] === '-h' || !args[0]) {
    out.cmd = '--help'
    return out
  }
  out.cmd = args.shift()
  while (args.length) {
    const a = args.shift()
    if (a === '--help' || a === '-h') {
      out.cmd = '--help'
    } else if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = args[0]
      if (!next || next.startsWith('--')) out.flags[key] = true
      else out.flags[key] = args.shift()
    } else {
      out.rest.push(a)
    }
  }
  return out
}

function readInstance() {
  const p = instancePath()
  if (!fs.existsSync(p)) return null
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

function writeInstance(data) {
  const dir = scratchDir()
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(instancePath(), `${JSON.stringify(data, null, 2)}\n`)
}

function pidAlive(pid) {
  if (!pid || !Number.isInteger(pid)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function portHasListener(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port }, () => {
      sock.end()
      resolve(true)
    })
    sock.on('error', () => resolve(false))
    sock.setTimeout(400, () => {
      sock.destroy()
      resolve(false)
    })
  })
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 1500 }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        try {
          resolve(JSON.parse(raw))
        } catch (err) {
          reject(err)
        }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('timeout'))
    })
  })
}

async function cdpTargets(port) {
  const list = await fetchJson(`http://127.0.0.1:${port}/json/list`)
  if (!Array.isArray(list)) throw new Error('cdp list was not an array')
  return list
}

function pickPageTarget(targets) {
  const pages = targets.filter(
    (t) =>
      t.type === 'page' &&
      typeof t.url === 'string' &&
      !t.url.startsWith('devtools://') &&
      !t.url.startsWith('chrome-extension://')
  )
  return (
    pages.find((t) => /localhost|127\.0\.0\.1/.test(t.url) && /gronk/i.test(t.title || '')) ||
    pages.find((t) => /localhost|127\.0\.0\.1/.test(t.url)) ||
    pages.find((t) => /gronk/i.test(t.title || '')) ||
    pages[0] ||
    null
  )
}

class CdpSession {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.ws = null
    this.nextId = 0
    this.pending = new Map()
  }

  async open() {
    const ws = new WebSocket(this.wsUrl)
    this.ws = ws
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data))
      if (msg.id == null) return
      const wait = this.pending.get(msg.id)
      if (!wait) return
      this.pending.delete(msg.id)
      if (msg.error) wait.reject(new Error(msg.error.message || JSON.stringify(msg.error)))
      else wait.resolve(msg.result)
    })
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', () => reject(new Error('cdp websocket failed')), { once: true })
    })
  }

  send(method, params = {}) {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  close() {
    try {
      this.ws?.close()
    } catch {
      /* already gone */
    }
  }
}

async function withPage(port, fn) {
  const targets = await cdpTargets(port)
  const page = pickPageTarget(targets)
  if (!page?.webSocketDebuggerUrl) {
    throw new Error('no Gronk page target on CDP (devtools:// does not count)')
  }
  const session = new CdpSession(page.webSocketDebuggerUrl)
  await session.open()
  try {
    return await fn(session, page)
  } finally {
    session.close()
  }
}

async function evaluate(session, expression) {
  const result = await session.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  })
  if (result.exceptionDetails) {
    const msg = result.exceptionDetails.text || 'eval threw'
    throw new Error(msg)
  }
  return result.result?.value
}

function resolveCdpPort(flags, inst) {
  if (flags.cdp) return Number(flags.cdp)
  if (inst?.cdpPort) return inst.cdpPort
  return DEFAULT_CDP
}

async function cmdPaths() {
  const report = {
    repo,
    defaultUserData: defaultUserData(),
    scratch: scratchDir(),
    evidence: evidenceDir(),
    instance: instancePath(),
    cdpPort: DEFAULT_CDP
  }
  console.log(JSON.stringify(report, null, 2))
  return 0
}

async function cmdLaunch(flags) {
  const existing = readInstance()
  if (existing && pidAlive(existing.pid)) {
    console.error(`already running pid ${existing.pid}; cleanup first`)
    return 2
  }

  const userData = path.resolve(flags['user-data'] || path.join(scratchDir(), 'user-data'))
  if (isSharedUserData(userData)) {
    console.error(`refusing shared userData: ${userData}`)
    return 2
  }

  const cdpPort = Number(flags.cdp || DEFAULT_CDP)
  if (await portHasListener(cdpPort)) {
    console.error(`cdp port ${cdpPort} already in use; pick another with --cdp`)
    return 2
  }

  fs.mkdirSync(userData, { recursive: true })
  const logPath = path.join(scratchDir(), 'launch.log')
  fs.mkdirSync(scratchDir(), { recursive: true })
  const logFd = fs.openSync(logPath, 'w')

  const electronVite = path.join(repo, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-vite.cmd' : 'electron-vite')
  if (!fs.existsSync(electronVite)) {
    console.error('electron-vite missing; run npm run setup first')
    return 2
  }

  const args = [
    `--remoteDebuggingPort=${cdpPort}`,
    '--noSandbox',
    '--',
    `--user-data-dir=${userData}`
  ]

  const child = spawn(electronVite, args, {
    cwd: repo,
    detached: process.platform !== 'win32',
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }
  })
  fs.closeSync(logFd)
  if (!child.pid) {
    console.error('launch spawned no pid')
    return 2
  }
  child.unref()

  writeInstance({
    pid: child.pid,
    cdpPort,
    userData,
    repo,
    log: logPath,
    startedAt: new Date().toISOString()
  })

  const deadline = Date.now() + LAUNCH_WAIT_MS
  let last = 'waiting for CDP'
  let ready = false
  while (Date.now() < deadline) {
    if (!pidAlive(child.pid)) {
      console.error(`launch process ${child.pid} exited early; see ${logPath}`)
      return 2
    }
    try {
      const targets = await cdpTargets(cdpPort)
      const page = pickPageTarget(targets)
      if (page) {
        ready = await withPage(cdpPort, async (session) => {
          await session.send('Runtime.enable')
          return evaluate(session, `!!document.querySelector('.app')`)
        })
        if (ready) {
          last = 'renderer .app present'
          break
        }
        last = 'page up, .app not yet'
      } else {
        last = 'cdp up, no page target'
      }
    } catch {
      last = 'cdp not answering'
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  if (!ready) {
    console.error(`launch timed out (${last}); see ${logPath}`)
    return 2
  }

  console.log(
    JSON.stringify(
      { ok: true, pid: child.pid, cdpPort, userData, log: logPath },
      null,
      2
    )
  )
  return 0
}

async function cmdDoctor(flags) {
  const inst = readInstance()
  const cdpPort = resolveCdpPort(flags, inst)
  const report = {
    ok: false,
    instanceFile: !!inst,
    pid: inst?.pid ?? null,
    pidAlive: inst ? pidAlive(inst.pid) : false,
    cdpPort,
    cdpUp: false,
    userData: inst?.userData ?? null,
    userDataDisposable: inst?.userData ? !isSharedUserData(inst.userData) : false,
    pageUrl: null,
    pageTitle: null,
    hasApp: false,
    authOverlay: null,
    homeKicker: null
  }

  if (!inst) {
    console.log(JSON.stringify({ ...report, error: 'no verification instance' }, null, 2))
    return 1
  }
  if (!pidAlive(inst.pid)) {
    console.log(JSON.stringify({ ...report, error: 'launch pid is not running' }, null, 2))
    return 1
  }
  if (!inst.userData || isSharedUserData(inst.userData)) {
    console.log(JSON.stringify({ ...report, error: 'userData is missing or is the shared Gronk directory' }, null, 2))
    return 1
  }

  try {
    const targets = await cdpTargets(cdpPort)
    report.cdpUp = true
    const page = pickPageTarget(targets)
    if (!page) {
      console.log(JSON.stringify({ ...report, error: 'no Gronk page target' }, null, 2))
      return 1
    }
    report.pageUrl = page.url
    report.pageTitle = page.title || null
    const probe = await withPage(cdpPort, async (session) => {
      await session.send('Runtime.enable')
      return evaluate(
        session,
        `(() => ({
          hasApp: !!document.querySelector('.app'),
          authOverlay: !!document.querySelector('.auth-overlay'),
          homeKicker: [...document.querySelectorAll('.home-kicker')].map((el) => el.textContent.trim()),
          topbarKicker: document.querySelector('.topbar-kicker')?.textContent?.trim() || null
        }))()`
      )
    })
    Object.assign(report, probe)
  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err)
    console.log(JSON.stringify(report, null, 2))
    return 1
  }

  report.ok = !!(report.cdpUp && report.hasApp && report.userDataDisposable && report.pidAlive)
  console.log(JSON.stringify(report, null, 2))
  return report.ok ? 0 : 1
}

async function cmdInfo() {
  const inst = readInstance()
  if (!inst) {
    console.error('no verification instance')
    return 1
  }
  console.log(JSON.stringify(inst, null, 2))
  return 0
}

async function requireDrive(flags) {
  const inst = readInstance()
  const cdpPort = resolveCdpPort(flags, inst)
  if (!flags.cdp) {
    if (!inst) throw new Error('no verification instance; launch first or pass --cdp')
    if (!pidAlive(inst.pid)) throw new Error('launch pid is not running')
    if (isSharedUserData(inst.userData)) throw new Error('refusing shared userData')
  }
  return cdpPort
}

function clickScript(flags) {
  const text = flags.text
  const selector = flags.selector
  const within = flags.within || ''
  return `(() => {
    const root = ${JSON.stringify(within)} ? document.querySelector(${JSON.stringify(within)}) : document
    if (!root) return { ok: false, reason: 'within not found: ${JSON.stringify(within)}' }
    const dialog = document.querySelector('.auth-overlay, [role="dialog"][aria-modal="true"]')
    const blocked = (el) => {
      if (dialog && !dialog.contains(el)) {
        return {
          ok: false,
          reason: 'blocked by dialog',
          dialog: true,
          dialogClass: dialog.className || null
        }
      }
      return null
    }
    if (${JSON.stringify(selector)}) {
      const el = root.querySelector(${JSON.stringify(selector)})
      if (!el) return { ok: false, reason: 'selector not found', dialog: !!dialog }
      const stop = blocked(el)
      if (stop) return stop
      el.click()
      return { ok: true, via: 'selector', text: (el.textContent || '').trim().slice(0, 80), dialog: !!dialog }
    }
    const wanted = ${JSON.stringify(text || '')}
    if (!wanted) return { ok: false, reason: 'need --text or --selector' }
    const nodes = [...root.querySelectorAll('button, [role="button"], a, [role="tab"]')]
    const labelOf = (n) => {
      const child = n.querySelector('.nav-item-label')
      if (child) return child.textContent.replace(/\\s+/g, ' ').trim()
      return (n.textContent || '').replace(/\\s+/g, ' ').trim()
    }
    const el = nodes.find((n) => labelOf(n) === wanted)
    if (!el) return { ok: false, reason: 'no control with that text', dialog: !!dialog }
    const stop = blocked(el)
    if (stop) return stop
    el.click()
    return { ok: true, via: 'text', text: wanted, dialog: !!dialog }
  })()`
}

async function cmdClick(flags) {
  if (!flags.text && !flags.selector) {
    console.error('click needs --text or --selector')
    return 2
  }
  const port = await requireDrive(flags)
  const result = await withPage(port, (session) => evaluate(session, clickScript(flags)))
  console.log(JSON.stringify(result, null, 2))
  return result?.ok ? 0 : 1
}

async function cmdWait(flags) {
  const text = flags.text
  if (!text) {
    console.error('wait needs --text')
    return 2
  }
  const timeout = Number(flags.timeout || 20_000)
  const port = await requireDrive(flags)
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const found = await withPage(port, (session) =>
      evaluate(session, `document.body && document.body.innerText.includes(${JSON.stringify(text)})`)
    )
    if (found) {
      console.log(JSON.stringify({ ok: true, text }, null, 2))
      return 0
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  console.error(`wait timed out for ${JSON.stringify(text)}`)
  return 1
}

async function cmdPress(flags) {
  const key = flags.key
  if (!key) {
    console.error('press needs --key')
    return 2
  }
  const port = await requireDrive(flags)
  await withPage(port, async (session) => {
    await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key })
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key })
  })
  console.log(JSON.stringify({ ok: true, key }, null, 2))
  return 0
}

async function cmdEval(flags) {
  const js = flags.js
  if (!js || typeof js !== 'string') {
    console.error('eval needs --js')
    return 2
  }
  const port = await requireDrive(flags)
  const value = await withPage(port, (session) => evaluate(session, js))
  console.log(JSON.stringify({ ok: true, value }, null, 2))
  return 0
}

function snapshotScript() {
  return `(() => {
    const lines = []
    const push = (n, s) => lines.push(\`\${'  '.repeat(n)}\${s}\`)
    const kicker = document.querySelector('.topbar-kicker')?.textContent?.trim()
    const title = document.querySelector('.topbar-title')?.textContent?.trim()
    push(0, \`topbar: \${kicker || '?'} / \${title || '?'}\`)
    push(0, \`app: \${document.querySelector('.app')?.className || 'missing'}\`)
    const brand = document.querySelector('button.brand')
    if (brand) push(0, \`brand aria-current=\${brand.getAttribute('aria-current') || 'none'}\`)
    for (const el of document.querySelectorAll('.home-kicker')) {
      push(0, \`kicker: \${el.textContent.trim()}\`)
    }
    for (const h of document.querySelectorAll('h1, h2, h3')) {
      const t = (h.textContent || '').replace(/\\s+/g, ' ').trim()
      if (t) push(0, \`\${h.tagName.toLowerCase()}: \${t}\`)
    }
    const dialogs = document.querySelectorAll('[role="dialog"]')
    for (const d of dialogs) {
      const heading = (d.querySelector('h2, h3')?.textContent || '').replace(/\\s+/g, ' ').trim()
      push(0, \`dialog\${d.className ? '.' + d.className.split(' ')[0] : ''}: \${heading || '(no heading)'}\`)
    }
    const buttons = [...document.querySelectorAll('button')].slice(0, 40)
    for (const b of buttons) {
      const t = (b.textContent || '').replace(/\\s+/g, ' ').trim()
      if (t) push(1, \`button: \${t}\`)
    }
    return lines.join('\\n') + '\\n'
  })()`
}

async function cmdSnapshot(flags) {
  const port = await requireDrive(flags)
  const text = await withPage(port, (session) => evaluate(session, snapshotScript()))
  const out = flags.path || path.join(evidenceDir(), 'snapshot.aria.txt')
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
  fs.writeFileSync(out, text)
  console.log(JSON.stringify({ ok: true, path: path.resolve(out), bytes: Buffer.byteLength(text) }, null, 2))
  return 0
}

async function cmdScreenshot(flags) {
  const port = await requireDrive(flags)
  const png = await withPage(port, async (session) => {
    await session.send('Page.enable')
    const shot = await session.send('Page.captureScreenshot', { format: 'png' })
    return shot.data
  })
  const out = flags.path || path.join(evidenceDir(), 'screenshot.png')
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
  fs.writeFileSync(out, Buffer.from(png, 'base64'))
  console.log(JSON.stringify({ ok: true, path: path.resolve(out), bytes: fs.statSync(out).size }, null, 2))
  return 0
}

function killLaunched(inst) {
  if (!inst?.pid) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(inst.pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  try {
    process.kill(-inst.pid, 'SIGTERM')
  } catch {
    try {
      process.kill(inst.pid, 'SIGTERM')
    } catch {
      /* already gone */
    }
  }
}

async function cmdCleanup() {
  const inst = readInstance()
  const evidence = evidenceDir()
  if (inst) killLaunched(inst)
  // Give Electron a moment to drop the CDP port before we delete userData.
  await new Promise((r) => setTimeout(r, 400))
  const scratch = scratchDir()
  if (fs.existsSync(scratch)) {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
  const evidenceStill = fs.existsSync(evidence)
  console.log(
    JSON.stringify(
      {
        ok: true,
        killed: inst?.pid ?? null,
        scratchRemoved: scratch,
        evidenceKept: evidence,
        evidenceExists: evidenceStill
      },
      null,
      2
    )
  )
  return 0
}

async function main(argv) {
  const { cmd, flags } = parseArgs(argv)
  try {
    switch (cmd) {
      case '--help':
        process.stdout.write(usage())
        return 0
      case 'paths':
        return await cmdPaths()
      case 'launch':
        return await cmdLaunch(flags)
      case 'doctor':
        return await cmdDoctor(flags)
      case 'info':
        return await cmdInfo()
      case 'click':
        return await cmdClick(flags)
      case 'wait':
        return await cmdWait(flags)
      case 'press':
        return await cmdPress(flags)
      case 'eval':
        return await cmdEval(flags)
      case 'snapshot':
        return await cmdSnapshot(flags)
      case 'screenshot':
        return await cmdScreenshot(flags)
      case 'cleanup':
        return await cmdCleanup()
      default:
        console.error(`unknown command: ${cmd}`)
        process.stdout.write(usage())
        return 2
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : err)
    return 1
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
    console.error(err)
    process.exit(1)
  })
}
