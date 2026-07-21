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
import { getSettings, upsertSession } from './store'
import type {
  ConnectionState,
  MainToRendererEvent,
  PermissionDecision,
  PermissionRequest
} from '../../shared/types'

interface PendingPermission {
  requestId: JsonRpcId
  options: PermissionOption[]
  toolCallId?: string
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

  async start(
    cwd: string,
    options?: { model?: string; alwaysApprove?: boolean }
  ): Promise<{ sessionId: string }> {
    await this.stop()

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
    this.alwaysApprove = options?.alwaysApprove ?? settings.alwaysApprove

    const agentArgs = ['agent']
    if (model) {
      agentArgs.push('-m', model)
    }
    if (this.alwaysApprove) {
      agentArgs.push('--always-approve')
    }
    agentArgs.push('stdio')

    this.setState('starting')
    this.cwd = cwd
    this.client = new GrokAcpClient(binary, agentArgs)

    this.client.on('stderr', (line) => {
      this.log('stderr', line)
      // Always forward severe-looking stderr as soft errors (non-fatal)
      if (/error|panic|fatal/i.test(line) && !/0 errors/i.test(line)) {
        // don't spam UI for every rust log; only store last
      }
    })

    this.client.on('error', (err) => {
      this.setState('error', err.message)
    })

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

    try {
      this.client.start()
      await this.client.initialize()
      const { sessionId } = await this.client.sessionNew(cwd)
      this.sessionId = sessionId
      this.setState('ready')
      this.emit({ type: 'session', sessionId, cwd })

      upsertSession({
        id: sessionId,
        cwd,
        title: path.basename(cwd),
        createdAt: Date.now(),
        updatedAt: Date.now()
      })

      return { sessionId }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.setState('error', message)
      await this.stop()
      throw err
    }
  }

  async loadSession(sessionId: string, cwd?: string): Promise<{ sessionId: string }> {
    if (!this.client || this.state !== 'ready') {
      if (!cwd) throw new Error('No active agent; provide a project folder first')
      await this.start(cwd)
    }
    if (!this.client) throw new Error('Agent not running')

    try {
      const result = await this.client.sessionLoad(sessionId, cwd ?? this.cwd ?? undefined)
      this.sessionId = result.sessionId || sessionId
      this.emit({
        type: 'session',
        sessionId: this.sessionId,
        cwd: this.cwd || cwd || ''
      })
      return { sessionId: this.sessionId }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.emit({ type: 'error', message: `Failed to load session: ${message}` })
      throw err
    }
  }

  async stop(): Promise<void> {
    this.setState('stopped')
    this.pendingPermission = null
    if (this.client) {
      await this.client.dispose()
      this.client = null
    }
    this.sessionId = null
    this.activeMessageId = null
    this.setState('idle')
  }

  async sendPrompt(text: string): Promise<{ messageId: string }> {
    if (!this.client || !this.sessionId || this.state !== 'ready') {
      throw new Error('Agent is not ready')
    }

    // Refresh always-approve from settings each prompt
    this.alwaysApprove = getSettings().alwaysApprove

    const messageId = randomUUID()
    this.activeMessageId = messageId

    void this.client
      .sessionPrompt(this.sessionId, [{ type: 'text', text }])
      .then((result) => {
        const stopReason =
          result && typeof result === 'object' && 'stopReason' in result
            ? String((result as { stopReason?: string }).stopReason)
            : undefined
        this.emit({
          type: 'message-done',
          sessionId: this.sessionId!,
          messageId,
          stopReason
        })
        this.activeMessageId = null
        this.pendingPermission = null

        if (this.sessionId && this.cwd) {
          upsertSession({
            id: this.sessionId,
            cwd: this.cwd,
            title: text.slice(0, 60),
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
        this.emit({
          type: 'message-done',
          sessionId: this.sessionId!,
          messageId,
          stopReason: 'error'
        })
        this.activeMessageId = null
        this.pendingPermission = null
      })

    return { messageId }
  }

  async cancelPrompt(): Promise<void> {
    if (!this.client || !this.sessionId) return

    // If a permission is outstanding, ACP requires a cancelled outcome
    if (this.pendingPermission && this.client) {
      this.client.respondToRequest(this.pendingPermission.requestId, {
        outcome: { outcome: 'cancelled' }
      })
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

    this.log('permission decision', decision, 'id', id, 'options', options)
    this.client.respondPermission(id, decision, options)
    this.pendingPermission = null
  }

  /**
   * Agent → client requests. Must always respond or the turn freezes.
   */
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

    // Optional FS methods — only if we ever advertise them; still handle to avoid hangs
    if (method === 'fs/read_text_file') {
      this.handleFsRead(id, p)
      return
    }
    if (method === 'fs/write_text_file') {
      this.handleFsWrite(id, p)
      return
    }

    // Unknown agent→client method: reject so the agent can recover instead of hanging
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
      (typeof toolCall.rawInput === 'string'
        ? toolCall.rawInput.slice(0, 80)
        : null) ||
      'Allow tool?'

    this.pendingPermission = {
      requestId: id,
      options,
      toolCallId
    }

    // Mark tool as waiting for auth in the UI
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

    // Auto-approve if user enabled the toggle (or agent was started with --always-approve)
    if (this.alwaysApprove || getSettings().alwaysApprove) {
      this.log('auto-approving permission', id)
      this.client?.respondPermission(id, 'allow-once', options)
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

    // Nested updates / vendor extensions
    if (method.startsWith('session/') || method.startsWith('x.ai/') || method.startsWith('_x.ai/')) {
      if (p.update || p.sessionUpdate) {
        this.handleSessionUpdate(p)
      }
    }
  }

  private handleSessionUpdate(params: Record<string, unknown>): void {
    const update = (params.update ?? params) as Record<string, unknown>
    const sessionId = (params.sessionId as string) || this.sessionId || ''
    const messageId = this.activeMessageId || randomUUID()
    if (!this.activeMessageId) this.activeMessageId = messageId

    const kind = (update.sessionUpdate as string) || ''

    if (kind === 'agent_message_chunk') {
      const content = update.content as { text?: string } | string | undefined
      const text =
        typeof content === 'string'
          ? content
          : content?.text || (update.text as string) || ''
      if (text) {
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
        this.emit({ type: 'thought-chunk', sessionId, messageId, text })
      }
      return
    }

    if (kind === 'tool_call') {
      const toolCall = parseToolCallFromUpdate(update)
      if (toolCall) {
        this.emit({ type: 'tool-call', sessionId, messageId, toolCall })
      }
      return
    }

    if (kind === 'tool_call_update') {
      const toolCall = parseToolCallFromUpdate(update)
      if (toolCall) {
        this.emit({
          type: 'tool-call-update',
          sessionId,
          messageId,
          toolCallId: toolCall.toolCallId,
          patch: toolCall
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
