import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { agentManager } from './agent-manager'
import { isChatWorkspace, normalizePath } from '../../shared/path'
import {
  assertTrustedSender,
  encodeSessionCwdKey,
  IMAGE_EXT_SET,
  isAllowedExternalUrl,
  isAppUrl,
  isPathInside,
  MAX_IMAGE_BYTES,
  mimeForImageExt
} from './ipc-guard'
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
import { assertAuthenticated, getAuthStatus, loginWithCli, logoutWithCli } from './auth'
import { redactSecrets } from './redact'
import {
  addMcpServer,
  disablePlugin,
  enablePlugin,
  installPlugin,
  listAvailablePlugins,
  listInstalledPlugins,
  listMarketplaces,
  listMcpServers,
  mcpDoctor,
  removeMcpServer,
  uninstallPlugin
} from './plugins'
import {
  initPreview,
  startPreview,
  stopPreview,
  setPreviewBounds,
  setPreviewUrl,
  reloadPreview,
  getPreviewStatus
} from './preview'
import type {
  AppSettings,
  ChatMessage,
  LoginMethod,
  McpAddInput,
  McpScope,
  McpTransport,
  PermissionDecision,
  PromptAttachment,
  SendPromptOptions
} from '../../shared/types'

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

let mainWindow: BrowserWindow | null = null

/** isAppUrl with this process's dev-server env applied. */
function isAppUrlLocal(target: string): boolean {
  return isAppUrl(target, process.env.ELECTRON_RENDERER_URL)
}

function openExternalSafely(target: string): void {
  if (isAllowedExternalUrl(target)) void shell.openExternal(target)
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

// ── Plugin / MCP argument validators ─────────────────────────────────
// Args reach the CLI as discrete argv (no shell), so shell injection is
// impossible — but a value starting with '-' would be parsed by grok as a
// flag (option injection), and control characters can smuggle newlines into
// config/headers. Both are rejected here, at the IPC boundary.
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/
const CLI_NAME_RE = /^[A-Za-z0-9._@/-]+$/
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/
const MCP_TRANSPORTS: McpTransport[] = ['stdio', 'http', 'sse']
const PROJECT_SCOPE_UNSUPPORTED =
  'Project scope is not supported yet: the CLI helper has no validated project directory, ' +
  "so `-s project` would write into Grocky's own folder. Use the user scope."

/** Non-empty string that grok cannot mistake for a flag. */
function assertCliToken(value: unknown, name: string): string {
  const v = assertString(value, name)
  if (v.startsWith('-')) throw new Error(`Invalid ${name}: must not start with '-'`)
  if (CONTROL_CHAR_RE.test(v)) {
    throw new Error(`Invalid ${name}: control characters are not allowed`)
  }
  if (v.length > 1024) throw new Error(`Invalid ${name}: too long`)
  return v
}

/** Plugin / MCP server name: CLI token restricted to a safe character set. */
function assertCliName(value: unknown, name: string): string {
  const v = assertCliToken(value, name)
  if (!CLI_NAME_RE.test(v)) {
    throw new Error(`Invalid ${name}: only letters, digits and . _ @ / - are allowed`)
  }
  if (v.length > 200) throw new Error(`Invalid ${name}: too long`)
  return v
}

function assertMcpTransport(value: unknown): McpTransport {
  const found = MCP_TRANSPORTS.find((t) => t === value)
  if (!found) throw new Error("Invalid transport: expected 'stdio', 'http' or 'sse'")
  return found
}

/**
 * Optional array of non-empty strings (MCP server argv). A leading '-' is
 * allowed here — these are the *server's* own flags and plugins.ts places
 * them after the `--` separator so grok cannot read them as its own.
 */
function assertOptionalStringArray(value: unknown, name: string): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new Error(`Invalid ${name}: expected an array`)
  if (value.length > 64) throw new Error(`Invalid ${name}: too many entries`)
  const out: string[] = []
  for (let i = 0; i < value.length; i++) {
    const item: unknown = value[i]
    if (typeof item !== 'string' || !item.trim()) {
      throw new Error(`Invalid ${name}[${i}]: expected non-empty string`)
    }
    if (CONTROL_CHAR_RE.test(item)) {
      throw new Error(`Invalid ${name}[${i}]: control characters are not allowed`)
    }
    if (item.length > 2048) throw new Error(`Invalid ${name}[${i}]: too long`)
    out.push(item)
  }
  return out.length ? out : undefined
}

/**
 * Optional plain string->string record (MCP env / headers). Values may be
 * secrets, so they are never echoed back in error messages.
 */
function assertOptionalStringRecord(
  value: unknown,
  name: string,
  keyPattern: RegExp
): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${name}: expected an object`)
  }
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(`Invalid ${name}: expected a plain object`)
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > 50) throw new Error(`Invalid ${name}: too many entries`)
  const out: Record<string, string> = {}
  for (const [key, raw] of entries) {
    if (!keyPattern.test(key)) throw new Error(`Invalid ${name} key: ${key}`)
    if (typeof raw !== 'string' || !raw) {
      throw new Error(`Invalid ${name} value for ${key}: expected non-empty string`)
    }
    if (CONTROL_CHAR_RE.test(raw)) {
      throw new Error(`Invalid ${name} value for ${key}: control characters are not allowed`)
    }
    if (raw.length > 4096) throw new Error(`Invalid ${name} value for ${key}: too long`)
    out[key] = raw
  }
  return Object.keys(out).length ? out : undefined
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
      mainWindow.webContents.send('grocky:event', {
        type: 'preview-status',
        ...(payload as Record<string, unknown>)
      })
    } else if (channel === 'preview-log') {
      mainWindow.webContents.send('grocky:event', { type: 'preview-log', text: String(payload) })
    }
  })

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
    if (isAppUrlLocal(url)) return
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
    stopPreview()
    mainWindow = null
    agentManager.setWindow(null)
  })
}

/**
 * Install the Grok CLI via the official x.ai installer. Only ever called from the
 * user-consented install modal — never automatically. Runs the platform installer,
 * then re-detects the binary.
 */
function installGrokCli(): Promise<{
  ok: boolean
  message: string
  grokPath: string | null
  installed: boolean
}> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32'
    const cmd = isWin ? 'powershell.exe' : 'bash'
    const args = isWin
      ? [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          'irm https://x.ai/cli/install.ps1 | iex'
        ]
      : // curl is not guaranteed on a minimal Linux image — Alpine's busybox ships
        // wget but no curl, and Debian slim ships neither. Without a fallback the
        // only symptom is "command not found" buried in the installer output tail.
        [
          '-lc',
          'if command -v curl >/dev/null 2>&1; then curl -fsSL https://x.ai/cli/install.sh | bash; ' +
            'elif command -v wget >/dev/null 2>&1; then wget -qO- https://x.ai/cli/install.sh | bash; ' +
            'else echo "Neither curl nor wget is installed. Install one, or run the Grok CLI installer manually: https://x.ai/cli" >&2; exit 127; fi'
        ]

    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn(cmd, args, { windowsHide: true, env: process.env })
    } catch (err) {
      resolve({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
        grokPath: null,
        installed: false
      })
      return
    }

    let out = ''
    const timer = setTimeout(() => {
      try {
        proc.kill()
      } catch {
        /* ignore */
      }
    }, 240_000)

    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on('data', (c: string) => {
      out += c
    })
    proc.stderr?.setEncoding('utf8')
    proc.stderr?.on('data', (c: string) => {
      out += c
    })
    proc.on('error', (err) => {
      clearTimeout(timer)
      resolve({ ok: false, message: err.message, grokPath: null, installed: false })
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      const grokPath = resolveGrokBinary(getSettings().grokBinary)
      const installed = !!grokPath
      const tail = redactSecrets((out || '').slice(-1500)).trim()
      resolve({
        ok: installed,
        message: installed
          ? 'Grok CLI installed. Sign in with your own account to continue.'
          : tail ||
            `Installer exited (code ${code ?? '?'}) but the grok binary was not found. Restart Grocky or install manually.`,
        grokPath,
        installed
      })
    })
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

  ipcMain.handle('grocky:install-cli', async (e) => {
    assertTrustedSender(e)
    return installGrokCli()
  })

  ipcMain.handle('grocky:preview-start', (e, cwd: string, command?: string) => {
    assertTrustedSender(e)
    return startPreview(normalizeCwd(assertString(cwd, 'cwd')), assertOptionalString(command, 'command'))
  })

  ipcMain.handle('grocky:preview-stop', (e) => {
    assertTrustedSender(e)
    stopPreview()
  })

  ipcMain.handle('grocky:preview-set-bounds', (e, rect: unknown) => {
    assertTrustedSender(e)
    if (rect && typeof rect === 'object') {
      const r = rect as { x?: number; y?: number; width?: number; height?: number }
      if (
        typeof r.x === 'number' &&
        typeof r.y === 'number' &&
        typeof r.width === 'number' &&
        typeof r.height === 'number'
      ) {
        setPreviewBounds({ x: r.x, y: r.y, width: r.width, height: r.height })
      }
    }
  })

  ipcMain.handle('grocky:preview-set-url', (e, url: string) => {
    assertTrustedSender(e)
    setPreviewUrl(assertString(url, 'url'))
  })

  ipcMain.handle('grocky:preview-reload', (e) => {
    assertTrustedSender(e)
    reloadPreview()
  })

  ipcMain.handle('grocky:preview-status', (e) => {
    assertTrustedSender(e)
    return getPreviewStatus()
  })

  // ── Plugins & Skills ────────────────────────────────────────────────
  // Read paths are CLI-local (git/config, not xAI-account scoped) so they are
  // not auth-gated; every mutating handler calls assertAuthenticated() first.
  // Trust is never implied — installPlugin receives an explicit boolean that
  // the UI may only set from a human-confirmed trust modal.

  ipcMain.handle('grocky:plugin-list', async (e) => {
    assertTrustedSender(e)
    return listInstalledPlugins()
  })

  ipcMain.handle('grocky:plugin-available', async (e) => {
    assertTrustedSender(e)
    return listAvailablePlugins()
  })

  ipcMain.handle('grocky:plugin-marketplaces', async (e) => {
    assertTrustedSender(e)
    return listMarketplaces()
  })

  ipcMain.handle('grocky:plugin-install', async (e, source: unknown, trust: unknown) => {
    assertTrustedSender(e)
    // A source may be a git URL, user/repo@ref#subdir, or a local path (spaces
    // allowed) — only a leading '-' and control characters are rejected.
    const src = assertCliToken(source, 'source')
    if (typeof trust !== 'boolean') throw new Error('Invalid trust flag: expected boolean')
    await assertAuthenticated()
    return installPlugin(src, trust)
  })

  ipcMain.handle('grocky:plugin-enable', async (e, name: unknown) => {
    assertTrustedSender(e)
    const pluginName = assertCliName(name, 'name')
    await assertAuthenticated()
    return enablePlugin(pluginName)
  })

  ipcMain.handle('grocky:plugin-disable', async (e, name: unknown) => {
    assertTrustedSender(e)
    const pluginName = assertCliName(name, 'name')
    await assertAuthenticated()
    return disablePlugin(pluginName)
  })

  ipcMain.handle('grocky:plugin-uninstall', async (e, name: unknown) => {
    assertTrustedSender(e)
    const pluginName = assertCliName(name, 'name')
    await assertAuthenticated()
    return uninstallPlugin(pluginName)
  })

  ipcMain.handle('grocky:mcp-list', async (e) => {
    assertTrustedSender(e)
    return listMcpServers()
  })

  ipcMain.handle('grocky:mcp-add', async (e, input: unknown) => {
    assertTrustedSender(e)
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('Invalid MCP server input: expected an object')
    }
    const raw = input as Record<string, unknown>
    // MVP: user scope only (spec §5) — the spawn helper has no validated
    // project cwd, so `-s project` would target Grocky's own directory.
    if (raw.scope === 'project') throw new Error(PROJECT_SCOPE_UNSUPPORTED)
    if (raw.scope !== 'user') throw new Error("Invalid scope: expected 'user' or 'project'")
    const payload: McpAddInput = {
      name: assertCliName(raw.name, 'name'),
      commandOrUrl: assertCliToken(raw.commandOrUrl, 'commandOrUrl'),
      transport: assertMcpTransport(raw.transport),
      scope: 'user',
      args: assertOptionalStringArray(raw.args, 'args'),
      env: assertOptionalStringRecord(raw.env, 'env', ENV_KEY_RE),
      headers: assertOptionalStringRecord(raw.headers, 'headers', HEADER_NAME_RE)
    }
    await assertAuthenticated()
    return addMcpServer(payload)
  })

  ipcMain.handle('grocky:mcp-remove', async (e, name: unknown, scope?: unknown) => {
    assertTrustedSender(e)
    const serverName = assertCliName(name, 'name')
    const rawScope = assertOptionalString(scope, 'scope')
    if (rawScope === 'project') throw new Error(PROJECT_SCOPE_UNSUPPORTED)
    if (rawScope !== undefined && rawScope !== 'user') {
      throw new Error("Invalid scope: expected 'user' or 'project'")
    }
    const mcpScope: McpScope | undefined = rawScope === 'user' ? 'user' : undefined
    await assertAuthenticated()
    return removeMcpServer(serverName, mcpScope)
  })

  ipcMain.handle('grocky:mcp-doctor', async (e, name?: unknown) => {
    assertTrustedSender(e)
    const rawName = assertOptionalString(name, 'name')
    return mcpDoctor(rawName === undefined ? undefined : assertCliName(rawName, 'name'))
  })
}

function grokSessionsRoot(): string {
  return path.join(app.getPath('home'), '.grok', 'sessions')
}

function chatWorkspaceRoot(): string {
  return path.join(app.getPath('userData'), 'chat-workspace')
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
