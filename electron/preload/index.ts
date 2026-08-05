import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppSettings,
  ChatMessage,
  GronkApi,
  LoginMethod,
  MainToRendererEvent,
  McpAddInput,
  McpScope,
  PermissionDecision,
  SendPromptOptions
} from '../../shared/types'

const api: GronkApi = {
  selectFolder: () => ipcRenderer.invoke('gronk:select-folder'),
  selectFile: (options) => ipcRenderer.invoke('gronk:select-file', options),
  getSettings: () => ipcRenderer.invoke('gronk:get-settings'),
  setSettings: (partial: Partial<AppSettings>) =>
    ipcRenderer.invoke('gronk:set-settings', partial),
  getRecentProjects: () => ipcRenderer.invoke('gronk:get-recent-projects'),
  addRecentProject: (cwd: string) => ipcRenderer.invoke('gronk:add-recent-project', cwd),
  removeRecentProject: (cwd: string) => ipcRenderer.invoke('gronk:remove-recent-project', cwd),
  setRecentProjectPinned: (cwd: string, pinned: boolean) =>
    ipcRenderer.invoke('gronk:set-recent-project-pinned', cwd, pinned),
  getProjectNotes: () => ipcRenderer.invoke('gronk:get-project-notes'),
  setProjectNote: (cwd: string, note: string) =>
    ipcRenderer.invoke('gronk:set-project-note', cwd, note),
  setChromeTheme: (theme: 'dark' | 'light') => ipcRenderer.invoke('gronk:set-chrome-theme', theme),
  writeClipboard: (text: string) => ipcRenderer.invoke('gronk:write-clipboard', text),
  startAgent: (cwd, options) => ipcRenderer.invoke('gronk:start-agent', cwd, options),
  getChatWorkspacePath: () => ipcRenderer.invoke('gronk:get-chat-workspace'),
  stopAgent: () => ipcRenderer.invoke('gronk:stop-agent'),
  sendPrompt: (text: string, options?: SendPromptOptions) =>
    ipcRenderer.invoke('gronk:send-prompt', text, options),
  cancelPrompt: () => ipcRenderer.invoke('gronk:cancel-prompt'),
  respondPermission: (requestId: number | string, decision: PermissionDecision) =>
    ipcRenderer.invoke('gronk:respond-permission', requestId, decision),
  listSessions: () => ipcRenderer.invoke('gronk:list-sessions'),
  loadSession: (sessionId: string) => ipcRenderer.invoke('gronk:load-session', sessionId),
  searchSessions: (query: string) => ipcRenderer.invoke('gronk:search-sessions', query),
  getTranscript: (sessionId: string) => ipcRenderer.invoke('gronk:get-transcript', sessionId),
  saveTranscript: (sessionId: string, messages: ChatMessage[]) =>
    ipcRenderer.invoke('gronk:save-transcript', sessionId, messages),
  deleteSession: (sessionId: string) => ipcRenderer.invoke('gronk:delete-session', sessionId),
  renameSession: (sessionId: string, title: string) =>
    ipcRenderer.invoke('gronk:rename-session', sessionId, title),
  archiveSession: (sessionId: string, archived?: boolean) =>
    ipcRenderer.invoke('gronk:archive-session', sessionId, archived),
  exportTranscript: (sessionId: string, format?: 'md' | 'json') =>
    ipcRenderer.invoke('gronk:export-transcript', sessionId, format),
  listProjectFiles: (cwd: string, query?: string, limit?: number) =>
    ipcRenderer.invoke('gronk:list-project-files', cwd, query, limit),
  listModels: () => ipcRenderer.invoke('gronk:list-models'),
  getPermissionAudit: () => ipcRenderer.invoke('gronk:get-permission-audit'),
  getConnectionState: () => ipcRenderer.invoke('gronk:get-connection-state'),
  getGrokPath: () => ipcRenderer.invoke('gronk:get-grok-path'),
  getHealth: () => ipcRenderer.invoke('gronk:get-health'),
  getAuthStatus: () => ipcRenderer.invoke('gronk:get-auth-status'),
  login: (method?: LoginMethod) => ipcRenderer.invoke('gronk:login', method),
  logout: () => ipcRenderer.invoke('gronk:logout'),
  installCli: () => ipcRenderer.invoke('gronk:install-cli'),
  getStoreHealth: () => ipcRenderer.invoke('gronk:get-store-health'),
  getCliVersion: () => ipcRenderer.invoke('gronk:get-cli-version'),
  getActivityCalendar: (days?: number) =>
    ipcRenderer.invoke('gronk:get-activity-calendar', days),
  getDataLocation: () => ipcRenderer.invoke('gronk:get-data-location'),
  chooseDataDir: () => ipcRenderer.invoke('gronk:choose-data-dir'),
  moveDataDir: (target: string) => ipcRenderer.invoke('gronk:move-data-dir', target),
  resetDataDir: () => ipcRenderer.invoke('gronk:reset-data-dir'),
  previewStart: (cwd: string, command?: string) =>
    ipcRenderer.invoke('gronk:preview-start', cwd, command),
  previewStop: () => ipcRenderer.invoke('gronk:preview-stop'),
  previewSetBounds: (rect: { x: number; y: number; width: number; height: number }) => {
    void ipcRenderer.invoke('gronk:preview-set-bounds', rect)
  },
  previewSetUrl: (url: string) => ipcRenderer.invoke('gronk:preview-set-url', url),
  previewPopOut: () => ipcRenderer.invoke('gronk:preview-pop-out'),
  previewDock: () => ipcRenderer.invoke('gronk:preview-dock'),
  previewReload: () => ipcRenderer.invoke('gronk:preview-reload'),
  previewStatus: () => ipcRenderer.invoke('gronk:preview-status'),
  listSkills: () => ipcRenderer.invoke('gronk:list-skills'),
  listInstalledPlugins: () => ipcRenderer.invoke('gronk:plugin-list'),
  listAvailablePlugins: () => ipcRenderer.invoke('gronk:plugin-available'),
  listMarketplaces: () => ipcRenderer.invoke('gronk:plugin-marketplaces'),
  installPlugin: (source: string, trust: boolean) =>
    ipcRenderer.invoke('gronk:plugin-install', source, trust),
  enablePlugin: (name: string) => ipcRenderer.invoke('gronk:plugin-enable', name),
  disablePlugin: (name: string) => ipcRenderer.invoke('gronk:plugin-disable', name),
  uninstallPlugin: (name: string) => ipcRenderer.invoke('gronk:plugin-uninstall', name),
  listMcpServers: () => ipcRenderer.invoke('gronk:mcp-list'),
  addMcpServer: (input: McpAddInput) => ipcRenderer.invoke('gronk:mcp-add', input),
  removeMcpServer: (name: string, scope?: McpScope) =>
    ipcRenderer.invoke('gronk:mcp-remove', name, scope),
  mcpDoctor: (name?: string) => ipcRenderer.invoke('gronk:mcp-doctor', name),
  readLocalImage: (filePath: string) => ipcRenderer.invoke('gronk:read-local-image', filePath),
  revealLocalPath: (filePath: string) => ipcRenderer.invoke('gronk:reveal-local-path', filePath),
  onEvent: (handler) => {
    const listener = (_: Electron.IpcRendererEvent, event: MainToRendererEvent) => {
      handler(event)
    }
    ipcRenderer.on('gronk:event', listener)
    return () => {
      ipcRenderer.removeListener('gronk:event', listener)
    }
  },
  platform: process.platform
}

contextBridge.exposeInMainWorld('gronk', api)
