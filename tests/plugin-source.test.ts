import test from 'node:test'
import assert from 'node:assert/strict'
import { isInstallableSource } from '../electron/main/plugins-map'

/**
 * What may be handed to `grok plugin install`.
 *
 * The shipped gap: catalog URLs read off DISK went through an https-only check,
 * but a `sourceUrl` arriving inside the CLI's own JSON did not. A marketplace
 * entry could therefore name a file://, ssh:// or scp-style target and have it
 * installed — third-party catalog data choosing the scheme. The gate now sits at
 * the install choke point so it holds for every caller.
 */

test('an https URL is installable', () => {
  for (const ok of [
    'https://github.com/owner/repo',
    'https://github.com/owner/repo.git',
    'https://gitlab.example.com/group/sub/repo.git'
  ]) {
    assert.equal(isInstallableSource(ok), true, ok)
  }
})

test('an owner/repo shorthand is installable', () => {
  for (const ok of ['owner/repo', 'some-org/some.repo', 'a/b/c']) {
    assert.equal(isInstallableSource(ok), true, ok)
  }
})

// Each of these was verified to reach the install command before the gate moved.
test('every non-https scheme is refused', () => {
  for (const bad of [
    'file:///C:/Windows/Temp/evil',
    'file:///etc/passwd',
    'ssh://git@attacker.example/repo.git',
    'git://attacker.example/repo.git',
    'http://attacker.example/repo.git',
    'javascript:alert(1)',
    'data:text/plain,x'
  ]) {
    assert.equal(isInstallableSource(bad), false, bad)
  }
})

// git accepts this form and it is not a URL, so a scheme test alone misses it.
test('scp-style git targets are refused', () => {
  for (const bad of [
    'git@attacker.example:repo.git',
    'user@host:path/to/repo',
    'git@github.com:owner/repo.git'
  ]) {
    assert.equal(isInstallableSource(bad), false, bad)
  }
})

test('absolute and traversing paths are refused', () => {
  for (const bad of [
    '/etc/passwd',
    '\\\\server\\share\\evil',
    'C:/Windows/Temp/evil',
    'C:\\Windows\\Temp\\evil',
    '../../etc/passwd',
    'owner/../../../etc/passwd'
  ]) {
    assert.equal(isInstallableSource(bad), false, bad)
  }
})

test('empty and whitespace are refused', () => {
  for (const bad of ['', '   ', '\t']) {
    assert.equal(isInstallableSource(bad), false, JSON.stringify(bad))
  }
})

// A bare name is not enough to identify a repository, so it is not a valid
// install target either.
test('a bare name with no owner is refused', () => {
  assert.equal(isInstallableSource('repo'), false)
  assert.equal(isInstallableSource('code-review'), false)
})

test('surrounding whitespace does not smuggle anything past the gate', () => {
  assert.equal(isInstallableSource('  https://github.com/owner/repo  '), true)
  assert.equal(isInstallableSource('  file:///etc/passwd  '), false)
})
