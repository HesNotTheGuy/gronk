import test from 'node:test'
import assert from 'node:assert/strict'
import { grokBinaryCandidates } from '../electron/main/acp/client'

/**
 * Where Gronk looks for the grok CLI.
 *
 * Reported by a mac tester: they installed the CLI while Gronk was open and
 * Gronk went on saying it was not installed. A macOS GUI app inherits launchd's
 * PATH rather than the shell's, so a binary in /opt/homebrew/bin is invisible to
 * a PATH scan even though it is plainly on the disk. Absolute candidates are the
 * fix, and they have to be checked ahead of PATH.
 *
 * Pure and parameterised because nobody working on this has a mac, so the paths
 * that most need to be right are the ones that cannot be exercised here. These
 * pin the list and the order; whether a real mac install lands in one of them is
 * the tester's to confirm.
 */

const posix = {
  join: (...parts: string[]) => parts.join('/'),
  delimiter: ':'
}

function mac(pathEnv = '/usr/bin:/bin') {
  return grokBinaryCandidates({
    platform: 'darwin',
    home: '/Users/t',
    grokHomeDir: '/Users/t/.grok',
    pathEnv,
    ...posix
  })
}

test('the mac list covers both Homebrew prefixes as absolute paths', () => {
  // Apple Silicon and Intel. This is the specific failure that was reported: a
  // GUI app cannot see either through PATH.
  const c = mac()
  assert.ok(c.includes('/opt/homebrew/bin/grok'), 'Apple Silicon Homebrew')
  assert.ok(c.includes('/usr/local/bin/grok'), 'Intel Homebrew and most installers')
})

test('the mac list covers the common no-sudo install locations', () => {
  const c = mac()
  for (const p of [
    '/opt/local/bin/grok',
    '/Users/t/.local/bin/grok',
    '/Users/t/bin/grok',
    '/Users/t/.bun/bin/grok'
  ]) {
    assert.ok(c.includes(p), `missing ${p}`)
  }
})

test('absolute candidates come before anything from PATH', () => {
  // The whole point. If PATH won, a GUI app with launchd's PATH would still miss
  // a binary that is sitting in /opt/homebrew/bin.
  const c = mac('/opt/homebrew/bin:/usr/bin')
  const firstPathEntry = c.indexOf('/usr/bin/grok')
  const homebrew = c.indexOf('/opt/homebrew/bin/grok')
  assert.ok(homebrew > -1 && firstPathEntry > -1)
  assert.ok(homebrew < firstPathEntry, 'PATH was consulted before the absolute locations')
})

test('the grok home override is tried first of all', () => {
  // A relocated CLI install has to be found by the launcher, not only by the
  // readers of its state, and it is the most specific answer available.
  const c = grokBinaryCandidates({
    platform: 'darwin',
    home: '/Users/t',
    grokHomeDir: '/opt/relocated/.grok',
    pathEnv: '/usr/bin',
    ...posix
  })
  assert.equal(c[0], '/opt/relocated/.grok/bin/grok')
})

test('a directory named in both PATH and the absolute list is probed once', () => {
  const c = mac('/opt/homebrew/bin:/usr/local/bin')
  const homebrewHits = c.filter((p) => p === '/opt/homebrew/bin/grok').length
  assert.equal(homebrewHits, 1, 'duplicate candidates cost a stat each')
})

test('windows looks for grok.exe and never for the extensionless name', () => {
  // The basename allowlist deliberately excludes .cmd and .bat: Node refuses to
  // spawn those without shell:true, which is unsafe here.
  const c = grokBinaryCandidates({
    platform: 'win32',
    home: 'C:\\Users\\t',
    grokHomeDir: 'C:\\Users\\t\\.grok',
    pathEnv: 'C:\\bin;C:\\other',
    join: (...parts: string[]) => parts.join('\\'),
    delimiter: ';'
  })
  assert.ok(
    c.every((p) => p.endsWith('grok.exe')),
    'a non-.exe candidate on windows'
  )
  assert.ok(c.includes('C:\\bin\\grok.exe'))
})

test('linux keeps its own list and does not inherit the mac one', () => {
  const c = grokBinaryCandidates({
    platform: 'linux',
    home: '/home/t',
    grokHomeDir: '/home/t/.grok',
    pathEnv: '/usr/bin',
    ...posix
  })
  assert.ok(c.includes('/usr/local/bin/grok'))
  assert.ok(c.includes('/home/t/.local/bin/grok'))
  assert.ok(!c.includes('/opt/homebrew/bin/grok'), 'Homebrew is not a linux default')
})

test('an empty PATH still yields the absolute candidates', () => {
  // A GUI app can be handed a startlingly bare environment. The absolute list is
  // what makes that survivable.
  const c = mac('')
  assert.ok(c.length > 0)
  assert.ok(c.includes('/opt/homebrew/bin/grok'))
  assert.ok(!c.some((p) => p === '/grok'), 'an empty PATH segment became a candidate')
})
