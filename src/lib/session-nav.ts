/**
 * How the Build rail turns a global session list into ordered rows.
 *
 * Extracted for the same reason as agent-dots.ts and scroll-stick.ts: the suite
 * is `node --test` with no DOM, so ordering and grouping decisions that live
 * inside a component cannot be mutation-checked. The Sidebar only renders what
 * this module returns.
 *
 * Default is flat recency. Grouping by project is a view of the same list, not
 * a second navigation path â€” the user no longer drills into a folder before
 * seeing sessions.
 */

import type { SessionInfo } from '../../shared/types'
import { folderName, isChatSession, pathsEqual } from '../../shared/path'

export type SessionNavMode = 'recent' | 'by-project'

/** Enough for a hop list; the browse homes still hold the full set. */
export const SESSION_NAV_LIMIT = 40

export interface SessionNavProject {
  cwd: string
  name: string
  pinned?: boolean
}

/** One session ready to paint: title from SessionRow, project always in meta. */
export interface SessionNavEntry {
  session: SessionInfo
  /**
   * Short destination label for the row (folder name, known project name, or
   * "Chat"). Shown on every row so a flat list of same-titled sessions is still
   * readable, and so one click that changes agent cwd is never silent.
   */
  projectLabel: string
}

export interface SessionNavGroup {
  cwd: string
  projectLabel: string
  /** Sessions in this group, newest first. */
  entries: SessionNavEntry[]
}

export interface SessionNavInput {
  sessions: readonly SessionInfo[]
  projects: readonly SessionNavProject[]
  mode: SessionNavMode
  /** Sandbox root so chat sessions label as Chat rather than a folder name. */
  chatWorkspacePath: string | null
  /** Cap after sorting / grouping. Defaults to SESSION_NAV_LIMIT. */
  limit?: number
}

export type SessionNavResult =
  | { mode: 'recent'; entries: SessionNavEntry[]; hidden: number }
  | { mode: 'by-project'; groups: SessionNavGroup[]; hidden: number }

/**
 * Newest first. Equal timestamps keep input order (stable for tests).
 * Unknown / non-finite updatedAt sorts last, never first.
 */
export function compareSessionsByRecency(a: SessionInfo, b: SessionInfo): number {
  const ta = Number.isFinite(a.updatedAt) ? a.updatedAt : 0
  const tb = Number.isFinite(b.updatedAt) ? b.updatedAt : 0
  return tb - ta
}

/**
 * Label for one session's project (or Chat).
 *
 * Prefer the recent-projects name when the cwd still matches a known entry;
 * otherwise fall back to the last path segment so sessions whose project left
 * the recent list still show a destination. Chat is never a folder name.
 */
export function projectLabelForSession(
  session: SessionInfo,
  projects: readonly SessionNavProject[],
  chatWorkspacePath: string | null
): string {
  if (isChatSession(session, chatWorkspacePath)) return 'Chat'
  const cwd = session.cwd || ''
  if (!cwd) return 'Project'
  const known = projects.find((p) => pathsEqual(p.cwd, cwd))
  if (known?.name?.trim()) return known.name.trim()
  return folderName(cwd) || 'Project'
}

function toEntry(
  session: SessionInfo,
  projects: readonly SessionNavProject[],
  chatWorkspacePath: string | null
): SessionNavEntry {
  return {
    session,
    projectLabel: projectLabelForSession(session, projects, chatWorkspacePath)
  }
}

/**
 * Given sessions, mode, and the recent-projects list, what the rail paints.
 *
 * - `recent`: all sessions flat, newest first, then capped.
 * - `by-project`: groups by cwd (case/slash-aware via pathsEqual), groups ordered
 *   by pinned project first then by the newest session in the group; within a
 *   group, newest first. Cap applies to total sessions, not groups.
 *
 * Archived filtering is the caller's job â€” this module only orders what it gets.
 */
export function buildSessionNav(input: SessionNavInput): SessionNavResult {
  const limit = input.limit ?? SESSION_NAV_LIMIT
  const { sessions, projects, mode, chatWorkspacePath } = input
  const sorted = [...sessions].sort(compareSessionsByRecency)
  const total = sorted.length

  if (mode === 'recent') {
    const slice = sorted.slice(0, Math.max(0, limit))
    return {
      mode: 'recent',
      entries: slice.map((s) => toEntry(s, projects, chatWorkspacePath)),
      hidden: Math.max(0, total - slice.length)
    }
  }

  // by-project: group in recency order so first-seen group is the hottest.
  const groupOrder: string[] = []
  const buckets = new Map<string, SessionInfo[]>()
  // Canonical key per pathsEqual: first session's cwd wins as the map key.
  const keyFor = (cwd: string): string => {
    for (const k of buckets.keys()) {
      if (pathsEqual(k, cwd)) return k
    }
    return cwd
  }

  for (const s of sorted) {
    const raw = s.cwd || ''
    const key = keyFor(raw)
    let list = buckets.get(key)
    if (!list) {
      list = []
      buckets.set(key, list)
      groupOrder.push(key)
    }
    list.push(s)
  }

  const pinnedCwd = (cwd: string): boolean =>
    projects.some((p) => pathsEqual(p.cwd, cwd) && !!p.pinned)

  // Rank groups: pinned first, then by newest session already at [0] in each bucket.
  groupOrder.sort((a, b) => {
    const pa = pinnedCwd(a) ? 1 : 0
    const pb = pinnedCwd(b) ? 1 : 0
    if (pa !== pb) return pb - pa
    const ta = buckets.get(a)?.[0]?.updatedAt ?? 0
    const tb = buckets.get(b)?.[0]?.updatedAt ?? 0
    return tb - ta
  })

  // Apply limit across groups in display order.
  let remaining = Math.max(0, limit)
  const groups: SessionNavGroup[] = []
  let shown = 0
  for (const cwd of groupOrder) {
    if (remaining <= 0) break
    const list = buckets.get(cwd) || []
    const take = list.slice(0, remaining)
    if (take.length === 0) continue
    remaining -= take.length
    shown += take.length
    const sample = take[0]
    groups.push({
      cwd,
      projectLabel: projectLabelForSession(sample, projects, chatWorkspacePath),
      entries: take.map((s) => toEntry(s, projects, chatWorkspacePath))
    })
  }

  return {
    mode: 'by-project',
    groups,
    hidden: Math.max(0, total - shown)
  }
}

/** Meta line under a session title: destination + date. */
export function sessionNavMeta(entry: SessionNavEntry, now = Date.now()): string {
  const date = new Date(entry.session.updatedAt || now).toLocaleDateString()
  return `${entry.projectLabel} · ${date}`
}
