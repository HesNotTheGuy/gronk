import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import type { PermissionDecision, ToolCallInfo } from '../../../shared/types'

export type JsonRpcId = string | number

export interface AcpInitializeResult {
  protocolVersion?: number
  agentCapabilities?: Record<string, unknown>
  authMethods?: unknown[]
  _meta?: Record<string, unknown>
}

export interface AcpSessionNewResult {
  sessionId: string
}

export interface PermissionOption {
  optionId: string
  name?: string
  kind?: string
}

type Pending = {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
}

/**
 * Minimal JSON-RPC 2.0 client over `grok agent stdio`.
 *
 * Critical: the agent also sends *requests* to us (permission, optional fs/terminal).
 * Those MUST get a response or the prompt turn freezes forever.
 */
export class GrokAcpClient extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null
  private rl: Interface | null = null
  private nextId = 1
  private pending = new Map<JsonRpcId, Pending>()
  private closed = false
  private debug = !!process.env.GROCKY_DEBUG

  constructor(
    private readonly grokBinary: string,
    private readonly args: string[] = ['agent', 'stdio']
  ) {
    super()
  }

  get pid(): number | undefined {
    return this.proc?.pid
  }

  get running(): boolean {
    return !!this.proc && !this.closed
  }

  start(env: NodeJS.ProcessEnv = process.env): void {
    if (this.proc) {
      throw new Error('ACP client already started')
    }

    this.closed = false
    this.proc = spawn(this.grokBinary, this.args, {
      env: {
        ...env,
        GROK_DISABLE_AUTOUPDATER: '1',
        // Surface more agent diagnostics on stderr when debugging
        ...(this.debug ? { RUST_LOG: env.RUST_LOG || 'info' } : {})
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })

    this.rl = createInterface({ input: this.proc.stdout })
    this.rl.on('line', (line) => this.onLine(line))

    this.proc.stderr.setEncoding('utf8')
    this.proc.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim()) this.emit('stderr', line)
      }
    })

    this.proc.on('error', (err) => {
      this.emit('error', err)
    })

    this.proc.on('exit', (code, signal) => {
      this.closed = true
      for (const [id, p] of this.pending) {
        p.reject(new Error(`Agent exited (code=${code}) before response ${id}`))
      }
      this.pending.clear()
      this.emit('exit', code, signal)
      this.proc = null
      this.rl?.close()
      this.rl = null
    })
  }

  async initialize(params?: {
    protocolVersion?: number
    clientInfo?: { name: string; version: string }
    clientCapabilities?: Record<string, unknown>
  }): Promise<AcpInitializeResult> {
    // Only advertise capabilities we actually implement.
    // Claiming fs/terminal without handlers freezes the agent on those requests.
    return this.request('initialize', {
      protocolVersion: params?.protocolVersion ?? 1,
      clientInfo: params?.clientInfo ?? { name: 'Grocky', version: '0.1.0' },
      clientCapabilities: params?.clientCapabilities ?? {
        // We handle session/request_permission in-app.
        // Do NOT claim fs/terminal unless implemented — that hangs tool turns.
      }
    }) as Promise<AcpInitializeResult>
  }

  async sessionNew(cwd: string, mcpServers: unknown[] = []): Promise<AcpSessionNewResult> {
    return this.request('session/new', {
      cwd,
      mcpServers
    }) as Promise<AcpSessionNewResult>
  }

  async sessionLoad(sessionId: string, cwd?: string): Promise<AcpSessionNewResult> {
    return this.request('session/load', {
      sessionId,
      ...(cwd ? { cwd } : {})
    }) as Promise<AcpSessionNewResult>
  }

  async sessionPrompt(
    sessionId: string,
    prompt: Array<{ type: string; text?: string; [k: string]: unknown }>
  ): Promise<unknown> {
    return this.request('session/prompt', { sessionId, prompt })
  }

  async sessionCancel(sessionId: string): Promise<unknown> {
    // cancel is often a notification; try request, ignore method errors
    try {
      return await this.request('session/cancel', { sessionId })
    } catch {
      this.write({
        jsonrpc: '2.0',
        method: 'session/cancel',
        params: { sessionId }
      })
      return null
    }
  }

  /** Reply to an agent→client request (permission, fs, etc.). */
  respondToRequest(requestId: JsonRpcId, result: unknown): void {
    this.write({ jsonrpc: '2.0', id: requestId, result })
  }

  respondError(requestId: JsonRpcId, code: number, message: string): void {
    this.write({
      jsonrpc: '2.0',
      id: requestId,
      error: { code, message }
    })
  }

  /**
   * Respond to session/request_permission using optionIds the agent offered.
   * Prefer matching by `kind` (allow_once / allow_always / reject_once).
   */
  respondPermission(
    requestId: JsonRpcId,
    decision: PermissionDecision,
    options: PermissionOption[] = []
  ): void {
    const kindMap: Record<PermissionDecision, string[]> = {
      'allow-once': ['allow_once', 'allow-once', 'allow'],
      'allow-always': ['allow_always', 'allow-always', 'allow_always'],
      'reject-once': ['reject_once', 'reject-once', 'reject', 'deny']
    }

    const wanted = kindMap[decision]
    let optionId: string | undefined

    for (const kind of wanted) {
      const byKind = options.find(
        (o) => (o.kind || '').toLowerCase().replace(/-/g, '_') === kind.replace(/-/g, '_')
      )
      if (byKind?.optionId) {
        optionId = byKind.optionId
        break
      }
    }

    if (!optionId) {
      // Fall back to common ids, then first option for allow decisions
      optionId =
        decision === 'allow-once'
          ? options.find((o) => /allow/i.test(o.optionId) && !/always/i.test(o.optionId))
              ?.optionId ||
            options[0]?.optionId ||
            'allow-once'
          : decision === 'allow-always'
            ? options.find((o) => /always/i.test(o.optionId))?.optionId ||
              options.find((o) => /allow/i.test(o.optionId))?.optionId ||
              'allow-always'
            : options.find((o) => /reject|deny/i.test(o.optionId))?.optionId || 'reject-once'
    }

    this.respondToRequest(requestId, {
      outcome: {
        outcome: 'selected',
        optionId
      }
    })
  }

  async dispose(): Promise<void> {
    if (!this.proc) return
    this.closed = true
    try {
      this.proc.stdin.end()
    } catch {
      /* ignore */
    }
    const proc = this.proc
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          proc.kill()
        } catch {
          /* ignore */
        }
        resolve()
      }, 2000)
      proc.once('exit', () => {
        clearTimeout(t)
        resolve()
      })
      try {
        proc.kill()
      } catch {
        clearTimeout(t)
        resolve()
      }
    })
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    if (!this.proc || this.closed) {
      return Promise.reject(new Error('ACP client not running'))
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  private write(msg: unknown): void {
    if (!this.proc?.stdin.writable) {
      throw new Error('ACP stdin not writable')
    }
    const line = JSON.stringify(msg)
    if (this.debug) {
      console.error('[acp →]', line.slice(0, 500))
    }
    this.proc.stdin.write(line + '\n')
  }

  private onLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return

    if (this.debug) {
      console.error('[acp ←]', trimmed.slice(0, 500))
    }

    let msg: {
      jsonrpc?: string
      id?: JsonRpcId
      method?: string
      params?: unknown
      result?: unknown
      error?: { code?: number; message?: string; data?: unknown }
    }

    try {
      msg = JSON.parse(trimmed)
    } catch {
      this.emit('stderr', `Non-JSON line from agent: ${trimmed.slice(0, 200)}`)
      return
    }

    // Response to one of our requests
    const isResponse =
      msg.id !== undefined &&
      !msg.method &&
      (Object.prototype.hasOwnProperty.call(msg, 'result') ||
        Object.prototype.hasOwnProperty.call(msg, 'error'))

    if (isResponse) {
      const pending = this.pending.get(msg.id as JsonRpcId)
      if (pending) {
        this.pending.delete(msg.id as JsonRpcId)
        if (msg.error) {
          pending.reject(
            new Error(msg.error.message || `RPC error ${msg.error.code ?? 'unknown'}`)
          )
        } else {
          pending.resolve(msg.result)
        }
      }
      return
    }

    // Agent → client request (MUST respond)
    if (msg.method && msg.id !== undefined) {
      this.emit('server-request', {
        id: msg.id,
        method: msg.method,
        params: msg.params
      })
      return
    }

    // Notification (no id)
    if (msg.method) {
      this.emit('notification', msg.method, msg.params)
    }
  }
}

/** Resolve the grok binary in a cross-platform way. */
export function resolveGrokBinary(override?: string): string | null {
  if (override && fs.existsSync(override)) {
    return override
  }

  const home = os.homedir()
  const isWin = process.platform === 'win32'
  const exe = isWin ? 'grok.exe' : 'grok'
  const candidates: string[] = []

  if (override) candidates.push(override)

  candidates.push(path.join(home, '.grok', 'bin', exe))

  if (process.platform === 'darwin') {
    candidates.push('/usr/local/bin/grok', '/opt/homebrew/bin/grok')
  } else if (process.platform === 'linux') {
    candidates.push('/usr/local/bin/grok', path.join(home, '.local', 'bin', 'grok'))
  }

  const pathEnv = process.env.PATH || process.env.Path || ''
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue
    candidates.push(path.join(dir, exe))
    if (isWin) candidates.push(path.join(dir, 'grok.cmd'), path.join(dir, 'grok.bat'))
  }

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c
    } catch {
      /* ignore */
    }
  }

  return null
}

export function parseToolCallFromUpdate(update: Record<string, unknown>): ToolCallInfo | null {
  const sessionUpdate = update.sessionUpdate as string | undefined
  if (sessionUpdate !== 'tool_call' && sessionUpdate !== 'tool_call_update') return null

  const toolCallId =
    (update.toolCallId as string) ||
    (update.tool_call_id as string) ||
    (update.id as string) ||
    `tool-${Date.now()}`

  return {
    toolCallId,
    title: (update.title as string) || (update.kind as string) || 'Tool',
    kind: update.kind as string | undefined,
    status: normalizeStatus(update.status),
    rawInput: update.rawInput ?? update.input ?? update.arguments,
    content: update.content ?? update.rawOutput ?? update.result ?? update.output,
    error: typeof update.error === 'string' ? update.error : undefined
  }
}

function normalizeStatus(status: unknown): ToolCallInfo['status'] {
  const s = String(status || 'in_progress').toLowerCase()
  if (s.includes('complete') || s === 'success' || s === 'done') return 'completed'
  if (s.includes('fail') || s === 'error') return 'failed'
  if (s.includes('cancel')) return 'cancelled'
  if (s.includes('pending')) return 'pending'
  return 'in_progress'
}
