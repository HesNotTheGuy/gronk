/**
 * The single authority for WHERE Grocky keeps its data.
 *
 * The data directory cannot be a normal setting: settings live inside
 * grocky-store.json, and the store's own path cannot be read from inside itself.
 * It is resolved instead from a small pointer file in the app's DEFAULT userData
 * directory — the one place that is always findable without knowing anything
 * else — which is why every path in the app has to come from here rather than
 * from a second `path.join(app.getPath('userData'), …)` somewhere.
 *
 * This module also owns the atomic-write primitive (see writeFileAtomicSync):
 * the pointer file and the store have the same durability requirement, and one
 * implementation is one place to get it right.
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import { pathsEqual } from '../../shared/path'
import type { DataLocation, MoveDataResult } from '../../shared/types'

/**
 * The directory segment under the OS application-data root — pinned, never
 * derived from the app name.
 *
 * `app.getPath('userData')` is `<appData>/<app.getName()>`, and getName() only
 * returns `grocky` because package.json has a `name` and no top-level
 * `productName`. Adding one — or renaming the product — would silently move
 * userData to a different folder, and every existing user's sessions would be
 * gone with no error to explain it. Pinning the segment decouples the brand from
 * the data location, so the app can be renamed without a migration.
 *
 * The value must stay exactly what shipped: `<appData>/grocky` is byte-identical
 * to today's userData on all three platforms (Windows `%APPDATA%\grocky`,
 * macOS `~/Library/Application Support/grocky`, Linux `~/.config/grocky`).
 * Changing it is a data migration, not a rename.
 */
export const DATA_DIR_NAME = 'grocky'

export const STORE_FILE = 'grocky-store.json'
export const BACKUP_FILE = 'grocky-store.backup.json'
export const CHAT_WORKSPACE_DIR = 'chat-workspace'

const POINTER_FILE = 'grocky-data-location.json'
const POINTER_VERSION = 1

/**
 * How many superseded chat-sandbox paths to remember. The Grok CLI keys its own
 * session folders by cwd, so images and CLI-side history from before a move sit
 * under the old key and are still probed (see resolveImageCandidates). Bounded
 * because a user who relocates repeatedly would otherwise grow the pointer file
 * forever, and each extra entry costs a directory probe on every image load.
 */
const MAX_PREVIOUS_WORKSPACES = 8

interface DataPointer {
  version: number
  /** Absolute directory holding the store. Absent means "the app default". */
  dataDir?: string
  previousChatWorkspaces?: string[]
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ── Durable writes ─────────────────────────────────────────────────────

/**
 * Block for a few milliseconds without an event loop turn. Used only by the
 * rename retry below, which sits inside synchronous store writes.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Windows can transiently refuse a replace-rename while an indexer or virus
 * scanner holds the target open. Those failures clear in milliseconds; treating
 * one as "your settings could not be saved" would be a lie.
 */
const RENAME_RETRY_DELAYS_MS = [0, 15, 45]

function renameWithRetry(from: string, to: string): void {
  let lastError: unknown
  for (const delay of RENAME_RETRY_DELAYS_MS) {
    if (delay) sleepSync(delay)
    try {
      fs.renameSync(from, to)
      return
    } catch (err) {
      lastError = err
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw err
    }
  }
  throw lastError
}

/**
 * fsync the directory so the rename itself survives a power cut.
 *
 * On POSIX the rename is a directory update and is only durable once the
 * directory is synced. Windows has no equivalent and cannot open a directory as
 * a file, so it is skipped there; MoveFileEx is already ordered against the
 * file data we flushed. Best effort either way — a failure here costs durability
 * of the last write, never correctness of what is already on disk.
 */
function fsyncDirSync(dir: string): void {
  if (process.platform === 'win32') return
  let fd: number | undefined
  try {
    fd = fs.openSync(dir, 'r')
    fs.fsyncSync(fd)
  } catch {
    /* best effort */
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Replace a file's contents in one step: write a sibling temp file, flush it to
 * the platter, then rename it over the target.
 *
 * A plain writeFileSync truncates the target first, so a crash, a kill or a
 * power loss in the middle leaves a half-written file — which for a JSON store
 * is indistinguishable from "your sessions are gone". A rename WITHIN one
 * directory (hence one filesystem) is atomic, so a reader sees either the whole
 * old file or the whole new one.
 *
 * The fsync is not optional: rename can reach the disk before the data it points
 * at, which produces a file that exists, has the right size and contains
 * garbage. Flushing first makes that ordering impossible.
 *
 * The temp file is removed on any failure, so a crashed write leaves at most one
 * stray dotfile and never a corrupt store.
 */
export function writeFileAtomicSync(filePath: string, contents: string): void {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  // Same directory on purpose: rename() is only atomic within one filesystem,
  // so an OS temp dir would silently degrade to copy+delete.
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
  )
  let fd: number | undefined
  try {
    fd = fs.openSync(tmp, 'wx', 0o600)
    fs.writeFileSync(fd, contents, 'utf8')
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    renameWithRetry(tmp, filePath)
    fsyncDirSync(dir)
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        /* ignore */
      }
    }
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* ignore */
    }
    throw err
  }
}

// ── The pointer file ───────────────────────────────────────────────────

/**
 * Built from `appData` (the OS root, which carries no app name) plus the pinned
 * segment — deliberately NOT from `userData`, which bakes app.getName() in.
 *
 * The fallback exists because `appData` is not guaranteed outside a real Electron
 * process (the `node --test` stub only provides `userData`). In Electron both
 * always resolve and, today, to the same directory.
 */
export function defaultDataDir(): string {
  try {
    return path.join(app.getPath('appData'), DATA_DIR_NAME)
  } catch {
    return app.getPath('userData')
  }
}

function pointerPath(): string {
  return path.join(defaultDataDir(), POINTER_FILE)
}

function parsePointer(file: string): DataPointer | null {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const raw = parsed as Record<string, unknown>
    const dir = typeof raw.dataDir === 'string' ? raw.dataDir.trim() : ''
    const previous = Array.isArray(raw.previousChatWorkspaces)
      ? raw.previousChatWorkspaces.filter((p): p is string => typeof p === 'string' && !!p)
      : []
    return {
      version: typeof raw.version === 'number' ? raw.version : POINTER_VERSION,
      // A relative path here would resolve against whatever cwd the app happened
      // to start with — a different directory per launch.
      dataDir: dir && path.isAbsolute(dir) ? dir : undefined,
      previousChatWorkspaces: previous.slice(0, MAX_PREVIOUS_WORKSPACES)
    }
  } catch {
    return null
  }
}

/**
 * An unreadable pointer means the default directory — deliberately NOT the last
 * location we happen to remember.
 *
 * The pointer is a few hundred bytes written through writeFileAtomicSync, so it
 * is either complete or absent; there is no torn state to recover from. And a
 * remembered previous location is precisely the directory a successful move
 * emptied, so treating it as a fallback would open an empty store AND start
 * writing new transcripts into the wrong place. The default is at least an
 * honest starting point, and the user's data is still wherever they put it —
 * nothing here deletes anything.
 */
function readPointer(): DataPointer {
  return parsePointer(pointerPath()) ?? { version: POINTER_VERSION }
}

function writePointer(pointer: DataPointer): void {
  const file = pointerPath()
  const isDefault = !pointer.dataDir
  const previous = (pointer.previousChatWorkspaces ?? []).slice(0, MAX_PREVIOUS_WORKSPACES)

  // Back at the default with nothing to remember: leave no pointer at all, so a
  // fresh install and a reset install are the same state on disk.
  if (isDefault && previous.length === 0) {
    fs.rmSync(file, { force: true })
    return
  }

  fs.mkdirSync(defaultDataDir(), { recursive: true })
  const payload: DataPointer = {
    version: POINTER_VERSION,
    ...(pointer.dataDir ? { dataDir: pointer.dataDir } : {}),
    ...(previous.length ? { previousChatWorkspaces: previous } : {})
  }
  writeFileAtomicSync(file, JSON.stringify(payload, null, 2))
}

// ── Resolved paths ─────────────────────────────────────────────────────

/**
 * Resolved from the pointer on every call rather than cached.
 *
 * The read is a few hundred bytes next to a store measured in hundreds of
 * kilobytes, and a cache would have to be invalidated from every path that can
 * change the location (a move, a test swapping userData) — a stale cache here
 * writes a user's next message into the wrong directory.
 *
 * A pointer aimed at a directory that is missing right now (external drive not
 * plugged in) is still honoured. Quietly falling back to the default would start
 * a second, empty store and write new transcripts into it; a read that comes up
 * empty is recoverable by plugging the drive back in, a write to the wrong place
 * is not.
 */
export function dataDir(): string {
  return readPointer().dataDir ?? defaultDataDir()
}

export function storePath(): string {
  return path.join(dataDir(), STORE_FILE)
}

export function backupStorePath(): string {
  return path.join(dataDir(), BACKUP_FILE)
}

export function chatWorkspacePath(): string {
  return path.join(dataDir(), CHAT_WORKSPACE_DIR)
}

/** Chat sandbox paths from before a move — see MAX_PREVIOUS_WORKSPACES. */
export function previousChatWorkspacePaths(): string[] {
  return readPointer().previousChatWorkspaces ?? []
}

/** Create the data directory if needed and return it. */
export function ensureDataDir(): string {
  const dir = dataDir()
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function getDataLocation(): DataLocation {
  const pointer = readPointer()
  const defaults = defaultDataDir()
  const dir = pointer.dataDir ?? defaults
  const previous = pointer.previousChatWorkspaces ?? []
  let storeBytes: number | undefined
  try {
    storeBytes = fs.statSync(path.join(dir, STORE_FILE)).size
  } catch {
    storeBytes = undefined
  }
  return {
    dataDir: dir,
    defaultDir: defaults,
    isDefault: pathsEqual(dir, defaults),
    storePath: path.join(dir, STORE_FILE),
    chatWorkspacePath: path.join(dir, CHAT_WORKSPACE_DIR),
    ...(storeBytes === undefined ? {} : { storeBytes }),
    ...(previous.length ? { previousChatWorkspaces: previous } : {})
  }
}

// ── Moving the data directory ──────────────────────────────────────────

/** True when `child` sits under `parent` (not when they are the same path). */
function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel)
}

async function rmQuiet(target: string): Promise<boolean> {
  try {
    await fsp.rm(target, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/** Entry count of a tree (files and directories), used to verify a copy. */
async function countEntries(dir: string): Promise<number> {
  try {
    return (await fsp.readdir(dir, { recursive: true })).length
  } catch {
    return -1
  }
}

/**
 * Confirm the copy is the same store, not just the same number of bytes that
 * happened to land. Returns a reason on mismatch, null when the copy is good.
 */
async function verifyStoreCopy(source: string, copy: string): Promise<string | null> {
  let sourceRaw: string
  let copyRaw: string
  try {
    sourceRaw = await fsp.readFile(source, 'utf8')
    copyRaw = await fsp.readFile(copy, 'utf8')
  } catch (err) {
    return `the copied store could not be read back (${errorText(err)})`
  }
  if (sourceRaw.length !== copyRaw.length) {
    return `the copied store is ${copyRaw.length} bytes, the original is ${sourceRaw.length}`
  }
  let parsedCopy: { sessions?: unknown[]; transcripts?: Record<string, unknown> }
  let parsedSource: { sessions?: unknown[]; transcripts?: Record<string, unknown> }
  try {
    parsedCopy = JSON.parse(copyRaw)
    parsedSource = JSON.parse(sourceRaw)
  } catch (err) {
    return `the copied store is not valid JSON (${errorText(err)})`
  }
  const copySessions = Array.isArray(parsedCopy.sessions) ? parsedCopy.sessions.length : 0
  const sourceSessions = Array.isArray(parsedSource.sessions) ? parsedSource.sessions.length : 0
  if (copySessions !== sourceSessions) {
    return `the copy has ${copySessions} sessions, the original has ${sourceSessions}`
  }
  const copyTranscripts = Object.keys(parsedCopy.transcripts ?? {}).length
  const sourceTranscripts = Object.keys(parsedSource.transcripts ?? {}).length
  if (copyTranscripts !== sourceTranscripts) {
    return `the copy has ${copyTranscripts} transcripts, the original has ${sourceTranscripts}`
  }
  return null
}

/** Newest first, de-duplicated, without the workspace that is now live. */
function rememberPreviousWorkspaces(
  supersededWorkspace: string,
  existing: string[],
  liveWorkspace: string
): string[] {
  const out: string[] = []
  for (const candidate of [supersededWorkspace, ...existing]) {
    if (!candidate) continue
    if (pathsEqual(candidate, liveWorkspace)) continue
    if (out.some((kept) => pathsEqual(kept, candidate))) continue
    out.push(candidate)
  }
  return out.slice(0, MAX_PREVIOUS_WORKSPACES)
}

/**
 * Relocate the store, its backup and the chat sandbox to `target`.
 *
 * Copy → verify → switch the pointer → only then delete the source. Nothing is
 * removed before the new copy has been read back and checked, and the pointer
 * (the one fact that decides where the app looks) is the commit point: a crash
 * before it leaves the original live with a stray copy at the target, a crash
 * after it leaves the new location live with a stray copy at the source. Both
 * are recoverable; a half-move that loses transcripts is not.
 *
 * Callers must ensure no agent is running — files held open by the child cannot
 * be removed on Windows. The failure is handled here anyway rather than trusted
 * to the caller: an un-deletable source after a verified copy is reported, not
 * hidden, and never rolls the pointer back onto data that may already be stale.
 */
export async function moveDataDir(target: string): Promise<MoveDataResult> {
  const current = getDataLocation()
  const fail = (message: string): MoveDataResult => ({
    ok: false,
    message,
    location: getDataLocation()
  })

  if (typeof target !== 'string' || !target.trim()) {
    return fail('Pick a folder to keep Grocky data in.')
  }
  const requested = target.trim()
  if (!path.isAbsolute(requested)) {
    // A relative path resolves against the app's cwd, which differs between a
    // dev run and a packaged launch — the data would move somewhere else each time.
    return fail(`Data folder must be an absolute path (got "${requested}").`)
  }
  const dest = path.resolve(requested)

  if (pathsEqual(dest, current.dataDir)) {
    return { ok: true, message: `Grocky data is already in ${dest}.`, location: current }
  }
  if (isInside(current.dataDir, dest)) {
    return fail(
      `${dest} is inside the current data folder (${current.dataDir}) — copying it into ` +
        'itself would never finish. Pick a folder outside it.'
    )
  }

  try {
    const stat = fs.statSync(dest)
    if (!stat.isDirectory()) return fail(`${dest} is a file, not a folder.`)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') return fail(`Cannot use ${dest}: ${errorText(err)}`)
  }

  try {
    await fsp.mkdir(dest, { recursive: true })
    const probe = path.join(dest, `.grocky-write-test-${process.pid}`)
    await fsp.writeFile(probe, 'ok')
    await fsp.rm(probe, { force: true })
  } catch (err) {
    return fail(`Cannot write to ${dest}: ${errorText(err)}`)
  }

  // Merging two installs' data has no correct answer — whichever store won, the
  // other's sessions would be gone with no way back.
  if (fs.existsSync(path.join(dest, STORE_FILE))) {
    return fail(
      `${dest} already holds a Grocky store (${STORE_FILE}). Merging two stores would lose ` +
        'the sessions of one of them, so nothing was moved — pick an empty folder, or move ' +
        'that store aside first.'
    )
  }
  if (fs.existsSync(path.join(dest, CHAT_WORKSPACE_DIR))) {
    return fail(
      `${dest} already holds a ${CHAT_WORKSPACE_DIR} folder. Merging it with this install's ` +
        'chat sandbox could overwrite files, so nothing was moved — pick an empty folder.'
    )
  }

  const sourceStore = path.join(current.dataDir, STORE_FILE)
  const sourceBackup = path.join(current.dataDir, BACKUP_FILE)
  const sourceChat = path.join(current.dataDir, CHAT_WORKSPACE_DIR)
  const hasStore = fs.existsSync(sourceStore)
  const hasBackup = fs.existsSync(sourceBackup)
  const hasChat = fs.existsSync(sourceChat)

  // Staged inside the destination so the final step is a rename on the same
  // filesystem, and so a failed copy leaves one obvious directory to delete
  // instead of half a store next to the user's files.
  const staging = path.join(dest, `.grocky-move-${process.pid}-${Date.now()}`)
  const placed: string[] = []

  try {
    await fsp.mkdir(staging, { recursive: true })
    if (hasStore) await fsp.copyFile(sourceStore, path.join(staging, STORE_FILE))
    if (hasBackup) await fsp.copyFile(sourceBackup, path.join(staging, BACKUP_FILE))
    if (hasChat) {
      await fsp.cp(sourceChat, path.join(staging, CHAT_WORKSPACE_DIR), { recursive: true })
    }

    if (hasStore) {
      const problem = await verifyStoreCopy(sourceStore, path.join(staging, STORE_FILE))
      if (problem) throw new Error(problem)
    }
    if (hasChat) {
      const before = await countEntries(sourceChat)
      const after = await countEntries(path.join(staging, CHAT_WORKSPACE_DIR))
      if (before !== after) {
        throw new Error(
          `the copied ${CHAT_WORKSPACE_DIR} has ${after} entries, the original has ${before}`
        )
      }
    }

    for (const name of [STORE_FILE, BACKUP_FILE, CHAT_WORKSPACE_DIR]) {
      const from = path.join(staging, name)
      if (!fs.existsSync(from)) continue
      const to = path.join(dest, name)
      await fsp.rename(from, to)
      placed.push(to)
    }
    await rmQuiet(staging)
  } catch (err) {
    // The pointer has not moved, so the original is still the live copy. Undo
    // only what we created at the destination.
    for (const created of placed) await rmQuiet(created)
    await rmQuiet(staging)
    return fail(`Move failed, nothing changed: ${errorText(err)}`)
  }

  const pointer = readPointer()
  const nextChatWorkspace = path.join(dest, CHAT_WORKSPACE_DIR)
  try {
    writePointer({
      version: POINTER_VERSION,
      dataDir: pathsEqual(dest, current.defaultDir) ? undefined : dest,
      previousChatWorkspaces: rememberPreviousWorkspaces(
        current.chatWorkspacePath,
        pointer.previousChatWorkspaces ?? [],
        nextChatWorkspace
      )
    })
  } catch (err) {
    for (const created of placed) await rmQuiet(created)
    return fail(`Move failed, nothing changed: could not record the new location (${errorText(err)}).`)
  }

  // Past the commit point: the new copy is verified and live. A source file that
  // will not delete is leftover clutter, not a failure.
  const leftovers: string[] = []
  for (const stale of [
    hasStore ? sourceStore : null,
    hasBackup ? sourceBackup : null,
    hasChat ? sourceChat : null
  ]) {
    if (!stale) continue
    if (!(await rmQuiet(stale))) leftovers.push(stale)
  }

  const location = getDataLocation()
  const note = leftovers.length
    ? ` The old copy in ${current.dataDir} could not be removed (${leftovers.length} item(s)) — ` +
      'it is safe to delete by hand.'
    : ''
  return { ok: true, message: `Grocky data moved to ${dest}.${note}`, location }
}

/** Move back to the app's default userData directory (same machinery). */
export async function resetDataDir(): Promise<MoveDataResult> {
  return moveDataDir(defaultDataDir())
}
