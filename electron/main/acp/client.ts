import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import type { PermissionDecision, ToolCallInfo } from '../../../shared/types'
import { redactSecrets } from '../redact'

const MAX_ACP_LINE_BYTES = 8 * 1024 * 1024 // 8 MB

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
    this.rl.on('line', (line) => {
      // FIX-8: drop oversized ACP lines to avoid unbounded memory use
      if (line.length > MAX_ACP_LINE_BYTES) {
        console.error(
          '[grocky] dropping oversized ACP line',
          line.length,
          'bytes (max',
          MAX_ACP_LINE_BYTES,
          ')'
        )
        return
      }
      this.onLine(line)
    })

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

  async sessionNew(
    cwd: string,
    mcpServers: unknown[] = [],
    meta?: Record<string, unknown>
  ): Promise<AcpSessionNewResult> {
    return this.request('session/new', {
      cwd,
      mcpServers,
      ...(meta && Object.keys(meta).length ? { _meta: meta } : {})
    }) as Promise<AcpSessionNewResult>
  }

  /**
   * ACP LoadSessionRequest requires sessionId + absolute cwd + mcpServers.
   * Omitting mcpServers yields JSON-RPC "Invalid params" from the agent.
   */
  async sessionLoad(
    sessionId: string,
    cwd: string,
    mcpServers: unknown[] = []
  ): Promise<AcpSessionNewResult> {
    return this.request('session/load', {
      sessionId,
      cwd,
      mcpServers
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
      // FIX-9: never fabricate allow ids or fall back to options[0]
      if (decision === 'allow-once') {
        optionId = options.find(
          (o) => /allow/i.test(o.optionId) && !/always/i.test(o.optionId)
        )?.optionId
      } else if (decision === 'allow-always') {
        optionId =
          options.find((o) => /always/i.test(o.optionId))?.optionId ||
          options.find((o) => /allow/i.test(o.optionId))?.optionId
      } else {
        optionId = options.find((o) => /reject|deny/i.test(o.optionId))?.optionId
      }
    }

    if (!optionId) {
      // Fail closed: cancel rather than invent an allow
      this.respondToRequest(requestId, {
        outcome: { outcome: 'cancelled' }
      })
      return
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
      console.error('[acp →]', redactSecrets(line).slice(0, 500))
    }
    this.proc.stdin.write(line + '\n')
  }

  private onLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return

    if (this.debug) {
      console.error('[acp ←]', redactSecrets(trimmed).slice(0, 500))
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

// Real CLI is grok / grok.exe. Do not include .cmd/.bat — Node 20+ / Electron 36
// rejects spawn of batch files without shell:true (EINVAL, post-CVE-2024-27980),
// and shell:true is unsafe here (FIX-R4).
const ALLOWED_GROK_BASENAMES = new Set(['grok', 'grok.exe'])

/** Basename must look like the grok CLI (blocks cmd.exe / powershell overrides). */
export function isAllowedGrokBasename(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase()
  return ALLOWED_GROK_BASENAMES.has(base)
}

/**
 * Probe that an override binary answers like grok (`--version`).
 * Auto-detected PATH/~/.grok/bin paths skip this probe.
 */
export function probeGrokBinary(binary: string, timeoutMs = 4000): Promise<boolean> {
  return new Promise((resolve) => {
    if (!isAllowedGrokBasename(binary)) {
      resolve(false)
      return
    }
    try {
      const proc = spawn(binary, ['--version'], {
        windowsHide: true,
        env: { ...process.env, GROK_DISABLE_AUTOUPDATER: '1' }
      })
      let out = ''
      const timer = setTimeout(() => {
        try {
          proc.kill()
        } catch {
          /* ignore */
        }
        resolve(/grok/i.test(out) || proc.exitCode === 0)
      }, timeoutMs)
      proc.stdout?.setEncoding('utf8')
      proc.stdout?.on('data', (c: string) => {
        out += c
      })
      proc.stderr?.setEncoding('utf8')
      proc.stderr?.on('data', (c: string) => {
        out += c
      })
      proc.on('error', () => {
        clearTimeout(timer)
        resolve(false)
      })
      proc.on('close', (code) => {
        clearTimeout(timer)
        resolve(code === 0 || /grok/i.test(out))
      })
    } catch {
      resolve(false)
    }
  })
}

/** Resolve the grok binary in a cross-platform way. */
export function resolveGrokBinary(override?: string): string | null {
  // FIX-3: never return a non-grok basename override
  if (override && fs.existsSync(override) && isAllowedGrokBasename(override)) {
    return override
  }

  const home = os.homedir()
  const isWin = process.platform === 'win32'
  const exe = isWin ? 'grok.exe' : 'grok'
  const candidates: string[] = []

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
  }

  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && isAllowedGrokBasename(c)) return c
    } catch {
      /* ignore */
    }
  }

  return null
}

/** Grok surfaces the tool identity under `_meta["x.ai/tool"]` (name, kind, label). */
function xaiToolMeta(update: Record<string, unknown>): Record<string, unknown> | undefined {
  const meta = update._meta as Record<string, unknown> | undefined
  const t = meta?.['x.ai/tool'] ?? meta?.['xai/tool']
  return t && typeof t === 'object' ? (t as Record<string, unknown>) : undefined
}

export function parseToolCallFromUpdate(update: Record<string, unknown>): ToolCallInfo | null {
  const sessionUpdate = update.sessionUpdate as string | undefined
  if (sessionUpdate !== 'tool_call' && sessionUpdate !== 'tool_call_update') return null

  const meta = xaiToolMeta(update)
  const toolCallId =
    (update.toolCallId as string) ||
    (update.tool_call_id as string) ||
    (update.id as string) ||
    `tool-${Date.now()}`

  // Prefer an explicit title, then the tool's human label / snake-case name from _meta.
  const title =
    (typeof update.title === 'string' && update.title) ||
    (meta && typeof meta.label === 'string' && meta.label) ||
    (meta && typeof meta.name === 'string' && meta.name) ||
    'Tool'

  // Kind lives at the top level on some updates and in _meta on the initial call.
  const kind =
    (typeof update.kind === 'string' && update.kind) ||
    (meta && typeof meta.kind === 'string' && (meta.kind as string)) ||
    undefined

  return {
    toolCallId,
    title: title as string,
    kind: kind || undefined,
    status: normalizeStatus(update.status),
    rawInput: update.rawInput ?? update.input ?? update.arguments,
    content: update.content ?? update.rawOutput ?? update.result ?? update.output,
    error: typeof update.error === 'string' ? update.error : undefined
  }
}

/**
 * Merge a freshly-parsed tool-call update into prior state. Grok's late,
 * status-only updates carry no title/kind/rawInput; a plain spread would wipe the
 * good values captured from the initial `tool_call`, so preserve them here.
 */
export function mergeToolCall(prev: ToolCallInfo | undefined, next: ToolCallInfo): ToolCallInfo {
  if (!prev) return next
  const generic = (t?: string): boolean => !t || t === 'Tool' || t === 'tool'
  return {
    toolCallId: next.toolCallId || prev.toolCallId,
    title: !generic(next.title) ? next.title : prev.title,
    kind: next.kind || prev.kind,
    status: next.status || prev.status,
    rawInput: next.rawInput ?? prev.rawInput,
    content: next.content ?? prev.content,
    error: next.error ?? prev.error
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
