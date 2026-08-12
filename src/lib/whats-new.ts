import { RELEASE_NOTES, type ReleaseNote } from '../../shared/release-notes'

/**
 * Which release notes to show, and whether to show any.
 *
 * Separated from the panel so the decision can be argued about in tests rather than by
 * launching the app: every case here is a launch that is awkward to stage by hand — a fresh
 * install, a skipped version, a downgrade, an unreleased build.
 */

/** One line, and never accompanied by detail. See the rule in `shared/release-notes.ts`. */
export const SECURITY_LINE = 'Security and stability improvements.'

/**
 * Compare two dotted numeric versions. Anything non-numeric in a part counts as 0, which is
 * how a build label like `0.4.2-rc1` sorts as `0.4.2` rather than throwing.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split('.').map((p) => Number.parseInt(p, 10) || 0)
  const left = parts(a)
  const right = parts(b)
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff < 0 ? -1 : 1
  }
  return 0
}

export interface WhatsNewDecision {
  /** Notes to show, newest first. Empty means show nothing. */
  notes: ReleaseNote[]
  /**
   * The version to record as seen, or null to record nothing.
   *
   * Set even when there is nothing to show — a fresh install records the version it started
   * on so the NEXT update has something to compare against, and shows no panel, because
   * someone opening the app for the first time wants the app and not a changelog.
   */
  record: string | null
}

export function decideWhatsNew(
  currentVersion: string,
  seenVersion: string | undefined,
  catalog: ReleaseNote[] = RELEASE_NOTES
): WhatsNewDecision {
  if (!currentVersion) return { notes: [], record: null }

  // First run on this install. Record where we came in, say nothing.
  if (!seenVersion) return { notes: [], record: currentVersion }

  // Already seen this one, or running something older than what was seen — a downgrade, or
  // a dev build below the last release. Neither is an occasion for a panel.
  if (compareVersions(currentVersion, seenVersion) <= 0) {
    return { notes: [], record: null }
  }

  // Everything released after what they last ran, up to and including this build. Skipping
  // versions is normal, so this is a range rather than a single entry.
  const notes = catalog
    .filter(
      (n) =>
        compareVersions(n.version, seenVersion) > 0 &&
        compareVersions(n.version, currentVersion) <= 0
    )
    .sort((a, b) => compareVersions(b.version, a.version))

  // Nothing written for the range — an unreleased build, or a version whose notes were not
  // worth writing. Record it anyway so it is not reconsidered on every launch.
  return { notes, record: currentVersion }
}

/** The lines to print under Fixes, with the security rule applied. */
export function fixedLines(note: ReleaseNote): string[] {
  return note.security ? [...note.fixed, SECURITY_LINE] : note.fixed
}
