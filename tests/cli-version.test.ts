import test from 'node:test'
import assert from 'node:assert/strict'
import {
  VERIFIED_CLI_VERSION,
  classifyCliVersion,
  compareSemver,
  formatSemver,
  parseSemver,
  parseVersionJson,
  parseVersionText
} from '../electron/main/cli-version'

/**
 * Ground truth, read off a real binary:
 *   grok version --json  → {"currentVersion":"0.2.112 (9bbd559437)","channel":"stable"}
 *   grok --version       → grok 0.2.112 (9bbd559437) [stable]
 * Note the build hash after the semver — equality on the raw string is useless.
 */
const VERSION_JSON = '{"currentVersion":"0.2.112 (9bbd559437)","channel":"stable"}'
const VERSION_TEXT = 'grok 0.2.112 (9bbd559437) [stable]'

/** Shorthand for "what does the CLI reporting X look like against verified Y". */
function classify(version: string, verified = VERIFIED_CLI_VERSION) {
  return classifyCliVersion(parseVersionText(version), verified)
}

// ── Both output forms ───────────────────────────────────────────────

test('grok version --json is parsed, hash and all', () => {
  const parsed = parseVersionJson(VERSION_JSON)
  assert.ok(parsed)
  assert.equal(parsed.version, '0.2.112', 'the build hash must not survive into the version')
  assert.deepEqual(parsed.semver, { major: 0, minor: 2, patch: 112 })
  assert.equal(parsed.channel, 'stable')
})

test('grok --version plain text is parsed as the fallback form', () => {
  const parsed = parseVersionText(VERSION_TEXT)
  assert.ok(parsed)
  assert.equal(parsed.version, '0.2.112')
  assert.equal(parsed.channel, 'stable')
})

test('the JSON form tolerates whitespace, a missing channel and a version key', () => {
  assert.equal(parseVersionJson(`\n  ${VERSION_JSON}  \n`)?.version, '0.2.112')
  assert.equal(parseVersionJson('{"currentVersion":"0.2.112"}')?.channel, undefined)
  // `version` is unobserved forward-compat — 0.2.112 emits `currentVersion`.
  assert.equal(parseVersionJson('{"version":"1.4.0"}')?.version, '1.4.0')
  assert.equal(parseVersionJson('{"currentVersion":"2.0.0","version":"1.0.0"}')?.version, '2.0.0')
})

test('a channel is only accepted as a short plain token', () => {
  assert.equal(parseVersionJson('{"currentVersion":"0.2.112","channel":"beta"}')?.channel, 'beta')
  assert.equal(parseVersionJson('{"currentVersion":"0.2.112","channel":"has space"}')?.channel, undefined)
  assert.equal(parseVersionJson('{"currentVersion":"0.2.112","channel":42}')?.channel, undefined)
  assert.equal(
    parseVersionJson(`{"currentVersion":"0.2.112","channel":"${'c'.repeat(64)}"}`)?.channel,
    undefined
  )
  assert.equal(parseVersionText('grok 0.2.112')?.channel, undefined)
})

// ── Semver parsing ──────────────────────────────────────────────────

test('a build hash, a v prefix and a prerelease tag are all stripped', () => {
  assert.deepEqual(parseSemver('0.2.112 (9bbd559437)'), { major: 0, minor: 2, patch: 112 })
  assert.deepEqual(parseSemver('v1.0.3'), { major: 1, minor: 0, patch: 3 })
  assert.deepEqual(parseSemver('0.3.0-beta.1'), { major: 0, minor: 3, patch: 0 })
  assert.equal(formatSemver({ major: 0, minor: 3, patch: 0 }), '0.3.0')
})

test('parseSemver refuses anything that is not a three-field version', () => {
  for (const bad of ['', '   ', '0.2', 'grok', 'x.y.z', '0.2.x', null, undefined, 42, {}]) {
    assert.equal(parseSemver(bad), null, `accepted ${JSON.stringify(bad)}`)
  }
  // Number() would turn an absurd field into Infinity, which compares as
  // "newer than verified" forever — refused instead.
  assert.equal(parseSemver(`0.2.${'9'.repeat(7)}`), null)
  assert.equal(parseSemver('9'.repeat(200)), null)
})

// ── Numeric, not lexicographic, ordering ────────────────────────────

test('0.2.9 is older than 0.2.10 — a string compare gets this backwards', () => {
  const nine = parseSemver('0.2.9')
  const ten = parseSemver('0.2.10')
  assert.ok(nine && ten)
  assert.equal(compareSemver(nine, ten), -1)
  assert.equal(compareSemver(ten, nine), 1)
  assert.ok('0.2.9' > '0.2.10', 'the lexicographic answer this must not use')
})

test('fields are compared most-significant first', () => {
  const cases: [string, string, number][] = [
    ['0.2.112', '0.2.112', 0],
    ['1.0.0', '0.99.99', 1],
    ['0.3.0', '0.2.999', 1],
    ['0.2.99', '0.10.0', -1],
    ['2.0.0', '10.0.0', -1]
  ]
  for (const [a, b, expected] of cases) {
    const left = parseSemver(a)
    const right = parseSemver(b)
    assert.ok(left && right)
    assert.equal(compareSemver(left, right), expected, `${a} vs ${b}`)
  }
})

// ── Classification ──────────────────────────────────────────────────

test('the verified constant is itself a parseable version', () => {
  // A typo here would classify every install as unknown and hide the warning
  // the whole module exists to raise.
  assert.ok(parseSemver(VERIFIED_CLI_VERSION), `VERIFIED_CLI_VERSION is unparseable`)
})

test('the exact verified version is ok and says nothing', () => {
  const info = classify(VERIFIED_CLI_VERSION)
  assert.equal(info.status, 'ok')
  assert.equal(info.current, VERIFIED_CLI_VERSION)
  assert.equal(info.verifiedAgainst, VERIFIED_CLI_VERSION)
  assert.equal(info.message, undefined, 'a matching CLI must not put text in Settings')
})

test('a patch difference never warns, in either direction or at any distance', () => {
  for (const version of ['0.2.111', '0.2.113', '0.2.0', '0.2.9', '0.2.10', '0.2.99999']) {
    const info = classify(version, '0.2.112')
    assert.equal(info.status, 'ok', `${version} nagged about a patch bump`)
    assert.equal(info.message, undefined)
  }
})

test('a minor or major difference is what earns a warning', () => {
  for (const version of ['0.3.0', '0.10.0', '1.0.0']) {
    const info = classify(version, '0.2.112')
    assert.equal(info.status, 'newer-than-verified', version)
    assert.match(info.message ?? '', /empty or incomplete/, 'the consequence must be spelled out')
  }
  for (const version of ['0.1.999', '0.0.1']) {
    const info = classify(version, '0.2.112')
    assert.equal(info.status, 'older-than-verified', version)
    assert.match(info.message ?? '', /empty or incomplete/)
  }
})

test('classification carries the reported version and channel through', () => {
  const info = classifyCliVersion(parseVersionJson('{"currentVersion":"0.3.0 (abc)","channel":"beta"}'))
  assert.equal(info.current, '0.3.0')
  assert.equal(info.channel, 'beta')
  assert.equal(info.verifiedAgainst, VERIFIED_CLI_VERSION)
})

// ── Garbage in, "unknown" out — never a throw, never a false mismatch ─

test('unreadable output yields unknown rather than throwing', () => {
  for (const bad of [
    '',
    '   ',
    '{ not json',
    '"a string"',
    '[]',
    '[{"currentVersion":"0.2.112"}]',
    'null',
    '{}',
    '{"currentVersion":"unreleased"}',
    '{"currentVersion":null}',
    '{"channel":"stable"}',
    null,
    undefined,
    42
  ]) {
    assert.equal(parseVersionJson(bad), null, `JSON parser accepted ${JSON.stringify(bad)}`)
  }

  for (const bad of ['', '   ', 'grok: command not found', 'error: unknown flag', null, undefined, 42]) {
    assert.equal(parseVersionText(bad), null, `text parser accepted ${JSON.stringify(bad)}`)
  }

  const info = classifyCliVersion(null)
  assert.equal(info.status, 'unknown')
  assert.equal(info.current, undefined)
  assert.equal(info.channel, undefined)
  assert.equal(info.verifiedAgainst, VERIFIED_CLI_VERSION)
  assert.match(info.message ?? '', /could not read/i)
})

test('megabytes of output are refused by a length check, not by a scan', () => {
  assert.equal(parseVersionJson(`{"currentVersion":"0.2.112","pad":"${'p'.repeat(100_000)}"}`), null)
  assert.equal(parseVersionText(`${'x'.repeat(100_000)} 0.2.112`), null)
})

test('a missing CLI is handled as unknown, not as a version mismatch', () => {
  // Exactly what probeCliVersion hands the parsers when resolveGrokBinary finds
  // nothing: runGrokCli resolves { code: 127, stdout: '', stderr: 'grok binary
  // not found' } rather than rejecting.
  const fromJson = parseVersionJson('')
  const fromText = parseVersionText('\ngrok binary not found')
  assert.equal(fromJson, null)
  assert.equal(fromText, null)

  const info = classifyCliVersion(fromJson ?? fromText)
  assert.equal(info.status, 'unknown')
  assert.equal(info.current, undefined)
  assert.ok(info.message, 'an unreadable CLI still owes the user an explanation')
})

test('an unparseable verified constant degrades to unknown instead of lying', () => {
  const info = classifyCliVersion(parseVersionText(VERSION_TEXT), 'not-a-version')
  assert.equal(info.status, 'unknown')
  assert.equal(info.current, '0.2.112', 'what the CLI reported is still worth showing')
  assert.equal(info.verifiedAgainst, 'not-a-version')
})
