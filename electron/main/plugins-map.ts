/**
 * Pure validation + CLI-JSON mapping for the plugin / skill / MCP surface.
 *
 * Deliberately free of Electron and child_process imports so the security-critical
 * logic here (option-injection guards, redaction, count derivation) can be covered
 * by `npm test` without booting an app. `plugins.ts` owns the process spawning.
 *
 * Security rules (do not weaken):
 * - Args are discrete argv (no shell), but a value starting with '-' would be
 *   parsed by grok as a flag → every caller-supplied value goes through
 *   `assertCliToken` (option injection, SKILLS-PLUGINS-SPEC Gotcha #8).
 * - `mcp list`/`mcp doctor` can echo `-e KEY=value` env and `-H Authorization:`
 *   headers → everything returned across IPC is redacted first (Gotcha #3).
 * - Component counts/flags are derived from `components.*` arrays; the flat
 *   `skill_count`/`has_*` fields are unreliable for available entries (Gotcha #5).
 */

import { redactSecrets, redactValue } from './redact'
import type {
  MarketplaceSource,
  McpScope,
  McpServer,
  McpTransport,
  Plugin,
  PluginComponent,
  PluginComponents,
  PluginStatus
} from '../../shared/types'

// ── Validation ─────────────────────────────────────────────────────

const NAME_CHARSET = /^[A-Za-z0-9._@/-]+$/
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

export interface CliTokenOptions {
  /** Enforce the plugin / MCP-server name charset (rejects whitespace, newlines). */
  nameCharset?: boolean
  /**
   * Permit a leading '-'. Only ever set for values placed AFTER the literal `--`
   * separator, where grok can no longer read them as its own flags — the CLI's
   * own documented example is `grok mcp add postgres -- npx -y @scope/server`.
   */
  allowLeadingDash?: boolean
  maxLength?: number
}

/**
 * Validate a value that will be handed to the CLI as an argv element.
 * Throws on anything that could be read as an option or smuggle control chars.
 */
export function assertCliToken(value: unknown, name: string, options?: CliTokenOptions): string {
  if (typeof value !== 'string') throw new Error(`Invalid ${name}: expected a string`)
  const v = value.trim()
  if (!v) throw new Error(`Invalid ${name}: must not be empty`)
  if (v.length > (options?.maxLength ?? 512)) throw new Error(`Invalid ${name}: too long`)
  if (CONTROL_CHARS.test(v)) throw new Error(`Invalid ${name}: control characters are not allowed`)
  if (!options?.allowLeadingDash && v.startsWith('-')) {
    throw new Error(`Invalid ${name}: must not start with '-'`)
  }
  if (options?.nameCharset && !NAME_CHARSET.test(v)) {
    throw new Error(`Invalid ${name}: only letters, digits and . _ @ / - are allowed`)
  }
  return v
}

export function assertName(value: unknown, label: string): string {
  return assertCliToken(value, label, { nameCharset: true, maxLength: 200 })
}

export function assertTransport(value: unknown): McpTransport {
  if (value === 'stdio' || value === 'http' || value === 'sse') return value
  throw new Error('Invalid transport: expected stdio, http or sse')
}

export function assertScope(value: unknown): McpScope {
  if (value === 'user' || value === 'project') return value
  throw new Error('Invalid scope: expected user or project')
}

/** Inline array validation — no array validator exists in the codebase (Gotcha #8). */
export function assertServerArgs(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error('Invalid args: expected an array of strings')
  if (value.length > 64) throw new Error('Invalid args: too many entries')
  // Leading '-' is allowed here and only here: these land after the `--`
  // separator, so grok cannot interpret them as its own flags.
  return value.map((v, i) => assertCliToken(v, `args[${i}]`, { allowLeadingDash: true }))
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/
const HEADER_KEY = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/

export function assertEnvPairs(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid env: expected an object of KEY=value pairs')
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > 64) throw new Error('Invalid env: too many entries')
  const out: string[] = []
  for (const [key, raw] of entries) {
    if (!ENV_KEY.test(key)) throw new Error(`Invalid env key "${key}"`)
    if (typeof raw !== 'string') throw new Error(`Invalid env value for "${key}": expected a string`)
    if (CONTROL_CHARS.test(raw)) throw new Error(`Invalid env value for "${key}"`)
    if (raw.length > 4096) throw new Error(`Invalid env value for "${key}": too long`)
    out.push('-e', `${key}=${raw}`)
  }
  return out
}

export function assertHeaderPairs(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid headers: expected an object of name/value pairs')
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > 64) throw new Error('Invalid headers: too many entries')
  const out: string[] = []
  for (const [key, raw] of entries) {
    if (!HEADER_KEY.test(key)) throw new Error(`Invalid header name "${key}"`)
    if (typeof raw !== 'string') {
      throw new Error(`Invalid header value for "${key}": expected a string`)
    }
    if (CONTROL_CHARS.test(raw)) throw new Error(`Invalid header value for "${key}"`)
    if (raw.length > 4096) throw new Error(`Invalid header value for "${key}": too long`)
    out.push('-H', `${key}: ${raw}`)
  }
  return out
}

// ── CLI text helpers ───────────────────────────────────────────────

export function cliMessage(
  result: { code: number | null; stdout: string; stderr: string },
  fallback: string
): string {
  const text = redactSecrets(`${result.stdout}\n${result.stderr}`).trim()
  return text.slice(0, 600) || fallback
}

// ── Raw CLI shapes ─────────────────────────────────────────────────

interface RawComponent {
  name?: unknown
  description?: unknown
}

interface RawPlugin {
  status?: unknown
  name?: unknown
  version?: unknown
  description?: unknown
  marketplace?: unknown
  category?: unknown
  enabled?: unknown
  skill_count?: unknown
  has_hooks?: unknown
  has_agents?: unknown
  has_mcp?: unknown
  sha?: unknown
  commit?: unknown
  source_url?: unknown
  components?: unknown
}

export interface RawMarketplace {
  name?: unknown
  kind?: unknown
  source?: { url?: unknown; branch?: unknown }
  url?: unknown
  branch?: unknown
}

interface RawMcpServer {
  name?: unknown
  transport?: unknown
  type?: unknown
  scope?: unknown
  commandOrUrl?: unknown
  command?: unknown
  url?: unknown
  args?: unknown
  status?: unknown
  ok?: unknown
  detail?: unknown
  error?: unknown
  message?: unknown
}

/**
 * Every 0.2.111 list command returns a BARE ARRAY — the `{plugins:[]}` /
 * `{servers:[]}` / `{marketplaces:[]}` envelope branch below is unobserved and
 * kept only as forward-compat. `tests/live-cli.test.ts` pins the real contract,
 * so treat the envelope as a guess, not as evidence of a shape the CLI emits.
 *
 * Not usable for `plugin-index.json`, whose `plugins` is an object map keyed by
 * name — feeding it here returns `[]`. See `applyPinnedShas`.
 */
export function asList<T>(raw: unknown, key: string): T[] {
  if (Array.isArray(raw)) return raw as T[]
  if (raw && typeof raw === 'object') {
    const inner = (raw as Record<string, unknown>)[key]
    if (Array.isArray(inner)) return inner as T[]
  }
  return []
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

// ── Plugin mapping ─────────────────────────────────────────────────

function mapComponentList(raw: unknown): PluginComponent[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: PluginComponent[] = []
  for (const item of raw) {
    if (typeof item === 'string') {
      if (item.trim()) out.push({ name: item })
      continue
    }
    if (!item || typeof item !== 'object') continue
    const c = item as RawComponent
    const name = str(c.name)
    if (!name) continue
    out.push({ name, description: str(c.description) })
  }
  return out
}

function mapComponents(raw: unknown): PluginComponents | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  // 0.2.111 emits camelCase keys (`mcpServers`); the snake_case fallback is
  // unobserved and kept only as forward-compat.
  const components: PluginComponents = {
    skills: mapComponentList(r.skills),
    mcpServers: mapComponentList(r.mcpServers ?? r.mcp_servers),
    commands: mapComponentList(r.commands),
    agents: mapComponentList(r.agents),
    hooks: mapComponentList(r.hooks)
  }
  const anyPresent = Object.values(components).some((v) => Array.isArray(v))
  return anyPresent ? components : undefined
}

function mapStatus(raw: unknown, fallback: PluginStatus): PluginStatus {
  if (raw === 'available' || raw === 'installed' || raw === 'disabled') return raw
  if (raw === 'enabled') return 'installed'
  return fallback
}

export function mapPlugin(raw: RawPlugin, fallbackStatus: PluginStatus): Plugin | null {
  const name = str(raw.name)
  if (!name) return null

  const components = mapComponents(raw.components)
  const status = mapStatus(raw.status, fallbackStatus)

  // Derive from components.* — the flat summary fields lie for available
  // entries (skill_count:0 while components.skills is populated). Only fall
  // back to them when the CLI gave us no components block at all.
  const skills = components?.skills
  const skillCount = skills
    ? skills.length
    : typeof raw.skill_count === 'number'
      ? raw.skill_count
      : 0
  const hasHooks = components?.hooks ? components.hooks.length > 0 : raw.has_hooks === true
  const hasAgents = components?.agents ? components.agents.length > 0 : raw.has_agents === true
  const hasMcp = components?.mcpServers ? components.mcpServers.length > 0 : raw.has_mcp === true

  const enabled =
    typeof raw.enabled === 'boolean'
      ? raw.enabled
      : status === 'installed'
        ? true
        : status === 'disabled'
          ? false
          : undefined

  // The flat fields 0.2.111 actually emits are status/name/version/description/
  // marketplace/skill_count/has_*/components. `category`, `sha`, `commit` and
  // `source_url` are never present — they are read as forward-compat, and both
  // sha and sourceUrl are really filled in by plugins.ts from local state.
  return {
    name,
    version: typeof raw.version === 'string' ? raw.version : null,
    description: str(raw.description),
    marketplace: str(raw.marketplace),
    category: str(raw.category),
    status,
    enabled,
    skillCount,
    hasHooks,
    hasAgents,
    hasMcp,
    components,
    sha: str(raw.sha) ?? str(raw.commit),
    sourceUrl: str(raw.source_url)
  }
}

export function mapPlugins(raw: unknown, fallbackStatus: PluginStatus): Plugin[] {
  const out: Plugin[] = []
  for (const item of asList<RawPlugin>(raw, 'plugins')) {
    if (!item || typeof item !== 'object') continue
    const plugin = mapPlugin(item, fallbackStatus)
    if (plugin) out.push(plugin)
  }
  return out
}

// ── Marketplace cache: pinned commits ──────────────────────────────
//
// The catalog has no sha, so the pinned commit the trust modal must show
// (SKILLS-PLUGINS-SPEC §4.2) comes from the clone the CLI already wrote to disk:
// `~/.grok/marketplace-cache/<hash>/.grok-plugin/plugin-index.json`, shaped
// `{version, plugins: {<name>: {sha, version, components}}}`.
//
// `plugins.ts` reads the files; parsing and the clone → marketplace join live
// here so they stay unit tested. All of it is third-party JSON: bounded,
// validated, and dropped without a word when it does not fit.

/** One marketplace clone under ~/.grok/marketplace-cache, as read by plugins.ts. */
export interface RawMarketplaceCache {
  /** The clone's `remote.origin.url`, from `parseGitRemoteUrl`. */
  url?: string
  /** Parsed `.grok-plugin/plugin-index.json`. */
  index: unknown
}

/**
 * Git object ids are 40 hex (sha1) or 64 (sha256). Abbreviated ids, branch names
 * and anything longer are refused rather than displayed: the modal promises the
 * full pinned commit, and showing a value that is not one is worse than showing
 * none at all.
 */
const COMMIT_SHA = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/

const MAX_INDEX_ENTRIES = 2000
const MAX_GIT_CONFIG_LINES = 500
const MAX_URL_LENGTH = 2048

/**
 * `remote.origin.url` out of a clone's `.git/config`.
 *
 * Hand-parsed on purpose: this is a local file the CLI wrote, and spawning git
 * to read it would add a process launch and a second trust surface for nothing.
 */
export function parseGitRemoteUrl(configText: unknown): string | undefined {
  if (typeof configText !== 'string') return undefined
  let inOrigin = false
  for (const line of configText.split('\n', MAX_GIT_CONFIG_LINES)) {
    const text = line.trim()
    if (text.startsWith('[')) {
      inOrigin = /^\[remote\s+"origin"\]$/i.test(text)
      continue
    }
    if (!inOrigin) continue
    const match = /^url\s*=\s*(.+)$/i.exec(text)
    if (!match) continue
    const url = match[1].trim()
    if (url.length > MAX_URL_LENGTH || CONTROL_CHARS.test(url)) return undefined
    return url || undefined
  }
  return undefined
}

/**
 * Compare git URLs written with and without `.git` / a trailing slash. Case is
 * kept significant — merging two URLs that differ only in case could attach one
 * marketplace's commit to another's plugin, and "no sha" is the safe answer.
 */
function normalizeGitUrl(value: unknown): string | undefined {
  const url = str(value)
  if (!url) return undefined
  const trimmed = url.trim().replace(/\/+$/, '')
  return (trimmed.endsWith('.git') ? trimmed.slice(0, -4) : trimmed) || undefined
}

/** plugin name → pinned sha, from one `plugin-index.json`. Invalid entries are dropped. */
function mapPluginIndex(raw: unknown): Map<string, string> {
  const out = new Map<string, string>()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  // `plugins` is an OBJECT MAP keyed by plugin name here, not the array shape
  // the CLI returns — `asList` would yield [].
  const plugins = (raw as { plugins?: unknown }).plugins
  if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) return out

  for (const [name, entry] of Object.entries(plugins as Record<string, unknown>)) {
    if (out.size >= MAX_INDEX_ENTRIES) break
    if (!name || name.length > 200 || CONTROL_CHARS.test(name)) continue
    if (!entry || typeof entry !== 'object') continue
    const sha = str((entry as { sha?: unknown }).sha)?.trim()
    if (sha && COMMIT_SHA.test(sha)) out.set(name, sha)
  }
  return out
}

/**
 * Fill in `sha` on catalog entries from the marketplace clones on disk.
 *
 * Scoped per marketplace, never globally: the official catalogs ship a dozen
 * colliding names (`vercel`, `stripe`, `sentry`, …), so a name-only lookup would
 * label one marketplace's plugin with another's commit. The clone is matched to
 * a configured marketplace by remote URL — the cache directory is an opaque hash
 * and the clone's own `marketplace.json` name ("xai-official") does not match the
 * configured source name ("xAI Official").
 *
 * Best effort throughout: a clone with no index, no remote, or no matching
 * marketplace simply leaves `sha` undefined.
 */
export function applyPinnedShas(
  plugins: Plugin[],
  caches: readonly RawMarketplaceCache[],
  marketplaces: readonly MarketplaceSource[]
): void {
  const namesByUrl = new Map<string, string[]>()
  for (const marketplace of marketplaces) {
    const url = normalizeGitUrl(marketplace.url)
    if (!url || !marketplace.name) continue
    const names = namesByUrl.get(url)
    if (names) names.push(marketplace.name)
    else namesByUrl.set(url, [marketplace.name])
  }

  const shasByMarketplace = new Map<string, Map<string, string>>()
  for (const cache of caches) {
    const url = normalizeGitUrl(cache.url)
    if (!url) continue
    const names = namesByUrl.get(url)
    if (!names) continue
    const shas = mapPluginIndex(cache.index)
    if (!shas.size) continue
    // One clone can back several configured marketplaces pointing at it.
    for (const name of names) shasByMarketplace.set(name, shas)
  }
  if (!shasByMarketplace.size) return

  for (const plugin of plugins) {
    // A sha the CLI itself reported wins; today it never reports one.
    if (plugin.sha || !plugin.marketplace) continue
    plugin.sha = shasByMarketplace.get(plugin.marketplace)?.get(plugin.name)
  }
}

// ── MCP mapping ────────────────────────────────────────────────────

function mapMcpStatus(raw: RawMcpServer): McpServer['status'] {
  const s = raw.status
  if (s === 'ok' || s === 'error' || s === 'unknown') return s
  if (typeof s === 'string') {
    if (/^(ok|healthy|connected|success)/i.test(s)) return 'ok'
    if (/(error|fail|unreachable|timeout)/i.test(s)) return 'error'
  }
  if (typeof raw.ok === 'boolean') return raw.ok ? 'ok' : 'error'
  return undefined
}

function mapMcpServer(raw: RawMcpServer): McpServer | null {
  const name = str(raw.name)
  if (!name) return null
  const transport = raw.transport ?? raw.type
  const args = Array.isArray(raw.args)
    ? raw.args.filter((a): a is string => typeof a === 'string')
    : undefined
  return {
    name,
    transport: transport === 'http' || transport === 'sse' ? transport : 'stdio',
    scope: raw.scope === 'project' ? 'project' : 'user',
    commandOrUrl: str(raw.commandOrUrl) ?? str(raw.command) ?? str(raw.url),
    args,
    status: mapMcpStatus(raw),
    detail: str(raw.detail) ?? str(raw.error) ?? str(raw.message)
  }
}

/**
 * Map + redact. MCP config carries `-e` env values and `-H` auth headers, so
 * nothing leaves this module before passing through redactValue (Gotcha #3).
 * Server env/headers are dropped entirely — the UI never needs them back.
 */
export function mapMcpServers(raw: unknown): McpServer[] {
  const out: McpServer[] = []
  for (const item of asList<RawMcpServer>(raw, 'servers')) {
    if (!item || typeof item !== 'object') continue
    const server = mapMcpServer(item)
    if (server) out.push(server)
  }
  return redactValue(out) as McpServer[]
}
