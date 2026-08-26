import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { grokHome } from '../grok-home'
import os from 'node:os'
import fs from 'node:fs'
import {
  REASONING_EFFORTS,
  type AgentCommand,
  type ModelInfo,
  type PermissionDecision,
  type ReasoningEffort,
  type ReasoningEffortOption,
  type SessionUsage,
  type ToolCallInfo,
  type TurnUsage
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
  /** The method this request called, so a rejection can say what failed. */
  method?: string
  resolve: (value: unknown) => void
  reject: (err: Error) => void
}

/**
 * Minimal JSON-RPC 2.0 client over `grok agent stdio`.
 *
 * Critical: the agent also sends *requests* to us (permission, optional fs/terminal).
 * Those MUST get a response or the prompt turn freezes forever.
 */
/**
 * What to show a person when the agent rejects one of our calls.
 *
 * The agent's own `message` is often just the JSON-RPC name for the code — a -32603
 * arrives as the bare words "Internal error", which names neither the call that failed
 * nor anything to try. The method is the one piece of context that always exists, and
 * the code is worth keeping because it says whose fault it is: -32601 and -32602 are
 * Gronk sending something wrong, -32603 is the agent failing inside a call we made
 * correctly.
 */
/**
 * Read the id the agent actually settled on out of a `session/set_model` reply.
 *
 * The result is a serde-serialized Rust `Result` under `_meta.model`: `{"Ok": "grok-4.5"}`
 * on success, and the `Err` arm on refusal (the CLI has named failures for this call,
 * `MODEL_SWITCH_REBUILD_FAILED` and an agent-type mismatch among them). Both arms are
 * read rather than assuming success, because a switch that silently did nothing would
 * leave the picker claiming a model the conversation is not running.
 *
 * The id is taken from the reply rather than echoed back from the request for the same
 * reason: the agent resolves what it was given, and it is the one that knows.
 */
export function parseSetModelResult(
  result: unknown
): { ok: true; modelId: string } | { ok: false; message: string } {
  const meta = (result as { _meta?: unknown } | null | undefined)?._meta
  const model = (meta as { model?: unknown } | null | undefined)?.model
  if (model && typeof model === 'object') {
    const arm = model as { Ok?: unknown; Err?: unknown }
    if (typeof arm.Ok === 'string' && arm.Ok.trim()) return { ok: true, modelId: arm.Ok }
    if (arm.Err !== undefined) {
      const said =
        typeof arm.Err === 'string'
          ? arm.Err
          : typeof (arm.Err as { message?: unknown })?.message === 'string'
            ? String((arm.Err as { message?: unknown }).message)
            : ''
      return { ok: false, message: said.trim() || 'The agent refused the model switch.' }
    }
  }
  return { ok: false, message: 'The agent did not say which model it switched to.' }
}

/**
 * The model list out of `initialize._meta.modelState`, including what each model says
 * about reasoning effort.
 *
 * The levels are per-model and differ between them — grok-4.5 offers three, grok-4.6
 * offers four, `xhigh` being the new one — so a picker cannot hold a fixed list and has
 * to read this. Everything here is optional on purpose: an agent that says nothing about
 * effort leaves `supportsReasoningEffort` undefined, which reads as "we do not know"
 * rather than "this model has none", and the UI shows no picker instead of a wrong one.
 *
 * Ids are checked against the known set rather than trusted, because they end up as the
 * value of `--reasoning-effort`, which the CLI itself does not validate.
 */
export function parseModelState(meta: unknown): { models: ModelInfo[]; current?: string } {
  const state = (meta as { modelState?: unknown } | null | undefined)?.modelState as
    | { currentModelId?: string; availableModels?: unknown[] }
    | undefined
  const list = Array.isArray(state?.availableModels) ? state.availableModels : []

  const models: ModelInfo[] = []
  for (const raw of list) {
    const entry = (raw ?? {}) as Record<string, unknown>
    const id = String(entry.modelId || '')
    if (!id) continue
    const modelMeta = (entry._meta ?? {}) as Record<string, unknown>

    const efforts: ReasoningEffortOption[] = []
    const offered = Array.isArray(modelMeta.reasoningEfforts) ? modelMeta.reasoningEfforts : []
    for (const item of offered) {
      const option = (item ?? {}) as Record<string, unknown>
      const effortId = normalizeEffortId(option.id ?? option.value)
      // Deduped: 4.6 currently reports two entries flagged `default: true`, so a list
      // built straight from the payload can repeat a level.
      if (!effortId || efforts.some((e) => e.id === effortId)) continue
      efforts.push({
        id: effortId,
        label: typeof option.label === 'string' && option.label.trim() ? option.label : effortId,
        description: typeof option.description === 'string' ? option.description : undefined
      })
    }

    const contextTokens =
      typeof modelMeta.totalContextTokens === 'number' && modelMeta.totalContextTokens > 0
        ? modelMeta.totalContextTokens
        : undefined

    models.push({
      id,
      name: String(entry.name || id),
      description: typeof entry.description === 'string' ? entry.description : undefined,
      isDefault: id === state?.currentModelId,
      ...(typeof modelMeta.supportsReasoningEffort === 'boolean'
        ? { supportsReasoningEffort: modelMeta.supportsReasoningEffort }
        : {}),
      ...(efforts.length ? { reasoningEfforts: efforts } : {}),
      ...(normalizeEffortId(modelMeta.reasoningEffort)
        ? { defaultReasoningEffort: normalizeEffortId(modelMeta.reasoningEffort) }
        : {}),
      ...(contextTokens ? { contextTokens } : {})
    })
  }

  return { models, current: state?.currentModelId || undefined }
}

function normalizeEffortId(value: unknown): ReasoningEffort | undefined {
  return typeof value === 'string' && (REASONING_EFFORTS as readonly string[]).includes(value)
    ? (value as ReasoningEffort)
    : undefined
}

/**
 * Slash commands out of `initialize._meta.availableCommands`.
 *
 * Validated because they come from the agent and end up rendered in the composer's
 * completion menu and echoed back as prompt text: a name is kept only when it looks
 * like a command name, and free-text fields are length-capped. Unknown extra fields
 * are dropped, not carried.
 */
const COMMAND_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i
const MAX_COMMANDS = 64

export function parseAvailableCommands(meta: unknown): AgentCommand[] {
  const raw = (meta as { availableCommands?: unknown } | null | undefined)?.availableCommands
  if (!Array.isArray(raw)) return []
  const out: AgentCommand[] = []
  for (const item of raw) {
    if (out.length >= MAX_COMMANDS) break
    const entry = (item ?? {}) as Record<string, unknown>
    const name = typeof entry.name === 'string' ? entry.name : ''
    if (!COMMAND_NAME_RE.test(name)) continue
    if (out.some((c) => c.name === name)) continue
    const input = (entry.input ?? {}) as Record<string, unknown>
    out.push({
      name,
      ...(typeof entry.description === 'string' && entry.description.trim()
        ? { description: entry.description.slice(0, 200) }
        : {}),
      ...(typeof input.hint === 'string' && input.hint.trim()
        ? { hint: input.hint.slice(0, 120) }
        : {})
    })
  }
  return out
}

/**
 * The CLI's rate-limit code, set only for an HTTP 429 (`RATE_LIMITED_ERROR_CODE`,
 * xai-org/grok-build). The one code whose meaning is documented rather than inferred,
 * which is why it is the only one this file is willing to translate into a sentence.
 */
const RATE_LIMITED = -32003

/**
 * Whatever the agent said beyond the code and the message, as plain text.
 *
 * `data` is a string on most refusals and an object on others, and the old check took
 * strings only. That silently dropped the single most useful sentence a person can get
 * out of a refusal: a real rate-limit reply carries the limit, the amount used and the
 * reset window in here, and the banner showed two words instead.
 *
 * Redacted on the way out. This is agent-supplied text heading for the screen, and an
 * error detail is exactly where an echoed `Authorization:` header ends up.
 */
export function errorDetailText(data: unknown): string {
  if (typeof data === 'string') return redactSecrets(data.trim())
  if (!data || typeof data !== 'object') return ''
  const bag = data as Record<string, unknown>
  // Named fields only, never a JSON dump of the whole object: the dump would be
  // unreadable in a banner and would carry every field the agent felt like attaching.
  for (const key of ['message', 'detail', 'description', 'error']) {
    const value = bag[key]
    if (typeof value === 'string' && value.trim()) return redactSecrets(value.trim())
  }
  return ''
}

export function rpcErrorMessage(
  method: string | undefined,
  error: { code?: number; message?: string; data?: unknown }
): string {
  const said = (error.message || '').trim()
  const generic = !said || /^(internal|server|parse) error$/i.test(said)
  const code = error.code !== undefined ? ` (${error.code})` : ''
  const where = method ? `The agent failed on ${method}` : 'The agent failed'
  const detailText = errorDetailText(error.data)
  const detail = detailText ? `: ${detailText}` : ''

  // The one refusal that is not a fault. "The agent failed on session/prompt (-32003):
  // Rate limited" describes a broken app to someone whose account simply ran out, names
  // a protocol method they have no reason to know exists, and buries the numbers that
  // say when they can work again. Nothing here guesses WHICH limit — the agent's own
  // detail says that when it sends one, and this says nothing about it when it does not.
  if (error.code === RATE_LIMITED) {
    const lead = 'Your Grok account has hit a usage limit.'
    return detailText
      ? `${lead} ${detailText}`
      : `${lead} Nothing about the app or the request caused it.`
  }

  if (generic) {
    // No reason given, and deliberately no guess at one.
    //
    // This used to suggest a spent plan quota, which was wrong. The CLI reports rate
    // limits on their own code — `RATE_LIMITED_ERROR_CODE = -32003`, set only for an HTTP
    // 429 — with its own user-facing copy, and it classifies -32603 as a server error
    // specifically NOT a rate limit (`stop_failure_error_type`, xai-org/grok-build). So a
    // quota block arrives clearly labelled, and pointing at quota here sent people to
    // check the one thing the CLI would already have told them about.
    //
    // What -32603 does mean is worth saying, because it decides whose problem it is: the
    // call was well-formed and the agent failed inside it. That is not something the user
    // can fix by changing what they typed.
    const hint =
      error.code === -32603
        ? ' It gave no reason. The request was well-formed, so this is a fault inside the agent rather than something to change here — worth retrying.'
        : '. It gave no reason.'
    return `${where}${code}${detail || hint}`
  }
  return `${where}${code}: ${said}${detail}`
}

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
      // Drop oversized ACP lines to avoid unbounded memory use.
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

  /**
   * Change the model on a session that is already running, conversation intact.
   *
   * The field is `modelId`. Sending `model` instead is rejected outright
   * (-32602, "missing field `modelId`"), so there is no forgiving alias to fall back on.
   */
  async sessionSetModel(sessionId: string, modelId: string): Promise<unknown> {
    return this.request('session/set_model', { sessionId, modelId })
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
      // Session batch is resolved to allow-once before this map is used; keep a
      // row so the type stays exhaustive if a caller forgets to fold.
      'allow-session': ['allow_once', 'allow-once', 'allow'],
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
      // Never fabricate allow ids or fall back to options[0].
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
      // The method travels with the request so a failure can name it. Without it the
      // renderer showed whatever the agent put in `message`, and for a JSON-RPC -32603
      // that is the literal words "Internal error" — a banner that tells the user
      // nothing about which call failed or where to look.
      this.pending.set(id, { resolve, reject, method })
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
          pending.reject(new Error(rpcErrorMessage(pending.method, msg.error)))
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
// and shell:true is unsafe here.
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

/**
 * Every absolute path worth trying, in order, before touching the disk.
 *
 * Pure so the mac and linux orderings can be tested from any machine, which
 * matters because nobody working on this has a mac and the paths that need to be
 * right are exactly the ones we cannot exercise.
 *
 * The absolute entries are not a convenience, they are the fix for a real report:
 * a macOS GUI app inherits launchd's PATH, not the shell's, so a CLI the user
 * just installed into /opt/homebrew/bin is invisible to a PATH scan even though
 * it is plainly on the disk. Anything a mac installer commonly writes to has to
 * be named here or it does not exist as far as Gronk is concerned.
 */
export function grokBinaryCandidates(opts: {
  platform: NodeJS.Platform
  home: string
  grokHomeDir: string
  pathEnv: string
  /** path.join / path.delimiter differ per platform; injected so tests can pin either. */
  join?: (...parts: string[]) => string
  delimiter?: string
}): string[] {
  const join = opts.join ?? path.join
  const delimiter = opts.delimiter ?? path.delimiter
  const exe = opts.platform === 'win32' ? 'grok.exe' : 'grok'
  const candidates: string[] = []

  // Same override as everywhere else: a relocated CLI install must be found
  // by the launcher too, not only by the readers of its state.
  candidates.push(join(opts.grokHomeDir, 'bin', exe))

  if (opts.platform === 'darwin') {
    candidates.push(
      // Homebrew on Apple Silicon, then Intel. Also where most installers and
      // `npm i -g` land when node itself came from Homebrew.
      '/opt/homebrew/bin/grok',
      '/usr/local/bin/grok',
      // MacPorts.
      '/opt/local/bin/grok',
      // Installer scripts and pipx-style layouts that avoid sudo.
      join(opts.home, '.local', 'bin', 'grok'),
      join(opts.home, 'bin', 'grok'),
      // Bun and pnpm keep their own global bins outside PATH for GUI apps.
      join(opts.home, '.bun', 'bin', 'grok'),
      join(opts.home, 'Library', 'pnpm', 'grok')
    )
  } else if (opts.platform === 'linux') {
    candidates.push(
      '/usr/local/bin/grok',
      join(opts.home, '.local', 'bin', 'grok'),
      join(opts.home, 'bin', 'grok'),
      join(opts.home, '.bun', 'bin', 'grok')
    )
  }

  for (const dir of opts.pathEnv.split(delimiter)) {
    if (!dir) continue
    candidates.push(join(dir, exe))
  }

  // Order is the contract: first match wins, and the absolute entries are ahead
  // of PATH on purpose so a GUI-launched app finds the same binary a terminal
  // would. Duplicates are dropped rather than probed twice.
  return [...new Set(candidates)]
}

/** Resolve the grok binary in a cross-platform way. */
export function resolveGrokBinary(override?: string): string | null {
  // Never return a non-grok basename override.
  if (override && fs.existsSync(override) && isAllowedGrokBasename(override)) {
    return override
  }

  const candidates = grokBinaryCandidates({
    platform: process.platform,
    home: os.homedir(),
    grokHomeDir: grokHome(),
    pathEnv: process.env.PATH || process.env.Path || ''
  })

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
