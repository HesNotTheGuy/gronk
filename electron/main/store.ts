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
import { isChatWorkspace, normalizePath } from '../../shared/path'
import { redactPreview, redactValue } from './redact'

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

/** Resolve + slash-normalize so G:\foo and G:/foo match (main process). */
export function normalizeCwd(cwd: string): string {
  try {
    return normalizePath(path.resolve(cwd)) || cwd
  } catch {
    return normalizePath(cwd)
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
  // FIX-14: require ack already on disk before enabling YOLO (not same-partial ack+enable)
  const priorAck = !!data.settings.alwaysApproveAck
  const merged: AppSettings = {
    ...DEFAULT_SETTINGS,
    ...data.settings,
    ...partial
  }

  // Keep permissionMode ↔ alwaysApprove in sync
  if (partial.permissionMode === 'bypassPermissions') {
    if (priorAck || merged.alwaysApproveAck) {
      merged.alwaysApprove = true
    } else {
      merged.permissionMode = 'default'
      merged.alwaysApprove = false
    }
  } else if (partial.permissionMode) {
    merged.alwaysApprove = false
  }

  if (partial.alwaysApprove === true) {
    if (priorAck || merged.alwaysApproveAck) {
      merged.alwaysApprove = true
      merged.permissionMode = 'bypassPermissions'
    } else {
      merged.alwaysApprove = false
      if (merged.permissionMode === 'bypassPermissions') {
        merged.permissionMode = 'default'
      }
    }
  } else if (partial.alwaysApprove === false) {
    merged.alwaysApprove = false
    if (merged.permissionMode === 'bypassPermissions') {
      merged.permissionMode = 'default'
    }
  }

  // Explicit clear of optional string fields
  if ('grokBinary' in partial && !partial.grokBinary) {
    delete merged.grokBinary
  }
  if ('model' in partial && !partial.model) {
    delete merged.model
  }

  data.settings = merged
  writeStore(data)
  return data.settings
}

/** Never list the app chat sandbox as a coding folder. */
function filterOutChatProjects(projects: ProjectContext[]): ProjectContext[] {
  return projects.filter((p) => !isChatWorkspace(p.cwd, null))
}

/** Stamp surface on sessions that live in chat-workspace (migrate old store rows). */
function withResolvedSurface(s: SessionInfo): SessionInfo {
  if (isChatWorkspace(s.cwd, null)) {
    return { ...s, surface: 'chat' }
  }
  if (!s.surface) {
    return { ...s, surface: 'project' }
  }
  // Path wins: never keep surface=project for chat sandbox
  if (s.surface === 'project' && isChatWorkspace(s.cwd, null)) {
    return { ...s, surface: 'chat' }
  }
  return s
}

export function getRecentProjects(): ProjectContext[] {
  const data = readStore()
  const filtered = filterOutChatProjects(data.recentProjects)
  if (filtered.length !== data.recentProjects.length) {
    data.recentProjects = filtered
    writeStore(data)
  }
  return filtered
}

export function addRecentProject(cwd: string): ProjectContext[] {
  const data = readStore()
  const normalized = normalizeCwd(cwd)
  // Chat is app-local — never a Workspace folder
  if (isChatWorkspace(normalized, null)) {
    return filterOutChatProjects(data.recentProjects)
  }
  const name = path.basename(normalized) || normalized
  const entry: ProjectContext = { cwd: normalized, name }
  data.recentProjects = filterOutChatProjects([
    entry,
    ...data.recentProjects.filter((p) => normalizeCwd(p.cwd) !== normalized)
  ]).slice(0, 12)
  writeStore(data)
  return data.recentProjects
}

export function listSessions(): SessionInfo[] {
  const data = readStore()
  const cleaned = dedupeSessions(data.sessions).slice(0, 50).map(withResolvedSurface)
  const changed =
    cleaned.length !== data.sessions.length ||
    cleaned.some(
      (s, i) =>
        s.id !== data.sessions[i]?.id ||
        s.cwd !== data.sessions[i]?.cwd ||
        s.surface !== data.sessions[i]?.surface
    )
  if (changed) {
    data.sessions = cleaned
    writeStore(data)
  }
  return cleaned
}

export function upsertSession(session: SessionInfo): SessionInfo {
  const data = readStore()
  data.sessions = dedupeSessions(data.sessions)

  const cwd = normalizeCwd(session.cwd)
  // Always tag chat-workspace sessions as chat (app-local storage path)
  const surface =
    isChatWorkspace(cwd, null) || session.surface === 'chat' ? 'chat' : 'project'

  const normalized: SessionInfo = {
    ...session,
    cwd,
    surface
  }

  const idx = data.sessions.findIndex((s) => s.id === normalized.id)
  if (idx >= 0) {
    const prev = data.sessions[idx]
    data.sessions[idx] = {
      ...prev,
      ...normalized,
      createdAt: prev.createdAt || normalized.createdAt,
      title: normalized.title || prev.title,
      surface,
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

export function deleteSession(sessionId: string): SessionInfo[] {
  const data = readStore()
  data.sessions = data.sessions.filter((s) => s.id !== sessionId)
  delete data.transcripts[sessionId]
  writeStore(data)
  return listSessions()
}

export function renameSession(sessionId: string, title: string): SessionInfo | null {
  const data = readStore()
  const idx = data.sessions.findIndex((s) => s.id === sessionId)
  if (idx < 0) return null
  const trimmed = title.trim().slice(0, 120)
  if (!trimmed) return data.sessions[idx]
  data.sessions[idx] = {
    ...data.sessions[idx],
    title: trimmed,
    updatedAt: Date.now()
  }
  writeStore(data)
  return data.sessions[idx]
}

export function archiveSession(
  sessionId: string,
  archived = true
): SessionInfo | null {
  const data = readStore()
  const idx = data.sessions.findIndex((s) => s.id === sessionId)
  if (idx < 0) return null
  data.sessions[idx] = {
    ...data.sessions[idx],
    archived,
    archivedAt: archived ? Date.now() : undefined,
    updatedAt: Date.now()
  }
  writeStore(data)
  return data.sessions[idx]
}

/**
 * FIX-R7: drop echoed user turns saved as [user X, assistant, user X].
 * A user message is dropped when its text matches the previous user message and
 * only assistant/system turns sit between them.
 */
export function dedupeTranscriptMessages(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length < 2) return messages
  const out: ChatMessage[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      let lastUserIdx = -1
      for (let i = out.length - 1; i >= 0; i--) {
        if (out[i].role === 'user') {
          lastUserIdx = i
          break
        }
      }
      if (lastUserIdx >= 0) {
        const prev = out[lastUserIdx]
        const sameText = (prev.text || '').trim() === (m.text || '').trim()
        if (sameText && (prev.text || '').trim().length > 0) {
          const between = out.slice(lastUserIdx + 1)
          if (
            between.length > 0 &&
            between.every((b) => b.role === 'assistant' || b.role === 'system')
          ) {
            continue
          }
        }
      }
    }
    out.push(m)
  }
  return out
}

export function getTranscript(sessionId: string): ChatMessage[] {
  const data = readStore()
  const raw = data.transcripts[sessionId] ?? []
  const cleaned = dedupeTranscriptMessages(raw)
  // Heal store once if old dups were present
  if (cleaned.length !== raw.length) {
    data.transcripts[sessionId] = cleaned
    const idx = data.sessions.findIndex((s) => s.id === sessionId)
    if (idx >= 0) {
      data.sessions[idx] = {
        ...data.sessions[idx],
        messageCount: cleaned.length,
        userTurns: cleaned.filter((m) => m.role === 'user').length
      }
    }
    writeStore(data)
  }
  return cleaned
}

export function saveTranscript(sessionId: string, messages: ChatMessage[]): void {
  const data = readStore()
  // Cap session length. Message text/thought are the user's own conversation on
  // their machine — do NOT redact or truncate them (FIX-R1). Secrets still stay
  // out of tool payloads (FIX-7) and the permission audit log.
  // FIX-R7: de-dupe echoed user turns before persist.
  const trimmed = dedupeTranscriptMessages(messages).slice(-200).map((m) => ({
    ...m,
    streaming: false,
    // Don't persist transient send pipeline state as "failed" forever after a good turn
    sendStatus:
      m.role === 'user' && m.sendStatus === 'failed' ? ('failed' as const) : ('sent' as const),
    text: m.text,
    thought: m.thought,
    toolCalls: m.toolCalls?.map((t) => ({
      ...t,
      content: redactValue(t.content),
      rawInput: redactValue(t.rawInput)
    }))
  }))
  data.transcripts[sessionId] = trimmed

  // Activity counters for home / browse frequency UI
  const idx = data.sessions.findIndex((s) => s.id === sessionId)
  if (idx >= 0) {
    data.sessions[idx] = {
      ...data.sessions[idx],
      messageCount: trimmed.length,
      userTurns: trimmed.filter((m) => m.role === 'user').length,
      updatedAt: Date.now()
    }
  }

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
  const safe: PermissionAuditEntry = {
    ...entry,
    rawInputPreview: entry.rawInputPreview
      ? redactPreview(entry.rawInputPreview, 500)
      : undefined,
    title: entry.title ? String(redactValue(entry.title)).slice(0, 200) : entry.title
  }
  data.permissionAudit = [safe, ...data.permissionAudit].slice(0, 200)
  writeStore(data)
  return data.permissionAudit
}

export function getPermissionAudit(): PermissionAuditEntry[] {
  return readStore().permissionAudit
}
