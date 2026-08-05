import fs from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type ChatMessage,
  type PermissionAuditEntry,
  type PermissionMode,
  type ProjectContext,
  type ProjectNotes,
  type SessionInfo
} from '../../shared/types'
import { isChatWorkspace, normalizePath } from '../../shared/path'
import { normalizePermissionMode } from './agent-args'
import {
  BACKUP_FILE,
  STORE_FILE,
  backupStorePath,
  storePath,
  writeFileAtomicSync
} from './data-dir'
import { redactPreview, redactValue } from './redact'

/**
 * What actually lands in gronk-store.json. `alwaysApprove` is absent on purpose:
 * it is a view of `permissionMode === 'bypassPermissions'`, and keeping a second
 * copy of one security fact is what let them disagree — a store holding
 * `bypassPermissions` with `alwaysApprove: false` still spawned the child with
 * `--always-approve` while the in-app toggle read off.
 */
type StoredSettings = Omit<AppSettings, 'alwaysApprove'>

/**
 * Shape of the JSON on disk. Bump only with a matching `migrate` step.
 *
 * v1 is everything shipped so far, versioned or not: the field was added after
 * the fact, so a file without it is already v1 and is stamped on the next write.
 */
const SCHEMA_VERSION = 1

interface StoreData {
  version: number
  settings: StoredSettings
  recentProjects: ProjectContext[]
  sessions: SessionInfo[]
  /** sessionId -> chat messages (local transcript cache) */
  transcripts: Record<string, ChatMessage[]>
  permissionAudit: PermissionAuditEntry[]
  /**
   * normalized project cwd -> scratchpad text.
   *
   * Its own key rather than a field on `recentProjects` because that list is
   * capped and pruned; see the ProjectNotes doc in shared/types.ts. Nothing
   * evicts from here, so a note outlives the rail row it was written beside.
   */
  projectNotes: ProjectNotes
}

/** Store as read off disk: older files also carried the now-derived field. */
interface RawStore extends Partial<Omit<StoreData, 'settings' | 'version'>> {
  version?: number
  settings?: Partial<AppSettings>
}

/** Where the data actually came from — see getStoreHealth. */
export type StoreSource = 'file' | 'backup' | 'fresh' | 'unrecoverable'

export interface StoreHealth {
  source: StoreSource
  /** True when something was on disk that could not be read as written. */
  degraded: boolean
  message?: string
  /** The unreadable file, kept for manual rescue. Never deleted by the store. */
  corruptPath?: string
  schemaVersion: number
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

/**
 * Same, for an incoming patch — `alwaysApprove` folds onto the mode instead.
 *
 * Keys carrying `undefined` are dropped as well. Spreading them over the stored
 * settings makes "key present but undefined" erase a persisted value:
 * `{ alwaysApproveAck: undefined }` — which is what an optional field, an IPC
 * round-trip or a renderer spread produces by accident — wiped the
 * acknowledgement and took YOLO down with it. Absent and undefined therefore both
 * mean "leave it alone"; a deliberate revoke sends `false`, which still lands.
 */
function toStoredPatch(partial: Partial<AppSettings>): Partial<StoredSettings> {
  const { alwaysApprove: _derived, ...rest } = partial
  const patch: Partial<StoredSettings> = { ...rest }
  for (const key of Object.keys(patch) as Array<keyof StoredSettings>) {
    if (patch[key] === undefined) delete patch[key]
  }
  return patch
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
 *
 * The mode itself is validated first: the file is user-writable and its
 * `permissionMode` becomes the value of `--permission-mode`, so an unknown string
 * must never survive the read (normalizePermissionMode explains what grok does
 * with one).
 */
function normalizeStoredSettings(raw: Partial<AppSettings> | undefined): StoredSettings {
  const merged = toStored({ ...DEFAULT_SETTINGS, ...raw })
  const settings: StoredSettings = {
    ...merged,
    permissionMode: normalizePermissionMode(merged.permissionMode)
  }
  if (settings.permissionMode !== 'bypassPermissions') return settings
  if (raw?.alwaysApprove === false || !settings.alwaysApproveAck) {
    return { ...settings, permissionMode: 'default' }
  }
  return settings
}

function emptyStore(): StoreData {
  return {
    version: SCHEMA_VERSION,
    settings: { ...DEFAULT_STORED_SETTINGS },
    recentProjects: [],
    sessions: [],
    transcripts: {},
    permissionAudit: [],
    projectNotes: {}
  }
}

type ReadOutcome =
  | { kind: 'missing' }
  | { kind: 'ok'; raw: RawStore }
  | { kind: 'bad'; error: string }

/**
 * Read one store file, keeping "there is nothing here" apart from "there is
 * something here and it is broken". Collapsing those two is what let a truncated
 * file look exactly like a fresh install.
 */
function readJsonFile(file: string): ReadOutcome {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
    return { kind: 'bad', error: (err as Error).message }
  }
  try {
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { kind: 'bad', error: 'the store is not a JSON object' }
    }
    return { kind: 'ok', raw: parsed as RawStore }
  } catch (err) {
    return { kind: 'bad', error: (err as Error).message }
  }
}

/**
 * Migration hook. A future format change adds its step here rather than
 * scattering "if this key looks old" tests through the readers.
 *
 * A file stamped NEWER than this build is read with the fields we know instead
 * of being rejected: refusing to open would be indistinguishable from data loss
 * to the user. It is re-stamped on the next write, so keys this build has never
 * heard of do not survive a downgrade — flagged in the health message rather
 * than hidden.
 */
function migrate(raw: RawStore, from: number): RawStore {
  if (from === SCHEMA_VERSION) return raw
  return raw
}

/** A `{ key: string }` map and nothing else: not an array, not a prototype trick. */
function isPlainRecord(value: unknown): value is ProjectNotes {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return false
  return Object.values(value as Record<string, unknown>).every((v) => typeof v === 'string')
}

function fromRaw(raw: RawStore): StoreData {
  const from = typeof raw.version === 'number' ? raw.version : SCHEMA_VERSION
  const data = migrate(raw, from)
  return {
    version: SCHEMA_VERSION,
    settings: normalizeStoredSettings(data.settings),
    recentProjects: data.recentProjects ?? [],
    sessions: data.sessions ?? [],
    transcripts: data.transcripts ?? {},
    permissionAudit: data.permissionAudit ?? [],
    // Guarded rather than defaulted: the file is user-writable, and every reader
    // of this one iterates its keys.
    projectNotes: isPlainRecord(data.projectNotes) ? data.projectNotes : {}
  }
}

let health: StoreHealth = { source: 'fresh', degraded: false, schemaVersion: SCHEMA_VERSION }

/**
 * Set when the main store could not be parsed. The unreadable bytes are copied
 * aside on the next write instead of during the read: a read must not mutate the
 * data directory, and until something is written the file is still sitting there
 * untouched for anyone who wants to rescue it by hand.
 */
let quarantineOnNextWrite: string | null = null

function setHealth(next: Omit<StoreHealth, 'schemaVersion'>): void {
  health = { ...next, schemaVersion: SCHEMA_VERSION }
}

/**
 * Load the store, preferring the main file, then the backup, and only then
 * empty defaults.
 *
 * The old version caught every failure and returned defaults, so a store
 * truncated by a crash opened the app with zero sessions and no complaint —
 * from the user's seat, identical to "the update wiped my data". The corrupt
 * file is never overwritten here: destroying it would take the evidence and the
 * last chance of a manual rescue with it.
 */
function readStore(): StoreData {
  const file = storePath()
  const main = readJsonFile(file)
  if (main.kind === 'ok') {
    setHealth({ source: 'file', degraded: false })
    return fromRaw(main.raw)
  }

  const backupFile = backupStorePath()
  const backup = readJsonFile(backupFile)
  if (main.kind === 'bad') quarantineOnNextWrite = file

  if (backup.kind === 'ok') {
    setHealth({
      source: 'backup',
      degraded: true,
      message:
        main.kind === 'bad'
          ? `${STORE_FILE} could not be read (${main.error}). Recovered the previous copy from ${BACKUP_FILE}; anything from the last save may be missing.`
          : `${STORE_FILE} was missing. Recovered the previous copy from ${BACKUP_FILE}.`,
      ...(main.kind === 'bad' ? { corruptPath: file } : {})
    })
    return fromRaw(backup.raw)
  }

  if (main.kind === 'missing' && backup.kind === 'missing') {
    setHealth({ source: 'fresh', degraded: false })
    return emptyStore()
  }

  setHealth({
    source: 'unrecoverable',
    degraded: true,
    message:
      `Could not read ${STORE_FILE}` +
      (main.kind === 'bad' ? ` (${main.error})` : ' (missing)') +
      ` or ${BACKUP_FILE}` +
      (backup.kind === 'bad' ? ` (${backup.error})` : ' (missing)') +
      '. Starting empty — the unreadable files were left in place.',
    corruptPath: main.kind === 'bad' ? file : backupFile
  })
  return emptyStore()
}

/**
 * What is on disk right now, so the UI can warn about a recovery instead of
 * quietly showing an empty session list.
 *
 * Reads rather than reporting the last load: the data directory can move under
 * the app, and a stale "everything is fine" is the exact failure this whole
 * mechanism exists to stop.
 */
export function getStoreHealth(): StoreHealth {
  readStore()
  return health
}

/** Roll the current store forward into the one retained backup. */
function refreshBackup(file: string): void {
  try {
    if (fs.statSync(file).size === 0) return
    fs.copyFileSync(file, backupStorePath())
  } catch {
    /* no store yet (or it just vanished) — nothing to back up */
  }
}

function quarantineUnreadable(file: string): void {
  try {
    const kept = path.join(path.dirname(file), `gronk-store.corrupt-${Date.now()}.json`)
    fs.copyFileSync(file, kept)
  } catch {
    /* best effort: failing to keep evidence must not block the save */
  }
}

/**
 * Persist the store without ever exposing a half-written file.
 *
 * Two rules do the work: the previous good copy is rolled into the backup first,
 * and the new copy lands via temp-file + fsync + rename (writeFileAtomicSync).
 * A crash therefore leaves either the old store or the new one, and the backup
 * covers the case where the filesystem loses the main file entirely.
 */
function writeStore(data: StoreData): void {
  const file = storePath()
  const corrupt = quarantineOnNextWrite
  quarantineOnNextWrite = null

  // `corrupt !== file` means the data directory moved since that read; the flag
  // belongs to a store we are no longer writing.
  if (corrupt && corrupt === file) {
    // The file about to be replaced could not be parsed. Keep a copy for manual
    // rescue and leave the backup alone: the backup is either what we just
    // recovered from or the only other candidate, so overwriting it with the
    // unreadable bytes would burn the last chance of getting anything back.
    quarantineUnreadable(file)
  } else {
    refreshBackup(file)
  }

  writeFileAtomicSync(file, JSON.stringify({ ...data, version: SCHEMA_VERSION }, null, 2))
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
 *
 * Exported because the per-start YOLO override (`gronk:start-agent`) is the same
 * question asked for one boot instead of for the stored settings. It must fold by
 * the same rule: a second copy of it in agent-manager is a second place for the
 * toggle and the mode to disagree, which is the drift this collapse removed.
 */
export function requestedPermissionMode(
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
  // Validate what the patch asked for: the renderer is not the only caller and an
  // unknown mode would be persisted and later handed to `--permission-mode`.
  const requested = normalizePermissionMode(
    requestedPermissionMode(partial, data.settings.permissionMode)
  )
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

/** Pinned first, then most-recently-used order among the rest. */
function sortRecentProjects(list: ProjectContext[]): ProjectContext[] {
  const pinned: ProjectContext[] = []
  const rest: ProjectContext[] = []
  for (const p of list) {
    if (p.pinned) pinned.push(p)
    else rest.push(p)
  }
  return [...pinned, ...rest]
}

export function getRecentProjects(): ProjectContext[] {
  const data = readStore()
  const filtered = sortRecentProjects(filterOutChatProjects(data.recentProjects))
  if (
    filtered.length !== data.recentProjects.length ||
    filtered.some((p, i) => p.cwd !== data.recentProjects[i]?.cwd || !!p.pinned !== !!data.recentProjects[i]?.pinned)
  ) {
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
    return getRecentProjects()
  }
  const name = path.basename(normalized) || normalized
  const prev = data.recentProjects.find((p) => normalizeCwd(p.cwd) === normalized)
  const entry: ProjectContext = {
    cwd: normalized,
    name,
    pinned: prev?.pinned
  }
  data.recentProjects = sortRecentProjects(
    filterOutChatProjects([
      entry,
      ...data.recentProjects.filter((p) => normalizeCwd(p.cwd) !== normalized)
    ])
  ).slice(0, 12)
  writeStore(data)
  return data.recentProjects
}

/**
 * Drop a folder from the recent list only. Does not delete the directory or
 * any sessions — those stay until the user archives or deletes them.
 */
export function removeRecentProject(cwd: string): ProjectContext[] {
  const data = readStore()
  const normalized = normalizeCwd(cwd)
  data.recentProjects = sortRecentProjects(
    filterOutChatProjects(data.recentProjects.filter((p) => normalizeCwd(p.cwd) !== normalized))
  )
  writeStore(data)
  return data.recentProjects
}

export function setRecentProjectPinned(cwd: string, pinned: boolean): ProjectContext[] {
  const data = readStore()
  const normalized = normalizeCwd(cwd)
  let found = false
  data.recentProjects = sortRecentProjects(
    filterOutChatProjects(
      data.recentProjects.map((p) => {
        if (normalizeCwd(p.cwd) !== normalized) return p
        found = true
        return { ...p, pinned: pinned || undefined }
      })
    )
  )
  if (!found) return getRecentProjects()
  writeStore(data)
  return data.recentProjects
}

export function getProjectNotes(): ProjectNotes {
  return readStore().projectNotes
}

/**
 * Write one project's scratchpad. An empty note forgets it entirely.
 *
 * Stored exactly as given. The note is the user's own writing, so it is NOT
 * redacted and NOT truncated, the same rule message text follows (FIX-R1): a
 * scratchpad that silently rewrites what you typed is worse than no scratchpad.
 * Trimming the ends is the renderer's job (`normalizeNote`), and `''` arriving
 * here is what "forget this note" looks like on the wire, which is why the key
 * is deleted rather than left holding an empty string for every folder ever
 * opened.
 */
export function setProjectNote(cwd: string, note: string): ProjectNotes {
  const data = readStore()
  const normalized = normalizeCwd(cwd)
  if (note) data.projectNotes[normalized] = note
  else delete data.projectNotes[normalized]
  writeStore(data)
  return data.projectNotes
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

/**
 * Every non-archived session paired with its transcript, from ONE store read.
 *
 * Search needed sessions plus every transcript. Composing that from
 * listSessions() and getTranscript() re-read and re-parsed the entire store file
 * once per session, on every keystroke — 10 full parses of a 200 KB file for 9
 * sessions, and it grows linearly. This reads once.
 *
 * Deliberately does NOT heal duplicate messages the way getTranscript does:
 * this is a read-only query on a debounced path, and writing the store back on
 * every keystroke is exactly what a search must never do.
 */
export function listSessionsWithTranscripts(): Array<{
  session: SessionInfo
  messages: ChatMessage[]
}> {
  const data = readStore()
  const sessions = dedupeSessions(data.sessions).slice(0, 50).map(withResolvedSurface)
  return sessions
    .filter((s) => !s.archived)
    .map((session) => ({
      session,
      messages: dedupeTranscriptMessages(data.transcripts[session.id] ?? [])
    }))
}
