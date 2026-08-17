/**
 * Argument validation for the IPC boundary.
 *
 * Everything here runs on renderer-supplied values, so these are load-bearing
 * security checks, not ergonomics. Pure by design — no Electron imports — so a
 * handler cannot accidentally depend on app state through a validator.
 */

import {
  NOTE_MAX_CHARS,
  PERMISSION_MODE_OPTIONS,
  REASONING_EFFORTS,
  type McpTransport,
  type PromptAttachment
} from '../../../shared/types'

export function assertString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Invalid ${name}: expected non-empty string`)
  }
  return value
}

export function assertOptionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new Error(`Invalid ${name}`)
  return value
}

/**
 * A project scratchpad on its way to the store.
 *
 * Deliberately looser than every other validator here, because this is the one
 * argument that is the user's own prose rather than something bound for a
 * command line or a path. Empty is legal and means "forget this note", and
 * newlines, tabs and any character somebody chose to type are left exactly as
 * written: this value reaches a `<textarea>` value and a JSON string and nothing
 * else. Stripping control characters the way the CLI validators do would silently
 * rewrite what the user typed, which is the FIX-R1 failure in store.ts.
 *
 * The length cap is the whole check, and it refuses rather than truncating.
 */
export function assertNoteText(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid ${name}: expected a string`)
  if (value.length > NOTE_MAX_CHARS) {
    throw new Error(`Invalid ${name}: longer than ${NOTE_MAX_CHARS} characters`)
  }
  return value
}

/**
 * A plain `{}` and nothing else.
 *
 * `typeof x === 'object'` is true of an array, of `null`, and of anything
 * carrying a prototype somebody chose. Every options object below starts here,
 * so that reading a field means reading it off an ordinary object.
 *
 * `Object.create(null)` is accepted: it has no prototype to inherit from, which
 * is the property being checked.
 */
export function assertPlainObject(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${name}: expected an object`)
  }
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(`Invalid ${name}: expected a plain object`)
  }
  return value as Record<string, unknown>
}

/**
 * Every key of `value` is one of `allowed`, and the object is plain.
 *
 * Rejecting rather than ignoring, because these objects are merged into things
 * that persist. A key nobody recognises is either a renderer that has moved on
 * or something that has no business being written, and quietly dropping it makes
 * both look identical from the outside.
 */
export function assertOnlyKeys(
  value: unknown,
  name: string,
  allowed: readonly string[]
): Record<string, unknown> {
  const obj = assertPlainObject(value, name)
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw new Error(`Invalid ${name}: unknown field ${key}`)
  }
  return obj
}

export function assertOptionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new Error(`Invalid ${name}: expected a boolean`)
  return value
}

/** One of a fixed set, compared by value. */
export function assertOneOf<T extends string>(
  value: unknown,
  name: string,
  allowed: readonly T[]
): T {
  const found = allowed.find((option) => option === value)
  if (found === undefined) {
    throw new Error(`Invalid ${name}: expected one of ${allowed.join(', ')}`)
  }
  return found
}

/**
 * The id the renderer sends back to answer a permission prompt.
 *
 * A number or a non-empty string, because the agent supplies whichever the
 * protocol gave it. Anything else cannot match a pending request and would fail
 * silently rather than loudly.
 */
export function assertRequestId(value: unknown, name: string): number | string {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) return value
  throw new Error(`Invalid ${name}: expected a number or a non-empty string`)
}

// ── Plugin / MCP argument validators ─────────────────────────────────
// Args reach the CLI as discrete argv (no shell), so shell injection is
// impossible — but a value starting with '-' would be parsed by grok as a
// flag (option injection), and control characters can smuggle newlines into
// config/headers. Both are rejected here, at the IPC boundary.
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/
const CLI_NAME_RE = /^[A-Za-z0-9._@/-]+$/
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
export const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/
const MCP_TRANSPORTS: McpTransport[] = ['stdio', 'http', 'sse']
export const PROJECT_SCOPE_UNSUPPORTED =
  'Project scope is not supported yet: the CLI helper has no validated project directory, ' +
  "so `-s project` would write into Gronk's own folder. Use the user scope."

/** Non-empty string that grok cannot mistake for a flag. */
export function assertCliToken(value: unknown, name: string): string {
  const v = assertString(value, name)
  if (v.startsWith('-')) throw new Error(`Invalid ${name}: must not start with '-'`)
  if (CONTROL_CHAR_RE.test(v)) {
    throw new Error(`Invalid ${name}: control characters are not allowed`)
  }
  if (v.length > 1024) throw new Error(`Invalid ${name}: too long`)
  return v
}

/** Plugin / MCP server name: CLI token restricted to a safe character set. */
export function assertCliName(value: unknown, name: string): string {
  const v = assertCliToken(value, name)
  if (!CLI_NAME_RE.test(v)) {
    throw new Error(`Invalid ${name}: only letters, digits and . _ @ / - are allowed`)
  }
  if (v.length > 200) throw new Error(`Invalid ${name}: too long`)
  return v
}

export function assertMcpTransport(value: unknown): McpTransport {
  const found = MCP_TRANSPORTS.find((t) => t === value)
  if (!found) throw new Error("Invalid transport: expected 'stdio', 'http' or 'sse'")
  return found
}

/**
 * Optional array of non-empty strings (MCP server argv). A leading '-' is
 * allowed here — these are the *server's* own flags and plugins.ts places
 * them after the `--` separator so grok cannot read them as its own.
 */
export function assertOptionalStringArray(value: unknown, name: string): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new Error(`Invalid ${name}: expected an array`)
  if (value.length > 64) throw new Error(`Invalid ${name}: too many entries`)
  const out: string[] = []
  for (let i = 0; i < value.length; i++) {
    const item: unknown = value[i]
    if (typeof item !== 'string' || !item.trim()) {
      throw new Error(`Invalid ${name}[${i}]: expected non-empty string`)
    }
    if (CONTROL_CHAR_RE.test(item)) {
      throw new Error(`Invalid ${name}[${i}]: control characters are not allowed`)
    }
    if (item.length > 2048) throw new Error(`Invalid ${name}[${i}]: too long`)
    out.push(item)
  }
  return out.length ? out : undefined
}

/**
 * Optional plain string->string record (MCP env / headers). Values may be
 * secrets, so they are never echoed back in error messages.
 */
/**
 * A settings patch, field by field.
 *
 * Built rather than forwarded: only the fields named here reach the store, and
 * each is checked for what it is rather than for being present. `model` and
 * `grokBinary` get the CLI treatment because both end up on a command line, and
 * an empty string is how the UI clears an override, so it is allowed through as
 * `''` rather than rejected as a non-empty string would be.
 *
 * `alwaysApprove` and `alwaysApproveAck` are booleans here and nothing more. The
 * rule about what they mean together lives in the store, which folds them
 * against the persisted acknowledgement; re-deriving it here would put that
 * decision in two places.
 */
export function assertSettingsPatch(value: unknown): Record<string, unknown> {
  const raw = assertOnlyKeys(value, 'settings', [
    'model',
    'reasoningEffort',
    'permissionMode',
    'alwaysApprove',
    'alwaysApproveAck',
    'grokBinary',
    'theme',
    'previewCommand'
  ])
  const out: Record<string, unknown> = {}
  if ('model' in raw) out.model = assertClearableCliName(raw.model, 'model')
  if ('reasoningEffort' in raw) {
    // Clearable like the model: empty means no `--reasoning-effort` flag at all, and
    // each model then uses its own default. A closed set otherwise, because the CLI
    // accepts any string for that flag without checking it.
    out.reasoningEffort =
      raw.reasoningEffort === undefined || raw.reasoningEffort === null || raw.reasoningEffort === ''
        ? ''
        : assertOneOf(raw.reasoningEffort, 'reasoningEffort', REASONING_EFFORTS)
  }
  if ('permissionMode' in raw) {
    out.permissionMode = assertOneOf(raw.permissionMode, 'permissionMode', PERMISSION_MODES)
  }
  if ('alwaysApprove' in raw) {
    out.alwaysApprove = assertOptionalBoolean(raw.alwaysApprove, 'alwaysApprove')
  }
  if ('alwaysApproveAck' in raw) {
    out.alwaysApproveAck = assertOptionalBoolean(raw.alwaysApproveAck, 'alwaysApproveAck')
  }
  if ('grokBinary' in raw) out.grokBinary = assertClearableCliToken(raw.grokBinary, 'grokBinary')
  if ('theme' in raw) out.theme = assertOneOf(raw.theme, 'theme', THEMES)
  if ('previewCommand' in raw) {
    out.previewCommand = assertClearablePlainText(raw.previewCommand, 'previewCommand', 512)
  }
  return out
}

const PERMISSION_MODES = PERMISSION_MODE_OPTIONS.map((o) => o.id)
const THEMES = ['dark', 'light', 'system'] as const

/** Empty clears the override; anything else must survive `assertCliName`. */
function assertClearableCliName(value: unknown, name: string): string {
  if (value === undefined || value === null || value === '') return ''
  return assertCliName(value, name)
}

/** Empty clears the override; a path may contain characters a name may not. */
function assertClearableCliToken(value: unknown, name: string): string {
  if (value === undefined || value === null || value === '') return ''
  return assertCliToken(value, name)
}

/**
 * Free text with a length cap and no control characters.
 *
 * The preview command is run through a shell by the preview pane, so it is the
 * user's own instruction to their own machine and is not narrowed further here.
 * What is refused is the shape that is never typed on purpose: embedded
 * newlines and other control characters.
 */
function assertClearablePlainText(value: unknown, name: string, max: number): string {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string') throw new Error(`Invalid ${name}: expected a string`)
  if (CONTROL_CHAR_RE.test(value)) {
    throw new Error(`Invalid ${name}: control characters are not allowed`)
  }
  if (value.length > max) throw new Error(`Invalid ${name}: too long`)
  return value
}

/**
 * Attachments on a prompt.
 *
 * The bytes and the paths here reach the agent and the transcript, so the array
 * has to be an array and each member has to be an object with the fields this
 * app puts on one. Extra keys are refused rather than dropped, for the same
 * reason as settings.
 */
export function assertOptionalAttachments(value: unknown, name: string): PromptAttachment[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error(`Invalid ${name}: expected an array`)
  if (value.length > 32) throw new Error(`Invalid ${name}: too many entries`)
  return value.map((item, i) => {
    const raw = assertOnlyKeys(item, `${name}[${i}]`, [
      'id',
      'kind',
      'name',
      'path',
      'data',
      'mimeType',
      'previewUrl'
    ])
    const out: PromptAttachment = {
      id: assertString(raw.id, `${name}[${i}].id`),
      kind: assertOneOf(raw.kind, `${name}[${i}].kind`, ATTACHMENT_KINDS),
      name: assertString(raw.name, `${name}[${i}].name`)
    }
    const path = assertOptionalString(raw.path, `${name}[${i}].path`)
    if (path !== undefined) out.path = path
    const data = assertOptionalString(raw.data, `${name}[${i}].data`)
    if (data !== undefined) out.data = data
    const mimeType = assertOptionalString(raw.mimeType, `${name}[${i}].mimeType`)
    if (mimeType !== undefined) out.mimeType = mimeType
    const previewUrl = assertOptionalString(raw.previewUrl, `${name}[${i}].previewUrl`)
    if (previewUrl !== undefined) out.previewUrl = previewUrl
    return out
  })
}

const ATTACHMENT_KINDS = ['file', 'image'] as const

/**
 * Options for the native file dialog.
 *
 * Rebuilt rather than forwarded: this object is handed to Electron, and the
 * dialog takes far more keys than the renderer has any reason to set.
 */
export function assertFileDialogOptions(
  value: unknown,
  name: string
): { title?: string; filters?: { name: string; extensions: string[] }[] } {
  if (value === undefined || value === null) return {}
  const raw = assertOnlyKeys(value, name, ['title', 'filters'])
  const out: { title?: string; filters?: { name: string; extensions: string[] }[] } = {}
  const title = assertOptionalString(raw.title, `${name}.title`)
  if (title !== undefined) out.title = title.slice(0, 200)
  if (raw.filters !== undefined && raw.filters !== null) {
    if (!Array.isArray(raw.filters)) throw new Error(`Invalid ${name}.filters: expected an array`)
    if (raw.filters.length > 20) throw new Error(`Invalid ${name}.filters: too many entries`)
    out.filters = raw.filters.map((item, i) => {
      const filter = assertOnlyKeys(item, `${name}.filters[${i}]`, ['name', 'extensions'])
      const extensions = assertOptionalStringArray(
        filter.extensions,
        `${name}.filters[${i}].extensions`
      )
      return {
        name: assertString(filter.name, `${name}.filters[${i}].name`).slice(0, 100),
        extensions: extensions ?? []
      }
    })
  }
  return out
}

export function assertOptionalStringRecord(
  value: unknown,
  name: string,
  keyPattern: RegExp
): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${name}: expected an object`)
  }
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(`Invalid ${name}: expected a plain object`)
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > 50) throw new Error(`Invalid ${name}: too many entries`)
  const out: Record<string, string> = {}
  for (const [key, raw] of entries) {
    if (!keyPattern.test(key)) throw new Error(`Invalid ${name} key: ${key}`)
    if (typeof raw !== 'string' || !raw) {
      throw new Error(`Invalid ${name} value for ${key}: expected non-empty string`)
    }
    if (CONTROL_CHAR_RE.test(raw)) {
      throw new Error(`Invalid ${name} value for ${key}: control characters are not allowed`)
    }
    if (raw.length > 4096) throw new Error(`Invalid ${name} value for ${key}: too long`)
    out[key] = raw
  }
  return Object.keys(out).length ? out : undefined
}
