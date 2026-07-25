import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppSettings,
  ChatMessage,
  GrockyApi,
  LoginMethod,
  MainToRendererEvent,
  McpAddInput,
  McpScope,
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
  getStoreHealth: () => ipcRenderer.invoke('grocky:get-store-health'),
  getCliVersion: () => ipcRenderer.invoke('grocky:get-cli-version'),
  getDataLocation: () => ipcRenderer.invoke('grocky:get-data-location'),
  chooseDataDir: () => ipcRenderer.invoke('grocky:choose-data-dir'),
  moveDataDir: (target: string) => ipcRenderer.invoke('grocky:move-data-dir', target),
  resetDataDir: () => ipcRenderer.invoke('grocky:reset-data-dir'),
  previewStart: (cwd: string, command?: string) =>
    ipcRenderer.invoke('grocky:preview-start', cwd, command),
  previewStop: () => ipcRenderer.invoke('grocky:preview-stop'),
  previewSetBounds: (rect: { x: number; y: number; width: number; height: number }) => {
    void ipcRenderer.invoke('grocky:preview-set-bounds', rect)
  },
  previewSetUrl: (url: string) => ipcRenderer.invoke('grocky:preview-set-url', url),
  previewReload: () => ipcRenderer.invoke('grocky:preview-reload'),
  previewStatus: () => ipcRenderer.invoke('grocky:preview-status'),
  listInstalledPlugins: () => ipcRenderer.invoke('grocky:plugin-list'),
  listAvailablePlugins: () => ipcRenderer.invoke('grocky:plugin-available'),
  listMarketplaces: () => ipcRenderer.invoke('grocky:plugin-marketplaces'),
  installPlugin: (source: string, trust: boolean) =>
    ipcRenderer.invoke('grocky:plugin-install', source, trust),
  enablePlugin: (name: string) => ipcRenderer.invoke('grocky:plugin-enable', name),
  disablePlugin: (name: string) => ipcRenderer.invoke('grocky:plugin-disable', name),
  uninstallPlugin: (name: string) => ipcRenderer.invoke('grocky:plugin-uninstall', name),
  listMcpServers: () => ipcRenderer.invoke('grocky:mcp-list'),
  addMcpServer: (input: McpAddInput) => ipcRenderer.invoke('grocky:mcp-add', input),
  removeMcpServer: (name: string, scope?: McpScope) =>
    ipcRenderer.invoke('grocky:mcp-remove', name, scope),
  mcpDoctor: (name?: string) => ipcRenderer.invoke('grocky:mcp-doctor', name),
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
