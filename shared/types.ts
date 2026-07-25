/** Shared IPC + domain types between main and renderer. */

export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'auto'
  | 'dontAsk'
  | 'bypassPermissions'
  | 'plan'

export type ConnectionState =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'error'
  | 'stopped'
  | 'loading'

/** Top-level app surface: home hub, general Grok chat, or coding project */
export type AppSurface = 'home' | 'chat' | 'project'

export type AgentSurface = 'chat' | 'project'

export interface SessionInfo {
  id: string
  cwd: string
  title?: string
  createdAt: number
  updatedAt: number
  /**
   * Where this session belongs in the UI.
   * `chat` = app-level chat (no coding folder); `project` = workspace folder agent.
   * Optional for older store entries — fall back to isChatWorkspace(cwd).
   */
  surface?: AgentSurface
  /** Soft-hide from main lists (can still restore later) */
  archived?: boolean
  archivedAt?: number
  /** Approx. messages in transcript — used for activity / frequency UI */
  messageCount?: number
  /** User prompts sent in this session */
  userTurns?: number
}

export interface ProjectContext {
  cwd: string
  name: string
}

export type ToolCallStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface ToolCallInfo {
  toolCallId: string
  title: string
  kind?: string
  status: ToolCallStatus
  rawInput?: unknown
  content?: unknown
  error?: string
}

export type MessageRole = 'user' | 'assistant' | 'system'

export type MessageSendStatus = 'sending' | 'sent' | 'failed'

export interface ChatMessage {
  id: string
  role: MessageRole
  /** Accumulated assistant/user text */
  text: string
  /** Streaming thought/reasoning */
  thought?: string
  toolCalls?: ToolCallInfo[]
  createdAt: number
  streaming?: boolean
  error?: string
  /**
   * Outbound user-message delivery (renderer-only).
   * - sending: in flight
   * - sent: accepted by agent
   * - failed: not delivered — may show Retry once
   */
  sendStatus?: MessageSendStatus
  /** True when restored from history (not live stream) */
  fromHistory?: boolean
  /** Attached image previews (data URLs) for UI only */
  attachments?: PromptAttachment[]
}

export interface PromptAttachment {
  id: string
  kind: 'file' | 'image'
  /** Absolute path for files, or display name for images */
  name: string
  path?: string
  /** Base64 payload without data: prefix (images) */
  data?: string
  mimeType?: string
  /** data URL for image preview in UI */
  previewUrl?: string
}

export interface PermissionRequest {
  /** JSON-RPC request id (number or string from the agent) */
  requestId: number | string
  sessionId: string
  toolCallId: string
  title: string
  kind?: string
  rawInput?: unknown
}

export type PermissionDecision =
  | 'allow-once'
  | 'allow-always'
  | 'reject-once'

export interface PermissionAuditEntry {
  id: string
  at: number
  sessionId: string
  cwd: string
  toolCallId: string
  title: string
  kind?: string
  decision: PermissionDecision | 'cancelled' | 'auto-allow'
  rawInputPreview?: string
}

export interface ModelInfo {
  id: string
  name: string
  description?: string
  isDefault?: boolean
}

export interface PlanItem {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | string
  priority?: number
}

export interface ActivePlan {
  sessionId: string
  messageId: string
  entries: PlanItem[]
  updatedAt: number
}

export interface FileEntry {
  path: string
  name: string
  relative: string
  isDir: boolean
}

export type AuthState =
  | 'authenticated'
  | 'unauthenticated'
  | 'cli_missing'
  | 'unknown'
  | 'checking'

export type AuthMethod = 'none' | 'session' | 'api_key_env' | 'unknown'

export type LoginMethod = 'oauth' | 'device'

/**
 * Safe auth snapshot for the UI — never includes tokens or API keys.
 * Credentials live in the Grok CLI (`~/.grok/auth.json` or XAI_API_KEY env).
 */
export interface AuthStatus {
  state: AuthState
  authenticated: boolean
  method: AuthMethod
  /** Human-safe label only, e.g. "grok.com" — never an email/token */
  accountLabel?: string
  hasAuthFile?: boolean
  hasEnvApiKey?: boolean
  message?: string
}

export interface HealthStatus {
  grokFound: boolean
  grokPath: string | null
  nodeOk: boolean
  platform: string
  auth: AuthStatus
}

export interface AppSettings {
  model?: string
  /**
   * Grok CLI permission mode (`--permission-mode`).
   * `bypassPermissions` is YOLO — requires alwaysApproveAck.
   */
  permissionMode: PermissionMode
  /**
   * Bypass tool permission prompts (equivalent to --always-approve).
   * Kept in sync with permissionMode === 'bypassPermissions'.
   * Dangerous — must be confirmed in UI before enabling.
   */
  alwaysApprove: boolean
  /** User acknowledged YOLO risk at least once this install */
  alwaysApproveAck?: boolean
  grokBinary?: string
  theme: 'dark' | 'light' | 'system'
  /** Custom dev command for the preview pane (defaults to `npm run dev`). */
  previewCommand?: string
}

export const DEFAULT_SETTINGS: AppSettings = {
  permissionMode: 'default',
  alwaysApprove: false,
  alwaysApproveAck: false,
  theme: 'dark'
}

/** UI labels for permission modes (Grok CLI compatible). */
export const PERMISSION_MODE_OPTIONS: Array<{
  id: PermissionMode
  label: string
  short: string
  description: string
  dangerous?: boolean
}> = [
  {
    id: 'default',
    label: 'Default',
    short: 'Ask',
    description: 'Prompt for tools that are not auto-approved'
  },
  {
    id: 'acceptEdits',
    label: 'Accept edits',
    short: 'Edits',
    description: 'Auto-approve file edits; still ask for shell/network'
  },
  {
    id: 'auto',
    label: 'Auto',
    short: 'Auto',
    description: 'Broader auto-approval for common agent actions'
  },
  {
    id: 'plan',
    label: 'Plan',
    short: 'Plan',
    description: 'Plan-first mode — design approach before writing code'
  },
  {
    id: 'dontAsk',
    label: "Don't ask",
    short: 'Strict',
    description: 'Deny anything without an explicit allow rule'
  },
  {
    id: 'bypassPermissions',
    label: 'Bypass all',
    short: 'YOLO',
    description: 'Auto-approve tools (dangerous — same as --always-approve)',
    dangerous: true
  }
]

/** Events pushed from main → renderer */
export type MainToRendererEvent =
  | { type: 'connection'; state: ConnectionState; error?: string }
  | { type: 'session'; sessionId: string; cwd: string }
  | { type: 'history-clear'; sessionId: string }
  | { type: 'history-done'; sessionId: string; source: 'acp' | 'local' | 'mixed' | 'empty' }
  | { type: 'user-message'; sessionId: string; message: ChatMessage }
  | { type: 'message-chunk'; sessionId: string; messageId: string; text: string }
  | { type: 'thought-chunk'; sessionId: string; messageId: string; text: string }
  | { type: 'tool-call'; sessionId: string; messageId: string; toolCall: ToolCallInfo }
  | {
      type: 'tool-call-update'
      sessionId: string
      messageId: string
      toolCallId: string
      patch: Partial<ToolCallInfo>
    }
  | { type: 'message-done'; sessionId: string; messageId: string; stopReason?: string }
  | { type: 'permission-request'; request: PermissionRequest | null }
  | { type: 'plan'; sessionId: string; messageId: string; plan: unknown }
  | { type: 'models'; models: ModelInfo[]; current?: string }
  | { type: 'auth'; auth: AuthStatus }
  | { type: 'error'; message: string; sessionId?: string }
  | {
      type: 'preview-status'
      running: boolean
      url: string | null
      cwd: string | null
      error?: string
    }
  | { type: 'preview-log'; text: string }

// ── Plugins & Skills (Grok CLI plugin system) ──────────────────────
export type PluginStatus = 'installed' | 'available' | 'disabled'

export interface PluginComponent {
  name: string
  description?: string
}

export interface PluginComponents {
  skills?: PluginComponent[]
  mcpServers?: PluginComponent[]
  commands?: PluginComponent[]
  agents?: PluginComponent[]
  hooks?: PluginComponent[]
}

export interface Plugin {
  name: string
  version?: string | null
  description?: string
  /** Source marketplace name, e.g. "xAI Official" */
  marketplace?: string
  category?: string
  status: PluginStatus
  enabled?: boolean
  /** Derived from components.* (the flat skill_count/has_* fields are unreliable) */
  skillCount: number
  hasHooks: boolean
  hasAgents: boolean
  hasMcp: boolean
  components?: PluginComponents
  /** Pinned commit for marketplace entries — shown in the trust modal */
  sha?: string
  sourceUrl?: string
}

export interface MarketplaceSource {
  name: string
  kind: string
  url?: string
  branch?: string | null
}

export type McpTransport = 'stdio' | 'http' | 'sse'
export type McpScope = 'user' | 'project'

export interface McpServer {
  name: string
  transport: McpTransport
  scope: McpScope
  commandOrUrl?: string
  args?: string[]
  status?: 'ok' | 'error' | 'unknown'
  detail?: string
}

export interface PluginActionResult {
  ok: boolean
  message: string
  plugins?: Plugin[]
}

export interface McpActionResult {
  ok: boolean
  message: string
  servers?: McpServer[]
}

export interface McpAddInput {
  name: string
  commandOrUrl: string
  transport: McpTransport
  scope: McpScope
  args?: string[]
  env?: Record<string, string>
  headers?: Record<string, string>
}

export interface SendPromptOptions {
  attachments?: PromptAttachment[]
}

export interface GrockyApi {
  selectFolder: () => Promise<string | null>
  selectFile: (options?: {
    filters?: { name: string; extensions: string[] }[]
    title?: string
  }) => Promise<string | null>
  getSettings: () => Promise<AppSettings>
  setSettings: (partial: Partial<AppSettings>) => Promise<AppSettings>
  getRecentProjects: () => Promise<ProjectContext[]>
  addRecentProject: (cwd: string) => Promise<ProjectContext[]>
  startAgent: (
    cwd: string,
    options?: {
      model?: string
      alwaysApprove?: boolean
      forceNew?: boolean
      /** project = coding agent; chat = conversational Grok (no project folder) */
      surface?: AgentSurface
    }
  ) => Promise<{ sessionId: string }>
  /** Dedicated sandbox folder for general chat sessions (not a user project) */
  getChatWorkspacePath: () => Promise<string>
  stopAgent: () => Promise<void>
  sendPrompt: (
    text: string,
    options?: SendPromptOptions
  ) => Promise<{ messageId: string }>
  cancelPrompt: () => Promise<void>
  respondPermission: (
    requestId: number | string,
    decision: PermissionDecision
  ) => Promise<void>
  listSessions: () => Promise<SessionInfo[]>
  loadSession: (sessionId: string) => Promise<{ sessionId: string; restored: boolean }>
  getTranscript: (sessionId: string) => Promise<ChatMessage[]>
  saveTranscript: (sessionId: string, messages: ChatMessage[]) => Promise<void>
  deleteSession: (sessionId: string) => Promise<SessionInfo[]>
  renameSession: (sessionId: string, title: string) => Promise<SessionInfo | null>
  archiveSession: (sessionId: string, archived?: boolean) => Promise<SessionInfo | null>
  exportTranscript: (
    sessionId: string,
    format?: 'md' | 'json'
  ) => Promise<{ path: string } | null>
  listProjectFiles: (
    cwd: string,
    query?: string,
    limit?: number
  ) => Promise<FileEntry[]>
  listModels: () => Promise<ModelInfo[]>
  getPermissionAudit: () => Promise<PermissionAuditEntry[]>
  getConnectionState: () => Promise<ConnectionState>
  getGrokPath: () => Promise<string | null>
  getHealth: () => Promise<HealthStatus>
  getAuthStatus: () => Promise<AuthStatus>
  login: (method?: LoginMethod) => Promise<{
    ok: boolean
    method: LoginMethod
    message: string
    deviceHint?: string
    auth: AuthStatus
  }>
  logout: () => Promise<{ ok: boolean; message: string; auth: AuthStatus }>
  /** Install the Grok CLI via the official installer (only after explicit user consent). */
  installCli: () => Promise<{
    ok: boolean
    message: string
    grokPath: string | null
    installed: boolean
  }>
  /**
   * Read a local image file as a data URL for inline chat display.
   * Path may be absolute or session-relative (e.g. images/1.jpg).
   * Restricted to project cwd, chat workspace, and ~/.grok/sessions.
   */
  readLocalImage: (filePath: string) => Promise<{
    dataUrl: string
    path: string
    mimeType: string
    error?: undefined
  } | { dataUrl?: undefined; path?: string; mimeType?: undefined; error: string }>
  /** Reveal a local file in the OS file manager (Finder / Explorer). */
  revealLocalPath: (filePath: string) => Promise<{ ok: boolean; error?: string }>
  onEvent: (handler: (event: MainToRendererEvent) => void) => () => void
  // Dev preview pane
  previewStart: (cwd: string, command?: string) => Promise<{ ok: boolean; message: string }>
  previewStop: () => Promise<void>
  previewSetBounds: (rect: { x: number; y: number; width: number; height: number }) => void
  previewSetUrl: (url: string) => Promise<void>
  previewReload: () => Promise<void>
  previewStatus: () => Promise<{
    running: boolean
    url: string | null
    cwd: string | null
    error?: string
  }>
  // Plugins & Skills
  listInstalledPlugins: () => Promise<Plugin[]>
  listAvailablePlugins: () => Promise<Plugin[]>
  listMarketplaces: () => Promise<MarketplaceSource[]>
  installPlugin: (source: string, trust: boolean) => Promise<PluginActionResult>
  enablePlugin: (name: string) => Promise<PluginActionResult>
  disablePlugin: (name: string) => Promise<PluginActionResult>
  uninstallPlugin: (name: string) => Promise<PluginActionResult>
  listMcpServers: () => Promise<McpServer[]>
  addMcpServer: (input: McpAddInput) => Promise<McpActionResult>
  removeMcpServer: (name: string, scope?: McpScope) => Promise<McpActionResult>
  mcpDoctor: (name?: string) => Promise<McpServer[]>
  platform: NodeJS.Platform
}
