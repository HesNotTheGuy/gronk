import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type ChatMessage,
  type PermissionAuditEntry,
  type PermissionMode,
  type ProjectContext,
  type SessionInfo
} from '../../shared/types'
import { isChatWorkspace, normalizePath } from '../../shared/path'
import { redactPreview, redactValue } from './redact'

/**
 * What actually lands in grocky-store.json. `alwaysApprove` is absent on purpose:
 * it is a view of `permissionMode === 'bypassPermissions'`, and keeping a second
 * copy of one security fact is what let them disagree — a store holding
 * `bypassPermissions` with `alwaysApprove: false` still spawned the child with
 * `--always-approve` while the in-app toggle read off.
 */
type StoredSettings = Omit<AppSettings, 'alwaysApprove'>

interface StoreData {
  settings: StoredSettings
  recentProjects: ProjectContext[]
  sessions: SessionInfo[]
  /** sessionId -> chat messages (local transcript cache) */
  transcripts: Record<string, ChatMessage[]>
  permissionAudit: PermissionAuditEntry[]
}

/** Store as read off disk: older files also carried the now-derived field. */
interface RawStore extends Partial<Omit<StoreData, 'settings'>> {
  settings?: Partial<AppSettings>
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

/** Drop the derived field so it never reaches disk. */
function toStored(settings: AppSettings): StoredSettings {
  const { alwaysApprove: _derived, ...stored } = settings
  return stored
}

/** Same, for an incoming patch — `alwaysApprove` folds onto the mode instead. */
function toStoredPatch(partial: Partial<AppSettings>): Partial<StoredSettings> {
  const { alwaysApprove: _derived, ...rest } = partial
  return rest
}

/** Re-derive `alwaysApprove` for callers; the renderer reads it off AppSettings. */
function withDerived(settings: StoredSettings): AppSettings {
  return {
    ...settings,
    alwaysApprove: settings.permissionMode === 'bypassPermissions'
  }
}

const DEFAULT_STORED_SETTINGS: StoredSettings = toStored(DEFAULT_SETTINGS)

/**
 * Resolve a settings block read off disk onto the single stored permission fact.
 *
 * Older builds persisted `alwaysApprove` beside `permissionMode`, so a file can
 * hold any combination. Resolution is fail-safe — when the pair disagrees the
 * value granting LESS access wins:
 * - `bypassPermissions` + `alwaysApprove: false` -> `default` (the drift that
 *   used to boot `--always-approve` with the in-app toggle showing off)
 * - `alwaysApprove: true` beside a gated mode -> the gated mode survives; a
 *   stray legacy flag never promotes a session to bypass
 * - `bypassPermissions` with no acknowledgement on disk -> `default`, so a
 *   hand-edited or pre-FIX-14 file cannot launch straight into YOLO
 *
 * A file written by this build has no `alwaysApprove` key at all, so only the
 * ack gate applies to it.
 */
function normalizeStoredSettings(raw: Partial<AppSettings> | undefined): StoredSettings {
  const settings = toStored({ ...DEFAULT_SETTINGS, ...raw })
  if (settings.permissionMode !== 'bypassPermissions') return settings
  if (raw?.alwaysApprove === false || !settings.alwaysApproveAck) {
    return { ...settings, permissionMode: 'default' }
  }
  return settings
}

function readStore(): StoreData {
  try {
    const raw = fs.readFileSync(storePath(), 'utf8')
    const data = JSON.parse(raw) as RawStore
    return {
      settings: normalizeStoredSettings(data.settings),
      recentProjects: data.recentProjects ?? [],
      sessions: data.sessions ?? [],
      transcripts: data.transcripts ?? {},
      permissionAudit: data.permissionAudit ?? []
    }
  } catch {
    return {
      settings: { ...DEFAULT_STORED_SETTINGS },
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
  return withDerived(readStore().settings)
}

/**
 * Fold a settings patch down to the one mode it asks for.
 *
 * `alwaysApprove` in a patch is the UI's YOLO toggle — shorthand for
 * `permissionMode: 'bypassPermissions'`, or for leaving it when false. A patch
 * carrying only the toggle is the user flipping the switch, so it wins over the
 * stored mode. A patch carrying BOTH and disagreeing with itself resolves
 * towards less access, so no call can turn bypass on as a side effect.
 */
function requestedPermissionMode(
  partial: Partial<AppSettings>,
  stored: PermissionMode
): PermissionMode {
  const { permissionMode: mode, alwaysApprove: yolo } = partial
  if (yolo === undefined) return mode ?? stored
  if (mode === undefined) {
    if (yolo) return 'bypassPermissions'
    return stored === 'bypassPermissions' ? 'default' : stored
  }
  // Both supplied: honour them when they agree, otherwise take the gated side.
  if (yolo === (mode === 'bypassPermissions')) return mode
  return mode === 'bypassPermissions' ? 'default' : mode
}

export function setSettings(partial: Partial<AppSettings>): AppSettings {
  const data = readStore()
  // FIX-14: require ack already on disk before enabling YOLO (not same-partial ack+enable)
  const priorAck = !!data.settings.alwaysApproveAck
  const merged: StoredSettings = {
    ...DEFAULT_STORED_SETTINGS,
    ...data.settings,
    ...toStoredPatch(partial)
  }

  // permissionMode is the whole permission state; alwaysApprove is derived from
  // it on the way out, so there is nothing left here to keep "in sync".
  //
  // Only `priorAck` (the ack ALREADY on disk) may unlock YOLO. Reading
  // `merged.alwaysApproveAck` alone would accept an ack supplied in this same
  // call, which is exactly the one-shot self-authorization FIX-14 exists to
  // stop. The UI acknowledges and enables in two separate calls (`confirmYolo`).
  // The merged ack is required on top of it so that revoking the ack in this
  // call also drops bypass, instead of leaving a state the next read undoes.
  const ackAllowsBypass = priorAck && !!merged.alwaysApproveAck
  const requested = requestedPermissionMode(partial, data.settings.permissionMode)
  merged.permissionMode =
    requested === 'bypassPermissions' && !ackAllowsBypass ? 'default' : requested

  // Explicit clear of optional string fields
  if ('grokBinary' in partial && !partial.grokBinary) {
    delete merged.grokBinary
  }
  if ('model' in partial && !partial.model) {
    delete merged.model
  }

  data.settings = merged
  writeStore(data)
  return withDerived(data.settings)
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
