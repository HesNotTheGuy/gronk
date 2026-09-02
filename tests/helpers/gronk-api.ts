/**
 * A stand-in for the preload bridge, so the renderer can be tested without
 * Electron.
 *
 * Every method resolves to something shaped like the real thing. Anything the
 * hook awaits on mount must return a usable value, or the component under test
 * dies in an effect and the failure looks like a render bug.
 */
import { ensureDom } from './render'
import type { MainToRendererEvent } from '../../shared/types'

type Handler = (event: MainToRendererEvent) => void

export interface FakeBridge {
  /** Push an event as the main process would. */
  emit: (event: MainToRendererEvent) => void
  /** Every call made, for asserting what the UI actually asked for. */
  calls: string[]
  restore: () => void
}

const EMPTY_SETTINGS = {
  permissionMode: 'default' as const,
  alwaysApprove: false,
  alwaysApproveAck: false,
  theme: 'dark' as const
}

const EMPTY_LOCATION = {
  dataDir: '/data',
  defaultDir: '/data',
  isDefault: true,
  storePath: '/data/gronk-store.json',
  chatWorkspacePath: '/data/chat-workspace',
  storeBytes: 0,
  previousChatWorkspaces: []
}

/**
 * Installs `window.gronk`. Overrides are merged last so a test can make one
 * call fail or return fixtures without restating the other fifty-seven.
 */
export function installFakeBridge(overrides: Record<string, unknown> = {}): FakeBridge {
  const handlers: Handler[] = []
  const calls: string[] = []
  const track = <T>(name: string, value: T) => {
    calls.push(name)
    return value
  }

  const api: Record<string, unknown> = {
    platform: 'linux',
    onEvent: (handler: Handler) => {
      handlers.push(handler)
      return () => {
        const i = handlers.indexOf(handler)
        if (i >= 0) handlers.splice(i, 1)
      }
    },

    getSettings: async () => track('getSettings', { ...EMPTY_SETTINGS }),
    setSettings: async (partial: object) => track('setSettings', { ...EMPTY_SETTINGS, ...partial }),
    getRecentProjects: async () => track('getRecentProjects', []),
    addRecentProject: async () => track('addRecentProject', []),
    removeRecentProject: async () => track('removeRecentProject', []),
    setRecentProjectPinned: async () => track('setRecentProjectPinned', []),
    getGitChanges: async () =>
      track('getGitChanges', { repo: false, reason: 'no-folder', files: [], truncated: false }),
    getGitFileDiff: async () =>
      track('getGitFileDiff', {
        path: '',
        status: 'modified',
        text: '',
        truncated: false,
        binary: false
      }),
    getProjectNotes: async () => track('getProjectNotes', {}),
    setProjectNote: async () => track('setProjectNote', {}),
    setChromeTheme: async () => track('setChromeTheme', undefined),
    writeClipboard: async () => track('writeClipboard', undefined),
    listSessions: async () => track('listSessions', []),
    listModels: async () => track('listModels', [{ id: 'grok-4.5', name: 'Grok 4.5', isDefault: true }]),
    getPermissionAudit: async () => track('getPermissionAudit', []),
    getConnectionState: async () => track('getConnectionState', 'idle'),
    getGrokPath: async () => track('getGrokPath', '/usr/local/bin/grok'),
    getChatWorkspacePath: async () => track('getChatWorkspacePath', '/data/chat-workspace'),
    getHealth: async () =>
      track('getHealth', {
        grokFound: true,
        grokPath: '/usr/local/bin/grok',
        nodeOk: true,
        platform: 'linux',
        auth: { state: 'authenticated', authenticated: true, method: 'session' }
      }),
    getAuthStatus: async () =>
      track('getAuthStatus', {
        state: 'authenticated',
        authenticated: true,
        method: 'session',
        accountLabel: 'grok.com'
      }),
    getStoreHealth: async () => track('getStoreHealth', { source: 'file', degraded: false, schemaVersion: 1 }),
    getCliVersion: async () =>
      track('getCliVersion', { current: '0.2.112', channel: 'stable', verifiedAgainst: '0.2.112', status: 'ok' }),
    getActivityCalendar: async () =>
      track('getActivityCalendar', {
        days: [],
        from: '2026-01-01',
        to: '2026-01-01',
        peak: 1,
        totalUserTurns: 0,
        currentStreak: 0,
        longestStreak: 0
      }),

    getDataLocation: async () => track('getDataLocation', { ...EMPTY_LOCATION }),
    chooseDataDir: async () => track('chooseDataDir', null),
    moveDataDir: async () => track('moveDataDir', { ok: true, message: '', location: { ...EMPTY_LOCATION } }),
    resetDataDir: async () => track('resetDataDir', { ok: true, message: '', location: { ...EMPTY_LOCATION } }),

    startAgent: async () => track('startAgent', { sessionId: 's1' }),
    stopAgent: async () => track('stopAgent', undefined),
    focusSession: async () => track('focusSession', undefined),
    getSessionLiveness: async () => track('getSessionLiveness', {}),
    sendPrompt: async () => track('sendPrompt', { messageId: 'm1' }),
    setModel: async (model: string) => track('setModel', { model }),
    cancelPrompt: async () => track('cancelPrompt', undefined),
    respondPermission: async () => track('respondPermission', undefined),
    loadSession: async () => track('loadSession', { sessionId: 's1', restored: false }),
    getTranscript: async () => track('getTranscript', []),
    searchSessions: async () => track('searchSessions', []),
    saveTranscript: async () => track('saveTranscript', undefined),
    deleteSession: async () => track('deleteSession', []),
    renameSession: async () => track('renameSession', null),
    archiveSession: async () => track('archiveSession', null),
    exportTranscript: async () => track('exportTranscript', { ok: false, reason: 'cancelled' }),
    listProjectFiles: async () => track('listProjectFiles', []),
    selectFolder: async () => track('selectFolder', null),
    selectFile: async () => track('selectFile', null),
    login: async () => track('login', { ok: true, method: 'oauth', message: '', auth: {} }),
    cancelLogin: async () => track('cancelLogin', false),
    logout: async () => track('logout', { ok: true, message: '', auth: {} }),
    installCli: async () => track('installCli', { ok: true, message: '', grokPath: null, installed: false }),

    previewStart: async () => track('previewStart', { ok: true, message: '' }),
    previewStop: async () => track('previewStop', undefined),
    previewSetBounds: () => undefined,
    previewSetUrl: async () => track('previewSetUrl', undefined),
    previewReload: async () => track('previewReload', undefined),
    previewStatus: async () =>
      track('previewStatus', { running: false, url: null, cwd: null, poppedOut: false }),
    previewPopOut: async () => track('previewPopOut', { ok: true, message: '' }),
    previewDock: async () => track('previewDock', undefined),

    listSkills: async () => track('listSkills', []),
    listWorkflows: async () => track('listWorkflows', []),

    listInstalledPlugins: async () => track('listInstalledPlugins', []),
    listAvailablePlugins: async () => track('listAvailablePlugins', []),
    listMarketplaces: async () => track('listMarketplaces', []),
    installPlugin: async () => track('installPlugin', { ok: true, message: '' }),
    enablePlugin: async () => track('enablePlugin', { ok: true, message: '' }),
    disablePlugin: async () => track('disablePlugin', { ok: true, message: '' }),
    uninstallPlugin: async () => track('uninstallPlugin', { ok: true, message: '' }),
    listMcpServers: async () => track('listMcpServers', []),
    addMcpServer: async () => track('addMcpServer', { ok: true, message: '' }),
    removeMcpServer: async () => track('removeMcpServer', { ok: true, message: '' }),
    mcpDoctor: async () => track('mcpDoctor', []),

    readLocalImage: async () => track('readLocalImage', { error: 'not available in tests' }),
    revealLocalPath: async () => track('revealLocalPath', { ok: true }),

    ...overrides
  }

  // The DOM has to exist first: jsdom replaces globalThis.window when it is
  // created, which would discard a bridge installed onto the old one.
  ensureDom()

  const globals = globalThis as Record<string, unknown>
  const previous = globals.gronk
  globals.gronk = api
  if (globals.window) (globals.window as Record<string, unknown>).gronk = api

  return {
    emit: (event) => {
      for (const handler of [...handlers]) handler(event)
    },
    calls,
    restore: () => {
      globals.gronk = previous
      if (globals.window) (globals.window as Record<string, unknown>).gronk = previous
    }
  }
}
