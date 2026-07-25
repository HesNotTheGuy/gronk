import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyPinnedShas,
  assertCliToken,
  assertEnvPairs,
  assertHeaderPairs,
  assertName,
  assertScope,
  assertServerArgs,
  assertTransport,
  cliMessage,
  mapMcpServers,
  mapPlugin,
  mapPlugins,
  parseGitRemoteUrl
} from '../electron/main/plugins-map'

// ── Option injection (SKILLS-PLUGINS-SPEC Gotcha #8) ────────────────

test('assertCliToken rejects values that grok would read as flags', () => {
  for (const bad of ['--trust', '-t', '--permission-mode']) {
    assert.throws(() => assertCliToken(bad, 'source'), /must not start with/)
  }
})

test('assertCliToken rejects non-strings, empties and oversized values', () => {
  assert.throws(() => assertCliToken(undefined, 'x'), /expected a string/)
  assert.throws(() => assertCliToken(42, 'x'), /expected a string/)
  assert.throws(() => assertCliToken('   ', 'x'), /must not be empty/)
  assert.throws(() => assertCliToken('a'.repeat(513), 'x'), /too long/)
})

test('assertCliToken rejects smuggled control characters', () => {
  const withNewline = 'ok\nrm -rf /'
  assert.throws(() => assertCliToken(withNewline, 'x'), /control characters/)
  assert.throws(() => assertCliToken(`ok${String.fromCharCode(0)}`, 'x'), /control characters/)
  assert.throws(() => assertCliToken(`ok${String.fromCharCode(127)}`, 'x'), /control characters/)
})

test('assertCliToken trims and accepts normal sources', () => {
  assert.equal(assertCliToken('  https://github.com/xai-org/plugins  ', 'source'), 'https://github.com/xai-org/plugins')
})

test('assertName enforces the name charset', () => {
  assert.equal(assertName('my-server_1.0@scope/x', 'n'), 'my-server_1.0@scope/x')
  assert.throws(() => assertName('has space', 'n'), /only letters/)
  assert.throws(() => assertName('semi;colon', 'n'), /only letters/)
})

test('leading dash is allowed only for values placed after the -- separator', () => {
  assert.deepEqual(assertServerArgs(['-y', '@scope/server']), ['-y', '@scope/server'])
  assert.deepEqual(assertServerArgs(undefined), [])
  assert.throws(() => assertServerArgs('nope'), /expected an array/)
  assert.throws(() => assertServerArgs(new Array(65).fill('a')), /too many entries/)
})

test('assertTransport and assertScope reject anything unexpected', () => {
  assert.equal(assertTransport('sse'), 'sse')
  assert.throws(() => assertTransport('ws'), /expected stdio, http or sse/)
  assert.equal(assertScope('project'), 'project')
  assert.throws(() => assertScope('global'), /expected user or project/)
})

test('env and header pairs are emitted as discrete argv and validated', () => {
  assert.deepEqual(assertEnvPairs({ API_TOKEN: 'abc' }), ['-e', 'API_TOKEN=abc'])
  assert.deepEqual(assertHeaderPairs({ Authorization: 'Bearer abc' }), [
    '-H',
    'Authorization: Bearer abc'
  ])
  assert.throws(() => assertEnvPairs({ 'BAD KEY': 'v' }), /Invalid env key/)
  assert.throws(() => assertEnvPairs({ OK: 'a\nb' }), /Invalid env value/)
  assert.throws(() => assertHeaderPairs({ 'Bad Header': 'v' }), /Invalid header name/)
  assert.throws(() => assertHeaderPairs({ Ok: `v${String.fromCharCode(13)}` }), /Invalid header value/)
  assert.throws(() => assertEnvPairs(['A=1']), /expected an object/)
})

// ── Plugin mapping (Gotcha #5) ──────────────────────────────────────

test('counts come from components.*, not the lying flat fields', () => {
  const plugin = mapPlugin(
    {
      name: 'demo',
      status: 'available',
      skill_count: 0,
      has_hooks: true,
      has_mcp: true,
      components: {
        skills: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
        hooks: [],
        mcp_servers: []
      }
    },
    'available'
  )
  assert.ok(plugin)
  assert.equal(plugin.skillCount, 3, 'skill_count:0 must lose to components.skills')
  assert.equal(plugin.hasHooks, false, 'has_hooks:true must lose to an empty components.hooks')
  assert.equal(plugin.hasMcp, false)
})

test('flat fields are only a fallback when no components block exists', () => {
  const plugin = mapPlugin({ name: 'demo', skill_count: 4, has_agents: true }, 'installed')
  assert.ok(plugin)
  assert.equal(plugin.skillCount, 4)
  assert.equal(plugin.hasAgents, true)
  assert.equal(plugin.components, undefined)
})

test('status normalizes and drives the enabled flag', () => {
  assert.equal(mapPlugin({ name: 'a', status: 'enabled' }, 'available')?.status, 'installed')
  assert.equal(mapPlugin({ name: 'a', status: 'disabled' }, 'installed')?.enabled, false)
  assert.equal(mapPlugin({ name: 'a' }, 'installed')?.enabled, true)
  assert.equal(mapPlugin({ name: 'a' }, 'available')?.enabled, undefined)
  assert.equal(mapPlugin({ name: 'a', status: 'bogus' }, 'available')?.status, 'available')
})

test('nameless entries are dropped', () => {
  assert.equal(mapPlugin({ description: 'x' }, 'installed'), null)
  assert.equal(mapPlugins([{ name: 'ok' }, {}, null, 'junk'], 'installed').length, 1)
})

test('mapPlugins accepts both a bare array and a {plugins:[]} envelope', () => {
  assert.equal(mapPlugins([{ name: 'a' }], 'installed').length, 1)
  assert.equal(mapPlugins({ plugins: [{ name: 'a' }] }, 'installed').length, 1)
  assert.equal(mapPlugins(null, 'installed').length, 0)
  assert.equal(mapPlugins({ other: 1 }, 'installed').length, 0)
})

test('string component entries are accepted', () => {
  const plugin = mapPlugin({ name: 'a', components: { skills: ['one', '  ', 'two'] } }, 'installed')
  assert.deepEqual(plugin?.components?.skills, [{ name: 'one' }, { name: 'two' }])
})

// ── Pinned commits from the marketplace cache (spec §4.2) ───────────

const XAI_URL = 'https://github.com/xai-org/plugin-marketplace.git'
const CLAUDE_URL = 'https://github.com/anthropics/claude-plugins-official.git'
const MARKETPLACES = [
  { name: 'xAI Official', kind: 'git', url: XAI_URL, branch: null },
  { name: 'claude-plugins-official', kind: 'git', url: CLAUDE_URL, branch: null }
]
const VERCEL_SHA = '4f867228f69a48c4781ccf1bc5d2741af435cc97'

/** Both official catalogs ship a plugin called `vercel` — the collision is the point. */
function catalog() {
  return mapPlugins(
    [
      { name: 'vercel', marketplace: 'xAI Official' },
      { name: 'vercel', marketplace: 'claude-plugins-official' }
    ],
    'available'
  )
}

/** One clone of the xAI marketplace holding `index` as its plugin-index.json. */
function xaiCache(index: unknown) {
  return [{ url: XAI_URL, index }]
}

test('a pinned sha reaches the entry from that marketplace and no other', () => {
  const plugins = catalog()
  applyPinnedShas(
    plugins,
    xaiCache({ version: 1, plugins: { vercel: { sha: VERCEL_SHA, version: '0.45.1' } } }),
    MARKETPLACES
  )
  assert.equal(plugins[0].sha, VERCEL_SHA)
  assert.equal(plugins[1].sha, undefined, 'the same name elsewhere must not inherit the commit')
})

test('a clone is matched to its marketplace across a .git suffix', () => {
  const plugins = catalog()
  const index = { plugins: { vercel: { sha: VERCEL_SHA } } }
  applyPinnedShas(plugins, [{ url: XAI_URL.replace(/\.git$/, ''), index }], MARKETPLACES)
  assert.equal(plugins[0].sha, VERCEL_SHA)
})

test('a missing, unusable or unmatched cache leaves sha undefined without throwing', () => {
  const index = { plugins: { vercel: { sha: VERCEL_SHA } } }
  for (const caches of [
    [],
    xaiCache(null),
    xaiCache('not an object'),
    xaiCache({}),
    // The index keys plugins by name; the array shape asList handles is not it.
    xaiCache({ plugins: [{ name: 'vercel', sha: VERCEL_SHA }] }),
    xaiCache({ plugins: { vercel: 'nope' } }),
    xaiCache({ plugins: { vercel: {} } }),
    xaiCache({ plugins: { other: { sha: VERCEL_SHA } } }),
    [{ url: undefined, index }],
    [{ url: 'https://github.com/someone/unconfigured.git', index }]
  ]) {
    const plugins = catalog()
    applyPinnedShas(plugins, caches, MARKETPLACES)
    assert.equal(plugins[0].sha, undefined)
  }
})

test('only a full-length hex object id is shown as a pinned commit', () => {
  for (const sha of [
    'main',
    'refs/heads/main',
    VERCEL_SHA.slice(0, 12),
    `${VERCEL_SHA}0`,
    'z'.repeat(40),
    'a'.repeat(100_000),
    42,
    null
  ]) {
    const plugins = catalog()
    applyPinnedShas(plugins, xaiCache({ plugins: { vercel: { sha } } }), MARKETPLACES)
    assert.equal(plugins[0].sha, undefined, `accepted ${String(sha).slice(0, 24)}`)
  }
  // git is migrating to sha256, so a 64-char id is a commit id too.
  const plugins = catalog()
  applyPinnedShas(plugins, xaiCache({ plugins: { vercel: { sha: 'a'.repeat(64) } } }), MARKETPLACES)
  assert.equal(plugins[0].sha, 'a'.repeat(64))
})

test('a sha the CLI itself reported is not overwritten by the cache', () => {
  const reported = 'b'.repeat(40)
  const raw = [{ name: 'vercel', marketplace: 'xAI Official', sha: reported }]
  const plugins = mapPlugins(raw, 'available')
  applyPinnedShas(plugins, xaiCache({ plugins: { vercel: { sha: VERCEL_SHA } } }), MARKETPLACES)
  assert.equal(plugins[0].sha, reported)
})

test('parseGitRemoteUrl reads remote.origin.url and nothing else', () => {
  const config = `[core]
\tbare = false
[remote "origin"]
\turl = ${XAI_URL}
\tfetch = +refs/heads/main:refs/remotes/origin/main
[branch "main"]
\tremote = origin
`
  assert.equal(parseGitRemoteUrl(config), XAI_URL)
  assert.equal(parseGitRemoteUrl(config.replace(/\n/g, '\r\n')), XAI_URL, 'CRLF checkouts count')
  assert.equal(parseGitRemoteUrl(`[remote "upstream"]\n\turl = ${CLAUDE_URL}`), undefined)
  assert.equal(parseGitRemoteUrl('[core]\n\tbare = false'), undefined)
  assert.equal(parseGitRemoteUrl(null), undefined)
  assert.equal(parseGitRemoteUrl(`[remote "origin"]\n\turl = ${'u'.repeat(3000)}`), undefined)
  assert.equal(parseGitRemoteUrl(`[remote "origin"]\n\turl = a${String.fromCharCode(0)}b`), undefined)
})

// ── MCP mapping + redaction (Gotcha #3) ─────────────────────────────

test('MCP servers are redacted before crossing IPC', () => {
  const [server] = mapMcpServers([
    {
      name: 'db',
      type: 'stdio',
      command: 'run --api_key=SUPERSECRET123',
      detail: 'Authorization: Bearer abcdefghijklmnop123'
    }
  ])
  assert.ok(!JSON.stringify(server).includes('SUPERSECRET123'))
  assert.ok(!JSON.stringify(server).includes('abcdefghijklmnop123'))
})

test('MCP transport falls back to stdio and scope to user', () => {
  const [server] = mapMcpServers([{ name: 'x', type: 'websocket', scope: 'weird' }])
  assert.equal(server.transport, 'stdio')
  assert.equal(server.scope, 'user')
})

test('MCP status is normalized from several CLI shapes', () => {
  const rows = mapMcpServers([
    { name: 'a', status: 'connected' },
    { name: 'b', status: 'request failed' },
    { name: 'c', ok: false },
    { name: 'd' }
  ])
  assert.equal(rows[0].status, 'ok')
  assert.equal(rows[1].status, 'error')
  assert.equal(rows[2].status, 'error')
  assert.equal(rows[3].status, undefined)
})

// ── CLI message surfacing ───────────────────────────────────────────

test('cliMessage redacts, trims and falls back', () => {
  assert.equal(cliMessage({ code: 0, stdout: '  \n ', stderr: '' }, 'fallback'), 'fallback')
  const out = cliMessage({ code: 1, stdout: 'api_key=SUPERSECRET123', stderr: '' }, 'fallback')
  assert.ok(!out.includes('SUPERSECRET123'))
  assert.ok(cliMessage({ code: 1, stdout: 'x'.repeat(2000), stderr: '' }, 'f').length <= 600)
})
