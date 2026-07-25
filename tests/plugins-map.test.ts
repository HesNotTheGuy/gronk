import test from 'node:test'
import assert from 'node:assert/strict'
import {
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
  mapPlugins
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
