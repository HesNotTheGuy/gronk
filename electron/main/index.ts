import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { agentManager } from './agent-manager'
import { isChatWorkspace, normalizePath } from '../../shared/path'
import {
  addRecentProject,
  archiveSession,
  deleteSession,
  getPermissionAudit,
  getRecentProjects,
  getSettings,
  getTranscript,
  listSessions,
  normalizeCwd,
  renameSession,
  saveTranscript,
  setSettings
} from './store'
import { resolveGrokBinary } from './acp/client'
import { listModels } from './models'
import { exportTranscriptMarkdown, listProjectFiles } from './fs-utils'
import { getAuthStatus, loginWithCli, logoutWithCli } from './auth'
import type {
  AppSettings,
  ChatMessage,
  LoginMethod,
  PermissionDecision,
  PromptAttachment,
  SendPromptOptions
} from '../../shared/types'

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

let mainWindow: BrowserWindow | null = null

const ALLOWED_EXTERNAL_SCHEMES = new Set(['https:', 'http:', 'mailto:'])

function openExternalSafely(target: string): void {
  try {
    const url = new URL(target)
    if (ALLOWED_EXTERNAL_SCHEMES.has(url.protocol)) void shell.openExternal(target)
  } catch {
    /* ignore malformed */
  }
}

function isLocalDevHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1'
  )
}

function isAppUrl(target: string): boolean {
  try {
    const u = new URL(target)
    if (process.env.ELECTRON_RENDERER_URL) {
      // Dev: any localhost / 127.0.0.1 page from the Vite server
      return (u.protocol === 'http:' || u.protocol === 'https:') && isLocalDevHost(u.hostname)
    }
    return u.protocol === 'file:'
  } catch {
    return false
  }
}

function assertTrustedSender(e: Electron.IpcMainInvokeEvent): void {
  const url = e.senderFrame?.url ?? ''
  let ok = false
  try {
    if (process.env.ELECTRON_RENDERER_URL) {
      const u = new URL(url)
      ok = (u.protocol === 'http:' || u.protocol === 'https:') && isLocalDevHost(u.hostname)
    } else {
      ok = url.startsWith('file://')
    }
  } catch {
    ok = false
  }
  if (!ok) throw new Error(`Rejected IPC from untrusted sender: ${url || '(empty)'}`)
}

function assertString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Invalid ${name}: expected non-empty string`)
  }
  return value
}

function assertOptionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new Error(`Invalid ${name}`)
  return value
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'Grocky',
    backgroundColor: '#000000',
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 16, y: 16 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox:true blanks the UI with electron-vite preload on Windows; keep isolation + no node
      sandbox: false
    }
  })

  agentManager.setWindow(mainWindow)

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
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
    if (isAppUrl(url)) return
    e.preventDefault()
    openExternalSafely(url)
  }
  mainWindow.webContents.on('will-navigate', blockOffOriginNav)
  mainWindow.webContents.on('will-redirect', blockOffOriginNav)
  mainWindow.webContents.on('will-attach-webview', (e) => e.preventDefault())

  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[grocky] did-fail-load', code, desc, url)
  })
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[grocky] render-process-gone', details)
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
    mainWindow = null
    agentManager.setWindow(null)
  })
}

function registerIpc(): void {
  ipcMain.handle('grocky:select-folder', async (e) => {
    assertTrustedSender(e)
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    return result.filePaths[0]
  })

  ipcMain.handle(
    'grocky:select-file',
    async (
      e,
      options?: { filters?: { name: string; extensions: string[] }[]; title?: string }
    ) => {
      assertTrustedSender(e)
      const result = await dialog.showOpenDialog(mainWindow!, {
        title: options?.title || 'Select file',
        properties: ['openFile'],
        filters: options?.filters
      })
      if (result.canceled || !result.filePaths[0]) return null
      return result.filePaths[0]
    }
  )

  ipcMain.handle('grocky:get-settings', (e) => {
    assertTrustedSender(e)
    return getSettings()
  })

  ipcMain.handle('grocky:set-settings', (e, partial: Partial<AppSettings>) => {
    assertTrustedSender(e)
    if (!partial || typeof partial !== 'object') throw new Error('Invalid settings')
    return setSettings(partial)
  })

  ipcMain.handle('grocky:get-recent-projects', (e) => {
    assertTrustedSender(e)
    return getRecentProjects()
  })

  ipcMain.handle('grocky:add-recent-project', (e, cwd: string) => {
    assertTrustedSender(e)
    return addRecentProject(assertString(cwd, 'cwd'))
  })

  ipcMain.handle('grocky:get-chat-workspace', (e) => {
    assertTrustedSender(e)
    const dir = path.join(app.getPath('userData'), 'chat-workspace')
    fs.mkdirSync(dir, { recursive: true })
    const readme = path.join(dir, 'README.txt')
    if (!fs.existsSync(readme)) {
      fs.writeFileSync(
        readme,
        [
          'Grocky Chat workspace',
          '',
          'This folder is a local sandbox for general Grok chat sessions.',
          'It is not one of your coding projects. Conversations here are',
          'backed by the Grok CLI (same account as `grok login`), not the website.',
          ''
        ].join('\n'),
        'utf8'
      )
    }
    return dir
  })

  ipcMain.handle(
    'grocky:start-agent',
    async (
      e,
      cwd: string,
      options?: {
        model?: string
        alwaysApprove?: boolean
        forceNew?: boolean
        surface?: 'chat' | 'project'
      }
    ) => {
      assertTrustedSender(e)
      const auth = await getAuthStatus()
      if (!auth.authenticated) {
        throw new Error(
          auth.message ||
            'Sign in required. Use your own Grok account before chatting or opening a project.'
        )
      }

      const normalized = normalizeCwd(assertString(cwd, 'cwd'))
      // Path is authoritative: chat-workspace is always app Chat, never Workspace
      const surface =
        options?.surface === 'chat' || isChatWorkspace(normalized, null)
          ? 'chat'
          : 'project'
      // Chat sandbox must never appear under Workspace folders
      if (surface === 'project') {
        addRecentProject(normalized)
      }
      const settings = getSettings()
      const model = options?.model ?? settings.model
      const alwaysApprove = options?.alwaysApprove ?? settings.alwaysApprove

      if (
        !options?.forceNew &&
        agentManager.getConnectionState() === 'ready' &&
        agentManager.getCwd() &&
        normalizeCwd(agentManager.getCwd()!) === normalized &&
        agentManager.getSessionId() &&
        agentManager.getSurface() === surface &&
        (!model || model === agentManager.getCurrentModel())
      ) {
        return { sessionId: agentManager.getSessionId()! }
      }

      return agentManager.start(normalized, { model, alwaysApprove, surface })
    }
  )

  ipcMain.handle('grocky:stop-agent', async (e) => {
    assertTrustedSender(e)
    return agentManager.stop()
  })

  ipcMain.handle(
    'grocky:send-prompt',
    (e, text: string, options?: SendPromptOptions) => {
      assertTrustedSender(e)
      if (typeof text !== 'string') throw new Error('Invalid prompt')
      return agentManager.sendPrompt(text, options as { attachments?: PromptAttachment[] })
    }
  )

  ipcMain.handle('grocky:cancel-prompt', async (e) => {
    assertTrustedSender(e)
    return agentManager.cancelPrompt()
  })

  ipcMain.handle(
    'grocky:respond-permission',
    (e, requestId: number | string, decision: PermissionDecision) => {
      assertTrustedSender(e)
      if (requestId === undefined || requestId === null) throw new Error('Invalid requestId')
      if (!['allow-once', 'allow-always', 'reject-once'].includes(decision)) {
        throw new Error('Invalid permission decision')
      }
      agentManager.respondPermission(requestId, decision)
    }
  )

  ipcMain.handle('grocky:list-sessions', (e) => {
    assertTrustedSender(e)
    return listSessions()
  })

  ipcMain.handle('grocky:load-session', async (e, sessionId: string) => {
    assertTrustedSender(e)
    const auth = await getAuthStatus()
    if (!auth.authenticated) {
      throw new Error(
        auth.message ||
          'Sign in required before restoring a session. Use your own Grok account.'
      )
    }
    const id = assertString(sessionId, 'sessionId')
    const sessions = listSessions()
    const match = sessions.find((s) => s.id === id)
    return agentManager.loadSession(id, match?.cwd)
  })

  ipcMain.handle('grocky:get-transcript', (e, sessionId: string) => {
    assertTrustedSender(e)
    return getTranscript(assertString(sessionId, 'sessionId'))
  })

  ipcMain.handle(
    'grocky:save-transcript',
    (e, sessionId: string, messages: ChatMessage[]) => {
      assertTrustedSender(e)
      if (!Array.isArray(messages)) throw new Error('Invalid messages')
      saveTranscript(assertString(sessionId, 'sessionId'), messages)
    }
  )

  ipcMain.handle('grocky:delete-session', (e, sessionId: string) => {
    assertTrustedSender(e)
    return deleteSession(assertString(sessionId, 'sessionId'))
  })

  ipcMain.handle('grocky:rename-session', (e, sessionId: string, title: string) => {
    assertTrustedSender(e)
    return renameSession(assertString(sessionId, 'sessionId'), assertString(title, 'title'))
  })

  ipcMain.handle(
    'grocky:archive-session',
    (e, sessionId: string, archived?: boolean) => {
      assertTrustedSender(e)
      return archiveSession(assertString(sessionId, 'sessionId'), archived !== false)
    }
  )

  ipcMain.handle(
    'grocky:export-transcript',
    async (e, sessionId: string, format: 'md' | 'json' = 'md') => {
      assertTrustedSender(e)
      const id = assertString(sessionId, 'sessionId')
      if (format !== 'md' && format !== 'json') throw new Error('Invalid format')
      const sessions = listSessions()
      const sessionInfo = sessions.find((s) => s.id === id)
      const messages = getTranscript(id)
      if (!messages.length) return null

      const base = (sessionInfo?.title || id.slice(0, 8)).replace(/[<>:"/\\|?*]/g, '_')
      const defaultPath = path.join(
        app.getPath('documents'),
        `grocky-${base}.${format === 'json' ? 'json' : 'md'}`
      )

      const result = await dialog.showSaveDialog(mainWindow!, {
        title: 'Export transcript',
        defaultPath,
        filters:
          format === 'json'
            ? [{ name: 'JSON', extensions: ['json'] }]
            : [{ name: 'Markdown', extensions: ['md'] }]
      })
      if (result.canceled || !result.filePath) return null

      if (format === 'json') {
        fs.writeFileSync(
          result.filePath,
          JSON.stringify({ session: sessionInfo, messages }, null, 2),
          'utf8'
        )
      } else {
        const md = exportTranscriptMarkdown(sessionInfo?.title || id, messages)
        fs.writeFileSync(result.filePath, md, 'utf8')
      }
      return { path: result.filePath }
    }
  )

  ipcMain.handle(
    'grocky:list-project-files',
    (e, cwd: string, query?: string, limit?: number) => {
      assertTrustedSender(e)
      const root = assertString(cwd, 'cwd')
      // FIX-13: only allow listing under the active agent project when one is open
      const active = agentManager.getCwd()
      if (active) {
        const nRoot = normalizeCwd(root)
        const nActive = normalizeCwd(active)
        if (nRoot !== nActive && !nRoot.startsWith(nActive + '/')) {
          throw new Error('listProjectFiles restricted to the open project')
        }
      }
      const q = assertOptionalString(query, 'query')
      const lim =
        typeof limit === 'number' && Number.isFinite(limit)
          ? Math.min(Math.max(1, Math.floor(limit)), 100)
          : 40
      return listProjectFiles(root, q, lim)
    }
  )

  ipcMain.handle('grocky:list-models', (e) => {
    assertTrustedSender(e)
    return listModels()
  })

  ipcMain.handle('grocky:get-permission-audit', (e) => {
    assertTrustedSender(e)
    return getPermissionAudit()
  })

  ipcMain.handle('grocky:get-connection-state', (e) => {
    assertTrustedSender(e)
    return agentManager.getConnectionState()
  })

  ipcMain.handle('grocky:get-grok-path', (e) => {
    assertTrustedSender(e)
    const settings = getSettings()
    return resolveGrokBinary(settings.grokBinary)
  })

  ipcMain.handle('grocky:get-health', async (e) => {
    assertTrustedSender(e)
    const settings = getSettings()
    const grokPath = resolveGrokBinary(settings.grokBinary)
    const auth = await getAuthStatus()
    return {
      grokFound: !!grokPath,
      grokPath,
      nodeOk: true,
      platform: process.platform,
      auth
    }
  })

  ipcMain.handle('grocky:get-auth-status', async (e) => {
    assertTrustedSender(e)
    return getAuthStatus()
  })

  ipcMain.handle('grocky:login', async (e, method?: LoginMethod) => {
    assertTrustedSender(e)
    const m = method === 'device' ? 'device' : 'oauth'
    const result = await loginWithCli(m)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('grocky:event', {
        type: 'auth',
        auth: result.auth
      })
    }
    return result
  })

  ipcMain.handle('grocky:logout', async (e) => {
    assertTrustedSender(e)
    try {
      await agentManager.stop()
    } catch {
      /* best effort */
    }
    const result = await logoutWithCli()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('grocky:event', {
        type: 'auth',
        auth: result.auth
      })
    }
    return result
  })

  ipcMain.handle('grocky:read-local-image', async (e, filePath: string) => {
    assertTrustedSender(e)
    return readLocalImageSafe(assertString(filePath, 'filePath'))
  })

  ipcMain.handle('grocky:reveal-local-path', async (e, filePath: string) => {
    assertTrustedSender(e)
    return revealLocalPathSafe(assertString(filePath, 'filePath'))
  })
}

const IMAGE_EXT_SET = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.bmp',
  '.svg'
])
const MAX_IMAGE_BYTES = 20 * 1024 * 1024 // 20 MB

function mimeForImageExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.png':
      return 'image/png'
    case '.gif':
      return 'image/gif'
    case '.webp':
      return 'image/webp'
    case '.bmp':
      return 'image/bmp'
    case '.svg':
      return 'image/svg+xml'
    default:
      return 'application/octet-stream'
  }
}

function isPathInside(root: string, target: string): boolean {
  const nRoot = path.resolve(root)
  const nTarget = path.resolve(target)
  if (process.platform === 'win32') {
    const r = nRoot.toLowerCase()
    const t = nTarget.toLowerCase()
    return t === r || t.startsWith(r + '\\')
  }
  return nTarget === nRoot || nTarget.startsWith(nRoot + path.sep)
}

function grokSessionsRoot(): string {
  return path.join(app.getPath('home'), '.grok', 'sessions')
}

function chatWorkspaceRoot(): string {
  return path.join(app.getPath('userData'), 'chat-workspace')
}

/** Encode cwd the same way Grok CLI does for session storage folders. */
function encodeSessionCwdKey(cwd: string): string {
  return encodeURIComponent(normalizePath(cwd))
}

function resolveImageCandidates(filePath: string): string[] {
  const trimmed = filePath.trim().replace(/^["'`]+|["'`]+$/g, '')
  if (!trimmed) return []

  const candidates: string[] = []
  const isAbs = path.isAbsolute(trimmed)

  if (isAbs) {
    candidates.push(path.normalize(trimmed))
  } else {
    const rel = trimmed.replace(/^\.[\\/]/, '')
    const cwd = agentManager.getCwd()
    const sessionId = agentManager.getSessionId()

    if (cwd) {
      candidates.push(path.resolve(cwd, rel))
      // Grok Imagine saves under ~/.grok/sessions/<encoded-cwd>/<sessionId>/images/N.jpg
      const enc = encodeSessionCwdKey(normalizeCwd(cwd))
      const sessionBase = path.join(grokSessionsRoot(), enc)
      if (sessionId) {
        candidates.push(path.join(sessionBase, sessionId, rel))
      }
      // Fall back: newest session folder under this cwd that has the file
      try {
        if (fs.existsSync(sessionBase)) {
          const dirs = fs
            .readdirSync(sessionBase, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name)
          for (const d of dirs) {
            candidates.push(path.join(sessionBase, d, rel))
          }
        }
      } catch {
        /* ignore */
      }
    }

    // Also try chat workspace encoding (common when surface is chat)
    try {
      const chatRoot = chatWorkspaceRoot()
      const encChat = encodeSessionCwdKey(normalizeCwd(chatRoot))
      const chatSessions = path.join(grokSessionsRoot(), encChat)
      if (fs.existsSync(chatSessions)) {
        for (const d of fs.readdirSync(chatSessions, { withFileTypes: true })) {
          if (d.isDirectory()) candidates.push(path.join(chatSessions, d.name, rel))
        }
      }
    } catch {
      /* ignore */
    }
  }

  return candidates
}

function isAllowedImagePath(resolved: string): boolean {
  const roots: string[] = [grokSessionsRoot(), chatWorkspaceRoot(), app.getPath('userData')]
  const cwd = agentManager.getCwd()
  if (cwd) roots.push(path.resolve(cwd))
  // Recent projects: allow images under any recently opened project cwd
  try {
    for (const p of getRecentProjects()) {
      if (p?.cwd) roots.push(path.resolve(p.cwd))
    }
  } catch {
    /* ignore */
  }

  for (const root of roots) {
    try {
      if (isPathInside(root, resolved)) return true
    } catch {
      /* ignore */
    }
  }
  return false
}

function readLocalImageSafe(filePath: string): {
  dataUrl?: string
  path?: string
  mimeType?: string
  error?: string
} {
  try {
    const candidates = resolveImageCandidates(filePath)
    let found: string | null = null
    for (const c of candidates) {
      try {
        if (fs.existsSync(c) && fs.statSync(c).isFile()) {
          found = c
          break
        }
      } catch {
        /* try next */
      }
    }
    if (!found) {
      return { error: `Image not found: ${filePath}` }
    }

    // realpath to defeat symlink escapes outside allowed roots
    let real: string
    try {
      real = fs.realpathSync(found)
    } catch {
      real = path.resolve(found)
    }

    const ext = path.extname(real).toLowerCase()
    if (!IMAGE_EXT_SET.has(ext)) {
      return { error: `Not an image file (${ext || 'no extension'})` }
    }
    if (!isAllowedImagePath(real)) {
      return { error: 'Path outside allowed image roots' }
    }

    const stat = fs.statSync(real)
    if (stat.size > MAX_IMAGE_BYTES) {
      return { error: `Image too large (${stat.size} bytes)` }
    }

    const buf = fs.readFileSync(real)
    const mime = mimeForImageExt(ext)
    const dataUrl = `data:${mime};base64,${buf.toString('base64')}`
    return { dataUrl, path: real, mimeType: mime }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

function revealLocalPathSafe(filePath: string): { ok: boolean; error?: string } {
  try {
    const candidates = resolveImageCandidates(filePath)
    let found: string | null = null
    for (const c of candidates) {
      try {
        if (fs.existsSync(c)) {
          found = c
          break
        }
      } catch {
        /* next */
      }
    }
    if (!found) return { ok: false, error: 'Path not found' }

    let real: string
    try {
      real = fs.realpathSync(found)
    } catch {
      real = path.resolve(found)
    }
    if (!isAllowedImagePath(real)) {
      return { ok: false, error: 'Path outside allowed roots' }
    }
    shell.showItemInFolder(real)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function hardenSession(): void {
  // CSP on both dev and prod (FIX-R2). Dev relaxes only what Vite HMR needs.
  // img-src includes https: intentionally (FIX-R3) so agent-returned remote
  // images work the same in dev and packaged builds — no silent breakage.
  const isDev = !!process.env.ELECTRON_RENDERER_URL
  const csp = isDev
    ? [
        "default-src 'self'",
        // Vite injects module scripts + react-refresh; HMR needs eval/ws
        "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
        "style-src 'self' 'unsafe-inline'",
        "font-src 'self' data:",
        "img-src 'self' data: blob: https:",
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
        "img-src 'self' data: blob: https:",
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

  // FIX-11 deny web permissions
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
}

app.whenReady().then(() => {
  hardenSession()
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
