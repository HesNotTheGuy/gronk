/**
 * Dev preview: run a project's dev server as a child process and show it in an
 * attached WebContentsView pane (isolated session, sandboxed). Start/stop owned
 * by the user via the preview icon — never automatic.
 */
import { BrowserWindow, WebContentsView, shell } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { redactSecrets } from './redact'

export interface PreviewStatus {
  running: boolean
  url: string | null
  cwd: string | null
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

const LOCALHOST_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+[^\s"']*/i

export function initPreview(win: BrowserWindow, emitter: Emit): void {
  hostWindow = win
  emit = emitter
}

export function getPreviewStatus(): PreviewStatus {
  return { running: !!devProc, url: currentUrl, cwd: currentCwd }
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
  if (!view) {
    view = new WebContentsView({
      webPreferences: {
        // Isolated, sandboxed, no bridge — the preview never touches window.grocky.
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition: 'preview'
      }
    })
    // Keep the preview locked to localhost; external links go to the OS browser.
    const wc = view.webContents
    wc.setWindowOpenHandler(({ url: u }) => {
      void shell.openExternal(u)
      return { action: 'deny' }
    })
    wc.on('will-navigate', (e, u) => {
      if (!LOCALHOST_URL.test(u)) {
        e.preventDefault()
        void shell.openExternal(u)
      }
    })
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
  if (!LOCALHOST_URL.test(url) && !/^https?:\/\//i.test(url)) return
  if (!view) attachView(url)
  else {
    currentUrl = url
    void view.webContents.loadURL(url)
    status({ url })
  }
}

export function reloadPreview(): void {
  view?.webContents.reload()
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

  const onData = (chunk: Buffer): void => {
    const text = redactSecrets(chunk.toString())
    emit('preview-log', text)
    if (!urlFound) {
      const m = text.match(LOCALHOST_URL)
      if (m) attachView(m[0])
    }
  }
  devProc.stdout?.on('data', onData)
  devProc.stderr?.on('data', onData)
  devProc.on('error', (err) => {
    status({ error: err.message })
  })
  devProc.on('exit', (code) => {
    emit('preview-log', `\n[dev server exited: code ${code ?? '?'}]\n`)
    // Server died; tear down the pane too.
    stopPreview()
  })

  status()
  return { ok: true, message: `Started: ${command}` }
}

function killTree(proc: ChildProcess): void {
  if (!proc.pid) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true })
    } catch {
      /* ignore */
    }
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
  }
}

export function stopPreview(): void {
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
  const hadState = currentUrl || currentCwd
  currentUrl = null
  currentCwd = null
  urlFound = false
  if (hadState) status()
}
