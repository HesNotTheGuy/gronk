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
  //
  // The CLI is a source like any other: its sha goes through the same validator
  // as the cache's, so an unparseable value cannot reach the trust modal just
  // because it arrived on the trusted-looking path.
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
    sha: commitSha(raw.sha) ?? commitSha(raw.commit),
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
// The CLI catalog has no sha, so the pinned commit the trust modal must show
// (SKILLS-PLUGINS-SPEC §4.2) comes from the clones the CLI already wrote under
// `~/.grok/marketplace-cache/<hash>/`. Two catalog layouts were read off a real
// cache; both are handled, and neither is assumed to be present:
//
//   `.grok-plugin/plugin-index.json`   {version, plugins: {<name>: {sha, …}}}
//                                      `plugins` is an OBJECT MAP keyed by name.
//   `.grok-plugin/marketplace.json`    {name, …, plugins: [{name, source, …}]}
//   `.claude-plugin/marketplace.json`  {name, …, plugins: [{name, source, …}]}
//                                      `plugins` is an ARRAY; `source` is
//                                      polymorphic — see `readCatalogArray`.
//
// `plugins.ts` reads the bytes and nothing else; every parse, bound and join
// lives here so it stays unit tested. All of it is third-party JSON: bounded,
// validated, and dropped without a word when it does not fit.

/** The raw bytes of one marketplace clone, handed over by plugins.ts. */
export interface RawMarketplaceCache {
  /** Text of the clone's `.git/config`; null when it could not be read. */
  gitConfig: string | null
  /** Text of each catalog file looked for in the clone; null where absent. */
  catalogs: readonly (string | null)[]
}

/**
 * What one clone declares about a plugin.
 *
 * The commit and the repository it belongs to travel together on purpose: a sha
 * is only meaningful next to the repo it indexes, and `applyPinnedShas` refuses
 * to publish one without the other.
 */
interface PinnedEntry {
  sha?: string
  sourceUrl?: string
  /** Two catalogs in one clone contradicted each other — the entry is unusable. */
  conflicted?: boolean
}

/**
 * Git object ids are 40 hex (sha1) or 64 (sha256). Abbreviated ids, branch names
 * and anything longer are refused rather than displayed: the modal promises the
 * full pinned commit, and showing a value that is not one is worse than showing
 * none at all.
 *
 * Every candidate reaches `Plugin.sha` through here, whatever claimed to produce
 * it — the CLI's own output included.
 */
const COMMIT_SHA = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/

export function commitSha(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const sha = value.trim()
  // Length is checked before the pattern so a megabyte of "a" is rejected by a
  // comparison rather than by a scan.
  if (sha.length !== 40 && sha.length !== 64) return undefined
  return COMMIT_SHA.test(sha) ? sha : undefined
}

const MAX_CATALOG_ENTRIES = 2000
const MAX_PLUGIN_NAME_LENGTH = 200
const MAX_GIT_CONFIG_LINES = 500
const MAX_URL_LENGTH = 2048

/**
 * A repository URL taken out of a catalog.
 *
 * The accepted value is displayed as the install source and can be handed to
 * `grok plugin install`, so only the scheme the observed catalogs actually use
 * is allowed: an `ssh://`, `file://` or scp-style remote would be a different
 * and unaudited install path arriving from third-party JSON.
 */
export function catalogRepoUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const url = value.trim()
  if (!url || url.length > MAX_URL_LENGTH || CONTROL_CHARS.test(url)) return undefined
  return /^https:\/\/[^/\s]/i.test(url) ? url : undefined
}

export interface GitRemote {
  /** `remote.origin.url`. */
  url?: string
  /** The single branch this clone tracks, from origin's fetch refspec. */
  branch?: string
}

const BRANCH_NAME = /^[A-Za-z0-9._/-]{1,200}$/

/**
 * The origin remote out of a clone's `.git/config`.
 *
 * Hand-parsed on purpose: this is a local file the CLI wrote, and spawning git
 * to read it would add a process launch and a second trust surface for nothing.
 *
 * The branch comes from the fetch refspec (`+refs/heads/main:…`) rather than from
 * HEAD: the caches read off disk held a raw object id in HEAD, which names no
 * branch. A wildcard refspec identifies no single branch and yields undefined.
 */
export function parseGitRemote(configText: unknown): GitRemote {
  if (typeof configText !== 'string') return {}
  const remote: GitRemote = {}
  let inOrigin = false
  for (const line of configText.split('\n', MAX_GIT_CONFIG_LINES)) {
    const text = line.trim()
    if (text.startsWith('[')) {
      inOrigin = /^\[remote\s+"origin"\]$/i.test(text)
      continue
    }
    if (!inOrigin) continue

    const url = /^url\s*=\s*(.+)$/i.exec(text)
    if (url && remote.url === undefined) {
      const value = url[1].trim()
      // A remote we cannot read cleanly makes the whole clone unidentifiable.
      if (!value || value.length > MAX_URL_LENGTH || CONTROL_CHARS.test(value)) return {}
      remote.url = value
      continue
    }

    const fetch = /^fetch\s*=\s*\+?refs\/heads\/([^:*\s]+):/i.exec(text)
    if (fetch && remote.branch === undefined) {
      const branch = fetch[1].trim()
      if (BRANCH_NAME.test(branch)) remote.branch = branch
    }
  }
  return remote
}

/** Just the remote URL — the shape most callers want. */
export function parseGitRemoteUrl(configText: unknown): string | undefined {
  return parseGitRemote(configText).url
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

function catalogName(value: unknown): string | undefined {
  const name = str(value)?.trim()
  if (!name || name.length > MAX_PLUGIN_NAME_LENGTH || CONTROL_CHARS.test(name)) return undefined
  return name
}

/**
 * `{plugins: {<name>: {sha}}}` — the `plugin-index.json` layout.
 *
 * It records a commit per plugin and names no repository at all, so entries from
 * here carry a sha and no URL. On their own that is not enough to display: see
 * `applyPinnedShas` for why the pair is required.
 */
function readCatalogMap(plugins: Record<string, unknown>): Map<string, PinnedEntry> {
  const out = new Map<string, PinnedEntry>()
  for (const [rawName, entry] of Object.entries(plugins)) {
    if (out.size >= MAX_CATALOG_ENTRIES) break
    const name = catalogName(rawName)
    if (!name || !entry || typeof entry !== 'object') continue
    const sha = commitSha((entry as { sha?: unknown }).sha)
    if (sha) out.set(name, { sha })
  }
  return out
}

/**
 * `{plugins: [{name, source}]}` — the `marketplace.json` layout, used by both
 * the `.grok-plugin` and `.claude-plugin` directories.
 *
 * `source` is polymorphic. All three object forms below were read off a real
 * cache, along with a plain-string form:
 *
 * - `{source: 'url' | 'git-subdir', url, sha, path?, ref?}` — the sha pins the
 *   PLUGIN'S OWN repository, the one `url` names. Both are taken together so the
 *   trust modal never shows a commit beside some other repo's URL.
 * - `{source: 'github', repo, commit, sha}` — names no URL, and its `commit` and
 *   `sha` hold two DIFFERENT object ids. Nothing on disk says which of them an
 *   install checks out, so the entry is marked contradictory: another file in
 *   the same clone may name the repo, but it cannot resolve the two ids.
 * - `'./plugins/<name>'` — a subdirectory of the marketplace repo itself, so it
 *   has no commit of its own and the catalog declares none. The clone's current
 *   HEAD is only whatever was last fetched rather than a declared pin, so these
 *   are left unpinned.
 */
function readCatalogArray(plugins: readonly unknown[]): Map<string, PinnedEntry> {
  const out = new Map<string, PinnedEntry>()
  for (const item of plugins) {
    if (out.size >= MAX_CATALOG_ENTRIES) break
    if (!item || typeof item !== 'object') continue
    const name = catalogName((item as { name?: unknown }).name)
    if (!name) continue

    const source = (item as { source?: unknown }).source
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue
    const raw = source as { url?: unknown; sha?: unknown; commit?: unknown }

    const sha = commitSha(raw.sha)
    const alternate = commitSha(raw.commit)
    if (sha && alternate && sha.toLowerCase() !== alternate.toLowerCase()) {
      out.set(name, { conflicted: true })
      continue
    }

    const sourceUrl = catalogRepoUrl(raw.url)
    // A URL on its own is still worth keeping: a sibling catalog in this clone
    // may hold the commit it belongs to.
    if (sha || sourceUrl) out.set(name, { sha, sourceUrl })
  }
  return out
}

/** One catalog file's text → plugin name → what it declares. */
function readCatalog(text: unknown): Map<string, PinnedEntry> {
  if (typeof text !== 'string' || !text) return new Map()
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return new Map()
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return new Map()

  const plugins = (raw as { plugins?: unknown }).plugins
  if (Array.isArray(plugins)) return readCatalogArray(plugins)
  if (plugins && typeof plugins === 'object') {
    return readCatalogMap(plugins as Record<string, unknown>)
  }
  return new Map()
}

/**
 * Fold one catalog's entry into what the clone already declared.
 *
 * The layouts overlap — `plugin-index.json` supplies commits, `marketplace.json`
 * supplies the repository each commit belongs to — so they are merged per plugin
 * rather than one being preferred. Two files of the same clone naming different
 * commits (or different repos) for one plugin is a contradiction we cannot
 * resolve from disk, so the entry is burned instead of picked from.
 */
function mergeEntry(into: Map<string, PinnedEntry>, name: string, next: PinnedEntry): void {
  const prev = into.get(name)
  if (!prev) {
    into.set(name, { ...next })
    return
  }
  if (prev.conflicted) return
  if (next.conflicted) {
    prev.conflicted = true
    return
  }

  if (next.sha) {
    if (!prev.sha) prev.sha = next.sha
    else if (prev.sha.toLowerCase() !== next.sha.toLowerCase()) prev.conflicted = true
  }
  if (next.sourceUrl) {
    if (!prev.sourceUrl) prev.sourceUrl = next.sourceUrl
    else if (normalizeGitUrl(prev.sourceUrl) !== normalizeGitUrl(next.sourceUrl)) {
      prev.conflicted = true
    }
  }
}

interface ResolvedClone {
  branch?: string
  entries: Map<string, PinnedEntry>
}

function readClone(cache: RawMarketplaceCache): Map<string, PinnedEntry> {
  const merged = new Map<string, PinnedEntry>()
  for (const text of cache?.catalogs ?? []) {
    for (const [name, entry] of readCatalog(text)) {
      if (!merged.has(name) && merged.size >= MAX_CATALOG_ENTRIES) break
      mergeEntry(merged, name, entry)
    }
  }
  return merged
}

/**
 * Which clone backs a marketplace, when the remote URL alone does not say.
 *
 * `readdir` order is not evidence, so two clones of one URL that nothing tells
 * apart get no attribution at all rather than whichever the filesystem listed
 * last. The tracked branch is the only other discriminator on disk: a clone that
 * tracks a branch the marketplace does not use is the wrong checkout and is
 * dropped, while a clone whose branch could not be read is merely unproven and
 * stays in the running.
 */
function pickClone(
  clones: readonly ResolvedClone[],
  branch: string | null | undefined
): ResolvedClone | undefined {
  const declared = typeof branch === 'string' && branch.trim() ? branch.trim() : undefined
  const usable = declared
    ? clones.filter((c) => c.branch === undefined || c.branch === declared)
    : clones
  if (usable.length === 1) return usable[0]
  const exact = usable.filter((c) => c.branch !== undefined && c.branch === declared)
  return exact.length === 1 ? exact[0] : undefined
}

/** marketplace name → what its clone declares, or nothing when it is ambiguous. */
function resolveClones(
  caches: readonly RawMarketplaceCache[],
  marketplaces: readonly MarketplaceSource[]
): Map<string, Map<string, PinnedEntry>> {
  const clonesByUrl = new Map<string, ResolvedClone[]>()
  for (const cache of caches) {
    const remote = parseGitRemote(cache?.gitConfig)
    const url = normalizeGitUrl(remote.url)
    if (!url) continue
    const entries = readClone(cache)
    if (!entries.size) continue
    const clone: ResolvedClone = { branch: remote.branch, entries }
    const existing = clonesByUrl.get(url)
    if (existing) existing.push(clone)
    else clonesByUrl.set(url, [clone])
  }

  const out = new Map<string, Map<string, PinnedEntry>>()
  for (const marketplace of marketplaces) {
    const url = normalizeGitUrl(marketplace?.url)
    if (!url || !marketplace.name) continue
    const clones = clonesByUrl.get(url)
    if (!clones?.length) continue
    // One clone can back several configured marketplaces pointing at it.
    const clone = pickClone(clones, marketplace.branch)
    if (clone) out.set(marketplace.name, clone.entries)
  }
  return out
}

/**
 * Fill in `sha` — and the URL it pins — on catalog entries from the marketplace
 * clones on disk.
 *
 * Scoped per marketplace, never globally: the official catalogs ship a dozen
 * colliding names (`vercel`, `stripe`, `sentry`, …), so a name-only lookup would
 * label one marketplace's plugin with another's commit. The clone is matched to
 * a configured marketplace by remote URL — the cache directory is an opaque hash
 * and the clone's own `marketplace.json` name ("xai-official") does not match the
 * configured source name ("xAI Official").
 *
 * `sourceUrl` is overwritten deliberately. The catalog's sha pins the plugin's
 * own repository, while `listAvailablePlugins` backfills `sourceUrl` from the
 * MARKETPLACE repo; showing those two together reads as a commit the user could
 * look up in the repo above it, which they cannot. So the pair is published or
 * neither is: an entry whose repository the clone does not name stays unpinned.
 *
 * Best effort throughout: a clone with no catalog, no remote, no matching
 * marketplace or a contradictory one simply leaves `sha` undefined.
 */
export function applyPinnedShas(
  plugins: Plugin[],
  caches: readonly RawMarketplaceCache[],
  marketplaces: readonly MarketplaceSource[]
): void {
  const byMarketplace = resolveClones(caches, marketplaces)
  if (!byMarketplace.size) return

  for (const plugin of plugins) {
    if (!plugin.marketplace) continue
    const entry = byMarketplace.get(plugin.marketplace)?.get(plugin.name)
    if (!entry || entry.conflicted || !entry.sha || !entry.sourceUrl) continue
    // A validated sha the CLI itself reported wins (0.2.111 reports none). Its
    // repository is unknown, so its URL is left alone unless the clone names the
    // very same commit — pairing it with a different one is the mistake above.
    if (plugin.sha && plugin.sha.toLowerCase() !== entry.sha.toLowerCase()) continue
    plugin.sha = entry.sha
    plugin.sourceUrl = entry.sourceUrl
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
