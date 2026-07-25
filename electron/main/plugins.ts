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
 *   Installing runs third-party hooks/MCP servers outside Grocky's fs jail.
 */

import { runGrokCli, runGrokJson } from './grok-cli'
import {
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
  type RawMarketplace
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

  // Best-effort: catalog entries carry a marketplace name but no URL, and the
  // trust modal wants to echo the source. Local config read, never fatal.
  const marketplaces = await listMarketplaces()
  if (marketplaces.length) {
    const byName = new Map(marketplaces.map((m) => [m.name, m.url]))
    for (const plugin of plugins) {
      if (!plugin.sourceUrl && plugin.marketplace) {
        plugin.sourceUrl = byName.get(plugin.marketplace)
      }
    }
  }
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

// ── Mutating paths ─────────────────────────────────────────────────

/**
 * `trust` is the user's explicit, human-confirmed decision from Grocky's own
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
 * cwd — Grocky's own directory, not the user's project — so project scope is
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
