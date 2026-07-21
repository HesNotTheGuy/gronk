import { BrowserWindow } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import {
  GrokAcpClient,
  parseToolCallFromUpdate,
  resolveGrokBinary,
  type JsonRpcId,
  type PermissionOption
} from './acp/client'
import {
  appendPermissionAudit,
  getSettings,
  getTranscript,
  normalizeCwd,
  saveTranscript,
  upsertSession
} from './store'
import { listModels } from './models'
import type {
  ChatMessage,
  ConnectionState,
  MainToRendererEvent,
  ModelInfo,
  PermissionDecision,
  PermissionRequest,
  ToolCallInfo
} from '../../shared/types'

interface PendingPermission {
  requestId: JsonRpcId
  options: PermissionOption[]
  toolCallId?: string
  title: string
  kind?: string
  rawInput?: unknown
}

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
  private pendingPermission: PendingPermission | null = null
  private alwaysApprove = false
  /** When true, session/update chunks rebuild history instead of live turn */
  private replayingHistory = false
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
  private async bootAgent(
    cwd: string,
    options?: { model?: string; alwaysApprove?: boolean }
  ): Promise<void> {
    await this.stopProcessOnly()

    const settings = getSettings()
    const binary = resolveGrokBinary(settings.grokBinary)
    if (!binary) {
      this.setState(
        'error',
        'Could not find the grok binary. Install Grok CLI or set path in settings.'
      )
      throw new Error('grok binary not found')
    }

    const model = options?.model ?? settings.model
    this.currentModel = model
    this.alwaysApprove = !!(options?.alwaysApprove ?? settings.alwaysApprove)
    // Hard safety: store may refuse alwaysApprove without ack
    if (this.alwaysApprove && !settings.alwaysApproveAck) {
      this.alwaysApprove = false
    }

    const agentArgs = ['agent']
    if (model) {
      agentArgs.push('-m', model)
    }
    if (this.alwaysApprove) {
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
    this.pendingPermission = null

    this.client.on('stderr', (line) => this.log('stderr', line))
    this.client.on('error', (err) => this.setState('error', err.message))
    this.client.on('exit', (code) => {
      if (this.state !== 'stopped' && this.state !== 'idle') {
        this.setState('error', `Agent process exited (code ${code ?? '?'})`)
      }
      this.client = null
      this.sessionId = null
      this.pendingPermission = null
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
    options?: { model?: string; alwaysApprove?: boolean }
  ): Promise<{ sessionId: string }> {
    await this.bootAgent(cwd, options)
    if (!this.client) throw new Error('Agent failed to boot')

    try {
      const { sessionId } = await this.client.sessionNew(this.cwd!)
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

    // Prefer local transcript immediately for snappy UI
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
          alwaysApprove: settings.alwaysApprove
        })
      }
      if (!this.client) throw new Error('Agent not running')

      this.replayingHistory = true
      this.historyAssistantId = null
      this.liveMessages = local.map((m) => ({ ...m, streaming: false, fromHistory: true }))

      const result = await this.client.sessionLoad(sessionId, targetCwd)
      this.sessionId = result.sessionId || sessionId
      this.cwd = targetCwd
      this.replayingHistory = false
      this.setState('ready')
      this.emit({ type: 'session', sessionId: this.sessionId, cwd: targetCwd })

      const source =
        local.length > 0 && this.liveMessages.length > local.length
          ? 'mixed'
          : local.length > 0
            ? 'local'
            : this.liveMessages.length > 0
              ? 'acp'
              : 'empty'

      // If ACP didn't stream history, keep local
      if (source === 'local' || source === 'empty') {
        /* already emitted local */
      }
      this.persistLiveTranscript()
      this.emit({ type: 'history-done', sessionId: this.sessionId, source })
      return { sessionId: this.sessionId, restored: this.liveMessages.length > 0 }
    } catch (err) {
      this.replayingHistory = false
      const message = err instanceof Error ? err.message : String(err)
      // Fall back: start new live session but keep local transcript visible
      try {
        if (!this.client || this.state !== 'ready') {
          await this.start(targetCwd, {
            model: settings.model,
            alwaysApprove: settings.alwaysApprove
          })
        }
        this.emit({
          type: 'error',
          message: `Could not load session into agent (${message}). Showing local transcript; agent context may be fresh.`
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
    this.pendingPermission = null
    if (this.client) {
      await this.client.dispose()
      this.client = null
    }
    this.sessionId = null
    this.activeMessageId = null
  }

  async stop(): Promise<void> {
    this.setState('stopped')
    this.persistLiveTranscript()
    await this.stopProcessOnly()
    this.setState('idle')
  }

  async sendPrompt(text: string): Promise<{ messageId: string }> {
    if (!this.client || !this.sessionId || this.state !== 'ready') {
      throw new Error('Agent is not ready')
    }

    const settings = getSettings()
    this.alwaysApprove = !!(settings.alwaysApprove && settings.alwaysApproveAck)

    const messageId = randomUUID()
    this.activeMessageId = messageId

    const userMsg: ChatMessage = {
      id: randomUUID(),
      role: 'user',
      text,
      createdAt: Date.now()
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
      upsertSession({
        id: this.sessionId,
        cwd: this.cwd,
        title: text.slice(0, 60) || path.basename(this.cwd),
        createdAt: Date.now(),
        updatedAt: Date.now()
      })
    }

    void this.client
      .sessionPrompt(this.sessionId, [{ type: 'text', text }])
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
        this.pendingPermission = null
        this.persistLiveTranscript()

        if (this.sessionId && this.cwd) {
          upsertSession({
            id: this.sessionId,
            cwd: this.cwd,
            title: text.slice(0, 60) || path.basename(this.cwd),
            createdAt: Date.now(),
            updatedAt: Date.now()
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
        this.pendingPermission = null
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

    if (this.pendingPermission && this.client) {
      this.client.respondToRequest(this.pendingPermission.requestId, {
        outcome: { outcome: 'cancelled' }
      })
      this.recordAudit('cancelled')
      this.pendingPermission = null
      this.emit({ type: 'permission-request', request: null })
    }

    try {
      await this.client.sessionCancel(this.sessionId)
    } catch {
      /* best effort */
    }
  }

  respondPermission(requestId: number | string, decision: PermissionDecision): void {
    if (!this.client) return

    const pending = this.pendingPermission
    const options = pending?.options ?? []
    const id = pending?.requestId ?? requestId

    this.log('permission decision', decision, 'id', id)
    this.client.respondPermission(id, decision, options)
    this.recordAudit(decision)
    this.pendingPermission = null
  }

  private recordAudit(decision: PermissionDecision | 'cancelled' | 'auto-allow'): void {
    const p = this.pendingPermission
    if (!p) return
    const preview =
      p.rawInput === undefined
        ? undefined
        : typeof p.rawInput === 'string'
          ? p.rawInput.slice(0, 500)
          : JSON.stringify(p.rawInput).slice(0, 500)

    appendPermissionAudit({
      id: randomUUID(),
      at: Date.now(),
      sessionId: this.sessionId || '',
      cwd: this.cwd || '',
      toolCallId: p.toolCallId || 'unknown',
      title: p.title,
      kind: p.kind,
      decision,
      rawInputPreview: preview
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

    this.pendingPermission = {
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
      this.recordAudit('auto-allow')
      this.pendingPermission = null
      return
    }

    const request: PermissionRequest = {
      requestId: id,
      sessionId: (p.sessionId as string) || this.sessionId || '',
      toolCallId: toolCallId || 'unknown',
      title,
      kind: toolCall.kind as string | undefined,
      rawInput: toolCall.rawInput ?? toolCall.input ?? p.rawInput
    }

    this.emit({ type: 'permission-request', request })
  }

  private handleFsRead(id: JsonRpcId, p: Record<string, unknown>): void {
    try {
      const filePath = String(p.path || '')
      if (!filePath) {
        this.client?.respondError(id, -32602, 'path required')
        return
      }
      // Path jail: only under project cwd when set
      if (this.cwd) {
        const resolved = path.resolve(filePath)
        const root = path.resolve(this.cwd)
        if (!resolved.startsWith(root + path.sep) && resolved !== root) {
          this.client?.respondError(id, -32000, 'Path outside project root is not allowed')
          return
        }
      }
      let content = fs.readFileSync(filePath, 'utf8')
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
      if (this.cwd) {
        const resolved = path.resolve(filePath)
        const root = path.resolve(this.cwd)
        if (!resolved.startsWith(root + path.sep) && resolved !== root) {
          this.client?.respondError(id, -32000, 'Path outside project root is not allowed')
          return
        }
      }
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, content, 'utf8')
      this.client?.respondToRequest(id, null)
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
    if (kind === 'user_message_chunk') {
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

    if (kind === 'tool_call') {
      const toolCall = parseToolCallFromUpdate(update)
      if (toolCall) {
        this.patchAssistant(messageId, (m) => {
          const tools = [...(m.toolCalls || [])]
          const idx = tools.findIndex((t) => t.toolCallId === toolCall.toolCallId)
          if (idx >= 0) tools[idx] = { ...tools[idx], ...toolCall }
          else tools.push(toolCall)
          return { ...m, toolCalls: tools }
        })
        this.emit({ type: 'tool-call', sessionId, messageId, toolCall })
      }
      return
    }

    if (kind === 'tool_call_update') {
      const toolCall = parseToolCallFromUpdate(update)
      if (toolCall) {
        this.patchAssistant(messageId, (m) => {
          let tools = (m.toolCalls || []).map((t) =>
            t.toolCallId === toolCall.toolCallId ? { ...t, ...toolCall } : t
          )
          if (!tools.some((t) => t.toolCallId === toolCall.toolCallId)) {
            tools = [...tools, toolCall]
          }
          return { ...m, toolCalls: tools }
        })
        this.emit({
          type: 'tool-call-update',
          sessionId,
          messageId,
          toolCallId: toolCall.toolCallId,
          patch: toolCall as Partial<ToolCallInfo>
        })
      }
      return
    }

    if (kind === 'plan') {
      this.emit({ type: 'plan', sessionId, messageId, plan: update })
    }
  }
}

export const agentManager = new AgentManager()
