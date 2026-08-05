/**
 * Grok CLI plugin / skill / MCP wrapper (main process only).
 *
 * Every read path uses the CLI's own `--json` output — never scrape text.
 * Command shapes verified against grok 0.2.111.
 *
 * All validation, mapping and redaction lives in `plugins-map.ts` (pure, unit
 * tested). This module only decides which argv to spawn and with what budget.
 *
 * Security rules (do not weaken):
 * - Args are discrete argv (no shell), but a value starting with '-' would be
 *   parsed by grok as a flag → every caller-supplied value goes through
 *   `assertCliToken`. This is option injection: a plugin or server name is
 *   attacker-chosen text, and `--trust` in that position is a real escalation.
 * - `--trust` is passed ONLY when the caller explicitly says trust === true.
 *   Installing runs third-party hooks/MCP servers outside Gronk's fs jail.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { runGrokCli, runGrokJson } from './grok-cli'
import { grokHome } from './grok-home'
import { redactSecrets } from './redact'
import {
  applyPinnedShas,
  asList,
  assertCliToken,
  assertEnvPairs,
  assertHeaderPairs,
  assertName,
  assertScope,
  assertServerArgs,
  assertTransport,
  cliMessage,
  mapMcpServers,
  mapPlugins,
  str,
  type RawMarketplace,
  type RawMarketplaceCache,
  isInstallableSource,
  parseSkillFrontmatter
} from './plugins-map'
import type {
  McpActionResult,
  McpAddInput,
  McpScope,
  McpServer,
  MarketplaceSource,
  Plugin,
  PluginActionResult,
  InstalledSkill
} from '../../shared/types'

// ── Read paths ─────────────────────────────────────────────────────

export async function listInstalledPlugins(): Promise<Plugin[]> {
  return (await refreshInstalledPlugins()) ?? []
}

/**
 * The installed list, or null when the CLI's output could not be read.
 *
 * runGrokJson returns null for empty or unparseable stdout, and mapPlugins turns
 * that into [] — indistinguishable from "you have no plugins". After a
 * SUCCESSFUL install that emptied the Installed tab, so a working install looked
 * like it had wiped everything. Callers that report state to the UI need to tell
 * the two apart; callers that just want a list can keep using the wrapper above.
 */
async function refreshInstalledPlugins(): Promise<Plugin[] | null> {
  const raw = await runGrokJson<unknown>(['plugin', 'list', '--json'], { timeoutMs: 15_000 })
  if (raw === null) return null
  return mapPlugins(raw, 'installed')
}

/**
 * Shape a mutating command's result.
 *
 * The refresh is skipped entirely when the command failed — nothing changed, so
 * spending another CLI call to re-read an unchanged list only delays the error.
 * When it succeeds but the re-read cannot be parsed, `plugins` is omitted rather
 * than sent as [], which makes the renderer fall back to its own refresh instead
 * of rendering an empty tab.
 */
async function withRefreshedPlugins(
  ok: boolean,
  message: string
): Promise<PluginActionResult> {
  if (!ok) return { ok, message }
  const plugins = await refreshInstalledPlugins()
  return plugins ? { ok, message, plugins } : { ok, message }
}

export async function listMarketplaces(): Promise<MarketplaceSource[]> {
  const raw = await runGrokJson<unknown>(['plugin', 'marketplace', 'list', '--json'], {
    timeoutMs: 20_000
  })
  const out: MarketplaceSource[] = []
  for (const item of asList<RawMarketplace>(raw, 'marketplaces')) {
    if (!item || typeof item !== 'object') continue
    const name = str(item.name)
    if (!name) continue
    const branchRaw = item.source?.branch ?? item.branch
    out.push({
      name,
      kind: str(item.kind) ?? 'git',
      url: str(item.source?.url) ?? str(item.url),
      branch: typeof branchRaw === 'string' ? branchRaw : null
    })
  }
  return out
}

/**
 * Marketplace catalog. `--available` requires `--json` and syncs the marketplace
 * git caches, hence the 60s budget. A default timeout kills it mid-clone.
 */
export async function listAvailablePlugins(): Promise<Plugin[]> {
  const raw = await runGrokJson<unknown>(['plugin', 'list', '--available', '--json'], {
    timeoutMs: 60_000
  })
  const plugins = mapPlugins(raw, 'available')

  // The catalog names a marketplace but carries neither its URL nor the pinned
  // commit the trust modal has to show, so both are recovered from local state
  // the CLI already wrote. Best-effort: reads only, never fatal, never network.
  const marketplaces = await listMarketplaces()
  if (!marketplaces.length) return plugins

  const byName = new Map(marketplaces.map((m) => [m.name, m.url]))
  for (const plugin of plugins) {
    if (!plugin.sourceUrl && plugin.marketplace) {
      plugin.sourceUrl = byName.get(plugin.marketplace)
    }
  }
  // Runs last on purpose: this backfill can only name the marketplace repo,
  // while a pinned commit belongs to the plugin's own repo. Where the cache
  // knows both, its pair replaces the guess above so the trust modal's source
  // and commit describe one repository rather than two.
  applyPinnedShas(plugins, await readMarketplaceCaches(), marketplaces)
  return plugins
}

export async function listMcpServers(): Promise<McpServer[]> {
  const raw = await runGrokJson<unknown>(['mcp', 'list', '--json'], { timeoutMs: 15_000 })
  return mapMcpServers(raw)
}

/** `mcp doctor` actually dials the servers and spawns the stdio ones, so it
 *  needs a network budget rather than a local-command one. */
export async function mcpDoctor(name?: string): Promise<McpServer[]> {
  const args = ['mcp', 'doctor']
  if (name !== undefined && name !== null && name !== '') {
    args.push(assertName(name, 'server name'))
  }
  args.push('--json')
  const raw = await runGrokJson<unknown>(args, { timeoutMs: 120_000 })
  return mapMcpServers(raw)
}

// ── Marketplace cache: pinned commits ──────────────────────────────

/** Same resolution as auth.ts: GROK_HOME wins, else ~/.grok. */
/** Third-party files — bound what we are willing to read (observed catalogs run to ~160 KB). */
const MAX_CACHE_FILE_BYTES = 4_000_000
const MAX_CACHE_CLONES = 64

/**
 * The catalog files a clone can ship, all of them optional.
 *
 * Both layouts were read off a real cache and both declare pinned commits: the
 * Grok clone carries `.grok-plugin/plugin-index.json` (commits, keyed by plugin
 * name) alongside `.grok-plugin/marketplace.json` (each plugin's own repo URL
 * and commit), and the Claude clone carries `.claude-plugin/marketplace.json`
 * in that same array layout. `plugins-map.ts` decides what each one means.
 */
const CATALOG_FILES = [
  ['.grok-plugin', 'plugin-index.json'],
  ['.grok-plugin', 'marketplace.json'],
  ['.claude-plugin', 'marketplace.json']
] as const

/** Read a capped local file. Missing, oversized or unreadable all mean "no data". */
async function readCappedFile(file: string): Promise<string | null> {
  try {
    const stat = await fs.stat(file)
    if (!stat.isFile() || stat.size > MAX_CACHE_FILE_BYTES) return null
    return await fs.readFile(file, 'utf8')
  } catch {
    return null
  }
}

/**
 * The bytes of every marketplace clone under ~/.grok/marketplace-cache, each
 * paired with its `.git/config` so `applyPinnedShas` can tell the clones apart.
 *
 * Nothing is interpreted here on purpose: this is the readFile half, so the
 * parsing, validation and clone → marketplace join all stay in the pure module
 * where `npm test` can reach them without a filesystem.
 */
async function readMarketplaceCaches(): Promise<RawMarketplaceCache[]> {
  const root = path.join(grokHome(), 'marketplace-cache')
  // A missing directory just means no marketplace has ever been synced.
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])

  const caches: RawMarketplaceCache[] = []
  let scanned = 0
  for (const entry of entries) {
    if (scanned >= MAX_CACHE_CLONES) break
    if (!entry.isDirectory()) continue
    scanned++
    // `entry.name` is a single component straight from readdir, never a path.
    const clone = path.join(root, entry.name)

    const catalogs = await Promise.all(
      CATALOG_FILES.map((parts) => readCappedFile(path.join(clone, ...parts)))
    )
    if (!catalogs.some((text) => text !== null)) continue
    caches.push({
      gitConfig: await readCappedFile(path.join(clone, '.git', 'config')),
      catalogs
    })
  }
  return caches
}

// ── Mutating paths ─────────────────────────────────────────────────

/**
 * `trust` is the user's explicit, human-confirmed decision from Gronk's own
 * trust modal — never inferred, never remembered, never defaulted to true.
 * Without it the CLI wants its own TTY prompt, which a piped spawn cannot
 * answer, so the command fails instead of installing silently.
 */
export async function installPlugin(source: string, trust: boolean): Promise<PluginActionResult> {
  const src = assertCliToken(source, 'source')
  if (typeof trust !== 'boolean') throw new Error('Invalid trust flag')
  // The scheme gate lives HERE, not only where catalog URLs are read off disk:
  // a sourceUrl arriving inside the CLI's own JSON reached this command
  // unchecked, so a marketplace entry could name file://, ssh:// or
  // git@host:repo and have it installed.
  if (!isInstallableSource(src)) {
    throw new Error(
      `Invalid source: expected an https:// URL or an owner/repo name, got "${src.slice(0, 80)}"`
    )
  }

  const args = ['plugin', 'install', src]
  if (trust === true) args.push('--trust')

  const result = await runGrokCli(args, { timeoutMs: 180_000 })
  const ok = result.code === 0
  return withRefreshedPlugins(
    ok,
    cliMessage(result, ok ? `Installed ${src}` : `Could not install ${src}`)
  )
}

export async function enablePlugin(name: string): Promise<PluginActionResult> {
  return runPluginCommand(['plugin', 'enable', assertName(name, 'plugin name')], `Enabled ${name}`)
}

export async function disablePlugin(name: string): Promise<PluginActionResult> {
  return runPluginCommand(['plugin', 'disable', assertName(name, 'plugin name')], `Disabled ${name}`)
}

/** `--confirm` skips the interactive multi-plugin-repo prompt, which would
 *  otherwise block on stdin nothing is attached to and read as a hang. */
export async function uninstallPlugin(name: string): Promise<PluginActionResult> {
  return runPluginCommand(
    ['plugin', 'uninstall', assertName(name, 'plugin name'), '--confirm'],
    `Uninstalled ${name}`
  )
}

async function runPluginCommand(args: string[], okMessage: string): Promise<PluginActionResult> {
  const result = await runGrokCli(args, { timeoutMs: 60_000 })
  const ok = result.code === 0
  return withRefreshedPlugins(
    ok,
    cliMessage(result, ok ? okMessage : 'The Grok CLI reported a failure.')
  )
}

/**
 * Add (or update) an MCP server.
 *
 * MVP restriction: `-s project` writes ./.grok/config.toml relative to the spawn
 * cwd — Gronk's own directory, not the user's project — so project scope is
 * refused until a validated cwd is plumbed through. Writing config into the
 * wrong directory is silent, and it is the app's own directory.
 */
export async function addMcpServer(input: McpAddInput): Promise<McpActionResult> {
  if (!input || typeof input !== 'object') throw new Error('Invalid MCP server input')

  const name = assertName(input.name, 'server name')
  const transport = assertTransport(input.transport)
  const scope = assertScope(input.scope)
  if (scope === 'project') {
    throw new Error('Project scope is not supported yet — add MCP servers at user scope.')
  }

  const commandOrUrl = assertCliToken(input.commandOrUrl, 'command or URL')
  if ((transport === 'http' || transport === 'sse') && !/^https?:\/\//i.test(commandOrUrl)) {
    throw new Error('Invalid URL: http and sse transports require an http(s) URL')
  }

  const serverArgs = assertServerArgs(input.args)
  const envArgs = assertEnvPairs(input.env)
  const headerArgs = assertHeaderPairs(input.headers)

  // Command/URL and server args go after `--` so grok cannot read them as flags.
  const args = [
    'mcp',
    'add',
    name,
    '-t',
    transport,
    '-s',
    scope,
    ...envArgs,
    ...headerArgs,
    '--',
    commandOrUrl,
    ...serverArgs
  ]

  const result = await runGrokCli(args, { timeoutMs: 60_000 })
  const ok = result.code === 0
  return {
    ok,
    message: cliMessage(result, ok ? `Added MCP server ${name}` : `Could not add ${name}`),
    servers: await listMcpServers()
  }
}

export async function removeMcpServer(name: string, scope?: McpScope): Promise<McpActionResult> {
  const serverName = assertName(name, 'server name')
  const args = ['mcp', 'remove', serverName]
  if (scope !== undefined && scope !== null) {
    args.push('-s', assertScope(scope))
  }

  const result = await runGrokCli(args, { timeoutMs: 30_000 })
  const ok = result.code === 0
  return {
    ok,
    message: cliMessage(
      result,
      ok ? `Removed MCP server ${serverName}` : `Could not remove ${serverName}`
    ),
    servers: await listMcpServers()
  }
}

// ── Skills ─────────────────────────────────────────────────────────

/** Bound what a directory scan will look at; these are user-writable paths. */
const MAX_SKILLS = 400
const MAX_SKILL_FILE_BYTES = 1_000_000

/**
 * Every skill on this machine, from both places the CLI reads.
 *
 * A skill is a directory containing SKILL.md — that is the whole format, which
 * is why the identical folder works in ~/.claude/skills and ~/.grok/skills.
 * Nothing is installed or registered: dropping the folder in IS the install, so
 * listing the directories is the honest source of truth.
 *
 * Reads only. Unreadable or malformed entries are skipped rather than surfaced
 * as broken rows.
 */
export async function listSkills(): Promise<InstalledSkill[]> {
  const roots: Array<{ dir: string; source: InstalledSkill['source'] }> = [
    { dir: path.join(grokHome(), 'skills'), source: 'user' },
    { dir: path.join(grokHome(), 'bundled', 'skills'), source: 'bundled' }
  ]

  const out: InstalledSkill[] = []
  const seen = new Set<string>()
  for (const { dir, source } of roots) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (out.length >= MAX_SKILLS) return out
      if (!entry.isDirectory()) continue

      const file = path.join(dir, entry.name, 'SKILL.md')
      const stat = await fs.stat(file).catch(() => null)
      if (!stat?.isFile() || stat.size > MAX_SKILL_FILE_BYTES) continue

      const text = await fs.readFile(file, 'utf8').catch(() => null)
      const parsed = parseSkillFrontmatter(text)
      if (!parsed) continue

      // A user skill shadows a bundled one of the same name, which is the order
      // the roots are scanned in. Listing both would imply two are active.
      const key = parsed.name.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)

      out.push({
        name: parsed.name,
        description: parsed.description ? redactSecrets(parsed.description).slice(0, 400) : undefined,
        source,
        directory: entry.name
      })
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}
