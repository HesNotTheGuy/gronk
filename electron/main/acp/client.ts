import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import type {
  PermissionDecision,
  SessionUsage,
  ToolCallInfo,
  TurnUsage
} from '../../../shared/types'
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
  private debug = !!process.env.GRONK_DEBUG

  private readonly grokBinary: string
  private readonly args: string[]

  // Explicit field assignment rather than TS parameter properties: `node --test`
  // loads this module with strip-only type removal, which rejects `private x` in
  // a constructor signature. Keeping it plain is what makes the pure exports at
  // the bottom of this file unit-testable.
  constructor(grokBinary: string, args: string[] = ['agent', 'stdio']) {
    super()
    this.grokBinary = grokBinary
    this.args = args
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
          '[gronk] dropping oversized ACP line',
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
      clientInfo: params?.clientInfo ?? { name: 'Gronk', version: '0.1.0' },
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

/**
 * `Tool` is the CLI's placeholder title, not a real tool name. Both the parser and
 * the merge step must treat it as absent, otherwise a card renders as "TOOL".
 */
export function isGenericToolTitle(title?: string): boolean {
  return !title || title === 'Tool' || title === 'tool'
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
  // A literal "Tool" counts as no title: some updates send the placeholder at the top
  // level while the real identity sits in _meta, and taking it would show "TOOL" cards.
  const rawTitle = typeof update.title === 'string' ? update.title.trim() : ''
  const title =
    (!isGenericToolTitle(rawTitle) && rawTitle) ||
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
  return {
    toolCallId: next.toolCallId || prev.toolCallId,
    title: !isGenericToolTitle(next.title) ? next.title : prev.title,
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

// ── Usage / cost accounting ────────────────────────────────────────────────
/**
 * Nano-USD. The CLI reports cost as an integer `costUsdTicks`; every captured
 * sample resolves to a plausible sub-dollar amount at 1e9 ticks per USD. The
 * scale is a guess about a third-party field, so it lives behind one constant —
 * correcting it must be a one-line change, not a hunt through the UI.
 */
export const COST_USD_TICKS_PER_USD = 1_000_000_000

/**
 * Cap on remembered prompt ids. Dedup only has to defeat a repeat of the same
 * turn (a replay, or a re-delivered notification), which arrives close to the
 * original — so a bounded window is enough and a long session cannot grow this
 * set without limit.
 */
const MAX_TRACKED_PROMPT_IDS = 512

/** One `turn_completed` update, parsed. */
export interface TurnUsageUpdate {
  /**
   * `prompt_id` from the update. A turn's usage is a snapshot of that turn, not a
   * delta, so re-delivery of the same id must not be added twice.
   */
  promptId?: string
  stopReason?: string
  usage: TurnUsage
}

/** Third-party numbers: anything not a finite, non-negative number counts as absent. */
function finiteCount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  return value
}

/**
 * First readable alias wins. The CLI mixes conventions inside a single payload
 * (`prompt_id` beside `inputTokens`), so neither spelling can be assumed.
 */
function pickCount(source: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const v = finiteCount(source[key])
    if (v !== undefined) return v
  }
  return undefined
}

function pickString(source: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const v = source[key]
    if (typeof v === 'string' && v) return v
  }
  return undefined
}

/**
 * Zero ticks means "no cost reported", not "this turn was free" — rendering
 * $0.00 would state something the payload never said.
 */
function costFromTicks(source: Record<string, unknown>): number | undefined {
  const ticks = pickCount(source, 'costUsdTicks', 'cost_usd_ticks')
  if (!ticks) return undefined
  return ticks / COST_USD_TICKS_PER_USD
}

function parsePerModel(usage: Record<string, unknown>): TurnUsage['perModel'] | undefined {
  const raw = usage.modelUsage ?? usage.model_usage
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined

  const out: Record<string, { totalTokens: number; costUsd?: number }> = {}
  for (const [model, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!model || !value || typeof value !== 'object' || Array.isArray(value)) continue
    const entry = value as Record<string, unknown>
    const total =
      pickCount(entry, 'totalTokens', 'total_tokens') ??
      (pickCount(entry, 'inputTokens', 'input_tokens') ?? 0) +
        (pickCount(entry, 'outputTokens', 'output_tokens') ?? 0)
    const costUsd = costFromTicks(entry)
    out[model] = { totalTokens: total, ...(costUsd !== undefined ? { costUsd } : {}) }
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * Recognise the CLI's end-of-turn accounting update. Returns null for anything
 * else, including a `turn_completed` whose `usage` block is missing, not an
 * object, or carries no readable token count — accounting is secondary, so an
 * unparseable payload must degrade to "no data", never to zeros or NaN.
 */
export function parseTurnUsageFromUpdate(
  update: Record<string, unknown>
): TurnUsageUpdate | null {
  const kind = update.sessionUpdate ?? update.session_update
  if (kind !== 'turn_completed') return null

  const raw = update.usage
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const usage = raw as Record<string, unknown>

  const inputTokens = pickCount(usage, 'inputTokens', 'input_tokens')
  const outputTokens = pickCount(usage, 'outputTokens', 'output_tokens')
  const totalTokens = pickCount(usage, 'totalTokens', 'total_tokens')
  const cachedReadTokens = pickCount(
    usage,
    'cachedReadTokens',
    'cached_read_tokens',
    'cacheReadTokens'
  )
  const reasoningTokens = pickCount(usage, 'reasoningTokens', 'reasoning_tokens')

  // No token field at all means the shape changed or the block is a stub. Folding
  // a row of zeros in would inflate the turn count and claim data we do not have.
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined &&
    cachedReadTokens === undefined &&
    reasoningTokens === undefined
  ) {
    return null
  }

  const costUsd = costFromTicks(usage)
  const perModel = parsePerModel(usage)
  const promptId = pickString(update, 'prompt_id', 'promptId')
  const stopReason = pickString(update, 'stop_reason', 'stopReason')

  return {
    ...(promptId !== undefined ? { promptId } : {}),
    ...(stopReason !== undefined ? { stopReason } : {}),
    usage: {
      inputTokens: inputTokens ?? 0,
      outputTokens: outputTokens ?? 0,
      totalTokens: totalTokens ?? (inputTokens ?? 0) + (outputTokens ?? 0),
      cachedReadTokens: cachedReadTokens ?? 0,
      reasoningTokens: reasoningTokens ?? 0,
      modelCalls: pickCount(usage, 'modelCalls', 'model_calls') ?? 0,
      apiDurationMs: pickCount(usage, 'apiDurationMs', 'api_duration_ms') ?? 0,
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(perModel !== undefined ? { perModel } : {})
    }
  }
}

export function emptyTurnUsage(): TurnUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedReadTokens: 0,
    reasoningTokens: 0,
    modelCalls: 0,
    apiDurationMs: 0
  }
}

/**
 * Fold one turn into a running total. `costUsd` stays absent until some turn
 * actually reports a cost, so "no estimate available" never collapses into $0.
 */
export function addTurnUsage(total: TurnUsage, turn: TurnUsage): TurnUsage {
  const costUsd =
    total.costUsd === undefined && turn.costUsd === undefined
      ? undefined
      : (total.costUsd ?? 0) + (turn.costUsd ?? 0)

  const perModel =
    total.perModel || turn.perModel
      ? { ...(total.perModel ?? {}) }
      : undefined
  if (perModel && turn.perModel) {
    for (const [model, entry] of Object.entries(turn.perModel)) {
      const prev = perModel[model]
      const prevCost = prev?.costUsd
      const mergedCost =
        prevCost === undefined && entry.costUsd === undefined
          ? undefined
          : (prevCost ?? 0) + (entry.costUsd ?? 0)
      perModel[model] = {
        totalTokens: (prev?.totalTokens ?? 0) + entry.totalTokens,
        ...(mergedCost !== undefined ? { costUsd: mergedCost } : {})
      }
    }
  }

  return {
    inputTokens: total.inputTokens + turn.inputTokens,
    outputTokens: total.outputTokens + turn.outputTokens,
    totalTokens: total.totalTokens + turn.totalTokens,
    cachedReadTokens: total.cachedReadTokens + turn.cachedReadTokens,
    reasoningTokens: total.reasoningTokens + turn.reasoningTokens,
    modelCalls: total.modelCalls + turn.modelCalls,
    apiDurationMs: total.apiDurationMs + turn.apiDurationMs,
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(perModel !== undefined ? { perModel } : {})
  }
}

/**
 * Running per-session totals, folded from `turn_completed` updates.
 *
 * Kept here rather than inside AgentManager so it can be unit tested without an
 * Electron process, matching the pure helpers above.
 */
export class SessionUsageTracker {
  // Plain field assignment (no parameter properties) for the same reason as
  // GrokAcpClient: `node --test` strips types without transforming them.
  private sessionId: string | null = null
  private turns = 0
  private totals: TurnUsage = emptyTurnUsage()
  private last: TurnUsage | undefined = undefined
  private seenPromptIds = new Set<string>()

  /** Drop all totals. Pass a session id to start counting for that session. */
  reset(sessionId: string | null = null): void {
    this.sessionId = sessionId
    this.turns = 0
    this.totals = emptyTurnUsage()
    this.last = undefined
    this.seenPromptIds.clear()
  }

  /** Null until at least one turn has been counted — the UI shows nothing then. */
  snapshot(): SessionUsage | null {
    if (!this.sessionId || this.turns === 0) return null
    return {
      sessionId: this.sessionId,
      turns: this.turns,
      totals: this.totals,
      ...(this.last !== undefined ? { last: this.last } : {})
    }
  }

  /**
   * Fold a session update in. Returns the new snapshot when the totals changed,
   * and null when nothing did: not a usage update, unreadable usage, or a
   * `prompt_id` already counted. A different session id starts fresh.
   */
  add(sessionId: string, update: Record<string, unknown>): SessionUsage | null {
    if (!sessionId) return null
    const parsed = parseTurnUsageFromUpdate(update)
    if (!parsed) return null

    if (sessionId !== this.sessionId) this.reset(sessionId)

    if (parsed.promptId) {
      if (this.seenPromptIds.has(parsed.promptId)) return null
      this.seenPromptIds.add(parsed.promptId)
      if (this.seenPromptIds.size > MAX_TRACKED_PROMPT_IDS) {
        const oldest = this.seenPromptIds.values().next().value
        if (oldest !== undefined) this.seenPromptIds.delete(oldest)
      }
    }

    this.turns += 1
    this.totals = addTurnUsage(this.totals, parsed.usage)
    this.last = parsed.usage
    return this.snapshot()
  }
}
