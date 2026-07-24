import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppSettings,
  ChatMessage,
  GrockyApi,
  LoginMethod,
  MainToRendererEvent,
  PermissionDecision,
  SendPromptOptions
} from '../../shared/types'

const api: GrockyApi = {
  selectFolder: () => ipcRenderer.invoke('grocky:select-folder'),
  selectFile: (options) => ipcRenderer.invoke('grocky:select-file', options),
  getSettings: () => ipcRenderer.invoke('grocky:get-settings'),
  setSettings: (partial: Partial<AppSettings>) =>
    ipcRenderer.invoke('grocky:set-settings', partial),
  getRecentProjects: () => ipcRenderer.invoke('grocky:get-recent-projects'),
  addRecentProject: (cwd: string) => ipcRenderer.invoke('grocky:add-recent-project', cwd),
  startAgent: (cwd, options) => ipcRenderer.invoke('grocky:start-agent', cwd, options),
  getChatWorkspacePath: () => ipcRenderer.invoke('grocky:get-chat-workspace'),
  stopAgent: () => ipcRenderer.invoke('grocky:stop-agent'),
  sendPrompt: (text: string, options?: SendPromptOptions) =>
    ipcRenderer.invoke('grocky:send-prompt', text, options),
  cancelPrompt: () => ipcRenderer.invoke('grocky:cancel-prompt'),
  respondPermission: (requestId: number | string, decision: PermissionDecision) =>
    ipcRenderer.invoke('grocky:respond-permission', requestId, decision),
  listSessions: () => ipcRenderer.invoke('grocky:list-sessions'),
  loadSession: (sessionId: string) => ipcRenderer.invoke('grocky:load-session', sessionId),
  getTranscript: (sessionId: string) => ipcRenderer.invoke('grocky:get-transcript', sessionId),
  saveTranscript: (sessionId: string, messages: ChatMessage[]) =>
    ipcRenderer.invoke('grocky:save-transcript', sessionId, messages),
  deleteSession: (sessionId: string) => ipcRenderer.invoke('grocky:delete-session', sessionId),
  renameSession: (sessionId: string, title: string) =>
    ipcRenderer.invoke('grocky:rename-session', sessionId, title),
  archiveSession: (sessionId: string, archived?: boolean) =>
    ipcRenderer.invoke('grocky:archive-session', sessionId, archived),
  exportTranscript: (sessionId: string, format?: 'md' | 'json') =>
    ipcRenderer.invoke('grocky:export-transcript', sessionId, format),
  listProjectFiles: (cwd: string, query?: string, limit?: number) =>
    ipcRenderer.invoke('grocky:list-project-files', cwd, query, limit),
  listModels: () => ipcRenderer.invoke('grocky:list-models'),
  getPermissionAudit: () => ipcRenderer.invoke('grocky:get-permission-audit'),
  getConnectionState: () => ipcRenderer.invoke('grocky:get-connection-state'),
  getGrokPath: () => ipcRenderer.invoke('grocky:get-grok-path'),
  getHealth: () => ipcRenderer.invoke('grocky:get-health'),
  getAuthStatus: () => ipcRenderer.invoke('grocky:get-auth-status'),
  login: (method?: LoginMethod) => ipcRenderer.invoke('grocky:login', method),
  logout: () => ipcRenderer.invoke('grocky:logout'),
  installCli: () => ipcRenderer.invoke('grocky:install-cli'),
  readLocalImage: (filePath: string) => ipcRenderer.invoke('grocky:read-local-image', filePath),
  revealLocalPath: (filePath: string) => ipcRenderer.invoke('grocky:reveal-local-path', filePath),
  onEvent: (handler) => {
    const listener = (_: Electron.IpcRendererEvent, event: MainToRendererEvent) => {
      handler(event)
    }
    ipcRenderer.on('grocky:event', listener)
    return () => {
      ipcRenderer.removeListener('grocky:event', listener)
    }
  },
  platform: process.platform
}

contextBridge.exposeInMainWorld('grocky', api)
