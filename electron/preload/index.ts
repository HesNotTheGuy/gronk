import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppSettings,
  GrockyApi,
  MainToRendererEvent,
  PermissionDecision
} from '../../shared/types'

const api: GrockyApi = {
  selectFolder: () => ipcRenderer.invoke('grocky:select-folder'),
  getSettings: () => ipcRenderer.invoke('grocky:get-settings'),
  setSettings: (partial: Partial<AppSettings>) =>
    ipcRenderer.invoke('grocky:set-settings', partial),
  getRecentProjects: () => ipcRenderer.invoke('grocky:get-recent-projects'),
  addRecentProject: (cwd: string) => ipcRenderer.invoke('grocky:add-recent-project', cwd),
  startAgent: (cwd, options) => ipcRenderer.invoke('grocky:start-agent', cwd, options),
  stopAgent: () => ipcRenderer.invoke('grocky:stop-agent'),
  sendPrompt: (text: string) => ipcRenderer.invoke('grocky:send-prompt', text),
  cancelPrompt: () => ipcRenderer.invoke('grocky:cancel-prompt'),
  respondPermission: (requestId: number | string, decision: PermissionDecision) =>
    ipcRenderer.invoke('grocky:respond-permission', requestId, decision),
  listSessions: () => ipcRenderer.invoke('grocky:list-sessions'),
  loadSession: (sessionId: string) => ipcRenderer.invoke('grocky:load-session', sessionId),
  getConnectionState: () => ipcRenderer.invoke('grocky:get-connection-state'),
  getGrokPath: () => ipcRenderer.invoke('grocky:get-grok-path'),
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
