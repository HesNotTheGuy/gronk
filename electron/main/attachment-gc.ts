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
import { IMAGE_EXT_SET } from './ipc-guard'
import { ATTACHMENT_DIR, OWNERSHIP_MARKER } from './transcript-repair'
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

/** `<32 hex>.<image ext>`, which is exactly what `attachmentFileName` produces. */
const PARKED_NAME = /^[0-9a-f]{32}(\.[a-z0-9+]+)$/

/**
 * Is this a file this app parked?
 *
 * The directory sits under the data directory, and the user can point that
 * anywhere. Nothing is removed unless its name has the shape this app writes.
 *
 * That shape is not proof of authorship, only of resemblance: someone else's
 * file named with 32 hex characters and an image extension passes. It is the
 * ownership check on the directory that stops a folder this app never wrote
 * from being swept, and this narrows what is touched inside one it did.
 */
export function isParkedAttachmentName(name: string): boolean {
  const match = PARKED_NAME.exec(name)
  return match !== null && IMAGE_EXT_SET.has(match[1])
}

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
  const transcripts = (raw as { transcripts?: unknown })?.transcripts
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
 * The reference set, from the store and from the one retained backup.
 *
 * The backup matters: `readStore` falls back to it when the main file is
 * unreadable, so a transcript that only exists there is one the user can still
 * get back, and its images have to survive with it.
 *
 * Returns null when a file exists and cannot be read or parsed. That is an
 * uncertain outcome rather than an empty one, and an empty reference set would
 * propose deleting every attachment in the directory, so it has to refuse.
 */
async function readReferences(file: string): Promise<Set<string> | null | 'missing'> {
  let text: string
  try {
    text = await fsp.readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return 'missing'
    return null
  }
  try {
    return referencedNames(JSON.parse(text))
  } catch {
    return null
  }
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
 * Returns null if one is there and cannot be read, which is the same uncertain
 * outcome as an unreadable store.
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
  for (const name of names) {
    let text: string
    try {
      text = await fsp.readFile(path.join(dir, name), 'utf8')
    } catch (err) {
      // Vanished between the listing and the read: nothing to salvage from it,
      // so nothing can be referenced only by it.
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') continue
      return null
    }
    for (const found of scanForAttachmentNames(text)) referenced.add(found)
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

  const referenced = new Set<string>(stored)
  if (backed !== 'missing') for (const name of backed) referenced.add(name)
  for (const name of quarantined) referenced.add(name)

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
  // that, a file the store still references is proof, because that name is a
  // hash of bytes this app parked â€” and it lets an install that predates the
  // marker earn one instead of never collecting again.
  const names = new Set(entries.map((entry) => entry.name))
  if (!names.has(OWNERSHIP_MARKER)) {
    if (![...referenced].some((name) => names.has(name))) {
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
