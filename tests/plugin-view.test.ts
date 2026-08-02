import test from 'node:test'
import assert from 'node:assert/strict'
import {
  auditPlugin,
  componentCounts,
  componentLine,
  installSource,
  plainText,
  sourceOrigin
} from '../src/lib/plugin-view'
import type { Plugin } from '../shared/types'

function plugin(partial: Partial<Plugin>): Plugin {
  return {
    name: 'demo',
    status: 'available',
    skillCount: 0,
    hasHooks: false,
    hasAgents: false,
    hasMcp: false,
    ...partial
  }
}

// ── Untrusted catalog text ──────────────────────────────────────────

test('plainText strips control characters', () => {
  assert.equal(plainText(`a${String.fromCharCode(0)}b`), 'a b')
  assert.equal(plainText('line\nbreak\ttab'), 'line break tab')
})

test('plainText strips zero-width and bidi-override characters', () => {
  // RLO/LRO can visually reverse a name so "gnp.exe" reads as "exe.png".
  for (const code of [0x200b, 0x200e, 0x202e, 0x2066, 0x2069]) {
    const out = plainText(`safe${String.fromCodePoint(code)}name`)
    assert.equal(out, 'safe name', `codepoint ${code.toString(16)} survived`)
  }
})

test('plainText collapses whitespace and truncates', () => {
  assert.equal(plainText('  lots     of   space  '), 'lots of space')
  const out = plainText('x'.repeat(500))
  assert.equal(out.length, 260)
  assert.ok(out.endsWith('…'))
  assert.equal(plainText('abcdef', 4), 'abc…')
})

test('plainText returns empty string for non-strings', () => {
  assert.equal(plainText(undefined), '')
  assert.equal(plainText(null), '')
  assert.equal(plainText(42 as unknown as string), '')
})

test('componentLine joins name and description as inert text', () => {
  assert.equal(componentLine({ name: 'a', description: 'does x' }), 'a: does x')
  assert.equal(componentLine({ name: 'a' }), 'a')
  assert.equal(componentLine({ name: '' }), 'unnamed')
})

// ── Counts ──────────────────────────────────────────────────────────

test('componentCounts reads only components.*', () => {
  const counts = componentCounts(
    plugin({
      skillCount: 99,
      hasHooks: true,
      components: { skills: [{ name: 'a' }], hooks: [] }
    })
  )
  assert.deepEqual(counts, { skills: 1, commands: 0, agents: 0, mcp: 0, hooks: 0 })
  assert.deepEqual(componentCounts(plugin({})), {
    skills: 0,
    commands: 0,
    agents: 0,
    mcp: 0,
    hooks: 0
  })
})

// ── Risk audit (SKILLS-PLUGINS-SPEC §4.3) ───────────────────────────

test('a plugin with no components declares no risk tags', () => {
  assert.deepEqual(auditPlugin(plugin({})), [])
})

test('local MCP servers are HIGH; remote ones are MED', () => {
  const local = auditPlugin(plugin({ components: { mcpServers: [{ name: 's' }] } }))
  assert.equal(local[0].severity, 'HIGH')
  assert.match(local[0].label, /Shell-exec/)

  const remote = auditPlugin(
    plugin({ components: { mcpServers: [{ name: 's', description: 'http' }] } })
  )
  assert.equal(remote[0].severity, 'MED')
  assert.match(remote[0].label, /Remote/)
})

test('an unrecognised transport fails safe to shell-exec', () => {
  const tags = auditPlugin(
    plugin({ components: { mcpServers: [{ name: 's', description: 'quantum' }] } })
  )
  assert.equal(tags[0].severity, 'HIGH')
  assert.match(tags[0].label, /Shell-exec/)
})

test('hooks are HIGH and a matcher-less hook adds a second tag', () => {
  const described = auditPlugin(
    plugin({ components: { hooks: [{ name: 'h', description: 'PreToolUse' }] } })
  )
  assert.equal(described.length, 1)

  const broad = auditPlugin(plugin({ components: { hooks: [{ name: 'h' }] } }))
  assert.equal(broad.length, 2)
  assert.ok(broad.every((t) => t.severity === 'HIGH'))
  assert.match(broad[1].label, /Over-broad/)
})

test('skills are flagged MED as a prompt-injection surface', () => {
  const tags = auditPlugin(plugin({ components: { skills: [{ name: 's' }] } }))
  assert.equal(tags[0].severity, 'MED')
  assert.match(tags[0].detail, /prompt-injection/)
})

// ── Install source ──────────────────────────────────────────────────

test('installSource uses sourceUrl and never free-form prose', () => {
  assert.equal(
    installSource(plugin({ name: 'demo', sourceUrl: '  https://example.com/p  ' })),
    'https://example.com/p'
  )
  assert.equal(installSource(plugin({ name: '', description: 'https://evil.example' })), '')
})

// `grok plugin install --help` (0.2.111): <SOURCE> is a git URL, user/repo shorthand or
// local path. A bare name is none of those, so falling back to it would make the CLI
// resolve some unrelated path. An empty source leaves the confirm button disabled.
test('a plugin with no sourceUrl yields no install target rather than its name', () => {
  assert.equal(installSource(plugin({ name: 'demo' })), '')
  assert.equal(installSource(plugin({ name: '  spaced name  ' })), '')
})

// ── provenance ─────────────────────────────────────────────────────────────

/**
 * The card used to show the marketplace NAME as a badge. That name is a string
 * in a config file: anyone can set theirs to "xAI Official" and inherit the same
 * visual authority as the real catalog. The host and account cannot be claimed
 * that way, so the origin is what gets displayed.
 */
test('the origin is the host and the publishing account', () => {
  assert.equal(
    sourceOrigin('https://github.com/xai-org/plugin-marketplace.git'),
    'github.com/xai-org'
  )
  assert.equal(
    sourceOrigin('https://github.com/anthropics/claude-plugins-official.git'),
    'github.com/anthropics'
  )
  assert.equal(sourceOrigin('https://gitlab.com/some-org/sub/repo'), 'gitlab.com/some-org')
})

// The whole point: an impostor keeps the name but cannot keep the origin.
test('an impostor is distinguishable by origin alone', () => {
  const real = sourceOrigin('https://github.com/xai-org/plugin-marketplace.git')
  const fake = sourceOrigin('https://github.com/totally-not-xai/plugin-marketplace.git')
  assert.notEqual(real, fake)
  assert.equal(fake, 'github.com/totally-not-xai')
})

test('the host alone is shown when there is no account segment', () => {
  assert.equal(sourceOrigin('https://plugins.example.com'), 'plugins.example.com')
  assert.equal(sourceOrigin('https://plugins.example.com/'), 'plugins.example.com')
})

test('the host is lowercased so case cannot be used to mimic', () => {
  assert.equal(sourceOrigin('https://GitHub.COM/xai-org/repo'), 'github.com/xai-org')
})

// Null rather than an empty chip: a blank origin must not read as "no origin,
// therefore nothing to worry about".
test('anything unusable yields null rather than an empty chip', () => {
  for (const bad of [
    '',
    '   ',
    'not a url',
    'owner/repo',
    'file:///etc/passwd',
    'ssh://git@example.com/repo.git',
    'javascript:alert(1)',
    null,
    undefined
  ]) {
    assert.equal(sourceOrigin(bad as string), null, String(bad))
  }
})
