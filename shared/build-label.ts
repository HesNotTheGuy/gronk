/**
 * Display version for the sidebar footer and bug reports.
 *
 * package.json stays at X.Y.Z between releases, so a nightly and a stable
 * tagged as the same number both used to show "vX.Y.Z". The short commit is
 * the honest build identity; nightlies also say so out loud.
 *
 * Pure so the suite can pin the format without git or CI env.
 */

export type BuildChannel = 'stable' | 'nightly' | 'dev'

export function formatBuildLabel(opts: {
  version: string
  commit: string
  channel: BuildChannel
}): string {
  const v = String(opts.version || '0.0.0').replace(/^v/i, '')
  const sha = String(opts.commit || 'unknown')
    .trim()
    .replace(/^g/, '')
    .slice(0, 7)
  if (opts.channel === 'nightly') return `v${v}-nightly · ${sha}`
  if (opts.channel === 'dev') return `v${v}-dev · ${sha}`
  return `v${v} · ${sha}`
}

export function resolveBuildChannel(env: {
  githubRef?: string | null
  githubRefName?: string | null
  githubEventName?: string | null
  channelOverride?: string | null
  ci?: boolean
} = {}): BuildChannel {
  const override = (env.channelOverride || '').trim().toLowerCase()
  if (override === 'nightly' || override === 'stable' || override === 'dev') {
    return override
  }
  const ref = env.githubRef || ''
  const name = env.githubRefName || ''
  // Immutable v* tags are the stable channel (RELEASING.md).
  if (ref.startsWith('refs/tags/v') || /^v\d/.test(name)) return 'stable'
  if (ref === 'refs/tags/nightly' || name === 'nightly') return 'nightly'
  // CI installer builds that are not a v* tag are the nightly path.
  if (env.githubEventName === 'workflow_dispatch') return 'nightly'
  if (env.ci && !ref.startsWith('refs/tags/v')) return 'nightly'
  return 'dev'
}
