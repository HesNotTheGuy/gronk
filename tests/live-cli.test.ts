/**
 * Live Grok CLI contract test — OPT-IN, READ-ONLY.
 *
 * Every other test in this repo asserts against hand-written mock JSON. Nothing
 * verifies that the real `grok` binary still emits the shapes `plugins-map.ts`
 * maps. If xAI renames a field, the app silently renders empty lists and the
 * whole suite stays green. This file closes that gap.
 *
 * How to run:
 *   npm test                       → these cases report as SKIPPED
 *   GRONK_LIVE_CLI=1 npm test     → they spawn the real CLI
 *   (PowerShell: $env:GRONK_LIVE_CLI = '1'; npm test)
 *   GRONK_GROK_BINARY=<path>      → optional explicit binary (must be grok/grok.exe)
 *
 * Rules this file must keep (they are why it is safe to run against a real account):
 * 1. Skipped unless GRONK_LIVE_CLI is truthy, and skipped — never failed — when
 *    no grok binary can be resolved. CI with no CLI and no auth stays green.
 * 2. READ-ONLY. `assertReadOnlyArgv` is a hard allowlist of four commands
 *    (`--version`, `plugin list --json`, `plugin marketplace list --json`,
 *    `mcp list --json`). Anything that installs, enables, disables, adds,
 *    removes, logs in/out, spends tokens, syncs git caches (`--available`), or
 *    dials servers (`mcp doctor`) is refused by construction — do not extend it.
 * 3. Contract assertions, not snapshots. A machine with zero plugins and zero MCP
 *    servers is a legitimate PASS; the assertions target shape and the mapper's
 *    assumptions so a RENAMED OR MISSING FIELD fails loudly.
 * 4. No secrets in output. `mcp list` echoes `-e KEY=value` env and
 *    `-H Authorization:` headers, so raw stdout never reaches an assertion
 *    message or a diagnostic — excerpts go through `redactSecrets` first, and the
 *    MCP case reports byte counts and key NAMES only.
 * 5. Every spawn is argv (never a shell string) and carries a timeout, so a hung
 *    CLI fails the test instead of hanging the run.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { resolveGrokBinary } from '../electron/main/acp/client'
import { redactSecrets } from '../electron/main/redact'
import { asList, mapMcpServers, mapPlugins, str } from '../electron/main/plugins-map'

// ── Opt-in gate ─────────────────────────────────────────────────────

const OPTED_IN = /^(1|true|yes|on)$/i.test((process.env.GRONK_LIVE_CLI ?? '').trim())

/** Only resolved when opted in — the PATH scan is pointless otherwise. */
const BINARY = OPTED_IN ? resolveGrokBinary(process.env.GRONK_GROK_BINARY) : null

const skip: string | false = !OPTED_IN
  ? 'set GRONK_LIVE_CLI=1 to run the live Grok CLI contract checks'
  : !BINARY
    ? 'no grok binary found (GRONK_GROK_BINARY / ~/.grok/bin / PATH) — nothing to verify'
    : false

/** Test-level budget must exceed the per-command timeouts below. */
const live: { skip: string | boolean; timeout: number } = { skip, timeout: 60_000 }

// ── Read-only allowlist (requirement 2) ─────────────────────────────

const VERSION = ['--version'] as const
const PLUGIN_LIST = ['plugin', 'list', '--json'] as const
const MARKETPLACE_LIST = ['plugin', 'marketplace', 'list', '--json'] as const
const MCP_LIST = ['mcp', 'list', '--json'] as const

const READ_ONLY_ARGV: readonly (readonly string[])[] = [
  VERSION,
  PLUGIN_LIST,
  MARKETPLACE_LIST,
  MCP_LIST
]

/**
 * Exact-match allowlist. Not a heuristic: the argv must be one of the four
 * commands above, token for token. Refusing by construction is what makes it
 * safe to point this suite at the developer's real machine and real account.
 */
function assertReadOnlyArgv(args: readonly string[]): readonly string[] {
  const allowed = READ_ONLY_ARGV.some(
    (candidate) => candidate.length === args.length && candidate.every((tok, i) => tok === args[i])
  )
  if (!allowed) {
    throw new Error(`Refusing to run a non-allowlisted grok command: grok ${args.join(' ')}`)
  }
  return args
}

// ── Spawn helper ────────────────────────────────────────────────────

interface CliRun {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

/**
 * Mirrors `runGrokCli` in electron/main/grok-cli.ts (argv array, no shell,
 * windowsHide, autoupdater off) without importing it — that module pulls in
 * `store.ts`, which needs a configured Electron stub.
 */
function spawnCli(args: readonly string[], timeoutMs: number): Promise<CliRun> {
  assertReadOnlyArgv(args)
  const binary = BINARY
  if (!binary) throw new Error('spawnCli called with no resolved grok binary')

  return new Promise<CliRun>((resolve) => {
    let settled = false
    let timedOut = false
    let stdout = ''
    let stderr = ''

    const proc = spawn(binary, [...args], {
      windowsHide: true,
      shell: false,
      env: { ...process.env, GROK_DISABLE_AUTOUPDATER: '1' }
    })

    const done = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    }

    const timer = setTimeout(() => {
      timedOut = true
      try {
        proc.kill()
      } catch {
        /* ignore */
      }
      done(proc.exitCode)
    }, timeoutMs)

    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    proc.stderr?.setEncoding('utf8')
    proc.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    proc.on('error', (err) => {
      stderr += `\nspawn error: ${err.message}`
      done(null)
    })
    proc.on('close', (code) => done(code))
  })
}

/** One spawn per command per run, however many cases read it. */
const runs = new Map<string, Promise<CliRun>>()

function cli(args: readonly string[], timeoutMs: number): Promise<CliRun> {
  const key = args.join('\u0000')
  let pending = runs.get(key)
  if (!pending) {
    pending = spawnCli(args, timeoutMs)
    runs.set(key, pending)
  }
  return pending
}

// ── Output handling (requirement 4) ─────────────────────────────────

/** The ONLY way CLI text may enter a message: redacted, collapsed, truncated. */
function excerpt(text: string, max = 160): string {
  return redactSecrets(text).replace(/\s+/g, ' ').trim().slice(0, max)
}

/** For `mcp list`, whose payload may hold secrets redactSecrets cannot spot. */
function bytes(text: string): string {
  return `${Buffer.byteLength(text, 'utf8')} bytes`
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function stringLeaves(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const item of value) stringLeaves(item, out)
  else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) stringLeaves(item, out)
  }
  return out
}

function assertOk(run: CliRun, label: string, quiet = false): void {
  assert.equal(run.timedOut, false, `${label}: timed out`)
  assert.equal(
    run.code,
    0,
    `${label}: exited ${run.code} — ${quiet ? bytes(run.stderr) + ' on stderr' : excerpt(run.stderr)}`
  )
}

function parseJson(run: CliRun, label: string, quiet = false): unknown {
  const text = run.stdout.trim()
  if (!text) {
    assert.fail(
      `${label}: expected JSON on stdout, got nothing (stderr: ${quiet ? bytes(run.stderr) : excerpt(run.stderr)})`
    )
  }
  try {
    return JSON.parse(text) as unknown
  } catch (err) {
    assert.fail(
      `${label}: stdout is not valid JSON (${(err as Error).message}) — ` +
        (quiet ? bytes(text) : `starts: ${excerpt(text, 120)}`)
    )
  }
}

/**
 * `asList(raw, key)` accepts a bare array or `{ [key]: [] }` and returns `[]`
 * for anything else — i.e. an envelope rename degrades to an empty UI with no
 * error anywhere. This is the assertion that catches that.
 */
function assertEnvelope(raw: unknown, key: string, label: string): void {
  if (Array.isArray(raw)) return
  const record = asRecord(raw)
  assert.ok(record, `${label}: expected an array or an object, got ${raw === null ? 'null' : typeof raw}`)
  assert.ok(
    Array.isArray(record[key]),
    `${label}: neither a bare array nor { "${key}": [...] } — asList() would silently return [] ` +
      `and the UI would show nothing. Top-level keys: ${Object.keys(record).join(', ') || '(none)'}`
  )
}

// ── Allowlist guard (runs even when the live suite is skipped) ───────

test('the live-CLI allowlist admits only read-only commands', () => {
  const mutating = [
    'install',
    'uninstall',
    'enable',
    'disable',
    'add',
    'remove',
    'update',
    'login',
    'logout',
    'agent',
    'doctor',
    '--available',
    '--trust'
  ]
  for (const argv of READ_ONLY_ARGV) {
    for (const token of argv) {
      assert.ok(
        !mutating.includes(token),
        `"${token}" mutates state, costs tokens or hits the network — it must never be in READ_ONLY_ARGV`
      )
    }
  }

  for (const forbidden of [
    ['plugin', 'install', 'xai-org/plugin-marketplace'],
    ['plugin', 'uninstall', 'demo', '--confirm'],
    ['plugin', 'enable', 'demo'],
    ['plugin', 'disable', 'demo'],
    ['plugin', 'list', '--available', '--json'],
    ['mcp', 'add', 'demo'],
    ['mcp', 'remove', 'demo'],
    ['mcp', 'doctor', '--json'],
    ['login'],
    ['logout'],
    ['agent', 'stdio']
  ]) {
    assert.throws(
      () => assertReadOnlyArgv(forbidden),
      /Refusing to run a non-allowlisted grok command/,
      `${forbidden.join(' ')} must be refused`
    )
  }

  for (const allowed of READ_ONLY_ARGV) {
    assert.doesNotThrow(() => assertReadOnlyArgv(allowed))
  }
})

// ── Live: the binary answers ────────────────────────────────────────

test('live: grok --version exits 0 and reports a version', live, async (t) => {
  const run = await cli(VERSION, 15_000)
  assertOk(run, 'grok --version')
  const text = `${run.stdout}\n${run.stderr}`.trim()
  assert.match(text, /\d+\.\d+\.\d+/, `grok --version printed no semver: ${excerpt(text)}`)
  t.diagnostic(`binary: ${BINARY}`)
  t.diagnostic(`version: ${excerpt(text, 80)}`)
})

// ── Live: plugin list --json ────────────────────────────────────────

const KNOWN_COMPONENT_KEYS = new Set([
  'skills',
  'mcpServers',
  'mcp_servers',
  'commands',
  'agents',
  'hooks'
])

/** Everything `RawPlugin` in plugins-map.ts reads. Unknown keys are reported. */
const KNOWN_PLUGIN_KEYS = new Set([
  'status',
  'name',
  'version',
  'description',
  'marketplace',
  'category',
  'enabled',
  'skill_count',
  'has_hooks',
  'has_agents',
  'has_mcp',
  'sha',
  'commit',
  'source_url',
  'components'
])

test('live: plugin list --json emits an envelope asList() understands', live, async (t) => {
  const run = await cli(PLUGIN_LIST, 20_000)
  assertOk(run, 'plugin list --json')
  const raw = parseJson(run, 'plugin list --json')
  assertEnvelope(raw, 'plugins', 'plugin list --json')

  const entries = asList<unknown>(raw, 'plugins')
  t.diagnostic(`installed plugins: ${entries.length} (zero is a legitimate pass)`)
  t.diagnostic(`top level: ${Array.isArray(raw) ? 'bare array' : 'object with "plugins"'}`)
})

test('live: every installed plugin entry survives mapPlugins()', live, async (t) => {
  const run = await cli(PLUGIN_LIST, 20_000)
  assertOk(run, 'plugin list --json')
  const raw = parseJson(run, 'plugin list --json')
  const entries = asList<unknown>(raw, 'plugins')

  if (!entries.length) {
    t.diagnostic('no plugins installed — shape of an entry could not be verified')
    return
  }

  const unknownKeys = new Set<string>()
  for (const [i, entry] of entries.entries()) {
    const record = asRecord(entry)
    assert.ok(record, `plugin list --json: entry ${i} is not an object`)

    // A rename of `name` would make mapPlugin() drop the entry outright.
    assert.equal(
      typeof record.name,
      'string',
      `plugin list --json: entry ${i} has no string "name" — mapPlugin() drops it. Keys: ${Object.keys(record).join(', ')}`
    )
    assert.ok(str(record.name), `plugin list --json: entry ${i} has an empty "name"`)

    if (record.status !== undefined && record.status !== null) {
      assert.ok(
        ['installed', 'available', 'disabled', 'enabled'].includes(String(record.status)),
        `plugin list --json: unexpected status "${excerpt(String(record.status), 40)}" — ` +
          'mapStatus() silently falls back and the card would show the wrong state'
      )
    }

    for (const key of Object.keys(record)) if (!KNOWN_PLUGIN_KEYS.has(key)) unknownKeys.add(key)
  }

  // Nothing may be dropped in translation.
  const mapped = mapPlugins(raw, 'installed')
  assert.equal(
    mapped.length,
    entries.length,
    `mapPlugins() returned ${mapped.length} of ${entries.length} entries — a load-bearing field was renamed`
  )
  for (const plugin of mapped) {
    assert.equal(typeof plugin.name, 'string')
    assert.ok(plugin.name.length > 0)
    assert.equal(typeof plugin.skillCount, 'number')
    assert.equal(typeof plugin.hasHooks, 'boolean')
    assert.equal(typeof plugin.hasAgents, 'boolean')
    assert.equal(typeof plugin.hasMcp, 'boolean')
    assert.ok(['installed', 'available', 'disabled'].includes(plugin.status))
  }

  if (unknownKeys.size) {
    t.diagnostic(`plugin keys plugins-map.ts does not read: ${[...unknownKeys].join(', ')}`)
  }
  t.diagnostic(`mapped ${mapped.length} plugin(s): ${mapped.map((p) => p.name).join(', ')}`)
})

test('live: plugin components use a key spelling the mapper accepts', live, async (t) => {
  const run = await cli(PLUGIN_LIST, 20_000)
  assertOk(run, 'plugin list --json')
  const entries = asList<unknown>(parseJson(run, 'plugin list --json'), 'plugins')

  const seenKeys = new Set<string>()
  let withComponents = 0

  for (const [i, entry] of entries.entries()) {
    const record = asRecord(entry)
    // An absent or null components block is legitimate — mapComponents() returns
    // undefined for both and the card falls back to the flat summary fields.
    if (!record || record.components === undefined || record.components === null) continue
    const components = asRecord(record.components)
    assert.ok(
      components,
      `plugin list --json: entry ${i} "components" is not an object — mapComponents() returns undefined`
    )
    withComponents += 1

    for (const [key, value] of Object.entries(components)) {
      seenKeys.add(key)
      // mapComponentList() ignores anything that is not an array.
      assert.ok(
        value === null || value === undefined || Array.isArray(value),
        `plugin list --json: components.${key} is ${typeof value}, expected an array`
      )
      // The one spelling that must not drift: mapComponents reads
      // `mcpServers ?? mcp_servers` and nothing else, so a third spelling
      // silently zeroes hasMcp and hides the riskiest component in the trust UI.
      if (/mcp/i.test(key)) {
        assert.ok(
          key === 'mcpServers' || key === 'mcp_servers',
          `plugin list --json: components."${key}" is a third MCP spelling — ` +
            'mapComponents() reads only mcpServers / mcp_servers, so hasMcp would be false'
        )
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          assert.ok(
            typeof item === 'string' || asRecord(item),
            `plugin list --json: components.${key} holds a ${typeof item}, expected string or object`
          )
          const itemRecord = asRecord(item)
          if (itemRecord) {
            assert.ok(
              str(itemRecord.name),
              `plugin list --json: a components.${key} entry has no "name" — mapComponentList() drops it`
            )
          }
        }
      }
    }
  }

  if (!withComponents) {
    t.diagnostic('no installed plugin carries a components block — spelling not observed')
    return
  }
  const mcpSpelling = [...seenKeys].filter((k) => /mcp/i.test(k))
  t.diagnostic(`components keys observed: ${[...seenKeys].join(', ')}`)
  t.diagnostic(`MCP key spelling actually emitted: ${mcpSpelling.join(', ') || '(none present)'}`)
  const unexpected = [...seenKeys].filter((k) => !KNOWN_COMPONENT_KEYS.has(k))
  if (unexpected.length) t.diagnostic(`component keys the mapper ignores: ${unexpected.join(', ')}`)
})

// ── Live: plugin marketplace list --json ────────────────────────────

test('live: plugin marketplace list --json matches listMarketplaces() assumptions', live, async (t) => {
  const run = await cli(MARKETPLACE_LIST, 20_000)
  assertOk(run, 'plugin marketplace list --json')
  const raw = parseJson(run, 'plugin marketplace list --json')
  assertEnvelope(raw, 'marketplaces', 'plugin marketplace list --json')

  const entries = asList<unknown>(raw, 'marketplaces')
  t.diagnostic(`top level: ${Array.isArray(raw) ? 'bare array' : 'object with "marketplaces"'}`)
  if (!entries.length) {
    t.diagnostic('no marketplace sources configured — shape not verified')
    return
  }

  const shapes: string[] = []
  for (const [i, entry] of entries.entries()) {
    const record = asRecord(entry)
    assert.ok(record, `marketplace list: entry ${i} is not an object`)
    assert.ok(
      str(record.name),
      `marketplace list: entry ${i} has no "name" — listMarketplaces() drops it. Keys: ${Object.keys(record).join(', ')}`
    )

    const source = asRecord(record.source)
    const url = str(source?.url) ?? str(record.url)
    const kind = str(record.kind)
    // Only remote sources must expose a URL; the trust modal echoes it verbatim.
    if (!kind || /git|http/i.test(kind)) {
      assert.ok(
        url,
        `marketplace list: "${str(record.name)}" (kind ${kind ?? 'unset'}) exposes no URL at ` +
          `source.url or url — the trust modal has nothing to echo. Keys: ${Object.keys(record).join(', ')}` +
          (source ? ` / source keys: ${Object.keys(source).join(', ')}` : '')
      )
    }

    const branchRaw = source?.branch ?? record.branch
    assert.ok(
      branchRaw === undefined || branchRaw === null || typeof branchRaw === 'string',
      `marketplace list: "${str(record.name)}" branch is ${typeof branchRaw}, expected string or null`
    )
    shapes.push(
      `${str(record.name)} [kind=${kind ?? 'unset'}, url via ${str(source?.url) ? 'source.url' : str(record.url) ? 'url' : 'none'}]`
    )
  }
  t.diagnostic(`marketplace sources: ${shapes.join(' | ')}`)
})

// ── Live: mcp list --json (secret-bearing — payload never printed) ──

/** Everything `RawMcpServer` in plugins-map.ts reads. */
const KNOWN_MCP_KEYS = new Set([
  'name',
  'transport',
  'type',
  'scope',
  'commandOrUrl',
  'command',
  'url',
  'args',
  'status',
  'ok',
  'detail',
  'error',
  'message'
])

/** The full `McpServer` contract — nothing else may cross IPC. */
const ALLOWED_SERVER_KEYS = new Set([
  'name',
  'transport',
  'scope',
  'commandOrUrl',
  'args',
  'status',
  'detail'
])

test('live: mcp list --json maps cleanly and leaks nothing', live, async (t) => {
  const run = await cli(MCP_LIST, 20_000)
  // quiet=true: this command echoes `-e KEY=value` env and `-H Authorization:`
  // headers, so failure messages report sizes and key names, never payload.
  assertOk(run, 'mcp list --json', true)
  const raw = parseJson(run, 'mcp list --json', true)
  assertEnvelope(raw, 'servers', 'mcp list --json')

  const entries = asList<unknown>(raw, 'servers')
  t.diagnostic(`configured MCP servers: ${entries.length} (zero is a legitimate pass)`)
  t.diagnostic(`top level: ${Array.isArray(raw) ? 'bare array' : 'object with "servers"'}`)

  const seenKeys = new Set<string>()
  for (const [i, entry] of entries.entries()) {
    const record = asRecord(entry)
    assert.ok(record, `mcp list --json: entry ${i} is not an object`)
    for (const key of Object.keys(record)) seenKeys.add(key)
    assert.equal(
      typeof record.name,
      'string',
      `mcp list --json: entry ${i} has no string "name" — mapMcpServer() drops it. Keys: ${Object.keys(record).join(', ')}`
    )
    assert.ok(str(record.name), `mcp list --json: entry ${i} has an empty "name"`)
    assert.ok(
      record.args === undefined || record.args === null || Array.isArray(record.args),
      `mcp list --json: entry ${i} "args" is ${typeof record.args}, expected an array`
    )
    // Transport and command both have two/three accepted spellings; losing them
    // means every server renders as a stdio server with no command shown. These
    // mirror the mapper's own lookups exactly.
    const transport = record.transport ?? record.type
    assert.ok(
      transport !== undefined && transport !== null,
      `mcp list --json: entry ${i} has neither "transport" nor "type" — everything falls back to stdio. Keys: ${Object.keys(record).join(', ')}`
    )
    assert.ok(
      str(record.commandOrUrl) ?? str(record.command) ?? str(record.url),
      `mcp list --json: entry ${i} has none of commandOrUrl/command/url. Keys: ${Object.keys(record).join(', ')}`
    )
  }

  const servers = mapMcpServers(raw)
  assert.equal(
    servers.length,
    Math.min(entries.length, 100),
    `mapMcpServers() returned ${servers.length} of ${entries.length} entries — a load-bearing field was renamed`
  )

  for (const server of servers) {
    assert.ok(['stdio', 'http', 'sse'].includes(server.transport))
    assert.ok(['user', 'project'].includes(server.scope))
    // The mapper must never hand env/headers back to the renderer, and must not
    // start passing through any other unreviewed field either.
    const record = server as unknown as Record<string, unknown>
    assert.equal('env' in record, false, 'mapMcpServers() must not return env values')
    assert.equal('headers' in record, false, 'mapMcpServers() must not return header values')
    for (const key of Object.keys(record)) {
      assert.ok(
        ALLOWED_SERVER_KEYS.has(key),
        `mapMcpServers() returned an unreviewed field "${key}" — only the McpServer contract ` +
          '(name, transport, scope, commandOrUrl, args, status, detail) may cross IPC'
      )
    }
  }

  // Redaction is idempotent, so anything the mapper returns that redactSecrets
  // would still change is a secret that survived (Gotcha #3).
  const leaves = stringLeaves(servers)
  for (const [i, leaf] of leaves.entries()) {
    assert.equal(
      leaf === redactSecrets(leaf),
      true,
      `mapMcpServers() returned a string leaf (#${i}) that redactSecrets() still rewrites — ` +
        'a secret is crossing IPC unredacted. Value withheld on purpose.'
    )
  }

  if (entries.length) {
    t.diagnostic(`mcp entry keys observed: ${[...seenKeys].join(', ')}`)
    const unexpected = [...seenKeys].filter((k) => !KNOWN_MCP_KEYS.has(k))
    if (unexpected.length) t.diagnostic(`mcp keys the mapper ignores: ${unexpected.join(', ')}`)
    t.diagnostic(`transports: ${servers.map((s) => s.transport).join(', ')}`)
    t.diagnostic(`raw payload: ${bytes(run.stdout)} (never printed)`)
  }
})
