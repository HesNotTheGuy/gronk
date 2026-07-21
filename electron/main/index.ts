import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import path from 'node:path'
import { agentManager } from './agent-manager'
import {
  addRecentProject,
  getRecentProjects,
  getSettings,
  listSessions,
  setSettings
} from './store'
import { resolveGrokBinary } from './acp/client'
import type { AppSettings, PermissionDecision } from '../../shared/types'

// Prevent multiple instances fighting over the same agent child
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    title: 'Grocky',
    backgroundColor: '#000000',
    show: false,
    // Cross-platform: hidden inset title bar on macOS feels native
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 16, y: 16 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  agentManager.setWindow(mainWindow)

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

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
  ipcMain.handle('grocky:select-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    return result.filePaths[0]
  })

  ipcMain.handle('grocky:get-settings', () => getSettings())

  ipcMain.handle('grocky:set-settings', (_e, partial: Partial<AppSettings>) =>
    setSettings(partial)
  )

  ipcMain.handle('grocky:get-recent-projects', () => getRecentProjects())

  ipcMain.handle('grocky:add-recent-project', (_e, cwd: string) => addRecentProject(cwd))

  ipcMain.handle(
    'grocky:start-agent',
    async (_e, cwd: string, options?: { model?: string; alwaysApprove?: boolean }) => {
      addRecentProject(cwd)
      return agentManager.start(cwd, options)
    }
  )

  ipcMain.handle('grocky:stop-agent', () => agentManager.stop())

  ipcMain.handle('grocky:send-prompt', (_e, text: string) => agentManager.sendPrompt(text))

  ipcMain.handle('grocky:cancel-prompt', () => agentManager.cancelPrompt())

  ipcMain.handle(
    'grocky:respond-permission',
    (_e, requestId: number | string, decision: PermissionDecision) => {
      agentManager.respondPermission(requestId, decision)
    }
  )

  ipcMain.handle('grocky:list-sessions', () => listSessions())

  ipcMain.handle('grocky:load-session', async (_e, sessionId: string) => {
    const sessions = listSessions()
    const match = sessions.find((s) => s.id === sessionId)
    return agentManager.loadSession(sessionId, match?.cwd)
  })

  ipcMain.handle('grocky:get-connection-state', () => agentManager.getConnectionState())

  ipcMain.handle('grocky:get-grok-path', () => {
    const settings = getSettings()
    return resolveGrokBinary(settings.grokBinary)
  })
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()

  app.on('activate', () => {
    // macOS: re-create window when dock icon is clicked
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // macOS apps typically stay open until Cmd+Q
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
