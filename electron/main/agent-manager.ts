import { BrowserWindow } from 'electron'
import { chatWorkspacePath } from './data-dir'
import path from 'node:path'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import {
  GrokAcpClient,
  isAllowedGrokBasename,
  probeGrokBinary,
  resolveGrokBinary,
  SessionUsageTracker,
  type JsonRpcId
} from './acp/client'
import { buildAgentArgs, isAutoApproveActive } from './agent-args'
import { MAX_FS_READ_BYTES, resolveInsideJail, sliceLines } from './agent/fs-bridge'
import {
  canAppendHistoryUserChunk,
  historySource,
  needsAgentBoot,
  planHistoryReplay
} from './agent/history'
import {
  parsePermissionRequest,
  PermissionQueue,
  type PendingPermission
} from './agent/permissions'
import {
  buildPromptPayload,
  buildTurnMessages,
  sessionTitleFromPrompt
} from './agent/prompt'
import { routeSessionUpdate, upsertToolCall } from './agent/session-update'
import {
  appendPermissionAudit,
  getSettings,
  getTranscript,
  listSessions,
  normalizeCwd,
  requestedPermissionMode,
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
  PermissionRequest
} from '../../shared/types'

/** Gronk app chat sandbox (same path as gronk:get-chat-workspace). */
function isChatPadCwd(cwd: string): boolean {
  // Ask data-dir for the sandbox path rather than rebuilding it from
  // app.getPath('userData'). A third copy of this derivation would keep pointing
  // at the old location after the user relocates their data, and classification
  // would then only work by accident, via isChatWorkspace's /chat-workspace
  // suffix fallback.
  return isChatWorkspace(cwd, chatWorkspacePath())
}

/**
 * Owns the lifecycle of one `grok agent stdio` process and maps ACP events → renderer IPC.
 *
 * Coordinator only: the decisions it used to make inline now live in `./agent/*`
 * as pure functions (update routing, history restore, prompt building, the
 * filesystem jail) plus one small stateful queue for pending permissions. This
 * class keeps the process, the window and the live transcript, and applies what
 * those modules return.
 */
export class AgentManager {
  private client: GrokAcpClient | null = null
  private sessionId: string | null = null
  private cwd: string | null = null
  private state: ConnectionState = 'idle'
  private activeMessageId: string | null = null
  private window: BrowserWindow | null = null
  /** FIX-9: one pending permission per request id (queue display FIFO) */
  private permissions = new PermissionQueue()
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
  /**
   * The permission posture the RUNNING child was spawned with, straight from
   * buildAgentArgs. The runtime auto-approve gate is bound to it so a session
   * cannot drift from how it was started (see isAutoApproveActive).
   */
  private bootAlwaysApprove = false
  /** Running token/cost totals for the live session (in memory only, never persisted). */
  private usage = new SessionUsageTracker()

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
      this.window.webContents.send('gronk:event', event)
    }
  }

  private setState(state: ConnectionState, error?: string): void {
    this.state = state
    this.emit({ type: 'connection', state, error })
  }

  private log(...args: unknown[]): void {
    if (process.env.GRONK_DEBUG) {
      console.error('[gronk]', ...args)
    }
  }

  private persistLiveTranscript(): void {
    if (!this.sessionId) return
    saveTranscript(this.sessionId, this.liveMessages)
  }

  /**
   * May Gronk answer a permission request itself? Boot posture AND current
   * settings must both say bypass — isAutoApproveActive owns that rule and
   * documents which side wins when the user flips the toggle mid-session.
   */
  private autoApproveActive(): boolean {
    return isAutoApproveActive(this.bootAlwaysApprove, getSettings())
  }

  /**
   * Boot grok agent process + initialize only (no session/new).
   */
  private surface: 'chat' | 'project' = 'project'

  /**
   * `options.alwaysApprove` is the per-start YOLO override coming from the
   * `gronk:start-agent` IPC; it folds onto the stored permission mode (see
   * store.requestedPermissionMode) instead of travelling beside it. Omit it to
   * use the mode as stored.
   */
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

    // All permission derivation lives in buildAgentArgs — adopt what it decided
    // rather than recomputing the downgrades here (they must never drift apart).
    // The per-start override (IPC `gronk:start-agent`) is the UI's YOLO toggle
    // asked for one boot instead of for the stored settings, so it folds onto the
    // stored mode through the store's one fold rule: `true` asks for bypass (still
    // gated on the persisted ack below), `false` refuses it for this boot, absent
    // means use the mode as stored.
    const built = buildAgentArgs({
      permissionMode: requestedPermissionMode(
        { alwaysApprove: options?.alwaysApprove },
        settings.permissionMode
      ),
      alwaysApproveAck: settings.alwaysApproveAck,
      model,
      surface: options?.surface
    })
    this.surface = built.surface
    this.bootAlwaysApprove = built.alwaysApprove
    const agentArgs = built.args
    // The argv is what decides whether grok asks Gronk for permission at all,
    // so record the posture the child actually starts with.
    this.log('boot', {
      permissionMode: built.permissionMode,
      alwaysApprove: built.alwaysApprove,
      surface: built.surface
    })

    this.setState('starting')
    this.cwd = normalizeCwd(cwd)
    this.client = new GrokAcpClient(binary, agentArgs)
    this.liveMessages = []
    this.replayingHistory = false
    this.historyAssistantId = null
    this.activeMessageId = null
    this.permissions.clear()

    this.client.on('stderr', (line) => this.log('stderr', line))
    this.client.on('error', (err) => this.setState('error', err.message))
    // Surface the exit and stand down — deliberately no respawn. A crash loop
    // would keep spending the user's quota with nothing on screen to stop it, so
    // the next process only ever starts from an explicit user action.
    this.client.on('exit', (code) => {
      if (this.state !== 'stopped' && this.state !== 'idle') {
        this.setState('error', `Agent process exited (code ${code ?? '?'})`)
      }
      this.client = null
      this.sessionId = null
      this.bootAlwaysApprove = false
      this.permissions.clear()
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
    // Captured before the transition below. needsAgentBoot asks whether the
    // agent was already unusable, and reading this.state after setState made it
    // permanently 'loading', so the error/idle/stopped arms never fired. A live
    // client left in 'error' (the client error handler sets that state without
    // nulling it) would then be reused instead of respawned.
    const stateBeforeLoad = this.state
    this.setState('loading')
    this.emit({ type: 'history-clear', sessionId })

    // Prefer local transcript immediately for snappy UI (already de-duped in getTranscript)
    const local = getTranscript(sessionId)
    const plan = planHistoryReplay(local)
    for (const message of plan.messages) {
      this.emit({ type: 'user-message', sessionId, message })
    }

    try {
      // Fresh agent process bound to this project, then load (not new)
      const needBoot = needsAgentBoot({
        hasClient: !!this.client,
        state: stateBeforeLoad,
        currentCwd: this.cwd ? normalizeCwd(this.cwd) : null,
        targetCwd
      })

      if (needBoot) {
        // No alwaysApprove override: bootAgent reads the stored permission mode,
        // and passing the value derived from it back in would just be a second
        // copy of the same fact.
        await this.bootAgent(targetCwd, {
          model: settings.model,
          surface: isChatPadCwd(targetCwd) ? 'chat' : 'project'
        })
      }
      if (!this.client) throw new Error('Agent not running')

      this.replayingHistory = true
      // Resuming re-counts from zero: `needBoot` can be false (same folder, live
      // process), so without this an earlier session's totals would carry over.
      // Replayed turn_completed updates then rebuild this session's real total.
      this.usage.reset()
      // If we already have a local transcript, do not rebuild messages from ACP echo
      this.suppressHistoryReplay = plan.suppressHistoryReplay
      this.historyAssistantId = null
      this.liveMessages = plan.messages

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

      const source = historySource(local.length, this.liveMessages.length)

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
    // No child, no boot posture: the gate must not outlive the process it describes.
    this.bootAlwaysApprove = false
    // Totals belong to one live session; a new process starts a new accounting run.
    this.usage.reset()
    this.permissions.clear()
    if (this.client) {
      await this.client.dispose()
      this.client = null
    }
    this.sessionId = null
    this.activeMessageId = null
  }

  private emitFrontPermission(): void {
    const p = this.permissions.front()
    if (!p) {
      this.emit({ type: 'permission-request', request: null })
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

    const attachments = options?.attachments ?? []

    // Build ACP content blocks: files as path context, images as image blocks.
    // This runs BEFORE activeMessageId is set because it throws on an empty
    // prompt: pointing the manager at a message id first meant a rejected send
    // left tool-call updates attaching to a message that was never created,
    // until the next prompt happened to reset it.
    const { blocks: promptBlocks, text: fullText } = buildPromptPayload(text, attachments)

    const messageId = randomUUID()
    this.activeMessageId = messageId

    const { user, assistant } = buildTurnMessages({
      userId: randomUUID(),
      assistantId: messageId,
      text: fullText,
      rawText: text,
      attachments,
      now: Date.now()
    })
    this.liveMessages.push(user, assistant)
    this.persistLiveTranscript()

    if (this.sessionId && this.cwd) {
      // Only seed title when session has none yet; renameSession owns later titles
      const prev = listSessions().find((s) => s.id === this.sessionId)
      upsertSession({
        id: this.sessionId,
        cwd: this.cwd,
        surface: this.surface,
        ...(!prev?.title
          ? { title: sessionTitleFromPrompt(fullText || text, path.basename(this.cwd)) }
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

    for (const p of this.permissions.all()) {
      this.client.respondToRequest(p.requestId, {
        outcome: { outcome: 'cancelled' }
      })
      this.recordAuditFor(p, 'cancelled')
    }
    this.permissions.clear()
    this.emit({ type: 'permission-request', request: null })

    try {
      await this.client.sessionCancel(this.sessionId)
    } catch {
      /* best effort */
    }
  }

  respondPermission(requestId: number | string, decision: PermissionDecision): void {
    if (!this.client) return

    const pending = this.permissions.take(requestId)
    if (!pending) {
      this.log('permission decision for unknown requestId', requestId)
      return
    }

    this.log('permission decision', decision, 'id', requestId)

    // FIX-6: resolve fs/write after user consent
    if (pending.fsWrite) {
      if (decision === 'allow-once' || decision === 'allow-always') {
        try {
          const safe = resolveInsideJail(this.cwd, pending.fsWrite.path)
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
      `Method not supported by Gronk client: ${method}`
    )
    this.emit({
      type: 'error',
      message: `Agent requested unsupported client method: ${method}`
    })
  }

  private handlePermissionRequest(id: JsonRpcId, p: Record<string, unknown>): void {
    const { pending, toolCallPatch } = parsePermissionRequest(id, p)

    // Show the gated call on the tool card before the prompt is answered, so the
    // user can see what they are being asked about without reading the dialog.
    if (toolCallPatch && this.activeMessageId && this.sessionId) {
      this.emit({
        type: 'tool-call-update',
        sessionId: this.sessionId,
        messageId: this.activeMessageId,
        toolCallId: toolCallPatch.toolCallId,
        patch: toolCallPatch
      })
    }

    if (this.autoApproveActive()) {
      this.log('auto-approving permission', id)
      this.client?.respondPermission(id, 'allow-once', pending.options)
      this.recordAuditFor(pending, 'auto-allow')
      return
    }

    this.permissions.add(pending)
    this.emitFrontPermission()
  }

  private handleFsRead(id: JsonRpcId, p: Record<string, unknown>): void {
    try {
      const filePath = String(p.path || '')
      if (!filePath) {
        this.client?.respondError(id, -32602, 'path required')
        return
      }
      const safe = resolveInsideJail(this.cwd, filePath)
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

      const content = fs.readFileSync(safe, 'utf8')
      const line = typeof p.line === 'number' ? p.line : undefined
      const limit = typeof p.limit === 'number' ? p.limit : undefined
      this.client?.respondToRequest(id, { content: sliceLines(content, line, limit) })
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
      const safe = resolveInsideJail(this.cwd, filePath)
      if (!safe) {
        this.client?.respondError(id, -32000, 'Path outside project root is not allowed')
        return
      }

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
      if (this.autoApproveActive()) {
        fs.mkdirSync(path.dirname(safe), { recursive: true })
        fs.writeFileSync(safe, content, 'utf8')
        this.client?.respondToRequest(id, null)
        this.recordAuditFor(pending, 'auto-allow')
        return
      }

      this.permissions.add(pending)
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

  /**
   * Fold one turn's usage into the session total and push it to the UI.
   *
   * Accounting is secondary to the conversation working, so every failure path
   * here is swallowed: a renamed field upstream must cost the user a number on
   * screen, never the stream itself.
   */
  private trackUsage(sessionId: string, update: Record<string, unknown>): void {
    try {
      const usage = this.usage.add(sessionId, update)
      if (usage) this.emit({ type: 'usage', sessionId, usage })
    } catch (err) {
      this.log('usage accounting failed', err)
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

  /** Apply one routed session/update. Routing itself lives in ./agent/session-update. */
  private handleSessionUpdate(params: Record<string, unknown>): void {
    const routed = routeSessionUpdate(params, {
      sessionId: this.sessionId,
      replayingHistory: this.replayingHistory,
      suppressHistoryReplay: this.suppressHistoryReplay
    })
    const { sessionId, action } = routed

    if (action.type === 'ignore') return

    if (action.type === 'usage') {
      this.trackUsage(sessionId, action.update)
      return
    }

    if (action.type === 'history-user-chunk') {
      this.appendHistoryUserChunk(sessionId, action.text, action.messageId)
      return
    }

    // Everything below is assistant-scoped, and resolving the id is what opens a
    // replayed turn's bubble — so it happens for all of them, including a `noop`.
    const messageId = this.ensureAssistantId(routed.explicitMessageId)

    switch (action.type) {
      case 'text':
        this.patchAssistant(messageId, (m) => ({ ...m, text: m.text + action.text }))
        this.emit({ type: 'message-chunk', sessionId, messageId, text: action.text })
        return

      case 'thought':
        this.patchAssistant(messageId, (m) => ({
          ...m,
          thought: (m.thought || '') + action.text
        }))
        this.emit({ type: 'thought-chunk', sessionId, messageId, text: action.text })
        return

      case 'tool-call': {
        // The emitted call is the merged one: Grok's late status-only updates
        // carry a placeholder title that must not reach the renderer.
        const current = this.liveMessages.find((m) => m.id === messageId)
        const { toolCalls, merged } = upsertToolCall(current?.toolCalls, action.toolCall)
        this.patchAssistant(messageId, (m) => ({ ...m, toolCalls }))
        if (action.initial) {
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
        return
      }

      case 'plan':
        this.emit({ type: 'plan', sessionId, messageId, plan: action.plan })
        return

      default:
        return
    }
  }

  /** Rebuild one replayed user turn: extend the open bubble, or start a new one. */
  private appendHistoryUserChunk(
    sessionId: string,
    text: string,
    messageId?: string
  ): void {
    const last = this.liveMessages[this.liveMessages.length - 1]
    if (canAppendHistoryUserChunk(last)) {
      last.text += text
      this.emit({ type: 'message-chunk', sessionId, messageId: last.id, text })
    } else {
      const msg: ChatMessage = {
        id: messageId || randomUUID(),
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
  }
}

export const agentManager = new AgentManager()
