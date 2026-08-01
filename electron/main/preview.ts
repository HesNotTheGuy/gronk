/**
 * Dev preview: run a project's dev server as a child process and show it in an
 * attached WebContentsView pane (isolated session, sandboxed). Start/stop owned
 * by the user via the preview icon — never automatic.
 */
import { BrowserWindow, WebContentsView, session, shell } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { isAllowedExternalUrl, isLocalPreviewUrl } from './ipc-guard'
import { redactSecrets } from './redact'

export interface PreviewStatus {
  running: boolean
  url: string | null
  cwd: string | null
  /** Showing in its own window rather than the docked pane. */
  poppedOut?: boolean
  error?: string
}

type Emit = (channel: string, payload: unknown) => void

let hostWindow: BrowserWindow | null = null
let devProc: ChildProcess | null = null
let view: WebContentsView | null = null
let currentUrl: string | null = null
let currentCwd: string | null = null
let lastBounds = { x: 0, y: 0, width: 0, height: 0 }
let emit: Emit = () => {}
let urlFound = false
/**
 * Which run the current output belongs to.
 *
 * stopPreview nulled devProc but left the stdout listeners attached, so a chunk
 * arriving in the kill window re-entered attachView and rebuilt the pane AFTER
 * the user had stopped it. Detaching listeners alone still races callbacks
 * already queued; every handler checks its generation instead, and stopping
 * bumps the counter so anything in flight is stale by definition.
 */
let runId = 0
/** Detached preview window, when the pane has been popped out. */
let popWindow: BrowserWindow | null = null
/** Set while stopPreview() runs, so the window's 'closed' handler stays out of it. */
let tearingDown = false

const PREVIEW_PARTITION = 'preview'

/**
 * Finds a dev server's URL inside a line of its own log output.
 *
 * Deliberately unanchored, because it is searching a sentence. That makes it
 * unusable as a gate, which is what it was also being used for: `.test()` on a
 * navigation target returns true for `https://evil.example/#http://localhost:3000`,
 * since the substring really is present. Scanning and validating are different
 * jobs and cannot share one pattern. Validation lives in isLocalPreviewUrl.
 */
/**
 * The tail excludes brackets and angle brackets, not just whitespace and quotes.
 *
 * With `[^\s"']*` a markdown banner — `[http://localhost:3000](http://localhost:3000)`
 * — captured `http://localhost:3000](http://localhost:3000)` as ONE match, and
 * trimming the final paren still left the wreckage in the middle. Brackets are
 * legal in a URL but vanishingly rare in a dev server's banner, whereas being
 * wrapped in them is common, so excluding them is the right trade.
 */
const LOCALHOST_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+[^\s"'<>()[\]]*/i

/**
 * Trailing characters that abut a URL in prose but are never part of one.
 *
 * The pattern above already refuses brackets, so what reaches here is the
 * sentence punctuation that survives them: `App running at
 * http://localhost:3000.` and `ready http://localhost:3000;` both capture their
 * own final character, and the result then fails to parse, leaving the pane
 * waiting forever with no error.
 */
const TRAILING_PUNCTUATION = /[.,;:!?`)\]}>]+$/

/**
 * The dev server's URL from a chunk of its output, or null.
 *
 * Returns only what actually parses AND passes the same localhost gate the
 * navigation guards use, so a malformed capture is dropped rather than handed
 * to loadURL.
 */
export function extractDevServerUrl(text: string): string | null {
  const match = text.match(LOCALHOST_URL)
  if (!match) return null
  const candidate = match[0].replace(TRAILING_PUNCTUATION, '')
  return isLocalPreviewUrl(candidate) ? candidate : null
}

/**
 * Same scheme allow-list the main window uses. Handing an arbitrary string to
 * shell.openExternal lets the page choose the protocol, and the OS will honour
 * whatever handler is registered for it.
 */
function openExternalSafely(target: string): void {
  if (isAllowedExternalUrl(target)) void shell.openExternal(target)
}

/**
 * The navigation policy, in one place.
 *
 * Applied to the docked view AND the popped-out window. Duplicating it would
 * mean the detached window could silently lose a guard the pane still had, and
 * a window with no localhost lock is a browser pointed at anything.
 */
function installNavigationGuards(wc: Electron.WebContents): void {
  wc.setWindowOpenHandler(({ url: u }) => {
    openExternalSafely(u)
    return { action: 'deny' }
  })
  const keepLocal = (e: Electron.Event, u: string): void => {
    if (isLocalPreviewUrl(u)) return
    e.preventDefault()
    openExternalSafely(u)
  }
  wc.on('will-navigate', keepLocal)
  // will-navigate does not fire on an HTTP redirect. Without this a 3xx from the
  // dev server walks the preview to any origin it likes, and the localhost lock
  // only ever applied to the first hop.
  wc.on('will-redirect', keepLocal)
}

/**
 * The pane runs in its own partition, so hardenSession() in index.ts never
 * reaches it: that configures session.defaultSession only. Without this the
 * preview keeps Electron's defaults, where a page can be granted the
 * microphone, camera, geolocation or notifications.
 *
 * No CSP is imposed here, on purpose. The pane renders the user's own dev
 * server and a policy strict enough to be worth having would break real
 * projects. Containment comes from staying on localhost, with no preload and no
 * bridge to reach.
 */
/**
 * One definition, used by the docked view and the detached window alike.
 *
 * No `preload`, deliberately: without one the page has no window.gronk, so there
 * is no IPC surface and nothing to reach the agent, the transcript store or the
 * filesystem. Detaching into its own window must not quietly relax any of this.
 */
const PREVIEW_WEB_PREFERENCES = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  partition: PREVIEW_PARTITION
} as const

function hardenPreviewSession(): void {
  const previewSession = session.fromPartition(PREVIEW_PARTITION)
  previewSession.setPermissionRequestHandler((_wc, _permission, cb) => cb(false))
  previewSession.setPermissionCheckHandler(() => false)
}

export function initPreview(win: BrowserWindow, emitter: Emit): void {
  hostWindow = win
  emit = emitter
}

export function getPreviewStatus(): PreviewStatus {
  return {
    running: !!devProc,
    url: currentUrl,
    cwd: currentCwd,
    poppedOut: isPreviewPoppedOut()
  }
}

/** Resolve the dev command: explicit override, else `npm run dev` when a dev script exists. */
function resolveCommand(cwd: string, override?: string): string | null {
  if (override && override.trim()) return override.trim()
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    if (pkg?.scripts?.dev) return 'npm run dev'
    if (pkg?.scripts?.start) return 'npm start'
  } catch {
    /* no package.json */
  }
  return null
}

function status(extra?: Partial<PreviewStatus>): void {
  emit('preview-status', { ...getPreviewStatus(), ...extra })
}

function attachView(url: string): void {
  if (!hostWindow || hostWindow.isDestroyed()) return
  // The single place the pane is ever handed a URL to load, so the check lives
  // here too rather than only at the callers. Both of today's callers are
  // already safe; a future third one will not silently not be.
  if (!isLocalPreviewUrl(url)) return
  if (!view) {
    // Before the view exists, so no page can load under the default handlers.
    hardenPreviewSession()
    view = new WebContentsView({
      webPreferences: { ...PREVIEW_WEB_PREFERENCES }
    })
    // Keep the preview locked to localhost; external links go to the OS browser.
    installNavigationGuards(view.webContents)
    hostWindow.contentView.addChildView(view)
  }
  view.setBounds(lastBounds)
  currentUrl = url
  void view.webContents.loadURL(url)
  urlFound = true
  status({ url })
}

export function setPreviewBounds(b: { x: number; y: number; width: number; height: number }): void {
  lastBounds = {
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.round(b.width),
    height: Math.round(b.height)
  }
  if (view) view.setBounds(lastBounds)
}

export function setPreviewUrl(url: string): void {
  // The old guard was `!isLocalhost && !isHttpScheme`, so any http(s) origin
  // satisfied the second clause and the localhost check never rejected
  // anything. This is the address bar in PreviewPane, so an off-localhost entry
  // is a deliberate user action: hand it to the real browser rather than
  // dropping it silently, which is what happens to an outbound link clicked
  // inside the pane.
  if (!isLocalPreviewUrl(url)) {
    openExternalSafely(url)
    return
  }
  if (!view) attachView(url)
  else {
    currentUrl = url
    void view.webContents.loadURL(url)
    status({ url })
  }
}

/** True while the preview is showing in its own window rather than the pane. */
export function isPreviewPoppedOut(): boolean {
  return !!popWindow && !popWindow.isDestroyed()
}

/**
 * Move the preview into its own resizable window.
 *
 * The docked view is destroyed rather than hidden: two live WebContentsViews on
 * the same URL would both hold the dev server's socket and both run its
 * JavaScript, so a page with a timer or a websocket would do everything twice.
 *
 * The window gets the same webPreferences and the same navigation guards. A
 * detached window that quietly lost the localhost lock would just be a browser.
 */
export function popOutPreview(): { ok: boolean; message: string } {
  if (!currentUrl) return { ok: false, message: 'Nothing is previewing yet.' }
  if (isPreviewPoppedOut()) {
    popWindow!.focus()
    return { ok: true, message: 'Already open.' }
  }

  hardenPreviewSession()
  detachDockedView()

  popWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 380,
    minHeight: 320,
    title: 'Preview',
    backgroundColor: '#000000',
    // Not modal and not always-on-top: it is a second working surface, not a
    // dialog, and the user decides which window is in front.
    webPreferences: { ...PREVIEW_WEB_PREFERENCES }
  })
  installNavigationGuards(popWindow.webContents)

  popWindow.on('closed', () => {
    popWindow = null
    // destroy() emits 'closed' SYNCHRONOUSLY, and stopPreview() destroys the
    // window while currentUrl is still set (killTree needs it for the port). So
    // without this the teardown re-attached a pane for the preview it was tearing
    // down, loaded a URL into a server being killed, and emitted a preview-status
    // still carrying that URL — the UI flashed "running" after the user hit stop.
    // Measured, not theorised: the harness caught the stray event.
    if (tearingDown) return
    // Closing the window means "put it back", not "stop the server". The dev
    // process is untouched, so re-attaching restores the pane where it was.
    if (currentUrl) attachView(currentUrl)
    else status()
  })

  void popWindow.loadURL(currentUrl)
  status()
  return { ok: true, message: 'Preview opened in its own window.' }
}

/** Put a detached preview back into the pane. */
export function dockPreview(): void {
  if (!isPreviewPoppedOut()) return
  // The 'closed' handler re-attaches, so this is the whole operation.
  popWindow!.close()
}

/** Remove the in-window view without touching the dev server. */
function detachDockedView(): void {
  if (!view) return
  try {
    if (hostWindow && !hostWindow.isDestroyed()) hostWindow.contentView.removeChildView(view)
    view.webContents.close()
  } catch {
    /* already gone */
  }
  view = null
}

export function reloadPreview(): void {
  if (isPreviewPoppedOut()) popWindow!.webContents.reload()
  else view?.webContents.reload()
}

export function startPreview(cwd: string, override?: string): { ok: boolean; message: string } {
  stopPreview()
  const command = resolveCommand(cwd, override)
  if (!command) {
    const msg = 'No dev command found. Add a "dev" script to package.json or set a preview command.'
    status({ error: msg })
    return { ok: false, message: msg }
  }

  currentCwd = cwd
  urlFound = false
  try {
    devProc = spawn(command, {
      cwd,
      shell: true, // run `npm run dev` etc. as the project would
      windowsHide: true,
      detached: process.platform !== 'win32', // own process group for tree-kill
      env: { ...process.env, FORCE_COLOR: '0' }
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    status({ error: msg })
    return { ok: false, message: msg }
  }

  const myRun = ++runId

  const onData = (chunk: Buffer): void => {
    if (myRun !== runId) return
    const raw = chunk.toString()
    emit('preview-log', redactSecrets(raw))
    if (!urlFound) {
      // Scan the RAW text, not the redacted copy. redactSecrets rewrites
      // secret-shaped substrings, and a dev server that prints its own URL with
      // a query string — http://localhost:5173/?api_key=… — had that URL
      // mangled before it was ever matched, so the pane loaded a corrupted
      // address. The log the user sees is still redacted.
      const url = extractDevServerUrl(raw)
      if (url) attachView(url)
    }
  }
  devProc.stdout?.on('data', onData)
  devProc.stderr?.on('data', onData)
  devProc.on('error', (err) => {
    if (myRun !== runId) return
    // 'error' means the child never ran — a bad cwd emits error:ENOENT then
    // close, and NEVER exit, so nothing else would clear devProc and
    // getPreviewStatus() reported running:true forever with no pid.
    devProc = null
    status({ error: err.message })
  })
  devProc.on('exit', (code) => {
    if (myRun !== runId) return
    emit('preview-log', `\n[dev server exited: code ${code ?? '?'}]\n`)
    // Server died; tear down the pane too.
    stopPreview()
  })

  status()
  return { ok: true, message: `Started: ${command}` }
}

/**
 * Run a kill helper without letting its own failure reach the process.
 *
 * `spawn` reports ENOENT and EPERM ASYNCHRONOUSLY, as an 'error' event on the
 * returned child — a try/catch around the spawn call cannot see them. With no
 * listener attached, that event becomes an uncaughtException and takes the main
 * process down with it. The empty handler is the entire point.
 */
function spawnKiller(command: string, args: string[]): void {
  try {
    const killer = spawn(command, args, { windowsHide: true })
    killer.on('error', () => {
      /* the helper is missing or refused; nothing useful to do, and it must not throw */
    })
  } catch {
    /* synchronous failures too */
  }
}

/**
 * Kill whatever is still listening on the preview's port.
 *
 * `taskkill /T` walks the process TREE, and the tree link is broken the moment
 * an intermediate exits — which is exactly what `npm run dev` does when the
 * script hands the server to a detached grandchild and returns. Measured: the
 * port stays bound after taskkill reports success. Sweeping by port catches the
 * orphan the tree walk cannot see.
 *
 * Only ever targets a loopback listener on the port this preview discovered, so
 * it cannot reach an unrelated service.
 */
function killListenerOnPort(port: number): void {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return
  if (process.platform === 'win32') {
    // `for /f` over netstat: the PID is the last column of a LISTENING row.
    spawnKiller('cmd', [
      '/c',
      `for /f "tokens=5" %a in ('netstat -ano ^| findstr /r /c:":${port} .*LISTENING"') do @taskkill /pid %a /t /f`
    ])
  } else {
    spawnKiller('sh', ['-c', `lsof -ti tcp:${port} -sTCP:LISTEN | xargs -r kill -9`])
  }
}

function killTree(proc: ChildProcess): void {
  if (!proc.pid) return
  const port = currentUrl ? Number(new URL(currentUrl).port) : NaN

  if (process.platform === 'win32') {
    spawnKiller('taskkill', ['/pid', String(proc.pid), '/T', '/F'])
    // The tree walk misses an orphaned grandchild, so follow it with a sweep.
    if (Number.isFinite(port)) killListenerOnPort(port)
  } else {
    try {
      process.kill(-proc.pid, 'SIGTERM')
    } catch {
      try {
        proc.kill('SIGTERM')
      } catch {
        /* ignore */
      }
    }
    // SIGTERM alone leaves a server that traps it running with the port bound.
    const pid = proc.pid
    setTimeout(() => {
      try {
        process.kill(-pid, 0)
        process.kill(-pid, 'SIGKILL')
      } catch {
        /* already gone, which is the good case */
      }
      if (Number.isFinite(port)) killListenerOnPort(port)
    }, 2000).unref?.()
  }
}

export function stopPreview(): void {
  // Invalidate first: everything still queued from this run is now stale.
  runId++
  // Close the detached window WITHOUT letting its 'closed' handler re-attach a
  // pane for a preview that is being torn down. The flag is what actually does
  // that: 'closed' fires synchronously from destroy() and branches on
  // currentUrl, which killTree still needs for the port and so cannot be
  // cleared first.
  tearingDown = true
  try {
    if (popWindow && !popWindow.isDestroyed()) {
      const w = popWindow
      popWindow = null
      w.destroy()
    }
    if (view) {
      try {
        if (hostWindow && !hostWindow.isDestroyed()) hostWindow.contentView.removeChildView(view)
        view.webContents.close()
      } catch {
        /* ignore */
      }
      view = null
    }
    if (devProc) {
      killTree(devProc)
      devProc = null
    }
  } finally {
    tearingDown = false
  }
  const hadState = currentUrl || currentCwd
  currentUrl = null
  currentCwd = null
  urlFound = false
  if (hadState) status()
}
