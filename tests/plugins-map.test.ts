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
  catalogRepoUrl,
  cliMessage,
  commitSha,
  mapMcpServers,
  mapPlugin,
  mapPlugins,
  parseGitRemote,
  parseGitRemoteUrl,
  parseSkillFrontmatter
} from '../electron/main/plugins-map'

// ── Option injection: a name starting with - is parsed as a flag ────

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

// ── Plugin mapping: counts come from components.*, not the flat fields

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
//
// Shapes below are the ones a real ~/.grok/marketplace-cache holds: a Grok clone
// with `.grok-plugin/plugin-index.json` (object map, commits only) beside
// `.grok-plugin/marketplace.json`, and a Claude clone with
// `.claude-plugin/marketplace.json` (array, polymorphic `source`).

const XAI_URL = 'https://github.com/xai-org/plugin-marketplace.git'
const CLAUDE_URL = 'https://github.com/anthropics/claude-plugins-official.git'
const MARKETPLACES = [
  { name: 'xAI Official', kind: 'git', url: XAI_URL, branch: null },
  { name: 'claude-plugins-official', kind: 'git', url: CLAUDE_URL, branch: null }
]
const VERCEL_SHA = '4f867228f69a48c4781ccf1bc5d2741af435cc97'
/** The plugin's own upstream repo — a different repository from the marketplace. */
const VERCEL_REPO = 'https://github.com/vercel/vercel-plugin.git'

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

function gitConfig(url: string, branch: string | null = 'main'): string {
  const refspec = branch
    ? `+refs/heads/${branch}:refs/remotes/origin/${branch}`
    : '+refs/heads/*:refs/remotes/origin/*'
  return `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n\tfetch = ${refspec}\n`
}

/** A clone: raw `.git/config` text plus the raw text of each catalog file. */
function clone(url: string, catalogs: unknown[], branch: string | null = 'main') {
  return {
    gitConfig: gitConfig(url, branch),
    catalogs: catalogs.map((c) =>
      c === null || typeof c === 'string' ? (c as string | null) : JSON.stringify(c)
    )
  }
}

function xaiClone(...catalogs: unknown[]) {
  return [clone(XAI_URL, catalogs)]
}

/** `.grok-plugin/plugin-index.json` — `plugins` is an object map of commits. */
function indexFile(plugins: Record<string, unknown>) {
  return { version: 1, plugins }
}

/** `marketplace.json` — `plugins` is an array and `source` says what is pinned. */
function marketplaceFile(plugins: unknown[]) {
  return { $schema: 'x', name: 'xai-official', owner: {}, plugins }
}

function urlSource(url: unknown, sha: unknown) {
  return marketplaceFile([{ name: 'vercel', source: { source: 'url', url, sha } }])
}

test('an array catalog pins the commit together with the repository it belongs to', () => {
  const plugins = catalog()
  applyPinnedShas(plugins, xaiClone(urlSource(VERCEL_REPO, VERCEL_SHA)), MARKETPLACES)
  assert.equal(plugins[0].sha, VERCEL_SHA)
  assert.equal(plugins[0].sourceUrl, VERCEL_REPO)
  assert.equal(plugins[1].sha, undefined, 'the same name elsewhere must not inherit the commit')
})

test('the pinned repository replaces a source URL backfilled from the marketplace', () => {
  const plugins = catalog()
  // What listAvailablePlugins backfills: the marketplace repo, not the plugin's.
  plugins[0].sourceUrl = XAI_URL
  applyPinnedShas(plugins, xaiClone(urlSource(VERCEL_REPO, VERCEL_SHA)), MARKETPLACES)
  assert.equal(plugins[0].sourceUrl, VERCEL_REPO, 'source and commit must name one repository')
})

test('a git-subdir entry pins its own upstream repo, not the marketplace listing it', () => {
  const plugins = catalog()
  const file = marketplaceFile([
    {
      name: 'vercel',
      source: {
        source: 'git-subdir',
        url: VERCEL_REPO,
        path: 'plugins/vercel',
        ref: 'v1.5.5',
        sha: VERCEL_SHA
      }
    }
  ])
  applyPinnedShas(plugins, xaiClone(file), MARKETPLACES)
  assert.equal(plugins[0].sha, VERCEL_SHA)
  assert.equal(plugins[0].sourceUrl, VERCEL_REPO)
})

test('the object-map index pins only once a sibling catalog names the repository', () => {
  const index = indexFile({ vercel: { sha: VERCEL_SHA, version: '0.45.1' } })

  const alone = catalog()
  applyPinnedShas(alone, xaiClone(index), MARKETPLACES)
  assert.equal(alone[0].sha, undefined, 'a commit with no repository must not be displayed')

  const paired = catalog()
  applyPinnedShas(paired, xaiClone(index, urlSource(VERCEL_REPO, undefined)), MARKETPLACES)
  assert.equal(paired[0].sha, VERCEL_SHA)
  assert.equal(paired[0].sourceUrl, VERCEL_REPO)
})

test('a string source declares no commit of its own, so nothing is pinned', () => {
  const plugins = catalog()
  plugins[0].sourceUrl = XAI_URL
  const file = marketplaceFile([{ name: 'vercel', source: './plugins/vercel' }])
  applyPinnedShas(plugins, xaiClone(file), MARKETPLACES)
  assert.equal(plugins[0].sha, undefined)
  assert.equal(plugins[0].sourceUrl, XAI_URL, 'the backfill stands when there is no pin to pair')
})

test('a github source naming two different object ids is refused, not guessed at', () => {
  const plugins = catalog()
  const file = marketplaceFile([
    {
      name: 'vercel',
      source: {
        source: 'github',
        repo: 'vercel/vercel-plugin',
        commit: 'c'.repeat(40),
        sha: VERCEL_SHA
      }
    }
  ])
  // Even with a sibling catalog naming the repo, the two ids stay unresolvable.
  applyPinnedShas(plugins, xaiClone(file, urlSource(VERCEL_REPO, undefined)), MARKETPLACES)
  assert.equal(plugins[0].sha, undefined)
})

test('two catalogs of one clone naming different commits pin neither', () => {
  const plugins = catalog()
  applyPinnedShas(
    plugins,
    xaiClone(
      urlSource(VERCEL_REPO, VERCEL_SHA),
      indexFile({ vercel: { sha: 'd'.repeat(40) } })
    ),
    MARKETPLACES
  )
  assert.equal(plugins[0].sha, undefined)
})

test('a clone is matched to its marketplace across a .git suffix', () => {
  const plugins = catalog()
  const file = urlSource(VERCEL_REPO, VERCEL_SHA)
  applyPinnedShas(plugins, [clone(XAI_URL.replace(/\.git$/, ''), [file])], MARKETPLACES)
  assert.equal(plugins[0].sha, VERCEL_SHA)
})

test('a missing, unusable or unmatched cache leaves sha undefined without throwing', () => {
  const file = urlSource(VERCEL_REPO, VERCEL_SHA)
  for (const caches of [
    [],
    xaiClone(null),
    xaiClone(''),
    xaiClone('{ not json'),
    xaiClone('"a string"'),
    xaiClone('[]'),
    xaiClone({}),
    xaiClone({ plugins: 'nope' }),
    xaiClone(marketplaceFile([null, 'junk', {}, { name: 'vercel' }])),
    xaiClone(marketplaceFile([{ name: 'vercel', source: { source: 'url' } }])),
    xaiClone(indexFile({ vercel: 'nope' })),
    xaiClone(indexFile({ vercel: {} })),
    xaiClone(indexFile({ other: { sha: VERCEL_SHA } })),
    [{ gitConfig: null, catalogs: [JSON.stringify(file)] }],
    [{ gitConfig: '[core]\n\tbare = false', catalogs: [JSON.stringify(file)] }],
    [clone('https://github.com/someone/unconfigured.git', [file])]
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
    null,
    undefined
  ]) {
    for (const caches of [
      xaiClone(urlSource(VERCEL_REPO, sha)),
      xaiClone(indexFile({ vercel: { sha } }), urlSource(VERCEL_REPO, undefined))
    ]) {
      const plugins = catalog()
      applyPinnedShas(plugins, caches, MARKETPLACES)
      assert.equal(plugins[0].sha, undefined, `accepted ${String(sha).slice(0, 24)}`)
    }
  }
  // git is migrating to sha256, so a 64-char id is a commit id too.
  const plugins = catalog()
  applyPinnedShas(plugins, xaiClone(urlSource(VERCEL_REPO, 'a'.repeat(64))), MARKETPLACES)
  assert.equal(plugins[0].sha, 'a'.repeat(64))
})

test('commitSha accepts only sha1/sha256 object ids', () => {
  assert.equal(commitSha(` ${VERCEL_SHA} `), VERCEL_SHA)
  assert.equal(commitSha('A'.repeat(40)), 'A'.repeat(40))
  assert.equal(commitSha(VERCEL_SHA.slice(0, 39)), undefined)
  assert.equal(commitSha('g'.repeat(40)), undefined)
  assert.equal(commitSha('0'.repeat(50)), undefined)
  assert.equal(commitSha('0'.repeat(1_000_000)), undefined)
  assert.equal(commitSha(VERCEL_SHA.length), undefined)
})

test('a repo URL from a catalog is refused unless it is an https remote', () => {
  assert.equal(catalogRepoUrl(` ${VERCEL_REPO} `), VERCEL_REPO)
  for (const bad of [
    'http://github.com/vercel/vercel-plugin.git',
    'file:///etc/passwd',
    'ssh://git@github.com/vercel/vercel-plugin.git',
    'git@github.com:vercel/vercel-plugin.git',
    'javascript:alert(1)',
    '--trust',
    'https://',
    `https://x${String.fromCharCode(0)}y`,
    `https://example.com/${'p'.repeat(3000)}`,
    42,
    null
  ]) {
    assert.equal(catalogRepoUrl(bad), undefined, `accepted ${String(bad).slice(0, 24)}`)
  }
})

test('a catalog URL that is not an https remote pins nothing at all', () => {
  for (const url of ['git@github.com:vercel/vercel-plugin.git', 'file:///tmp/evil', '--trust']) {
    const plugins = catalog()
    applyPinnedShas(plugins, xaiClone(urlSource(url, VERCEL_SHA)), MARKETPLACES)
    assert.equal(plugins[0].sha, undefined, `accepted ${url}`)
    assert.equal(plugins[0].sourceUrl, undefined)
  }
})

test('mapPlugin validates a sha the CLI reported instead of trusting it', () => {
  assert.equal(mapPlugin({ name: 'a', sha: 'main' }, 'available')?.sha, undefined)
  assert.equal(mapPlugin({ name: 'a', sha: 'z'.repeat(40) }, 'available')?.sha, undefined)
  assert.equal(mapPlugin({ name: 'a', commit: 'HEAD' }, 'available')?.sha, undefined)
  assert.equal(mapPlugin({ name: 'a', sha: VERCEL_SHA }, 'available')?.sha, VERCEL_SHA)
  assert.equal(mapPlugin({ name: 'a', commit: VERCEL_SHA }, 'available')?.sha, VERCEL_SHA)
})

test('a sha the CLI reported is dropped when invalid and kept when valid', () => {
  const caches = xaiClone(urlSource(VERCEL_REPO, VERCEL_SHA))

  const bogus = mapPlugins([{ name: 'vercel', marketplace: 'xAI Official', sha: 'main' }], 'available')
  applyPinnedShas(bogus, caches, MARKETPLACES)
  assert.equal(bogus[0].sha, VERCEL_SHA, 'an unusable CLI value must not outrank the cache')

  const reported = 'b'.repeat(40)
  const kept = mapPlugins(
    [{ name: 'vercel', marketplace: 'xAI Official', sha: reported }],
    'available'
  )
  kept[0].sourceUrl = XAI_URL
  applyPinnedShas(kept, caches, MARKETPLACES)
  assert.equal(kept[0].sha, reported)
  assert.equal(kept[0].sourceUrl, XAI_URL, "a URL is never paired with someone else's commit")
})

// ── Telling two clones of one marketplace apart ─────────────────────

test('two clones of one remote pin nothing unless the branch tells them apart', () => {
  const stale = clone(XAI_URL, [urlSource(VERCEL_REPO, 'e'.repeat(40))], 'main')
  const fresh = clone(XAI_URL, [urlSource(VERCEL_REPO, VERCEL_SHA)], 'next')

  const ambiguous = catalog()
  applyPinnedShas(ambiguous, [stale, fresh], MARKETPLACES)
  assert.equal(ambiguous[0].sha, undefined, 'readdir order must not decide which clone wins')

  const named = catalog()
  applyPinnedShas(named, [stale, fresh], [
    { name: 'xAI Official', kind: 'git', url: XAI_URL, branch: 'next' }
  ])
  assert.equal(named[0].sha, VERCEL_SHA)
})

test('a clone tracking a branch the marketplace does not use is not attributed', () => {
  const wrongBranch = clone(XAI_URL, [urlSource(VERCEL_REPO, VERCEL_SHA)], 'main')
  const plugins = catalog()
  applyPinnedShas(plugins, [wrongBranch], [
    { name: 'xAI Official', kind: 'git', url: XAI_URL, branch: 'release' }
  ])
  assert.equal(plugins[0].sha, undefined)
})

test('one clone can back several marketplaces configured against it', () => {
  const plugins = mapPlugins(
    [
      { name: 'vercel', marketplace: 'xAI Official' },
      { name: 'vercel', marketplace: 'xAI mirror' }
    ],
    'available'
  )
  applyPinnedShas(plugins, xaiClone(urlSource(VERCEL_REPO, VERCEL_SHA)), [
    ...MARKETPLACES,
    { name: 'xAI mirror', kind: 'git', url: XAI_URL, branch: null }
  ])
  assert.equal(plugins[0].sha, VERCEL_SHA)
  assert.equal(plugins[1].sha, VERCEL_SHA)
})

test('parseGitRemote reads remote.origin.url and the branch that clone tracks', () => {
  const config = `[core]
\tbare = false
[remote "origin"]
\turl = ${XAI_URL}
\tfetch = +refs/heads/main:refs/remotes/origin/main
[branch "main"]
\tremote = origin
`
  assert.deepEqual(parseGitRemote(config), { url: XAI_URL, branch: 'main' })
  assert.deepEqual(parseGitRemote(config.replace(/\n/g, '\r\n')), {
    url: XAI_URL,
    branch: 'main'
  })
  // A wildcard refspec identifies no single branch, and the caches sit on a
  // detached HEAD, so there is nothing else on disk to read it from.
  assert.equal(parseGitRemote(gitConfig(XAI_URL, null)).branch, undefined)
  assert.equal(parseGitRemote(`[remote "upstream"]\n\tfetch = +refs/heads/x:y`).branch, undefined)
})

test('parseGitRemoteUrl reads remote.origin.url and nothing else', () => {
  const config = gitConfig(XAI_URL)
  assert.equal(parseGitRemoteUrl(config), XAI_URL)
  assert.equal(parseGitRemoteUrl(config.replace(/\n/g, '\r\n')), XAI_URL, 'CRLF checkouts count')
  assert.equal(parseGitRemoteUrl(`[remote "upstream"]\n\turl = ${CLAUDE_URL}`), undefined)
  assert.equal(parseGitRemoteUrl('[core]\n\tbare = false'), undefined)
  assert.equal(parseGitRemoteUrl(null), undefined)
  assert.equal(parseGitRemoteUrl(`[remote "origin"]\n\turl = ${'u'.repeat(3000)}`), undefined)
  assert.equal(parseGitRemoteUrl(`[remote "origin"]\n\turl = a${String.fromCharCode(0)}b`), undefined)
})

// ── MCP mapping + redaction: -e env and -H headers carry API keys ───

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

// ── SKILL.md front matter ──────────────────────────────────────────────────

test('name and description are read from the front matter', () => {
  const parsed = parseSkillFrontmatter('---\nname: code-review\ndescription: Be harsh\n---\n\n# Body')
  assert.deepEqual(parsed, { name: 'code-review', description: 'Be harsh' })
})

// Every real skill on disk that failed before this: `description: >` returned a
// description of literally ">".
test('a folded block scalar is joined into one line', () => {
  const parsed = parseSkillFrontmatter(
    '---\nname: build-with-ai\ndescription: >\n  Use whenever adding AI\n  features to an app.\n---\n'
  )
  assert.equal(parsed?.description, 'Use whenever adding AI features to an app.')
})

test('a literal block scalar keeps its line breaks', () => {
  const parsed = parseSkillFrontmatter('---\nname: x\ndescription: |\n  one\n  two\n---\n')
  assert.equal(parsed?.description, 'one\ntwo')
})

test('a chomping indicator is accepted', () => {
  assert.equal(parseSkillFrontmatter('---\nname: x\ndescription: >-\n  a b\n---\n')?.description, 'a b')
})

test('a block ends at the next unindented key', () => {
  const parsed = parseSkillFrontmatter(
    '---\nname: x\ndescription: >\n  wrapped text\nlicense: MIT\n---\n'
  )
  assert.equal(parsed?.description, 'wrapped text')
})

test('only the first colon splits, so a description may contain colons', () => {
  const parsed = parseSkillFrontmatter('---\nname: x\ndescription: Use for X: then Y\n---\n')
  assert.equal(parsed?.description, 'Use for X: then Y')
})

test('a name is required; a description is not', () => {
  assert.deepEqual(parseSkillFrontmatter('---\nname: solo\n---\n'), { name: 'solo' })
  assert.equal(parseSkillFrontmatter('---\ndescription: no name here\n---\n'), null)
})

test('anything without a front-matter block is not a skill', () => {
  assert.equal(parseSkillFrontmatter('# Just markdown\n'), null)
  assert.equal(parseSkillFrontmatter('---\nname: unterminated\n'), null)
  assert.equal(parseSkillFrontmatter(''), null)
  assert.equal(parseSkillFrontmatter(null), null)
})

// The declared name becomes a directory name when a skill is added, so a
// separator or traversal segment in it must never be accepted.
test('a name that could escape its directory is rejected', () => {
  for (const bad of ['../evil', 'a/b', 'a\b', '..']) {
    assert.equal(parseSkillFrontmatter(`---\nname: ${bad}\n---\n`), null, bad)
  }
})

test('a leading BOM does not defeat the block', () => {
  assert.equal(parseSkillFrontmatter('\uFEFF---\nname: bom\n---\n')?.name, 'bom')
})
