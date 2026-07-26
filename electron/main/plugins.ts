/**
 * Grok CLI plugin / skill / MCP wrapper (main process only).
 *
 * Every read path uses the CLI's own `--json` output — never scrape text.
 * See SKILLS-PLUGINS-SPEC.md §1/§2; command shapes verified against grok 0.2.111.
 *
 * All validation, mapping and redaction lives in `plugins-map.ts` (pure, unit
 * tested). This module only decides which argv to spawn and with what budget.
 *
 * Security rules (do not weaken):
 * - Args are discrete argv (no shell), but a value starting with '-' would be
 *   parsed by grok as a flag → every caller-supplied value goes through
 *   `assertCliToken` (option injection, Gotcha #8).
 * - `--trust` is passed ONLY when the caller explicitly says trust === true.
 *   Installing runs third-party hooks/MCP servers outside Gronk's fs jail.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { runGrokCli, runGrokJson } from './grok-cli'
import { grokHome } from './grok-home'
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
  type RawMarketplaceCache
} from './plugins-map'
import type {
  McpActionResult,
  McpAddInput,
  McpScope,
  McpServer,
  MarketplaceSource,
  Plugin,
  PluginActionResult
} from '../../shared/types'

// ── Read paths ─────────────────────────────────────────────────────

export async function listInstalledPlugins(): Promise<Plugin[]> {
  const raw = await runGrokJson<unknown>(['plugin', 'list', '--json'], { timeoutMs: 15_000 })
  return mapPlugins(raw, 'installed')
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
 * git caches, hence the 60s budget (Gotcha #4).
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

/** `mcp doctor` actually dials the servers → network budget (Gotcha #4). */
export async function mcpDoctor(name?: string): Promise<McpServer[]> {
  const args = ['mcp', 'doctor']
  if (name !== undefined && name !== null && name !== '') {
    args.push(assertName(name, 'server name'))
  }
  args.push('--json')
  const raw = await runGrokJson<unknown>(args, { timeoutMs: 120_000 })
  return mapMcpServers(raw)
}

// ── Marketplace cache: pinned commits (spec §4.2) ──────────────────

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

  const args = ['plugin', 'install', src]
  if (trust === true) args.push('--trust')

  const result = await runGrokCli(args, { timeoutMs: 180_000 })
  const ok = result.code === 0
  return {
    ok,
    message: cliMessage(result, ok ? `Installed ${src}` : `Could not install ${src}`),
    plugins: await listInstalledPlugins()
  }
}

export async function enablePlugin(name: string): Promise<PluginActionResult> {
  return runPluginCommand(['plugin', 'enable', assertName(name, 'plugin name')], `Enabled ${name}`)
}

export async function disablePlugin(name: string): Promise<PluginActionResult> {
  return runPluginCommand(['plugin', 'disable', assertName(name, 'plugin name')], `Disabled ${name}`)
}

/** `--confirm` skips the interactive multi-plugin-repo prompt (Gotcha #6). */
export async function uninstallPlugin(name: string): Promise<PluginActionResult> {
  return runPluginCommand(
    ['plugin', 'uninstall', assertName(name, 'plugin name'), '--confirm'],
    `Uninstalled ${name}`
  )
}

async function runPluginCommand(args: string[], okMessage: string): Promise<PluginActionResult> {
  const result = await runGrokCli(args, { timeoutMs: 60_000 })
  const ok = result.code === 0
  return {
    ok,
    message: cliMessage(result, ok ? okMessage : 'The Grok CLI reported a failure.'),
    plugins: await listInstalledPlugins()
  }
}

/**
 * Add (or update) an MCP server.
 *
 * MVP restriction: `-s project` writes ./.grok/config.toml relative to the spawn
 * cwd — Gronk's own directory, not the user's project — so project scope is
 * refused until a validated cwd is plumbed through (spec §5 / Gotcha #2).
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
