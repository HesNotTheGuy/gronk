import { BrowserWindow } from 'electron'
// Notification is a named export in real Electron; the test stub does not
// implement it. Resolve at call time so unit tests that load this module stay
// importable.
import * as electron from 'electron'
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
import { livenessOf, mayForward } from './agent/session-liveness'
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
import { appendTextPart, appendToolPart } from '../../shared/types'
import { redactPreview } from './redact'
import type {
  ChatMessage,
  ConnectionState,
  SessionLiveness,
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
  /** One pending permission per request id (queue display FIFO). */
  private permissions = new PermissionQueue()
  /**
   * Tool kinds the user batch-approved for this agent process only. Cleared on
   * stop/boot. Not persisted — that is what allow-always / CLI config is for.
   */
  private sessionAllowKinds = new Set<string>()
  /** When true, session/update chunks rebuild history instead of live turn */
  private replayingHistory = false
  /**
   * When true, ignore ACP history replay chunks (user/assistant/thought).
   * Used when a full local transcript already exists so session/load does not
   * re-append messages that the agent echoes.
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

  /**
   * Where this session's events go.
   *
   * Set by the registry so it can see every event before the renderer does. One
   * session's boot must not narrate itself over another's connection state, and
   * only something holding all the sessions can know which is which.
   */
  setEmitSink(sink: ((event: MainToRendererEvent) => void) | null): void {
    this.emitSink = sink
  }

  private emitSink: ((event: MainToRendererEvent) => void) | null = null

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

  /**
   * `{ sessionId }` when there is one, `{}` otherwise, for spreading into an
   * event. Absent means "no session yet", which the renderer reads as belonging
   * to whatever switch it is waiting on. Emitting `sessionId: undefined`
   * explicitly would say the same thing but survives a structured clone as a
   * present key, so the two are kept distinct.
   */
  private sessionTag(): { sessionId?: string } {
    return this.sessionId ? { sessionId: this.sessionId } : {}
  }

  private emit(event: MainToRendererEvent): void {
    if (this.emitSink) {
      this.emitSink(event)
      return
    }
    this.sendToWindow(event)
  }

  /** The last hop, called by the registry once it has decided the event may go. */
  sendToWindow(event: MainToRendererEvent): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send('gronk:event', event)
    }
  }

  private setState(state: ConnectionState, error?: string): void {
    this.state = state
    // Named whenever there is a session to name. Before one exists this is the
    // boot window and there is nothing to attribute it to; the renderer treats
    // an unnamed connection event as belonging to whatever it is waiting for.
    this.emit({ type: 'connection', state, error, ...this.sessionTag() })
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

    // User-supplied override must pass basename + version probe.
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
    this.sessionAllowKinds.clear()

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
   * What this session is doing, derived rather than stored.
   *
   * Nothing to disagree with: it is read off the same fields the rest of the
   * class already keeps. Waiting on the user wins over working, because a
   * blocked session looks busy from outside and is the one that needs a person.
   */
  livenessNow(): SessionLiveness | null {
    return livenessOf({
      state: this.state,
      hasPendingPermission: !!this.permissions.front(),
      hasOpenTurn: this.activeMessageId !== null
    })
  }

  /**
   * Put this session's pending permission back on screen.
   *
   * Called when a session is focused. A request raised while it was in the
   * background was emitted and dropped, because the renderer only accepts what
   * belongs to the conversation being shown, so opening it has to ask again.
   * Nothing is answered on anyone's behalf: the request is still the same one,
   * still waiting.
   */
  reemitFrontPermission(): void {
    this.emitFrontPermission()
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

    // Prefer local transcript immediately for snappy UI (already de-duped in getTranscript)
    const local = getTranscript(sessionId)
    const plan = planHistoryReplay(local)
    this.liveMessages = plan.messages
    // One event with the whole cache: clear + N user-message emits made restore
    // thrash the renderer for large sessions (and looked hung).
    if (plan.messages.length > 0) {
      this.emit({ type: 'history-replace', sessionId, messages: plan.messages })
    } else {
      this.emit({ type: 'history-clear', sessionId })
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
      // liveMessages already seeded above from the local plan

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
            `new replies start with a fresh context.`,
          ...this.sessionTag()
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

  /**
   * How long to let an in-flight turn wind down before the process is killed.
   *
   * Switching away used to sever a running turn outright: dispose() closed the
   * pipe mid-stream, so the agent never learned it was interrupted and the
   * partial reply was simply abandoned. A cancel gives it the chance to stop
   * cleanly, but must never let a wedged agent block the UI, so it is raced
   * against a short timer rather than awaited.
   */
  private static readonly CANCEL_GRACE_MS = 1500

  private async stopProcessOnly(): Promise<void> {
    // No child, no boot posture: the gate must not outlive the process it describes.
    this.bootAlwaysApprove = false

    // A turn is in flight only when a message is still open. Cancel it before
    // tearing anything down, so the agent stops on purpose instead of losing its
    // pipe mid-sentence.
    if (this.client && this.sessionId && this.activeMessageId) {
      const sessionId = this.sessionId
      try {
        await Promise.race([
          this.client.sessionCancel(sessionId),
          new Promise((resolve) => setTimeout(resolve, AgentManager.CANCEL_GRACE_MS))
        ])
      } catch {
        // An agent that cannot be cancelled is about to be killed anyway.
      }
    }

    // Totals belong to one live session; a new process starts a new accounting run.
    this.usage.reset()
    this.permissions.clear()
    this.sessionAllowKinds.clear()
    if (this.client) {
      await this.client.dispose()
      this.client = null
    }
    this.sessionId = null
    this.activeMessageId = null
  }

  private notifyIfUnfocused(title: string, body: string): void {
    try {
      const NotificationCtor = (electron as { Notification?: typeof import('electron').Notification })
        .Notification
      if (!NotificationCtor || typeof NotificationCtor.isSupported !== 'function') return
      if (!NotificationCtor.isSupported()) return
      const win = this.window
      if (win && !win.isDestroyed() && win.isFocused()) return
      const n = new NotificationCtor({ title, body, silent: false })
      n.on('click', () => {
        if (!win || win.isDestroyed()) return
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      })
      n.show()
    } catch {
      /* notification is best-effort */
    }
  }

  private emitFrontPermission(): void {
    const p = this.permissions.front()
    if (!p) {
      this.emit({ type: 'permission-request', request: null, ...this.sessionTag() })
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
    this.emit({ type: 'permission-request', request, ...this.sessionTag() })
    this.notifyIfUnfocused(
      'Permission needed',
      p.title ? `Gronk is waiting: ${p.title}` : 'Gronk is waiting for a permission decision'
    )
  }

  async stop(): Promise<void> {
    // Held across the teardown. stopProcessOnly clears sessionId, so the final
    // state would otherwise be emitted with nothing naming it, and an
    // unattributed connection event is accepted by whichever session is on
    // screen. Stopping one session in the background would take the composer
    // down in another.
    const stopping = this.sessionId
    this.setState('stopped')
    this.persistLiveTranscript()
    await this.stopProcessOnly()
    this.state = 'idle'
    this.emit({ type: 'connection', state: 'idle', ...(stopping ? { sessionId: stopping } : {}) })
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
        this.notifyIfUnfocused(
          'Gronk',
          stopReason === 'cancelled' ? 'Turn cancelled' : 'Agent finished a turn'
        )

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
        this.notifyIfUnfocused('Gronk', 'Agent turn failed')
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
    this.emit({ type: 'permission-request', request: null, ...this.sessionTag() })

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

    // Session batch: remember the kind, answer this request as allow-once to the CLI.
    let effective: PermissionDecision = decision
    if (decision === 'allow-session') {
      if (pending.kind) this.sessionAllowKinds.add(pending.kind)
      effective = 'allow-once'
    }

    // Resolve fs/write after user consent.
    if (pending.fsWrite) {
      if (effective === 'allow-once' || effective === 'allow-always') {
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
      this.client.respondPermission(pending.requestId, effective, pending.options)
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
      message: `Agent requested unsupported client method: ${method}`,
      ...this.sessionTag()
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

    if (pending.kind && this.sessionAllowKinds.has(pending.kind)) {
      this.log('session-batch approving permission', pending.kind, id)
      if (pending.fsWrite) {
        try {
          const safe = resolveInsideJail(this.cwd, pending.fsWrite.path)
          if (!safe) {
            this.client?.respondError(id, -32000, 'Path outside project root is not allowed')
            this.recordAuditFor(pending, 'reject-once')
            return
          }
          fs.mkdirSync(path.dirname(safe), { recursive: true })
          fs.writeFileSync(safe, pending.fsWrite.content, 'utf8')
          this.client?.respondToRequest(id, null)
          this.recordAuditFor(pending, 'auto-allow')
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          this.client?.respondError(id, -32000, message)
          this.recordAuditFor(pending, 'reject-once')
        }
        return
      }
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

      // Bound size before full read.
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

      // YOLO still audits; non-YOLO requires user consent.
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
        // `text` stays the whole turn's prose and `parts` records where this run
        // sits between the tool calls. Both are written, because the transcript
        // on disk is read by builds that predate parts, and by exports that only
        // ever want the prose.
        this.patchAssistant(messageId, (m) => ({
          ...m,
          text: m.text + action.text,
          parts: appendTextPart(m.parts, action.text)
        }))
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
        // Placed on every update, not just the initial one: appendToolPart is
        // idempotent per id, and a call whose first sighting is a status update
        // still belongs where it was first seen rather than nowhere.
        this.patchAssistant(messageId, (m) => ({
          ...m,
          toolCalls,
          parts: appendToolPart(m.parts, merged.toolCallId)
        }))
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

/**
 * The live sessions, and which one is on screen.
 *
 * `AgentManager` was already a per-session object in everything but its
 * lifetime: of its fields only the window is app-level. So this holds N of them
 * rather than rewriting the class, and the rule it adds is about attribution
 * rather than about agents.
 *
 * Every no-argument reader here answers **for the focused session**, which is
 * exactly what it meant when there could only be one. That is what lets the
 * folder-scoped callers (the image roots, the git views, the project file
 * list) go on asking `getCwd()` with no argument while they are moved separately.
 *
 * Two rules live here because only something holding every session can apply
 * them:
 *
 * - A background session's `connection` events are not forwarded. They are how
 *   the renderer decides whether the composer is usable, and an unattributed
 *   one (which is what boot produces, before an id exists) is accepted by
 *   whatever is on screen. A second agent booting would otherwise disable the
 *   composer of the session being watched.
 * - Focusing a session re-emits its pending permission, so a request raised
 *   while it was in the background becomes reachable the moment it is opened.
 *   Nothing is ever answered on the user's behalf; blocking IS the behaviour,
 *   and this is what makes it recoverable.
 */
/**
 * What the registry needs from a session. Narrower than AgentManager on purpose:
 * a real one owns a CLI child process, which is why nothing in the test suite
 * can construct one, and the orchestration below is the half of this feature a
 * user actually sees.
 */
export interface ManagedSession {
  setWindow(win: BrowserWindow | null): void
  setEmitSink(sink: ((event: MainToRendererEvent) => void) | null): void
  getConnectionState(): ConnectionState
  getSessionId(): string | null
  getCwd(): string | null
  getSurface(): 'chat' | 'project'
  getCurrentModel(): string | undefined
  livenessNow(): SessionLiveness | null
  reemitFrontPermission(): void
  start(
    cwd: string,
    options?: { model?: string; alwaysApprove?: boolean; surface?: 'chat' | 'project' }
  ): Promise<{ sessionId: string }>
  loadSession(sessionId: string, cwd?: string): Promise<{ sessionId: string; restored: boolean }>
  stop(): Promise<void>
  sendPrompt(text: string, options?: unknown): Promise<{ messageId: string }>
  cancelPrompt(): Promise<void>
  respondPermission(requestId: number | string, decision: PermissionDecision): void
}

export class AgentRegistry {
  private readonly createSession: () => ManagedSession

  constructor(createSession: () => ManagedSession = () => new AgentManager()) {
    this.createSession = createSession
  }

  private readonly sessions = new Map<string, ManagedSession>()
  private window: BrowserWindow | null = null
  /** The session whose events reach the renderer as the conversation on screen. */
  private focusedId: string | null = null
  /**
   * The manager that is booting and has no id yet.
   *
   * A session id only exists after the agent has started, so between `start()`
   * and that answer there is nothing to key on. It is held here so its boot
   * narration still reaches the renderer, which is waiting for exactly that.
   */
  private booting: ManagedSession | null = null
  private liveness = new Map<string, SessionLiveness>()
  /**
   * The folder of the last session that was on screen.
   *
   * Held past that session's death on purpose. `getCwd()` answers "which folder
   * is the app looking at", and callers read a null from it as "no project is
   * open" rather than "no session is focused". One of them, the project-file
   * listing, treats that as permission to enumerate anywhere, which is right
   * while the folder picker is choosing a project and wrong the moment a
   * session has been stopped with its project still on screen.
   *
   * Stopping a session used to be impossible, so those two states could not be
   * told apart and did not need to be. Keeping the folder narrows the answer to
   * the project that was open rather than widening it: it names a root that was
   * allowed a moment earlier, and never a new one.
   */
  private lastFocusedCwd: string | null = null

  setWindow(win: BrowserWindow | null): void {
    this.window = win
    for (const manager of this.sessions.values()) manager.setWindow(win)
    this.booting?.setWindow(win)
  }

  /** Every live session, newest last. */
  private all(): ManagedSession[] {
    const out = [...this.sessions.values()]
    if (this.booting && !out.includes(this.booting)) out.push(this.booting)
    return out
  }

  private focused(): ManagedSession | null {
    if (this.focusedId) {
      const found = this.sessions.get(this.focusedId)
      if (found) return found
    }
    return this.booting
  }

  private send(event: MainToRendererEvent): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send('gronk:event', event)
    }
  }

  /**
   * One session's event, on its way out.
   *
   * Everything except `connection` is already attributed and the renderer drops
   * what is not its own, so it is forwarded and the renderer decides.
   * `connection` is the exception: it is the one event that can arrive
   * unattributed, and an unattributed one is always accepted.
   */
  private route(manager: ManagedSession, event: MainToRendererEvent): void {
    if (!mayForward(event, manager === this.focused())) return
    this.send(event)
  }

  private adopt(manager: ManagedSession): void {
    manager.setWindow(this.window)
    manager.setEmitSink((event) => {
      const id = manager.getSessionId()
      // The id appears partway through boot. Move it out of the booting slot the
      // first time it is known, so later events are addressed rather than
      // treated as the foreground's by default.
      if (id && this.booting === manager) {
        this.sessions.set(id, manager)
        this.booting = null
        if (!this.focusedId) this.focusedId = id
      } else if (id && !this.sessions.has(id)) {
        this.sessions.set(id, manager)
      }
      this.route(manager, event)
      // Scheduled, not immediate, and that is the whole point. A session emits
      // `message-done` and THEN clears the turn it had open, both in one
      // synchronous block, so reading liveness during the emit sees a turn that
      // is about to close and nothing looks again afterwards. Every session that
      // finished a turn would read as working for the rest of its life, which
      // collapses the two states the sidebar exists to tell apart.
      //
      // A microtask runs once that block has finished, so what it reads is the
      // state the session settled on rather than the state it was passing
      // through.
      this.reportLivenessSoon(manager)
    })
  }

  /**
   * Tell the renderer what this session is doing, when it changes.
   *
   * Derived rather than stored, so it cannot disagree with the manager. Three
   * answers: waiting on the user, working, or connected with nothing to do.
   */
  /**
   * Look again once the session has finished whatever it was doing.
   *
   * Coalesced per session: a burst of events settles on one answer, and only a
   * change is sent, so this cannot become a stream of its own.
   */
  private readonly livenessPending = new Set<ManagedSession>()

  private reportLivenessSoon(manager: ManagedSession): void {
    if (this.livenessPending.has(manager)) return
    this.livenessPending.add(manager)
    queueMicrotask(() => {
      this.livenessPending.delete(manager)
      this.reportLiveness(manager)
    })
  }

  private reportLiveness(manager: ManagedSession): void {
    const id = manager.getSessionId()
    if (!id) return
    const next = manager.livenessNow()
    if (this.liveness.get(id) === next) return
    if (next === null) this.liveness.delete(id)
    else this.liveness.set(id, next)
    this.send({ type: 'session-liveness', sessionId: id, liveness: next })
  }

  /** Which sessions are live, for a renderer that has just mounted. */
  getLiveness(): Record<string, SessionLiveness> {
    const out: Record<string, SessionLiveness> = {}
    for (const [id, value] of this.liveness) out[id] = value
    return out
  }

  // ── Readers, all about the focused session ────────────────────────────────

  getConnectionState(): ConnectionState {
    return this.focused()?.getConnectionState() ?? 'idle'
  }

  getSessionId(): string | null {
    return this.focused()?.getSessionId() ?? null
  }

  getCwd(): string | null {
    return this.focused()?.getCwd() ?? this.lastFocusedCwd
  }

  getSurface(): 'chat' | 'project' {
    return this.focused()?.getSurface() ?? 'project'
  }

  getCurrentModel(): string | undefined {
    return this.focused()?.getCurrentModel()
  }

  /** Is any session in a state that a data-directory move must not interrupt? */
  isAnyBusy(): boolean {
    return this.all().some((m) => {
      const state = m.getConnectionState()
      return state === 'starting' || state === 'ready' || state === 'loading'
    })
  }

  // ── Focus ─────────────────────────────────────────────────────────────────

  /**
   * Put a session on screen.
   *
   * Re-emitting the pending permission is the whole reason this is more than a
   * variable assignment: a background session that blocked has a dialog nobody
   * can reach until its own session is the one being shown.
   */
  focus(sessionId: string | null): void {
    this.focusedId = sessionId
    if (!sessionId) return
    const manager = this.sessions.get(sessionId)
    if (!manager) return
    this.lastFocusedCwd = manager.getCwd() ?? this.lastFocusedCwd
    manager.reemitFrontPermission()
    const state = manager.getConnectionState()
    this.send({ type: 'connection', state, sessionId })
  }

  /** A live session for this request, if one is already running. */
  private findReusable(cwd: string, surface: 'chat' | 'project', model?: string): ManagedSession | null {
    for (const manager of this.sessions.values()) {
      if (manager.getConnectionState() !== 'ready') continue
      if (!manager.getSessionId()) continue
      const managerCwd = manager.getCwd()
      if (!managerCwd || normalizeCwd(managerCwd) !== normalizeCwd(cwd)) continue
      if (manager.getSurface() !== surface) continue
      if (model && model !== manager.getCurrentModel()) continue
      return manager
    }
    return null
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Start a session, or return to one already running for the same folder.
   *
   * Nothing is stopped here. That is the change this whole branch is for: a
   * session the user walks away from goes on working, and only an explicit stop
   * or quitting ends it.
   */
  async start(
    cwd: string,
    options?: { model?: string; alwaysApprove?: boolean; surface?: 'chat' | 'project'; forceNew?: boolean }
  ): Promise<{ sessionId: string }> {
    const surface = options?.surface ?? 'project'
    if (!options?.forceNew) {
      const existing = this.findReusable(cwd, surface, options?.model)
      const existingId = existing?.getSessionId()
      if (existing && existingId) {
        this.focus(existingId)
        return { sessionId: existingId }
      }
    }

    const manager = this.createSession()
    this.adopt(manager)
    this.booting = manager
    const result = await manager.start(cwd, options)
    this.sessions.set(result.sessionId, manager)
    if (this.booting === manager) this.booting = null
    this.focus(result.sessionId)
    return result
  }

  /**
   * Open a stored session. One already live is focused rather than reloaded,
   * because reloading it would tear down the work this branch exists to keep.
   */
  async loadSession(sessionId: string, cwd?: string): Promise<{ sessionId: string; restored: boolean }> {
    const live = this.sessions.get(sessionId)
    if (live && live.getConnectionState() === 'ready') {
      this.focus(sessionId)
      return { sessionId, restored: true }
    }

    const manager = live ?? this.createSession()
    if (!live) {
      this.adopt(manager)
      this.booting = manager
    }
    const result = await manager.loadSession(sessionId, cwd)
    this.sessions.set(result.sessionId, manager)
    if (this.booting === manager) this.booting = null
    this.focus(result.sessionId)
    return result
  }

  /** Stop one session, or the focused one when none is named. */
  async stop(sessionId?: string | null): Promise<void> {
    const id = sessionId ?? this.focusedId
    const manager = id ? this.sessions.get(id) : this.focused()
    if (!manager) return
    const key = id ?? manager.getSessionId()
    // Detached first. A session emits as it tears down, and the sink adds any
    // session it hears from back into the map, so stopping one with the sink
    // still attached would revive it.
    manager.setEmitSink(null)
    await manager.stop()
    if (key) {
      this.sessions.delete(key)
      if (this.liveness.delete(key)) {
        this.send({ type: 'session-liveness', sessionId: key, liveness: null })
      }
      // Named here as well as inside the session. Teardown clears the id, so a
      // terminal state emitted after it has nothing to attribute it to, and an
      // unattributed connection event is taken by whatever is on screen, so
      // stopping a background session would blank the composer of the one being
      // watched.
      this.send({ type: 'connection', state: 'idle', sessionId: key })
      if (this.focusedId === key) this.focusedId = null
    }
    if (this.booting === manager) this.booting = null
  }

  /** Every session, for quit and for signing out. */
  async stopAll(): Promise<void> {
    const managers = this.all()
    this.sessions.clear()
    this.booting = null
    this.focusedId = null
    for (const [id] of this.liveness) {
      this.send({ type: 'session-liveness', sessionId: id, liveness: null })
    }
    this.liveness.clear()
    for (const m of managers) m.setEmitSink(null)
    await Promise.all(managers.map((m) => m.stop().catch(() => {})))
  }

  // ── Per-session work ──────────────────────────────────────────────────────

  private require(sessionId?: string | null): ManagedSession {
    const manager = sessionId ? this.sessions.get(sessionId) : this.focused()
    if (!manager) throw new Error('Agent is not running')
    return manager
  }

  async sendPrompt(
    text: string,
    options?: Parameters<ManagedSession['sendPrompt']>[1],
    sessionId?: string | null
  ): Promise<{ messageId: string }> {
    return this.require(sessionId).sendPrompt(text, options)
  }

  async cancelPrompt(sessionId?: string | null): Promise<void> {
    const manager = sessionId ? this.sessions.get(sessionId) : this.focused()
    await manager?.cancelPrompt()
  }

  /**
   * Answer a permission request.
   *
   * The session is named by the caller and is not optional in practice: request
   * ids are chosen per child process and start at 1, so two sessions collide on
   * them. Falling back to the focused session is only for a renderer that has
   * not been updated, and it answers the session the user is looking at, which
   * is the one whose dialog they can see.
   */
  respondPermission(
    requestId: number | string,
    decision: PermissionDecision,
    sessionId?: string | null
  ): void {
    const manager = sessionId ? this.sessions.get(sessionId) : this.focused()
    if (!manager) return
    manager.respondPermission(requestId, decision)
    this.reportLiveness(manager)
  }
}

export const agentManager = new AgentRegistry()
