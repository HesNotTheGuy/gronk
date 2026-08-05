/**
 * Argument validation for the IPC boundary.
 *
 * Everything here runs on renderer-supplied values, so these are load-bearing
 * security checks, not ergonomics. Pure by design — no Electron imports — so a
 * handler cannot accidentally depend on app state through a validator.
 */

import { NOTE_MAX_CHARS, type McpTransport } from '../../../shared/types'

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
