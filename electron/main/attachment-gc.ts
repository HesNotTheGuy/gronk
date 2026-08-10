/**
 * Removing parked attachment files that no transcript refers to any more.
 *
 * `saveTranscript` moves image bytes out of the store and into
 * `dataDir()/attachments` under a content-hash name, which is what stopped the
 * store growing without bound. Nothing removed them again, so deleting a
 * session left its pictures on disk for good.
 *
 * Two properties make this harder than "delete the files that session used":
 *
 * - The name IS the content, so one file can be the picture in any number of
 *   transcripts. Deleting per session would take an image another conversation
 *   is still showing. So this is a mark-and-sweep over every transcript at
 *   once, and it never reasons about one session.
 * - For a pasted image this copy is the only copy. Leaving a file behind costs
 *   disk; removing one that is still referenced destroys something the user
 *   cannot get back. Every judgement call below therefore resolves towards
 *   leaving the file.
 *
 * Deletion is not the only way a file loses its last reference. `saveTranscript`
 * also trims a transcript to the last 200 messages, so an image can fall out of
 * a conversation that is still open.
 *
 * The decision is a pure function over names and timestamps; only `sweep` and
 * `readReferences` touch a disk.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
// The name predicate lives beside `attachmentFileName`, which produces the names
// it recognises. What may be READ out of the attachments folder and what may be
// DELETED from it are the same question about a file, so both ask one function
// rather than each keeping a copy of the shape.
import { ATTACHMENT_DIR, OWNERSHIP_MARKER, isParkedAttachmentName } from './transcript-repair'
import { dataDir, backupStorePath, storePath } from './data-dir'

/**
 * How recently a file can have been written and still be spared.
 *
 * This is load-bearing rather than caution. The sweep is async, so a
 * `saveTranscript` can park a new image in the middle of one, after the
 * reference set has been read and before the directory is walked. That file is
 * genuinely unreferenced at the instant the set was taken, and deleting it
 * would destroy an image the user had just attached. Anything written recently
 * is left for the next sweep, by which time its transcript is on disk.
 */
export const MIN_AGE_MS = 60 * 60 * 1000

/**
 * Every attachment file name a store-shaped object refers to.
 *
 * Compared by BASENAME, never by the stored path. Moving the data directory
 * copies the attachments across but leaves every path in every transcript
 * pointing at the old location, so a full-path comparison would find no
 * reference to any file in the new directory and propose deleting all of them.
 * The name is a content hash, so it is stable across the move and is the right
 * key anyway.
 *
 * Written to survive any shape: this parses a file on disk, and a malformed
 * transcript must produce a smaller sweep, never a crash.
 */
export function referencedNames(raw: unknown): Set<string> {
  const names = new Set<string>()
  // Two shapes, because transcripts moved out of the store into a file each: a
  // store carrying them inline (older builds, and the retained backup for a
  // while yet), or one conversation on its own.
  const transcripts = Array.isArray(raw)
    ? { one: raw }
    : (raw as { transcripts?: unknown })?.transcripts
  if (!transcripts || typeof transcripts !== 'object') return names

  for (const messages of Object.values(transcripts as Record<string, unknown>)) {
    if (!Array.isArray(messages)) continue
    for (const message of messages) {
      const attachments = (message as { attachments?: unknown })?.attachments
      if (!Array.isArray(attachments)) continue
      for (const attachment of attachments) {
        const file = (attachment as { path?: unknown })?.path
        if (typeof file === 'string' && file) names.add(path.basename(file))
      }
    }
  }
  return names
}

export interface SweepCandidate {
  name: string
  mtimeMs: number
  /**
   * A regular file, from `lstat`, so a symlink is false rather than whatever it
   * points at.
   *
   * Carried into the decision rather than filtered during the directory walk so
   * that the rule is testable without a filesystem that can produce the case. A
   * symlink cannot be created on Windows without elevation, so as a walk-time
   * check this had no coverage on that platform at all.
   */
  isFile: boolean
}

/**
 * Which of these files are safe to remove.
 *
 * Four independent reasons to keep one, and it has to clear all four: it has to
 * be a regular file, it has to be a name this app parked, it has to be
 * referenced by nothing, and it has to be old enough that no save in flight can
 * be about to reference it.
 */
export function sweepPlan(input: {
  files: readonly SweepCandidate[]
  referenced: ReadonlySet<string>
  now: number
  minAgeMs?: number
}): string[] {
  const minAge = input.minAgeMs ?? MIN_AGE_MS
  return input.files
    .filter((file) => file.isFile)
    .filter((file) => isParkedAttachmentName(file.name))
    .filter((file) => !input.referenced.has(file.name))
    .filter((file) => input.now - file.mtimeMs >= minAge)
    .map((file) => file.name)
}

/** Why a sweep declined to remove anything, or null when it ran. */
export type SweepRefusal =
  /** No store where one was expected. Weaker evidence than an unreadable one. */
  | 'store-missing'
  | 'store-unreadable'
  | 'backup-unreadable'
  | 'quarantine-unreadable'
  /** A conversation file exists and could not be read, so its images are unknown. */
  | 'transcripts-unreadable'
  | 'no-attachment-dir'
  | 'unreadable-directory'
  /** Nothing shows this folder was written by this app. */
  | 'not-our-directory'

export interface SweepResult {
  removed: number
  /** Files left in place, whatever the reason. */
  kept: number
  /** Set when nothing was removed because the sweep could not be sure. */
  refused: SweepRefusal | null
}

/**
 * Names referenced by the per-conversation transcript files.
 *
 * Transcripts used to live inside the store, so the two files this collector read
 * were the whole picture. They are one file each now, and a reference the
 * collector cannot see is an image it will delete — so a directory it cannot read
 * has to refuse, exactly like an unreadable store.
 */
async function readTranscriptReferences(): Promise<Set<string> | null> {
  const dir = path.join(path.dirname(storePath()), 'transcripts')
  let names: string[]
  try {
    names = await fsp.readdir(dir)
  } catch (err) {
    // No directory yet is not uncertainty: nothing has been split out.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return new Set()
    return null
  }
  const referenced = new Set<string>()
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    let text: string
    try {
      text = await fsp.readFile(path.join(dir, name), 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') continue
      return null
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      // Unreadable conversation. Its images are exactly the ones a rescue would
      // want, so scan the raw text for names rather than contributing none.
      for (const found of scanForAttachmentNames(text)) referenced.add(found)
      continue
    }
    for (const found of referencedNames(parsed)) referenced.add(found)
  }
  return referenced
}

/**
 * The reference set, from the store and from the one retained backup.
 *
 * The backup matters: `readStore` falls back to it when the main file is
 * unreadable, so a transcript that only exists there is one the user can still
 * get back, and its images have to survive with it.
 *
 * Returns null when a file exists and cannot be read, cannot be parsed, or
 * parses into something that is not a store. All three are uncertain rather
 * than empty, and an empty reference set would propose deleting every
 * attachment in the directory, so each has to refuse.
 */
async function readReferences(file: string): Promise<Set<string> | null | 'missing'> {
  let text: string
  try {
    text = await fsp.readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return 'missing'
    return null
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  // Parsing is not the same as being a store. `[]`, `42` and any other valid
  // JSON yield no references, which is indistinguishable from a store that
  // genuinely refers to nothing. The store's own reader treats exactly these as
  // corrupt and keeps the file for a manual rescue, so the collector cannot
  // treat them as permission to delete what that rescue would need.
  if (!isStoreShaped(raw)) return null
  return referencedNames(raw)
}

/**
 * Does this parse look like a store rather than merely like JSON?
 *
 * Deliberately loose about which keys are present: a fresh install and one
 * predating a migration are both legitimately thin, and the store's own reader
 * defaults a missing `transcripts` to empty. What it refuses is the shape that
 * cannot be a store at all.
 */
function isStoreShaped(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  const obj = raw as Record<string, unknown>
  const transcriptsOk =
    obj.transcripts === undefined ||
    (typeof obj.transcripts === 'object' &&
      obj.transcripts !== null &&
      !Array.isArray(obj.transcripts))
  if (!transcriptsOk) return false
  return 'transcripts' in obj || Array.isArray(obj.sessions) || 'version' in obj
}

/** `gronk-store.corrupt-<ms>.json`, written by `writeStore` before replacing a
 * store it could not read. */
const QUARANTINE_NAME = /^gronk-store\.corrupt-\d+\.json$/

/**
 * Attachment names mentioned anywhere in a quarantined store, read as text.
 *
 * Deliberately cruder than parsing, because these files are corrupt by
 * definition: that is why `writeStore` kept them. `JSON.parse` fails on most of
 * them, and a parse that fails contributes no references, which is exactly the
 * "found nothing" that must never be read as "there is nothing".
 *
 * A regex over the raw bytes has the failure mode this module wants. A name it
 * matches by accident costs one file kept forever; a name it misses costs an
 * image the user cannot get back. Truncation, a broken object, a half-written
 * array: none of them stop a path string that survived from being seen.
 */
export function scanForAttachmentNames(text: string): Set<string> {
  const found = new Set<string>()
  for (const match of text.matchAll(/[0-9a-f]{32}\.[A-Za-z0-9+]+/g)) {
    if (isParkedAttachmentName(match[0])) found.add(match[0])
  }
  return found
}

/** Read size for a quarantined store. Nothing larger than this is ever held. */
const SCAN_CHUNK_BYTES = 1 << 20

/**
 * Carried between chunks so a name split across the boundary is still seen.
 *
 * A parked name is 32 hex characters plus a short extension, so this only has to
 * exceed the longest one. Generous rather than exact: too small silently loses a
 * reference at a boundary, which costs an image, and too large costs nothing.
 */
const SCAN_OVERLAP = 128

/**
 * Total bytes this is willing to scan before refusing.
 *
 * Not a skip. Skipping a file contributes no references, which is the mistake
 * this module exists to not make, so exceeding this refuses the whole sweep and
 * everything stays on disk.
 *
 * Reachable in principle because nothing ever deletes a quarantined store: they
 * accumulate one per corruption, and each is as large as the store was when it
 * broke. The ceiling is high enough that a real install never meets it and low
 * enough that the sweep cannot become the freeze it was written to prevent.
 */
const MAX_SCAN_BYTES = 512 * 1024 * 1024

/**
 * Scan one file for parked names without ever holding it whole.
 *
 * A quarantined store is a copy of a store that failed to parse, so it is as
 * large as that store was, and the one this module exists because of reached
 * 117.9 MB. Reading that into a string and running a regex over it on the main
 * process is the same freeze from the other side.
 *
 * Returns null when the file cannot be read, and the bytes consumed otherwise.
 */
export async function scanFileForNames(
  file: string,
  into: Set<string>,
  budget: number
): Promise<number | null> {
  let handle: fsp.FileHandle
  try {
    handle = await fsp.open(file, 'r')
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return 0
    return null
  }
  try {
    const buffer = Buffer.allocUnsafe(SCAN_CHUNK_BYTES)
    let carry = ''
    let consumed = 0
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, SCAN_CHUNK_BYTES, null)
      if (bytesRead === 0) break
      consumed += bytesRead
      if (consumed > budget) return null
      // latin1 gives one character per byte, so the overlap below is a count of
      // bytes and not of whatever happened to decode. A parked name is ASCII, so
      // utf8 would find it too; this only removes the need to reason about where
      // a multi-byte sequence falls relative to a chunk edge.
      const text = carry + buffer.toString('latin1', 0, bytesRead)
      for (const name of scanForAttachmentNames(text)) into.add(name)
      carry = text.slice(-SCAN_OVERLAP)
    }
    return consumed
  } catch {
    return null
  } finally {
    await handle.close().catch(() => {})
  }
}

/**
 * Every quarantined store beside the live one, as reference sources.
 *
 * `readStore` recovers from the backup and has `writeStore` keep the unreadable
 * bytes under a quarantine name, precisely so a manual rescue is still possible.
 * A rescue that brings the transcripts back to find every image already deleted
 * is not a rescue, so these count.
 *
 * Refusing outright whenever one exists was the other option and is worse:
 * nothing ever removes these files, so collection would stop permanently after
 * the first corruption.
 *
 * Every file is streamed rather than read whole, and the total is capped. Size
 * and count are both unbounded at the source: a quarantined store is as large as
 * the store was when it broke, and one is added per corruption with nothing ever
 * removing them.
 *
 * Returns null if one is there and cannot be read, or if the total exceeds what
 * this is willing to scan. Both are the same uncertain outcome as an unreadable
 * store, and neither is a skip: a file that went unscanned contributes no
 * references, which is indistinguishable from a file that referenced nothing.
 */
async function readQuarantinedReferences(): Promise<Set<string> | null> {
  const dir = path.dirname(storePath())
  let names: string[]
  try {
    names = (await fsp.readdir(dir)).filter((name) => QUARANTINE_NAME.test(name))
  } catch (err) {
    // No directory at all is not a quarantine problem; the store checks above
    // have already decided what an absent store means.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return new Set()
    return null
  }

  const referenced = new Set<string>()
  let budget = MAX_SCAN_BYTES
  for (const name of names) {
    const consumed = await scanFileForNames(path.join(dir, name), referenced, budget)
    // Unreadable, or past the ceiling. Either way this cannot say what the file
    // referenced, so the sweep does not get to act on what it did find.
    if (consumed === null) return null
    budget -= consumed
  }
  return referenced
}


/**
 * Remove parked attachments that nothing refers to any more.
 *
 * Interrupting this halfway is safe and needs no recovery: no store is ever
 * written, so the only effect is that some files are gone and some are not,
 * which is the same state the sweep starts from. The next one finishes the job.
 * The single write it can make is the ownership marker, which is empty and
 * carries nothing that could be lost.
 *
 * Failing to delete a single file is ignored on purpose. A file locked by a
 * viewer, or on a read-only volume, is a file that stays, and one of those must
 * not stop the rest.
 */
export async function sweepAttachments(now = Date.now()): Promise<SweepResult> {
  const dir = path.join(dataDir(), ATTACHMENT_DIR)

  const stored = await readReferences(storePath())
  if (stored === null) return { removed: 0, kept: 0, refused: 'store-unreadable' }
  // Absent is WEAKER evidence than unreadable, not stronger. An unreadable store
  // refuses, so a missing one cannot be allowed to mean "nothing is referenced,
  // remove it all". It is also reachable while the real store is alive
  // elsewhere: the data-directory pointer falls back to the default on any read
  // error, and after a relocation that points the sweep at the old folder, where
  // the attachments are still there and the store and backup are not.
  if (stored === 'missing') return { removed: 0, kept: 0, refused: 'store-missing' }

  const backed = await readReferences(backupStorePath())
  if (backed === null) return { removed: 0, kept: 0, refused: 'backup-unreadable' }

  const quarantined = await readQuarantinedReferences()
  if (quarantined === null) return { removed: 0, kept: 0, refused: 'quarantine-unreadable' }

  const perFile = await readTranscriptReferences()
  if (perFile === null) return { removed: 0, kept: 0, refused: 'transcripts-unreadable' }

  const referenced = new Set<string>(stored)
  if (backed !== 'missing') for (const name of backed) referenced.add(name)
  for (const name of quarantined) referenced.add(name)
  for (const name of perFile) referenced.add(name)

  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { removed: 0, kept: 0, refused: 'no-attachment-dir' }
    }
    return { removed: 0, kept: 0, refused: 'unreadable-directory' }
  }

  // Is this folder one this app wrote? The marker says so outright. Failing
  // that, an install predating the marker can earn one, but only from a file
  // whose name this app could have produced.
  //
  // The reference set is not evidence on its own. It holds the basename of
  // every attachment path in every transcript, and a non-image attachment keeps
  // the real path it came from, so ordinary names like `report.pdf` are in
  // there. One of those colliding with something in a stranger's folder would
  // otherwise be enough to adopt it, write the marker in, and start deleting.
  // A content-hash name is the fact; a name that merely matches is resemblance.
  const names = new Set(entries.map((entry) => entry.name))
  if (!names.has(OWNERSHIP_MARKER)) {
    const provenByAParkedName = [...referenced].some(
      (name) => isParkedAttachmentName(name) && names.has(name)
    )
    if (!provenByAParkedName) {
      return { removed: 0, kept: 0, refused: 'not-our-directory' }
    }
    try {
      await fsp.writeFile(path.join(dir, OWNERSHIP_MARKER), '')
    } catch {
      /* the proof stands whether or not it can be recorded */
    }
  }

  const files: SweepCandidate[] = []
  for (const entry of entries) {
    try {
      // lstat, so a symlink reports itself rather than its target. What this
      // buys is narrow and worth stating exactly: `unlink` refuses a directory
      // on its own and never follows a link, so a link's target was never
      // reachable from here. The check keeps a link somebody put here from being
      // removed, and keeps the directory case off an errno.
      const stat = await fsp.lstat(path.join(dir, entry.name))
      files.push({ name: entry.name, mtimeMs: stat.mtimeMs, isFile: stat.isFile() })
    } catch {
      /* vanished or unreadable: leave it alone */
    }
  }

  const doomed = sweepPlan({ files, referenced, now })
  let removed = 0
  for (const name of doomed) {
    try {
      await fsp.unlink(path.join(dir, name))
      removed += 1
    } catch {
      /* a file that will not delete is a file that stays */
    }
  }
  return { removed, kept: files.length - removed, refused: null }
}

let inFlight: Promise<SweepResult> | null = null

/**
 * Run a sweep, unless one is already running.
 *
 * Two overlapping sweeps would walk the same directory and race each other's
 * unlinks, which is harmless but pointless. Callers do not wait: this runs
 * after the work that made it worth doing, never in front of it.
 */
export function scheduleAttachmentSweep(): Promise<SweepResult> {
  if (inFlight) return inFlight
  const run = sweepAttachments()
    .catch((): SweepResult => ({ removed: 0, kept: 0, refused: 'unreadable-directory' }))
    .finally(() => {
      inFlight = null
    })
  inFlight = run
  return run
}
