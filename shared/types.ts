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

export interface SessionInfo {
  id: string
  cwd: string
  title?: string
  createdAt: number
  updatedAt: number
}

export interface ProjectContext {
  cwd: string
  name: string
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource'; uri: string; text?: string }

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
  /** True when restored from history (not live stream) */
  fromHistory?: boolean
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

export interface AppSettings {
  model?: string
  /**
   * Bypass tool permission prompts (equivalent to --always-approve).
   * Dangerous — must be confirmed in UI before enabling.
   */
  alwaysApprove: boolean
  /** User acknowledged YOLO risk at least once this install */
  alwaysApproveAck?: boolean
  grokBinary?: string
  theme: 'dark' | 'light' | 'system'
}

export const DEFAULT_SETTINGS: AppSettings = {
  alwaysApprove: false,
  alwaysApproveAck: false,
  theme: 'dark'
}

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
  | { type: 'error'; message: string; sessionId?: string }

export interface GrockyApi {
  selectFolder: () => Promise<string | null>
  getSettings: () => Promise<AppSettings>
  setSettings: (partial: Partial<AppSettings>) => Promise<AppSettings>
  getRecentProjects: () => Promise<ProjectContext[]>
  addRecentProject: (cwd: string) => Promise<ProjectContext[]>
  startAgent: (
    cwd: string,
    options?: { model?: string; alwaysApprove?: boolean; forceNew?: boolean }
  ) => Promise<{ sessionId: string }>
  stopAgent: () => Promise<void>
  sendPrompt: (text: string) => Promise<{ messageId: string }>
  cancelPrompt: () => Promise<void>
  respondPermission: (
    requestId: number | string,
    decision: PermissionDecision
  ) => Promise<void>
  listSessions: () => Promise<SessionInfo[]>
  loadSession: (sessionId: string) => Promise<{ sessionId: string; restored: boolean }>
  getTranscript: (sessionId: string) => Promise<ChatMessage[]>
  saveTranscript: (sessionId: string, messages: ChatMessage[]) => Promise<void>
  listModels: () => Promise<ModelInfo[]>
  getPermissionAudit: () => Promise<PermissionAuditEntry[]>
  getConnectionState: () => Promise<ConnectionState>
  getGrokPath: () => Promise<string | null>
  onEvent: (handler: (event: MainToRendererEvent) => void) => () => void
  platform: NodeJS.Platform
}
