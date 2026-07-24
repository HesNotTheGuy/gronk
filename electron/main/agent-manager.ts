import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import {
  GrokAcpClient,
  isAllowedGrokBasename,
  mergeToolCall,
  parseToolCallFromUpdate,
  probeGrokBinary,
  resolveGrokBinary,
  type JsonRpcId,
  type PermissionOption
} from './acp/client'
import {
  appendPermissionAudit,
  getSettings,
  getTranscript,
  listSessions,
  normalizeCwd,
  saveTranscript,
  upsertSession
} from './store'
import { listModels } from './models'
import { assertAuthenticated } from './auth'
import { isChatWorkspace } from '../../shared/path'
import { redactPreview } from './redact'
import type {
  ChatMessage,
  ConnectionState,
  MainToRendererEvent,
  ModelInfo,
  PermissionDecision,
  PermissionRequest,
  ToolCallInfo
} from '../../shared/types'

/** Grocky app chat sandbox (same path as grocky:get-chat-workspace). */
function chatWorkspaceRoot(): string {
  return path.join(app.getPath('userData'), 'chat-workspace')
}

function isChatPadCwd(cwd: string): boolean {
  return isChatWorkspace(cwd, chatWorkspaceRoot())
}

interface PendingPermission {
  requestId: JsonRpcId
  options: PermissionOption[]
  toolCallId?: string
  title: string
  kind?: string
  rawInput?: unknown
  /** When set, resolve ACP fs/write after user decision */
  fsWrite?: { path: string; content: string }
}

const MAX_FS_READ_BYTES = 4 * 1024 * 1024 // 4 MB

/**
 * Owns the lifecycle of one `grok agent stdio` process and maps ACP events → renderer IPC.
 */
export class AgentManager {
  private client: GrokAcpClient | null = null
  private sessionId: string | null = null
  private cwd: string | null = null
  private state: ConnectionState = 'idle'
  private activeMessageId: string | null = null
  private window: BrowserWindow | null = null
  /** FIX-9: one pending permission per request id (queue display FIFO) */
  private pendingPermissions = new Map<string, PendingPermission>()
  private permissionQueue: string[] = []
  private alwaysApprove = false
  /** When true, session/update chunks rebuild history instead of live turn */
  private replayingHistory = false
  /**
   * When true, ignore ACP history replay chunks (user/assistant/thought).
   * Used when a full local transcript already exists so session/load does not
   * re-append messages that the agent echoes (FIX-R7 follow-on).
   */
  private suppressHistoryReplay = false
  private historyAssistantId: string | null = null
  private models: ModelInfo[] = []
  private currentModel?: string
  /** Live transcript for the active session (mirrored to disk) */
  private liveMessages: ChatMessage[] = []

  setWindow(win: BrowserWindow | null): void {
    this.window = win
  }

  getConnectionState(): ConnectionState {
    return this.state
  }

  getSessionId(): string | null {
    return this.sessionId
  }

  getCwd(): string | null {
    return this.cwd
  }

  getModels(): ModelInfo[] {
    return this.models
  }

  getCurrentModel(): string | undefined {
    return this.currentModel
  }

  private emit(event: MainToRendererEvent): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send('grocky:event', event)
    }
  }

  private setState(state: ConnectionState, error?: string): void {
    this.state = state
    this.emit({ type: 'connection', state, error })
  }

  private log(...args: unknown[]): void {
    if (process.env.GROCKY_DEBUG) {
      console.error('[grocky]', ...args)
    }
  }

  private persistLiveTranscript(): void {
    if (!this.sessionId) return
    saveTranscript(this.sessionId, this.liveMessages)
  }

  /**
   * Boot grok agent process + initialize only (no session/new).
   */
  private surface: 'chat' | 'project' = 'project'

  private async bootAgent(
    cwd: string,
    options?: { model?: string; alwaysApprove?: boolean; surface?: 'chat' | 'project' }
  ): Promise<void> {
    await this.stopProcessOnly()

    // Per-install: never start an agent without local CLI credentials.
    // Auth is this OS user's Grok session only — not shared across machines/users.
    try {
      await assertAuthenticated()
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Sign in required before starting the agent.'
      this.setState('error', message)
      throw err
    }

    const settings = getSettings()
    const binary = resolveGrokBinary(settings.grokBinary)
    if (!binary) {
      this.setState(
        'error',
        'Could not find the grok binary. Install Grok CLI or set path in settings.'
      )
      throw new Error('grok binary not found')
    }

    // FIX-3: user-supplied override must pass basename + version probe
    if (settings.grokBinary) {
      if (!isAllowedGrokBasename(binary)) {
        const msg = 'Grok binary override rejected: basename must be grok (not an arbitrary executable).'
        this.setState('error', msg)
        throw new Error(msg)
      }
      const ok = await probeGrokBinary(binary)
      if (!ok) {
        const msg =
          'Grok binary override failed version probe. Point settings at a real grok CLI binary.'
        this.setState('error', msg)
        throw new Error(msg)
      }
    }

    const model = options?.model ?? settings.model
    this.currentModel = model
    this.alwaysApprove = !!(options?.alwaysApprove ?? settings.alwaysApprove)
    // Hard safety: store may refuse alwaysApprove without ack
    if (this.alwaysApprove && !settings.alwaysApproveAck) {
      this.alwaysApprove = false
    }

    // permission-mode is a top-level grok flag (before `agent` subcommand)
    let permissionMode = settings.permissionMode || 'default'
    if (this.alwaysApprove) {
      permissionMode = 'bypassPermissions'
    } else if (permissionMode === 'bypassPermissions' && !settings.alwaysApproveAck) {
      permissionMode = 'default'
    }

    this.surface = options?.surface === 'chat' ? 'chat' : 'project'

    // Global flags before `agent` subcommand
    const agentArgs: string[] = []
    if (permissionMode && permissionMode !== 'default') {
      agentArgs.push('--permission-mode', permissionMode)
    }
    if (this.surface === 'chat') {
      // Conversational Grok (website/X-style) — still CLI-backed, not a web wrap
      agentArgs.push(
        '--system-prompt-override',
        [
          'You are Grok, built by xAI.',
          'You are in Grocky desktop Chat mode — a general conversation like grok.com or Grok on X.',
          'Be helpful, witty when appropriate, and clear.',
          'Answer directly. Do not browse or edit the local filesystem unless the user explicitly asks.',
          'You may use web search when current information helps.',
          'You are not limited to coding topics.'
        ].join(' ')
      )
      agentArgs.push(
        '--rules',
        'Chat mode: prefer direct answers over tool-heavy exploration. Never modify files unless asked.'
      )
    }
    agentArgs.push('agent')
    if (model) {
      agentArgs.push('-m', model)
    }
    if (this.alwaysApprove || permissionMode === 'bypassPermissions') {
      agentArgs.push('--always-approve')
    }
    agentArgs.push('stdio')

    this.setState('starting')
    this.cwd = normalizeCwd(cwd)
    this.client = new GrokAcpClient(binary, agentArgs)
    this.liveMessages = []
    this.replayingHistory = false
    this.historyAssistantId = null
    this.activeMessageId = null
    this.pendingPermissions.clear()
    this.permissionQueue = []

    this.client.on('stderr', (line) => this.log('stderr', line))
    this.client.on('error', (err) => this.setState('error', err.message))
    this.client.on('exit', (code) => {
      if (this.state !== 'stopped' && this.state !== 'idle') {
        this.setState('error', `Agent process exited (code ${code ?? '?'})`)
      }
      this.client = null
      this.sessionId = null
      this.pendingPermissions.clear()
      this.permissionQueue = []
    })
    this.client.on('notification', (method, params) => {
      this.handleNotification(method, params)
    })
    this.client.on(
      'server-request',
      (req: { id: JsonRpcId; method: string; params: unknown }) => {
        this.handleServerRequest(req)
      }
    )

    this.client.start()
    const init = await this.client.initialize()

    // Models from initialize meta when present
    const meta = init._meta as Record<string, unknown> | undefined
    const modelState = meta?.modelState as
      | {
          currentModelId?: string
          availableModels?: Array<{ modelId?: string; name?: string; description?: string }>
        }
      | undefined
    if (modelState?.availableModels?.length) {
      this.models = modelState.availableModels.map((m) => ({
        id: String(m.modelId || ''),
        name: String(m.name || m.modelId || ''),
        description: m.description,
        isDefault: m.modelId === modelState.currentModelId
      })).filter((m) => m.id)
      this.currentModel = modelState.currentModelId || model
    } else {
      this.models = await listModels()
      this.currentModel = model || this.models.find((m) => m.isDefault)?.id || this.models[0]?.id
    }
    this.emit({ type: 'models', models: this.models, current: this.currentModel })
  }

  async start(
    cwd: string,
    options?: { model?: string; alwaysApprove?: boolean; surface?: 'chat' | 'project' }
  ): Promise<{ sessionId: string }> {
    await this.bootAgent(cwd, options)
    if (!this.client) throw new Error('Agent failed to boot')

    try {
      const meta =
        this.surface === 'chat'
          ? {
              rules:
                'Chat mode: conversational Grok. Prefer direct answers; avoid filesystem edits unless asked.'
            }
          : undefined
      const { sessionId } = await this.client.sessionNew(this.cwd!, [], meta)
      this.sessionId = sessionId
      this.liveMessages = []
      this.setState('ready')
      this.emit({ type: 'session', sessionId, cwd: this.cwd! })
      return { sessionId }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.setState('error', message)
      await this.stop()
      throw err
    }
  }

  getSurface(): 'chat' | 'project' {
    return this.surface
  }

  /**
   * Resume an existing Grok session: boot agent, session/load (no session/new),
   * hydrate UI from ACP replay + local transcript cache.
   */
  async loadSession(
    sessionId: string,
    cwd?: string
  ): Promise<{ sessionId: string; restored: boolean }> {
    const targetCwd = cwd ? normalizeCwd(cwd) : this.cwd
    if (!targetCwd) throw new Error('No project folder for session')

    const settings = getSettings()
    this.setState('loading')
    this.emit({ type: 'history-clear', sessionId })

    // Prefer local transcript immediately for snappy UI (already de-duped in getTranscript)
    const local = getTranscript(sessionId)
    if (local.length > 0) {
      for (const m of local) {
        this.emit({
          type: 'user-message',
          sessionId,
          message: { ...m, streaming: false, fromHistory: true }
        })
      }
    }

    try {
      // Fresh agent process bound to this project, then load (not new)
      const needBoot =
        !this.client ||
        this.state === 'error' ||
        this.state === 'idle' ||
        this.state === 'stopped' ||
        !this.cwd ||
        normalizeCwd(this.cwd) !== targetCwd

      if (needBoot) {
        await this.bootAgent(targetCwd, {
          model: settings.model,
          alwaysApprove: settings.alwaysApprove,
          surface: isChatPadCwd(targetCwd) ? 'chat' : 'project'
        })
      }
      if (!this.client) throw new Error('Agent not running')

      this.replayingHistory = true
      // If we already have a local transcript, do not rebuild messages from ACP echo
      this.suppressHistoryReplay = local.length > 0
      this.historyAssistantId = null
      this.liveMessages = local.map((m) => ({ ...m, streaming: false, fromHistory: true }))

      // ACP requires absolute path; Windows paths with backslashes are fine.
      // Prefer native absolute form for the CLI.
      const absCwd = path.isAbsolute(targetCwd)
        ? targetCwd
        : path.resolve(targetCwd)
      const result = await this.client.sessionLoad(sessionId, absCwd, [])
      this.sessionId = result.sessionId || sessionId
      this.cwd = targetCwd
      this.replayingHistory = false
      this.suppressHistoryReplay = false
      this.setState('ready')
      this.emit({ type: 'session', sessionId: this.sessionId, cwd: targetCwd })

      const source =
        local.length > 0
          ? 'local'
          : this.liveMessages.length > 0
            ? 'acp'
            : 'empty'

      this.persistLiveTranscript()
      this.emit({ type: 'history-done', sessionId: this.sessionId, source })
      return { sessionId: this.sessionId, restored: this.liveMessages.length > 0 }
    } catch (err) {
      this.replayingHistory = false
      this.suppressHistoryReplay = false
      const message = err instanceof Error ? err.message : String(err)
      // Fall back: start new live session but keep local transcript visible
      try {
        if (!this.client || this.state !== 'ready') {
          await this.start(targetCwd, {
            model: settings.model,
            alwaysApprove: settings.alwaysApprove,
            surface: isChatPadCwd(targetCwd) ? 'chat' : 'project'
          })
        }
        // User-facing: history is still on screen; only the agent's live memory failed to resume.
        this.emit({
          type: 'error',
          message:
            `Could not resume this conversation in the Grok agent (${message}). ` +
            `Your chat history is still shown here, but the agent may not remember prior turns — ` +
            `new replies start with a fresh context.`
        })
        this.emit({
          type: 'history-done',
          sessionId,
          source: local.length ? 'local' : 'empty'
        })
        return { sessionId: this.sessionId || sessionId, restored: local.length > 0 }
      } catch (err2) {
        this.setState('error', message)
        throw err2
      }
    }
  }

  private async stopProcessOnly(): Promise<void> {
    this.pendingPermissions.clear()
    this.permissionQueue = []
    if (this.client) {
      await this.client.dispose()
      this.client = null
    }
    this.sessionId = null
    this.activeMessageId = null
  }

  private permKey(id: JsonRpcId): string {
    return String(id)
  }

  private emitFrontPermission(): void {
    const front = this.permissionQueue[0]
    if (!front) {
      this.emit({ type: 'permission-request', request: null })
      return
    }
    const p = this.pendingPermissions.get(front)
    if (!p) {
      this.permissionQueue.shift()
      this.emitFrontPermission()
      return
    }
    const request: PermissionRequest = {
      requestId: p.requestId,
      sessionId: this.sessionId || '',
      toolCallId: p.toolCallId || 'unknown',
      title: p.title,
      kind: p.kind,
      rawInput: p.rawInput
    }
    this.emit({ type: 'permission-request', request })
  }

  async stop(): Promise<void> {
    this.setState('stopped')
    this.persistLiveTranscript()
    await this.stopProcessOnly()
    this.setState('idle')
  }

  async sendPrompt(
    text: string,
    options?: {
      attachments?: Array<{
        id: string
        kind: 'file' | 'image'
        name: string
        path?: string
        data?: string
        mimeType?: string
        previewUrl?: string
      }>
    }
  ): Promise<{ messageId: string }> {
    if (!this.client || !this.sessionId || this.state !== 'ready') {
      throw new Error('Agent is not ready')
    }

    const settings = getSettings()
    this.alwaysApprove = !!(settings.alwaysApprove && settings.alwaysApproveAck)

    const messageId = randomUUID()
    this.activeMessageId = messageId
    const attachments = options?.attachments ?? []

    // Build ACP content blocks: files as path context, images as image blocks
    const promptBlocks: Array<{ type: string; text?: string; data?: string; mimeType?: string }> =
      []
    const filePaths = attachments
      .filter((a) => a.kind === 'file' && a.path)
      .map((a) => a.path as string)
    let fullText = text.trim()
    if (filePaths.length) {
      const ctx = filePaths.map((p) => `- ${p}`).join('\n')
      fullText = fullText
        ? `${fullText}\n\nAttached files:\n${ctx}`
        : `Please inspect these files:\n${ctx}`
    }
    if (fullText) {
      promptBlocks.push({ type: 'text', text: fullText })
    }
    for (const img of attachments.filter((a) => a.kind === 'image' && a.data)) {
      promptBlocks.push({
        type: 'image',
        data: img.data,
        mimeType: img.mimeType || 'image/png'
      })
    }
    if (promptBlocks.length === 0) {
      throw new Error('Empty prompt')
    }

    const userMsg: ChatMessage = {
      id: randomUUID(),
      role: 'user',
      text: fullText || text,
      createdAt: Date.now(),
      attachments: attachments.map((a) => ({
        ...a,
        // Don't persist huge base64 in local cache via liveMessages → save strips later
        data: a.kind === 'image' ? undefined : a.data
      }))
    }
    this.liveMessages.push(userMsg)
    this.liveMessages.push({
      id: messageId,
      role: 'assistant',
      text: '',
      thought: '',
      toolCalls: [],
      createdAt: Date.now(),
      streaming: true
    })
    this.persistLiveTranscript()

    if (this.sessionId && this.cwd) {
      // Only seed title when session has none yet; renameSession owns later titles
      const prev = listSessions().find((s) => s.id === this.sessionId)
      upsertSession({
        id: this.sessionId,
        cwd: this.cwd,
        surface: this.surface,
        ...(!prev?.title
          ? { title: (fullText || text).slice(0, 60) || path.basename(this.cwd) }
          : {}),
        createdAt: Date.now(),
        updatedAt: Date.now()
      })
    }

    void this.client
      .sessionPrompt(this.sessionId, promptBlocks)
      .then((result) => {
        const stopReason =
          result && typeof result === 'object' && 'stopReason' in result
            ? String((result as { stopReason?: string }).stopReason)
            : undefined
        this.finalizeAssistant(messageId)
        this.emit({
          type: 'message-done',
          sessionId: this.sessionId!,
          messageId,
          stopReason
        })
        this.activeMessageId = null
        this.persistLiveTranscript()

        if (this.sessionId && this.cwd) {
          upsertSession({
            id: this.sessionId,
            cwd: this.cwd,
            surface: this.surface,
            updatedAt: Date.now(),
            createdAt: Date.now()
          })
        }
      })
      .catch((err: Error) => {
        this.emit({
          type: 'error',
          message: err.message,
          sessionId: this.sessionId ?? undefined
        })
        this.finalizeAssistant(messageId)
        this.emit({
          type: 'message-done',
          sessionId: this.sessionId!,
          messageId,
          stopReason: 'error'
        })
        this.activeMessageId = null
        this.persistLiveTranscript()
      })

    return { messageId }
  }

  private finalizeAssistant(messageId: string): void {
    this.liveMessages = this.liveMessages.map((m) =>
      m.id === messageId ? { ...m, streaming: false } : m
    )
  }

  private patchAssistant(
    messageId: string,
    patch: (m: ChatMessage) => ChatMessage
  ): void {
    this.liveMessages = this.liveMessages.map((m) => (m.id === messageId ? patch(m) : m))
  }

  async cancelPrompt(): Promise<void> {
    if (!this.client || !this.sessionId) return

    for (const p of this.pendingPermissions.values()) {
      this.client.respondToRequest(p.requestId, {
        outcome: { outcome: 'cancelled' }
      })
      this.recordAuditFor(p, 'cancelled')
    }
    this.pendingPermissions.clear()
    this.permissionQueue = []
    this.emit({ type: 'permission-request', request: null })

    try {
      await this.client.sessionCancel(this.sessionId)
    } catch {
      /* best effort */
    }
  }

  respondPermission(requestId: number | string, decision: PermissionDecision): void {
    if (!this.client) return

    const key = this.permKey(requestId)
    const pending = this.pendingPermissions.get(key)
    if (!pending) {
      this.log('permission decision for unknown requestId', requestId)
      return
    }

    this.log('permission decision', decision, 'id', requestId)

    // FIX-6: resolve fs/write after user consent
    if (pending.fsWrite) {
      if (decision === 'allow-once' || decision === 'allow-always') {
        try {
          const safe = this.resolveInsideJail(pending.fsWrite.path)
          if (!safe) {
            this.client.respondError(pending.requestId, -32000, 'Path outside project root is not allowed')
            this.recordAuditFor(pending, 'reject-once')
          } else {
            fs.mkdirSync(path.dirname(safe), { recursive: true })
            fs.writeFileSync(safe, pending.fsWrite.content, 'utf8')
            this.client.respondToRequest(pending.requestId, null)
            this.recordAuditFor(pending, decision)
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          this.client.respondError(pending.requestId, -32000, message)
          this.recordAuditFor(pending, 'reject-once')
        }
      } else {
        this.client.respondError(pending.requestId, -32000, 'User denied file write')
        this.recordAuditFor(pending, 'reject-once')
      }
    } else {
      this.client.respondPermission(pending.requestId, decision, pending.options)
      this.recordAuditFor(pending, decision)
    }

    this.pendingPermissions.delete(key)
    this.permissionQueue = this.permissionQueue.filter((k) => k !== key)
    this.emitFrontPermission()
  }

  private recordAuditFor(
    p: PendingPermission,
    decision: PermissionDecision | 'cancelled' | 'auto-allow'
  ): void {
    appendPermissionAudit({
      id: randomUUID(),
      at: Date.now(),
      sessionId: this.sessionId || '',
      cwd: this.cwd || '',
      toolCallId: p.toolCallId || 'unknown',
      title: p.title,
      kind: p.kind,
      decision,
      rawInputPreview: redactPreview(p.rawInput, 500)
    })
  }

  private handleServerRequest(req: {
    id: JsonRpcId
    method: string
    params: unknown
  }): void {
    const { id, method, params } = req
    const p = (params ?? {}) as Record<string, unknown>
    this.log('server-request', method, id)

    if (
      method === 'session/request_permission' ||
      method.endsWith('/request_permission') ||
      method === 'request_permission'
    ) {
      this.handlePermissionRequest(id, p)
      return
    }

    if (method === 'fs/read_text_file') {
      this.handleFsRead(id, p)
      return
    }
    if (method === 'fs/write_text_file') {
      this.handleFsWrite(id, p)
      return
    }

    this.log('unhandled server method', method)
    this.client?.respondError(
      id,
      -32601,
      `Method not supported by Grocky client: ${method}`
    )
    this.emit({
      type: 'error',
      message: `Agent requested unsupported client method: ${method}`
    })
  }

  private handlePermissionRequest(id: JsonRpcId, p: Record<string, unknown>): void {
    const toolCall = (p.toolCall ?? p.tool_call ?? {}) as Record<string, unknown>
    const options = (Array.isArray(p.options) ? p.options : []) as PermissionOption[]

    const toolCallId =
      (toolCall.toolCallId as string) ||
      (toolCall.tool_call_id as string) ||
      (toolCall.id as string)

    const title =
      (toolCall.title as string) ||
      (p.title as string) ||
      (typeof toolCall.rawInput === 'string' ? toolCall.rawInput.slice(0, 80) : null) ||
      'Allow tool?'

    const pending: PendingPermission = {
      requestId: id,
      options,
      toolCallId,
      title,
      kind: toolCall.kind as string | undefined,
      rawInput: toolCall.rawInput ?? toolCall.input ?? p.rawInput
    }

    if (toolCallId && this.activeMessageId && this.sessionId) {
      this.emit({
        type: 'tool-call-update',
        sessionId: this.sessionId,
        messageId: this.activeMessageId,
        toolCallId,
        patch: {
          toolCallId,
          title,
          status: 'pending',
          rawInput: toolCall.rawInput ?? toolCall.input
        }
      })
    }

    const settings = getSettings()
    if (settings.alwaysApprove && settings.alwaysApproveAck) {
      this.log('auto-approving permission', id)
      this.client?.respondPermission(id, 'allow-once', options)
      this.recordAuditFor(pending, 'auto-allow')
      return
    }

    const key = this.permKey(id)
    this.pendingPermissions.set(key, pending)
    if (!this.permissionQueue.includes(key)) this.permissionQueue.push(key)
    this.emitFrontPermission()
  }

  /** FIX-5: realpath-aware jail; refuse when no project root */
  private resolveInsideJail(filePath: string): string | null {
    if (!this.cwd) return null
    let root: string
    try {
      root = fs.realpathSync(path.resolve(this.cwd))
    } catch {
      return null
    }
    const resolved = path.resolve(root, filePath)
    let probe = resolved
    while (!fs.existsSync(probe) && path.dirname(probe) !== probe) {
      probe = path.dirname(probe)
    }
    let realProbe: string
    try {
      realProbe = fs.realpathSync(probe)
    } catch {
      return null
    }
    const real = realProbe + resolved.slice(probe.length)
    if (real === root || real.startsWith(root + path.sep)) return real
    return null
  }

  private handleFsRead(id: JsonRpcId, p: Record<string, unknown>): void {
    try {
      const filePath = String(p.path || '')
      if (!filePath) {
        this.client?.respondError(id, -32602, 'path required')
        return
      }
      const safe = this.resolveInsideJail(filePath)
      if (!safe) {
        this.client?.respondError(id, -32000, 'Path outside project root is not allowed')
        return
      }

      // FIX-8: bound size before full read
      const stat = fs.statSync(safe)
      if (stat.size > MAX_FS_READ_BYTES) {
        this.client?.respondError(
          id,
          -32000,
          `File too large (${stat.size} bytes; max ${MAX_FS_READ_BYTES})`
        )
        return
      }

      let content = fs.readFileSync(safe, 'utf8')
      const line = typeof p.line === 'number' ? p.line : undefined
      const limit = typeof p.limit === 'number' ? p.limit : undefined
      if (line !== undefined || limit !== undefined) {
        const lines = content.split(/\r?\n/)
        const start = Math.max(0, (line ?? 1) - 1)
        const end = limit !== undefined ? start + limit : lines.length
        content = lines.slice(start, end).join('\n')
      }
      this.client?.respondToRequest(id, { content })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.client?.respondError(id, -32000, message)
    }
  }

  private handleFsWrite(id: JsonRpcId, p: Record<string, unknown>): void {
    try {
      const filePath = String(p.path || '')
      const content = String(p.content ?? '')
      if (!filePath) {
        this.client?.respondError(id, -32602, 'path required')
        return
      }
      const safe = this.resolveInsideJail(filePath)
      if (!safe) {
        this.client?.respondError(id, -32000, 'Path outside project root is not allowed')
        return
      }

      const settings = getSettings()
      const pending: PendingPermission = {
        requestId: id,
        options: [],
        toolCallId: `fs-write-${id}`,
        title: 'Write file',
        kind: 'fs/write',
        rawInput: { path: safe },
        fsWrite: { path: safe, content }
      }

      // FIX-6: YOLO still audits; non-YOLO requires user consent
      if (settings.alwaysApprove && settings.alwaysApproveAck) {
        fs.mkdirSync(path.dirname(safe), { recursive: true })
        fs.writeFileSync(safe, content, 'utf8')
        this.client?.respondToRequest(id, null)
        this.recordAuditFor(pending, 'auto-allow')
        return
      }

      const key = this.permKey(id)
      this.pendingPermissions.set(key, pending)
      if (!this.permissionQueue.includes(key)) this.permissionQueue.push(key)
      this.emitFrontPermission()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.client?.respondError(id, -32000, message)
    }
  }

  private handleNotification(method: string, params: unknown): void {
    const p = (params ?? {}) as Record<string, unknown>

    if (method === 'session/update' || method === 'x.ai/session/update') {
      this.handleSessionUpdate(p)
      return
    }

    if (method.startsWith('session/') || method.startsWith('x.ai/') || method.startsWith('_x.ai/')) {
      if (p.update || p.sessionUpdate) {
        this.handleSessionUpdate(p)
      }
    }
  }

  private ensureAssistantId(explicit?: string): string {
    if (explicit) {
      this.activeMessageId = explicit
      return explicit
    }
    if (this.replayingHistory) {
      if (!this.historyAssistantId) {
        this.historyAssistantId = randomUUID()
        const msg: ChatMessage = {
          id: this.historyAssistantId,
          role: 'assistant',
          text: '',
          thought: '',
          toolCalls: [],
          createdAt: Date.now(),
          fromHistory: true
        }
        this.liveMessages.push(msg)
        if (this.sessionId) {
          this.emit({ type: 'user-message', sessionId: this.sessionId, message: msg })
        }
      }
      return this.historyAssistantId
    }
    const messageId = this.activeMessageId || randomUUID()
    if (!this.activeMessageId) this.activeMessageId = messageId
    return messageId
  }

  private handleSessionUpdate(params: Record<string, unknown>): void {
    const update = (params.update ?? params) as Record<string, unknown>
    const sessionId = (params.sessionId as string) || this.sessionId || ''
    const kind = (update.sessionUpdate as string) || ''

    // History replay: user messages
    // FIX-R7: live turns already have the user bubble (renderer optimistic + main
    // sendPrompt). The agent echoes the prompt as user_message_chunk — ignore it.
    // Only rebuild user turns while replaying session/load history, and only when
    // we did not already load a full local transcript.
    if (kind === 'user_message_chunk') {
      if (!this.replayingHistory || this.suppressHistoryReplay) return
      const content = update.content as { text?: string } | string | undefined
      const text =
        typeof content === 'string'
          ? content
          : content?.text || (update.text as string) || ''
      if (!text) return
      const messageId =
        (update.messageId as string) || (update.id as string) || randomUUID()
      // Append to last user or create
      const last = this.liveMessages[this.liveMessages.length - 1]
      if (last?.role === 'user' && last.fromHistory && last.streaming !== false) {
        last.text += text
        this.emit({
          type: 'message-chunk',
          sessionId,
          messageId: last.id,
          text
        })
      } else {
        const msg: ChatMessage = {
          id: messageId,
          role: 'user',
          text,
          createdAt: Date.now(),
          fromHistory: this.replayingHistory
        }
        this.liveMessages.push(msg)
        this.emit({ type: 'user-message', sessionId, message: msg })
      }
      // Close prior assistant grouping when user speaks in history
      this.historyAssistantId = null
      return
    }

    // Skip assistant/thought history rebuild when local transcript is authoritative
    if (
      this.suppressHistoryReplay &&
      (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk')
    ) {
      return
    }

    const messageId = this.ensureAssistantId(
      (update.messageId as string) || undefined
    )

    if (kind === 'agent_message_chunk') {
      const content = update.content as { text?: string } | string | undefined
      const text =
        typeof content === 'string'
          ? content
          : content?.text || (update.text as string) || ''
      if (text) {
        this.patchAssistant(messageId, (m) => ({ ...m, text: m.text + text }))
        this.emit({ type: 'message-chunk', sessionId, messageId, text })
      }
      return
    }

    if (kind === 'agent_thought_chunk') {
      const content = update.content as { text?: string } | string | undefined
      const text =
        typeof content === 'string'
          ? content
          : content?.text || (update.text as string) || ''
      if (text) {
        this.patchAssistant(messageId, (m) => ({
          ...m,
          thought: (m.thought || '') + text
        }))
        this.emit({ type: 'thought-chunk', sessionId, messageId, text })
      }
      return
    }

    if (kind === 'tool_call' || kind === 'tool_call_update') {
      const parsed = parseToolCallFromUpdate(update)
      if (parsed) {
        // Preserve title/kind/rawInput across Grok's late status-only updates.
        let merged = parsed
        this.patchAssistant(messageId, (m) => {
          const tools = [...(m.toolCalls || [])]
          const idx = tools.findIndex((t) => t.toolCallId === parsed.toolCallId)
          if (idx >= 0) {
            merged = mergeToolCall(tools[idx], parsed)
            tools[idx] = merged
          } else {
            tools.push(parsed)
          }
          return { ...m, toolCalls: tools }
        })
        if (kind === 'tool_call') {
          this.emit({ type: 'tool-call', sessionId, messageId, toolCall: merged })
        } else {
          this.emit({
            type: 'tool-call-update',
            sessionId,
            messageId,
            toolCallId: merged.toolCallId,
            patch: merged
          })
        }
      }
      return
    }

    if (kind === 'plan') {
      this.emit({ type: 'plan', sessionId, messageId, plan: update })
      return
    }
  }
}

export const agentManager = new AgentManager()
