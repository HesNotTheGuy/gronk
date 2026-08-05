import test from 'node:test'
import assert from 'node:assert/strict'
import { formatBuildLabel, resolveBuildChannel } from '../shared/build-label'

test('stable shows version and short sha', () => {
  assert.equal(
    formatBuildLabel({ version: '0.2.0', commit: 'b6462a64559a', channel: 'stable' }),
    'v0.2.0 · b6462a6'
  )
})

test('nightly is visibly a nightly, with the same package version and sha', () => {
  // The bug: package.json stays at 0.2.0 for both; the label must still differ.
  const stable = formatBuildLabel({ version: '0.2.0', commit: 'aaaaaaaa', channel: 'stable' })
  const nightly = formatBuildLabel({ version: '0.2.0', commit: 'bbbbbbbb', channel: 'nightly' })
  assert.equal(stable, 'v0.2.0 · aaaaaaa')
  assert.equal(nightly, 'v0.2.0-nightly · bbbbbbb')
  assert.notEqual(stable, nightly)
  assert.match(nightly, /nightly/i)
})

test('dev is labelled so a local build is not mistaken for a release', () => {
  assert.equal(
    formatBuildLabel({ version: '0.2.0', commit: 'deadbee', channel: 'dev' }),
    'v0.2.0-dev · deadbee'
  )
})

test('sha is capped at seven characters', () => {
  assert.equal(
    formatBuildLabel({ version: '1.0.0', commit: '0123456789abcdef', channel: 'stable' }),
    'v1.0.0 · 0123456'
  )
})

test('a leading v on the package version is not doubled', () => {
  assert.equal(
    formatBuildLabel({ version: 'v0.2.0', commit: 'abc1234', channel: 'stable' }),
    'v0.2.0 · abc1234'
  )
})

test('v* tag ref is stable', () => {
  assert.equal(
    resolveBuildChannel({ githubRef: 'refs/tags/v0.2.0', githubRefName: 'v0.2.0', ci: true }),
    'stable'
  )
})

test('nightly tag and workflow_dispatch are nightly', () => {
  assert.equal(
    resolveBuildChannel({ githubRef: 'refs/tags/nightly', githubRefName: 'nightly', ci: true }),
    'nightly'
  )
  assert.equal(
    resolveBuildChannel({
      githubEventName: 'workflow_dispatch',
      githubRef: 'refs/heads/main',
      ci: true
    }),
    'nightly'
  )
})

test('local non-CI builds are dev', () => {
  assert.equal(resolveBuildChannel({}), 'dev')
  assert.equal(resolveBuildChannel({ ci: false, githubRef: 'refs/heads/main' }), 'dev')
})

test('GRONK_CHANNEL override wins', () => {
  assert.equal(
    resolveBuildChannel({
      channelOverride: 'nightly',
      githubRef: 'refs/tags/v1.0.0',
      ci: true
    }),
    'nightly'
  )
})
