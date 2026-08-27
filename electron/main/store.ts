import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type ChatMessage,
  type PermissionMode,
  type ProjectContext,
  type ProjectNotes,
  type SessionInfo,
  type ToolCallInfo
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
import { applyRedactionPolicy, redactValue, type RedactionPolicy } from './redact'
import { parkAttachmentBytes, repairTranscript, slimAttachments } from './transcript-repair'

// Permission audit lives in its own file (permission-audit.ts). Re-exported so
// callers that import from store keep working without a whole-store rewrite
// per decision.
export { appendPermissionAudit, getPermissionAudit } from './permission-audit'

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
 *
 * v2 repairs two things v1 wrote without bound: tool calls duplicated across
 * messages by the history-replay routing, and image attachments held twice in
 * full base64. See transcript-repair.ts. Nothing is truncated and no message is
 * removed; a v1 file and its v2 form hold the same conversation.
 */
const SCHEMA_VERSION = 2

interface StoreData {
  version: number
  settings: StoredSettings
  recentProjects: ProjectContext[]
  sessions: SessionInfo[]
  /** sessionId -> chat messages (local transcript cache) */
  transcripts: Record<string, ChatMessage[]>
  /**
   * normalized project cwd -> scratchpad text.
   *
   * Its own key rather than a field on `recentProjects` because that list is
   * capped and pruned; see the ProjectNotes doc in shared/types.ts. Nothing
   * evicts from here, so a note outlives the rail row it was written beside.
   */
  projectNotes: ProjectNotes
}

/**
 * Store as read off disk. `permissionAudit` may still appear on older files; it
 * is migrated into gronk-permission-audit.json on first audit access and is
 * never written back (not part of StoreData).
 */
interface RawStore extends Partial<Omit<StoreData, 'settings' | 'version'>> {
  version?: number
  settings?: Partial<AppSettings>
  /** Legacy key — handled by permission-audit.ts, not kept on StoreData. */
  permissionAudit?: unknown
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
 *   hand-edited file without acknowledgement cannot launch straight into YOLO
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
  if (from < 2 && raw.transcripts) {
    const repaired: Record<string, ChatMessage[]> = {}
    for (const [sessionId, messages] of Object.entries(raw.transcripts)) {
      repaired[sessionId] = Array.isArray(messages)
        ? repairTranscript(messages, parkAttachmentBytes)
        : messages
    }
    return { ...raw, transcripts: repaired }
  }
  return raw
}

/** A `{ key: string }` map and nothing else: not an array, not a prototype trick. */
/**
 * A map of string to string — project notes, specifically. The name undersells the
 * constraint: every value must be a string, so this answers false for any other
 * record shape. Do not reach for it as a general "is this a plain object".
 */
function isPlainRecord(value: unknown): value is ProjectNotes {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return false
  return Object.values(value as Record<string, unknown>).every((v) => typeof v === 'string')
}

/**
 * The version stamped on a file. An unversioned file is v1: the field was added
 * after v1 shipped, so its absence means "written before there was a version",
 * never "current".
 */
function storedVersion(raw: RawStore): number {
  return typeof raw.version === 'number' && Number.isFinite(raw.version) ? raw.version : 1
}

function fromRaw(raw: RawStore): StoreData {
  const from = storedVersion(raw)
  const data = migrate(raw, from)
  return {
    version: SCHEMA_VERSION,
    settings: normalizeStoredSettings(data.settings),
    recentProjects: data.recentProjects ?? [],
    sessions: data.sessions ?? [],
    transcripts: data.transcripts ?? {},
    // Guarded rather than defaulted: the file is user-writable, and every reader
    // of this one iterates its keys.
    // permissionAudit is deliberately omitted: legacy keys are migrated out by
    // permission-audit.ts and dropped from disk on this next writeStore.
    projectNotes: isPlainRecord(data.projectNotes) ? data.projectNotes : {}
  }
}

/**
 * Where one conversation lives on disk.
 *
 * Transcripts used to be a map inside the store file, so saving one turn meant
 * serialising and writing every conversation the user had ever had. Measured on a
 * 7.5 MB store: 16.3 ms to stringify it, 15.6 ms to write and fsync it, per turn,
 * growing with the total rather than with what changed.
 *
 * One file each means a turn costs its own conversation. The rest of the store —
 * sessions, settings, recent projects, notes — is kilobytes and changes together,
 * so it stays in one file and its write stays cheap.
 */
const TRANSCRIPT_DIR = 'transcripts'

function transcriptDir(): string {
  return path.join(path.dirname(storePath()), TRANSCRIPT_DIR)
}

/** Session ids come from the CLI, so the name is derived rather than trusted. */
function transcriptFile(sessionId: string): string {
  const safe = crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 32)
  return path.join(transcriptDir(), `${safe}.json`)
}

function readTranscriptFile(sessionId: string): ChatMessage[] | null {
  try {
    const raw = JSON.parse(fs.readFileSync(transcriptFile(sessionId), 'utf8')) as unknown
    return Array.isArray(raw) ? (raw as ChatMessage[]) : null
  } catch {
    // Missing is the ordinary case for a session that has never been saved.
    return null
  }
}

function writeTranscriptFile(sessionId: string, messages: ChatMessage[]): void {
  fs.mkdirSync(transcriptDir(), { recursive: true })
  writeFileAtomicSync(transcriptFile(sessionId), JSON.stringify(messages))
}

/**
 * Remove one conversation from disk.
 *
 * Deleting a session used to leave its conversation in the store's backup for a
 * generation, and #44's collector leaned on that: a picture stayed "while
 * anything can still restore the conversation that used it". One file per
 * conversation means nothing can restore it — the file is the only copy — so the
 * reason for the delay is gone and the picture goes with the conversation.
 *
 * That is a change in timing, not in the rule. The rule was never "wait a
 * generation"; it was "do not collect a picture something can still restore".
 *
 * Two other designs were tried and are recorded on #64: leaving the file for the
 * prune makes a deleted session's pictures uncollectable forever, which is the bug
 * #40 was filed for; and retiring it aside for one launch reproduces the old grace
 * but gives the collector a fourth reference source, which moved ground its
 * ownership and quarantine checks stand on.
 */
function removeTranscriptFile(sessionId: string): void {
  try {
    fs.rmSync(transcriptFile(sessionId), { force: true })
  } catch {
    /* nothing to remove */
  }
}

/**
 * Move a store that still carries its transcripts inline out into files.
 *
 * Order matters and is the whole safety of it: every file is written and counted
 * first, and only then is the store rewritten without them. A crash before that
 * last write leaves the transcripts in BOTH places, which reads correctly and
 * migrates again next launch. A crash after it leaves them only in the files,
 * which is the destination.
 */
function splitTranscriptsToFiles(data: StoreData): boolean {
  const ids = Object.keys(data.transcripts)
  if (!ids.length) return false
  let written = 0
  for (const id of ids) {
    writeTranscriptFile(id, data.transcripts[id])
    written += 1
  }
  if (written !== ids.length) {
    throw new Error(`transcript split wrote ${written} of ${ids.length}`)
  }
  return true
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
/**
 * The store, held between calls, keyed by the path it was read from.
 *
 * `readStore` used to read and parse the file on every call, at eighteen call
 * sites, and that is what made the store's size everybody's problem: a 120 MB
 * file was re-read and re-parsed for a question as small as "what is the
 * theme". Keying on the path means relocating the data directory misses the
 * cache and re-reads, so there is nothing to invalidate by hand.
 *
 * The object is shared, not copied. Every mutating function in this file reads,
 * mutates and then writes, and `tests/store-cache.test.ts` pins that so a new
 * one cannot quietly mutate the cache and skip the write. A copy per read would
 * cost most of what the cache saves.
 *
 * Held with the file's size and modified time, and checked against them on every
 * read. See `heldCopyIsCurrent` for why that is not paranoia.
 */
let cached: { file: string; data: StoreData; mtimeMs: number; size: number } | null = null

/**
 * Is the held copy still what is on disk?
 *
 * A stat rather than an assumption. Nothing but this process writes the store,
 * so in ordinary use the answer is always yes — but "ordinary" is doing a lot of
 * work in that sentence: a torn write from a crash, a sync client, a second
 * instance, or someone editing the file by hand all leave the file saying
 * something the held copy does not. Reading a stale store is the failure this
 * whole change must not introduce, and a stat is a rounding error against the
 * read and parse it replaces.
 */
function heldCopyIsCurrent(file: string): boolean {
  if (!cached || cached.file !== file) return false
  try {
    const stat = fs.statSync(file)
    return stat.mtimeMs === cached.mtimeMs && stat.size === cached.size
  } catch {
    // Gone, or unreadable. Either way the held copy no longer describes it.
    return false
  }
}

function hold(file: string, data: StoreData): void {
  try {
    const stat = fs.statSync(file)
    cached = { file, data, mtimeMs: stat.mtimeMs, size: stat.size }
  } catch {
    // No file to compare against later, so do not claim to have one.
    cached = null
  }
}

/**
 * Set when the file on disk is an older schema than this build writes, so the
 * repair can happen once, deliberately, instead of inside every read.
 */
let repairNeeded = false

/**
 * Did the file that was read still carry its transcripts inline?
 *
 * Read off the disk read rather than off `data.transcripts`, which is a cache of
 * whatever has been asked for since — so checking that would make every startup
 * look like it needed splitting again.
 */
let splitNeeded = false

function readStore(): StoreData {
  const file = storePath()
  if (heldCopyIsCurrent(file)) return cached!.data
  const read = readStoreFromDisk(file)
  // Only a copy that came from the file is held. A fallback — the backup, or an
  // empty store — would otherwise be pinned against the stat of the file it
  // failed to read, so one transient failure (a scanner's lock, a cloud
  // placeholder that would not hydrate) would latch older or empty data for the
  // rest of the process and the next write would put it on disk over the real
  // thing. Re-reading costs a parse; getting this wrong costs the conversations.
  if (read.fromFile) hold(file, read.data)
  else cached = null
  return read.data
}

/**
 * Bring the file on disk up to the current schema, once.
 *
 * This used to run inside `readStore`, which meant an unrepaired store did a
 * full write on every read — and a write is the file copied to the backup, then
 * written to a temp file, fsynced and renamed, so on a large store it is several
 * hundred megabytes of disk work for a read. Repeating that is what put the
 * rename in the way of whatever scanner or indexer had one of those files open,
 * and the write that kept failing was the repair itself, so the version on disk
 * never advanced and the next read tried again.
 *
 * Call once at startup, before the window can ask for anything. Safe to call
 * again: it is a no-op once the file matches.
 */
export function repairStoreOnStartup(): void {
  const data = readStore()
  // A store written by an earlier build carries its transcripts inline. Splitting
  // them out is what makes a save cost one conversation instead of all of them.
  // The files are written and counted BEFORE the store is rewritten without them,
  // so a crash in between leaves them in both places — which reads correctly and
  // simply migrates again next launch.
  if (splitNeeded) splitTranscriptsToFiles(data)
  if (!repairNeeded && !splitNeeded) return
  writeStore(data)
  repairNeeded = false
  splitNeeded = false
}

function readStoreFromDisk(file: string): { data: StoreData; fromFile: boolean } {
  const main = readJsonFile(file)
  if (main.kind === 'ok') {
    setHealth({ source: 'file', degraded: false })
    const data = fromRaw(main.raw)
    repairNeeded = storedVersion(main.raw) < SCHEMA_VERSION
    // Checked directly rather than through `isPlainRecord`, whose contract is
    // narrower than its name: it also requires every value to be a string,
    // because it exists for project notes. Transcript values are arrays, so it
    // answers false and the split silently never happened.
    const inline = (main.raw as { transcripts?: unknown }).transcripts
    splitNeeded =
      !!inline &&
      typeof inline === 'object' &&
      !Array.isArray(inline) &&
      Object.keys(inline as Record<string, unknown>).length > 0
    return { data, fromFile: true }
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
    return { data: fromRaw(backup.raw), fromFile: false }
  }

  if (main.kind === 'missing' && backup.kind === 'missing') {
    setHealth({ source: 'fresh', degraded: false })
    return { data: emptyStore(), fromFile: false }
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
  return { data: emptyStore(), fromFile: false }
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
/**
 * Move the version being replaced into the backup slot.
 *
 * This was `copyFileSync`, on every write. A save therefore cost two passes over
 * the whole store — copy it, then write it — so one session gaining one message
 * rewrote every conversation the user had, twice. Measured before this change:
 * 6.5 ms per saved turn at 0.1 MB, 37.6 ms at 6.7 MB, rising with the total
 * rather than with what changed.
 *
 * A rename gives the same backup — the exact bytes that were the store a moment
 * ago — for no I/O at all. It is called from inside the atomic write, after the
 * replacement is durable and before it is committed, so a failed write leaves the
 * store and its backup both untouched.
 *
 * `EXDEV` cannot happen: both paths are in the data directory, which is one
 * filesystem, which is also why the temp file lives there.
 */
function rotateIntoBackup(file: string): void {
  try {
    if (fs.statSync(file).size === 0) return
    fs.renameSync(file, backupStorePath())
  } catch {
    /* no store yet, or it just vanished — nothing to keep */
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
  // The held copy IS the object the caller just mutated, so it already describes
  // something that is not on disk. Dropping it here means a write that throws
  // leaves the next read to go and find out what is actually there, rather than
  // serving the change as though it had been saved. Restored at the end on
  // success.
  cached = null

  // Read, not consumed: clearing it here lost it when the write threw, and the
  // next successful write would then take the `refreshBackup` branch and copy the
  // still-unreadable store over the one good backup — the copy the user's whole
  // history had just been recovered from. Cleared after the write lands.
  const corrupt = quarantineOnNextWrite

  // `corrupt !== file` means the data directory moved since that read; the flag
  // belongs to a store we are no longer writing.
  if (corrupt && corrupt === file) {
    // The file about to be replaced could not be parsed. Keep a copy for manual
    // rescue and leave the backup alone: the backup is either what we just
    // recovered from or the only other candidate, so overwriting it with the
    // unreadable bytes would burn the last chance of getting anything back.
    quarantineUnreadable(file)
  }

  // Transcripts are not in here. Each lives in its own file, written only when it
  // changes, which is what stops one turn costing a pass over every conversation.
  const { transcripts: _held, ...rest } = data
  writeFileAtomicSync(
    file,
    JSON.stringify({ ...rest, version: SCHEMA_VERSION }, null, 2),
    // Not before the write: rotating first would mean a failed write leaves no
    // store at all, and the app reporting a recovery the user did not need. The
    // quarantine branch above deliberately does not rotate — it keeps the
    // unreadable bytes aside and leaves the backup alone, because that backup is
    // what the history was just recovered from.
    corrupt && corrupt === file ? undefined : () => rotateIntoBackup(file)
  )
  // On disk now, and at this version, so a later read need not go looking.
  hold(file, data)
  repairNeeded = false
  quarantineOnNextWrite = null
  // Health used to be re-derived by the next read, which re-read the file and so
  // noticed that it had become good. A held copy means no such read happens, and
  // without this the app would go on reporting a store that was missing or
  // recovered from backup after it had been written successfully.
  setHealth({ source: 'file', degraded: false })
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
  // Require ack already on disk before enabling YOLO (not same-partial ack+enable).
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
  // call, which is the one-shot self-authorization path we block. The UI
  // acknowledges and enables in two separate calls (`confirmYolo`).
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
  // Absent is a real state, not a missing value: no flag is emitted and each model
  // uses its own default. Storing '' instead would put an empty string on the argv.
  if ('reasoningEffort' in partial && !partial.reasoningEffort) {
    delete merged.reasoningEffort
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
  const next = sortRecentProjects(
    filterOutChatProjects(
      data.recentProjects.map((p) => {
        if (normalizeCwd(p.cwd) !== normalized) return p
        found = true
        return { ...p, pinned: pinned || undefined }
      })
    )
  )
  // Assigned only on the path that goes on to write. The store object is shared
  // with every other reader, so mutating it and then returning early left the app
  // holding a list that was never saved.
  if (!found) return getRecentProjects()
  data.recentProjects = next
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
  removeTranscriptFile(sessionId)
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
 * Drop echoed user turns saved as [user X, assistant, user X].
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
  // Read from its own file the first time and hold it: `data.transcripts` is a
  // cache of what has been asked for, not the whole set.
  if (!data.transcripts[sessionId]) {
    const fromFile = readTranscriptFile(sessionId)
    if (fromFile) data.transcripts[sessionId] = fromFile
  }
  const raw = data.transcripts[sessionId] ?? []
  const cleaned = dedupeTranscriptMessages(raw)
  // Heal store once if old dups were present
  if (cleaned.length !== raw.length) {
    data.transcripts[sessionId] = cleaned
    // The conversation itself, not just the counts. `writeStore` no longer
    // persists transcripts, so healing without this would clean it on every read
    // and never keep the result.
    writeTranscriptFile(sessionId, cleaned)
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

/**
 * What is persisted from a tool call, field by field.
 *
 * Everything the agent supplies is redacted; the app's own identifiers and the
 * short human-facing label are kept. `title` comes from the CLI rather than from
 * a tool's output and is what the transcript reads as, so it stays as it is.
 *
 * The exhaustive `Record` is doing real work: a field added to `ToolCallInfo`
 * fails `npm run typecheck` here until somebody chooses. Nothing arrives at the
 * store file because it happened to be on the object.
 */
const TOOL_CALL_POLICY: RedactionPolicy<ToolCallInfo> = {
  toolCallId: 'keep',
  title: 'keep',
  // A bounded identifier the agent chose for its own tool (`spawn_subagent`), not
  // anything a tool produced. Strictly less revealing than `title`, which is kept
  // and carries the paths and command lines.
  name: 'keep',
  kind: 'keep',
  status: 'keep',
  rawInput: 'redact',
  content: 'redact',
  error: 'redact'
}

/** One tool call as it should sit in the store. */
export function redactToolCall(call: ToolCallInfo): ToolCallInfo {
  return applyRedactionPolicy(call, TOOL_CALL_POLICY)
}

/**
 * Reconcile a save against what is already stored, so a save can never be a
 * replacement.
 *
 * The write used to be `data.transcripts[id] = incoming`, which made every
 * caller's array the whole truth. That is how three of the maintainer's
 * conversations were replaced by a single message each: `persistLiveTranscript`
 * writes `liveMessages`, which starts empty on a boot, so resuming a session and
 * completing one turn wrote a one-message transcript over the stored one. The
 * ids had no overlap at all — it was not a trim, it was a different, shorter
 * conversation landing on top.
 *
 * This class of bug has been fixed here before, path by path, and there are
 * tests named for it ("a turn completing mid-restore saves the whole transcript,
 * not the tail"). It came back through a path nobody had pinned. So the rule is
 * enforced at the single write instead: history is not something callers
 * remember to preserve, it is something they cannot drop.
 *
 * What is allowed, and why each is not this bug:
 *
 * - Growing. The ordinary case.
 * - The 200-message cap. It shortens the INCOMING array while the stored one is
 *   already capped, so the lengths come out equal rather than shorter.
 * - Removing duplicates. Loses stored ids and introduces none, which is the same
 *   conversation with less repetition in it.
 *
 * What is refused: an empty save over a stored conversation, and a save that both
 * drops stored messages AND brings new ones while ending up shorter. That is not this conversation continuing. Rather than
 * discard the caller's messages too, the stored history is kept and anything
 * genuinely new is appended — so neither side of the disagreement loses anything.
 *
 * Deleting a conversation and archiving it are separate, named, and unaffected.
 */
export function keepHistory(stored: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  if (!stored.length) return incoming

  // Nothing offered over something stored. A degenerate subset, so the rule
  // below would wave it through on the grounds that it introduces no new
  // messages — and it is the worst shape of all. No caller has a reason to empty
  // a conversation: clearing one is `deleteSession`, which is named for it.
  if (!incoming.length) {
    console.error(`[store] refused an empty save over ${stored.length} stored messages`)
    return stored
  }

  const incomingIds = new Set(incoming.map((m) => m.id))
  const storedIds = new Set(stored.map((m) => m.id))
  const drops = stored.some((m) => !incomingIds.has(m.id))
  const adds = incoming.some((m) => !storedIds.has(m.id))

  if (!(drops && adds && incoming.length < stored.length)) return incoming

  const appended = incoming.filter((m) => !storedIds.has(m.id))
  console.error(
    `[store] refused to shrink transcript: ${stored.length} stored, ${incoming.length} offered; ` +
      `kept history and appended ${appended.length}`
  )
  return [...stored, ...appended].slice(-200)
}

export function saveTranscript(sessionId: string, messages: ChatMessage[]): void {
  const data = readStore()
  // Cap session length. Message text/thought are the user's own conversation on
  // their machine — do NOT redact or truncate them. Secrets still stay out of
  // tool payloads and the permission audit log. De-dupe echoed user turns
  // before persist.
  // Attachment bytes are parked on disk and replaced by a path BEFORE anything
  // else runs, so an image is written once rather than into every future save of
  // the same conversation. An image attachment carries no path when it is
  // created, so nothing here can be skipped as "already on disk".
  const slimmed = slimAttachments(dedupeTranscriptMessages(messages), parkAttachmentBytes)
  const trimmed = slimmed.slice(-200).map((m) => ({
    ...m,
    streaming: false,
    // Don't persist transient send pipeline state as "failed" forever after a good turn
    sendStatus:
      m.role === 'user' && m.sendStatus === 'failed' ? ('failed' as const) : ('sent' as const),
    text: m.text,
    thought: m.thought,
    toolCalls: m.toolCalls?.map(redactToolCall)
  }))
  const stored = data.transcripts[sessionId] ?? readTranscriptFile(sessionId) ?? []
  const next = keepHistory(stored, trimmed)
  data.transcripts[sessionId] = next
  writeTranscriptFile(sessionId, next)

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

  // Cap how many conversations are kept. The list to prune is now the directory
  // rather than a map in memory, because that map only holds what has been read.
  const keep = new Set(listSessions().map((s) => s.id))
  if (keep.size > 40) {
    for (const id of Object.keys(data.transcripts)) {
      if (!keep.has(id)) {
        delete data.transcripts[id]
        removeTranscriptFile(id)
      }
    }
  }

  writeStore(data)
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
      // Read per session: `data.transcripts` only holds what has been asked for.
      messages: dedupeTranscriptMessages(getTranscript(session.id))
    }))
}
