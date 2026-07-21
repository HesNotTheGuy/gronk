import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type ChatMessage,
  type PermissionAuditEntry,
  type ProjectContext,
  type SessionInfo
} from '../../shared/types'

interface StoreData {
  settings: AppSettings
  recentProjects: ProjectContext[]
  sessions: SessionInfo[]
  /** sessionId -> chat messages (local transcript cache) */
  transcripts: Record<string, ChatMessage[]>
  permissionAudit: PermissionAuditEntry[]
}

function storePath(): string {
  return path.join(app.getPath('userData'), 'grocky-store.json')
}

/** Normalize paths so G:\foo and G:/foo match. */
export function normalizeCwd(cwd: string): string {
  try {
    return path.resolve(cwd).replace(/\\/g, '/').replace(/\/+$/, '') || cwd
  } catch {
    return cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  }
}

function readStore(): StoreData {
  try {
    const raw = fs.readFileSync(storePath(), 'utf8')
    const data = JSON.parse(raw) as Partial<StoreData>
    return {
      settings: { ...DEFAULT_SETTINGS, ...data.settings },
      recentProjects: data.recentProjects ?? [],
      sessions: data.sessions ?? [],
      transcripts: data.transcripts ?? {},
      permissionAudit: data.permissionAudit ?? []
    }
  } catch {
    return {
      settings: { ...DEFAULT_SETTINGS },
      recentProjects: [],
      sessions: [],
      transcripts: {},
      permissionAudit: []
    }
  }
}

function writeStore(data: StoreData): void {
  const dir = path.dirname(storePath())
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(storePath(), JSON.stringify(data, null, 2), 'utf8')
}

/** Keep one row per session id; prefer newest updatedAt. */
function dedupeSessions(sessions: SessionInfo[]): SessionInfo[] {
  const byId = new Map<string, SessionInfo>()
  for (const s of sessions) {
    if (!s?.id) continue
    const normalized: SessionInfo = {
      ...s,
      cwd: normalizeCwd(s.cwd)
    }
    const prev = byId.get(normalized.id)
    if (!prev || (normalized.updatedAt ?? 0) >= (prev.updatedAt ?? 0)) {
      if (prev?.createdAt && normalized.createdAt) {
        normalized.createdAt = Math.min(prev.createdAt, normalized.createdAt)
      } else if (prev?.createdAt) {
        normalized.createdAt = prev.createdAt
      }
      byId.set(normalized.id, normalized)
    }
  }
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getSettings(): AppSettings {
  return readStore().settings
}

export function setSettings(partial: Partial<AppSettings>): AppSettings {
  const data = readStore()
  data.settings = { ...data.settings, ...partial }
  // Safety: enabling alwaysApprove requires ack flag
  if (partial.alwaysApprove === true && !data.settings.alwaysApproveAck) {
    data.settings.alwaysApprove = false
  }
  writeStore(data)
  return data.settings
}

export function getRecentProjects(): ProjectContext[] {
  return readStore().recentProjects
}

export function addRecentProject(cwd: string): ProjectContext[] {
  const data = readStore()
  const normalized = normalizeCwd(cwd)
  const name = path.basename(normalized) || normalized
  const entry: ProjectContext = { cwd: normalized, name }
  data.recentProjects = [
    entry,
    ...data.recentProjects.filter((p) => normalizeCwd(p.cwd) !== normalized)
  ].slice(0, 12)
  writeStore(data)
  return data.recentProjects
}

export function listSessions(): SessionInfo[] {
  const data = readStore()
  const cleaned = dedupeSessions(data.sessions).slice(0, 50)
  if (
    cleaned.length !== data.sessions.length ||
    cleaned.some((s, i) => s.id !== data.sessions[i]?.id || s.cwd !== data.sessions[i]?.cwd)
  ) {
    data.sessions = cleaned
    writeStore(data)
  }
  return cleaned
}

export function upsertSession(session: SessionInfo): SessionInfo {
  const data = readStore()
  data.sessions = dedupeSessions(data.sessions)

  const normalized: SessionInfo = {
    ...session,
    cwd: normalizeCwd(session.cwd)
  }

  const idx = data.sessions.findIndex((s) => s.id === normalized.id)
  if (idx >= 0) {
    const prev = data.sessions[idx]
    data.sessions[idx] = {
      ...prev,
      ...normalized,
      createdAt: prev.createdAt || normalized.createdAt,
      title: normalized.title || prev.title,
      updatedAt: normalized.updatedAt || Date.now()
    }
  } else {
    data.sessions.unshift({
      ...normalized,
      createdAt: normalized.createdAt || Date.now(),
      updatedAt: normalized.updatedAt || Date.now()
    })
  }

  data.sessions = dedupeSessions(data.sessions).slice(0, 50)
  writeStore(data)
  return data.sessions.find((s) => s.id === normalized.id) || normalized
}

export function getTranscript(sessionId: string): ChatMessage[] {
  const data = readStore()
  return data.transcripts[sessionId] ?? []
}

export function saveTranscript(sessionId: string, messages: ChatMessage[]): void {
  const data = readStore()
  // Cap message size per session to avoid huge store files
  const trimmed = messages.slice(-200).map((m) => ({
    ...m,
    streaming: false,
    // Drop huge tool payloads from disk cache
    toolCalls: m.toolCalls?.map((t) => ({
      ...t,
      content:
        typeof t.content === 'string' && t.content.length > 4000
          ? t.content.slice(0, 4000) + '\n…[truncated]'
          : t.content,
      rawInput:
        typeof t.rawInput === 'string' && t.rawInput.length > 2000
          ? t.rawInput.slice(0, 2000) + '…'
          : t.rawInput
    }))
  }))
  data.transcripts[sessionId] = trimmed

  // Cap number of stored transcripts
  const ids = Object.keys(data.transcripts)
  if (ids.length > 40) {
    const keep = new Set(listSessions().map((s) => s.id))
    for (const id of ids) {
      if (!keep.has(id)) delete data.transcripts[id]
    }
  }

  writeStore(data)
}

export function appendPermissionAudit(entry: PermissionAuditEntry): PermissionAuditEntry[] {
  const data = readStore()
  data.permissionAudit = [entry, ...data.permissionAudit].slice(0, 200)
  writeStore(data)
  return data.permissionAudit
}

export function getPermissionAudit(): PermissionAuditEntry[] {
  return readStore().permissionAudit
}
