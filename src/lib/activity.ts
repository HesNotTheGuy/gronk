import type { ProjectContext, SessionInfo } from '../../shared/types'
import { folderName, isChatSession, isChatWorkspace, pathsEqual } from '../../shared/path'

export interface ProjectActivity {
  project: ProjectContext
  sessionCount: number
  userTurns: number
  messageCount: number
  lastActive: number
  /** 0–1 heat from recency + volume */
  heat: number
  /** Short label e.g. "Heavy · 2d ago" */
  frequencyLabel: string
}

function daysAgo(ts: number, now = Date.now()): number {
  return Math.max(0, (now - ts) / (1000 * 60 * 60 * 24))
}

function formatRelative(ts: number, now = Date.now()): string {
  const d = daysAgo(ts, now)
  if (d < 1 / 24) return 'just now'
  if (d < 1) return `${Math.max(1, Math.round(d * 24))}h ago`
  if (d < 7) return `${Math.round(d)}d ago`
  if (d < 30) return `${Math.round(d / 7)}w ago`
  return `${Math.round(d / 30)}mo ago`
}

/** Combine recency (0–1) and volume (0–1) into a single heat score. */
export function computeHeat(lastActive: number, userTurns: number, now = Date.now()): number {
  const recency = Math.max(0, 1 - daysAgo(lastActive, now) / 30)
  const volume = Math.min(1, userTurns / 24)
  return Math.min(1, recency * 0.55 + volume * 0.45)
}

export function frequencyLabel(
  lastActive: number,
  userTurns: number,
  heat: number,
  now = Date.now()
): string {
  const when = formatRelative(lastActive, now)
  let band = 'Light'
  if (heat >= 0.72) band = 'Heavy'
  else if (heat >= 0.4) band = 'Steady'
  else if (userTurns === 0) band = 'New'
  return `${band} · ${when}${userTurns ? ` · ${userTurns} prompts` : ''}`
}

export function buildProjectActivity(
  projects: ProjectContext[],
  sessions: SessionInfo[]
): ProjectActivity[] {
  // Never treat app chat sandbox as a workspace folder / session
  const workspaceSessions = sessions.filter(
    (s) => !s.archived && !isChatSession(s, null)
  )
  const workspaceProjects = projects.filter((p) => !isChatWorkspace(p.cwd, null))
  const active = workspaceSessions
  return workspaceProjects
    .map((project) => {
      const mine = active.filter((s) => pathsEqual(s.cwd, project.cwd))
      const userTurns = mine.reduce((n, s) => n + (s.userTurns ?? 0), 0)
      const messageCount = mine.reduce((n, s) => n + (s.messageCount ?? 0), 0)
      const lastActive = mine.reduce((max, s) => Math.max(max, s.updatedAt || 0), 0) || 0
      const heat = mine.length ? computeHeat(lastActive || Date.now(), userTurns) : 0
      return {
        project,
        sessionCount: mine.length,
        userTurns,
        messageCount,
        lastActive: lastActive || project.cwd.length, // stable fallback
        heat,
        frequencyLabel: mine.length
          ? frequencyLabel(lastActive || Date.now(), userTurns, heat)
          : 'No sessions yet'
      }
    })
    .sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0))
}

export function sessionFrequencyLabel(s: SessionInfo, now = Date.now()): string {
  const turns = s.userTurns ?? 0
  const heat = computeHeat(s.updatedAt, turns, now)
  return frequencyLabel(s.updatedAt, turns, heat, now)
}

export function sessionHeat(s: SessionInfo, now = Date.now()): number {
  return computeHeat(s.updatedAt, s.userTurns ?? 0, now)
}

/** One workspace folder + its sessions (for nested Workspace home). */
export interface WorkspaceFolderGroup {
  cwd: string
  name: string
  sessions: SessionInfo[]
  heat: number
  frequencyLabel: string
  /** True when folder is in recentProjects */
  knownProject: boolean
}

/**
 * Group workspace sessions under their folder. Known projects first,
 * then any orphan session folders not in recent list.
 */
export function buildWorkspaceFolderGroups(
  projects: ProjectContext[],
  sessions: SessionInfo[]
): WorkspaceFolderGroup[] {
  // App Chat lives only under Chat, so exclude sandbox from Workspace entirely
  const active = sessions.filter((s) => !s.archived && !isChatSession(s, null))
  const workspaceProjects = projects.filter((p) => !isChatWorkspace(p.cwd, null))
  const assigned = new Set<string>() // session ids claimed by a known project
  const groups: WorkspaceFolderGroup[] = []

  for (const p of workspaceProjects) {
    const mine = active
      .filter((s) => pathsEqual(s.cwd, p.cwd))
      .sort((a, b) => b.updatedAt - a.updatedAt)
    for (const s of mine) assigned.add(s.id)
    const userTurns = mine.reduce((n, s) => n + (s.userTurns ?? 0), 0)
    const lastActive = mine.reduce((max, s) => Math.max(max, s.updatedAt || 0), 0)
    const heat = mine.length ? computeHeat(lastActive || Date.now(), userTurns) : 0
    groups.push({
      cwd: p.cwd,
      name: p.name || folderName(p.cwd),
      sessions: mine,
      heat,
      frequencyLabel: mine.length
        ? frequencyLabel(lastActive || Date.now(), userTurns, heat)
        : 'No sessions yet',
      knownProject: true
    })
  }

  // Orphan sessions → group by cwd
  const orphanByCwd = new Map<string, SessionInfo[]>()
  for (const s of active) {
    if (assigned.has(s.id)) continue
    const list = orphanByCwd.get(s.cwd) || []
    list.push(s)
    orphanByCwd.set(s.cwd, list)
  }
  for (const [cwd, list] of orphanByCwd) {
    const mine = [...list].sort((a, b) => b.updatedAt - a.updatedAt)
    const userTurns = mine.reduce((n, s) => n + (s.userTurns ?? 0), 0)
    const lastActive = mine.reduce((max, s) => Math.max(max, s.updatedAt || 0), 0)
    const heat = computeHeat(lastActive || Date.now(), userTurns)
    groups.push({
      cwd,
      name: folderName(cwd),
      sessions: mine,
      heat,
      frequencyLabel: frequencyLabel(lastActive || Date.now(), userTurns, heat),
      knownProject: false
    })
  }

  return groups.sort((a, b) => {
    const aLast = a.sessions[0]?.updatedAt || 0
    const bLast = b.sessions[0]?.updatedAt || 0
    return bLast - aLast || b.heat - a.heat
  })
}
