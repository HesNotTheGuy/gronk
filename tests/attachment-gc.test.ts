import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { __freshUserData } from './stubs/electron'
import {
  MIN_AGE_MS,
  referencedNames,
  scanFileForNames,
  sweepAttachments,
  sweepPlan
} from '../electron/main/attachment-gc'
import {
  ATTACHMENT_DIR,
  OWNERSHIP_MARKER,
  attachmentFileName,
  isParkedAttachmentName
} from '../electron/main/transcript-repair'
import { deleteSession, saveTranscript, upsertSession } from '../electron/main/store'
import type { ChatMessage, PromptAttachment } from '../shared/types'

/**
 * Removing parked attachments without destroying one that is still in use.
 *
 * Every test here is really about the second half. For a pasted image the
 * parked copy is the only copy, so a sweep that is too eager is not a tidiness
 * bug, it is data loss the user cannot undo. The cases that keep a file
 * therefore outnumber the ones that remove it, deliberately.
 */

let userData = ''
beforeEach(() => {
  userData = __freshUserData()
})

const attachDir = () => path.join(userData, ATTACHMENT_DIR)
const storeFile = () => path.join(userData, 'gronk-store.json')
const backupFile = () => path.join(userData, 'gronk-store.backup.json')

/** A 1x1 PNG, so parked bytes are a real image rather than noise. */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
/** A different 1x1, so two sessions can hold genuinely different images. */
const GIF_B64 = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

function image(id: string, data = PNG_B64, name = 'paste.png'): PromptAttachment {
  return { id, kind: 'image', name, mimeType: 'image/png', data } as PromptAttachment
}

function msg(id: string, attachments?: PromptAttachment[]): ChatMessage {
  return {
    id,
    role: 'user',
    text: `turn ${id}`,
    createdAt: 1,
    ...(attachments ? { attachments } : {})
  } as ChatMessage
}

/** Save a session carrying one image, and return the parked file's name. */
function sessionWithImage(sessionId: string, data = PNG_B64): string {
  upsertSession({ id: sessionId, cwd: '/work/alpha', title: sessionId } as never)
  saveTranscript(sessionId, [msg(`${sessionId}-m1`, [image(`${sessionId}-a1`, data)])])
  const files = fs.readdirSync(attachDir())
  const expected = attachmentFileName(data, '.png')
  assert.ok(files.includes(expected), 'the fixture did not park anything')
  return expected
}

/**
 * Backdate every parked file past the age floor, as a real one would be.
 *
 * `lutimes`, not `utimes`, and that is the whole reason the symlink test below
 * means anything. `utimes` follows a link and stamps its TARGET, leaving the
 * link itself freshly modified, so the age floor spared it and the test passed
 * without the file-type guard ever being consulted.
 */
function ageFiles(): void {
  const old = new Date(Date.now() - MIN_AGE_MS - 60_000)
  for (const name of fs.readdirSync(attachDir())) {
    fs.lutimesSync(path.join(attachDir(), name), old, old)
  }
}

/**
 * One more store write, so the retained backup stops describing the state
 * before the change.
 *
 * `writeStore` rolls the current file into the backup BEFORE writing the new
 * one, so immediately after a delete the backup is the copy that still has the
 * session in it. A file's last reference therefore outlives the delete by
 * exactly one store write, which is why most tests here need this line. That
 * lag is the design working, not a workaround: until that write lands, a
 * recovery from the backup would bring the session back and want its pictures.
 */
function rollBackupForward(): void {
  upsertSession({ id: 'keepalive', cwd: '/work/keepalive', title: 'keepalive' } as never)
}

// ── The decision ────────────────────────────────────────────────────────────

test('only names this app could have written are ever candidates', () => {
  assert.equal(isParkedAttachmentName(`${'a'.repeat(32)}.png`), true)
  assert.equal(isParkedAttachmentName(`${'0123456789abcdef'.repeat(2)}.jpg`), true)

  // Everything a user might have put in the folder themselves.
  for (const name of [
    'holiday.png',
    'notes.txt',
    `${'a'.repeat(31)}.png`,
    `${'a'.repeat(33)}.png`,
    `${'g'.repeat(32)}.png`,
    `${'A'.repeat(32)}.png`,
    `${'a'.repeat(32)}.exe`,
    `${'a'.repeat(32)}`,
    '.env',
    '..',
    `../${'a'.repeat(32)}.png`
  ]) {
    assert.equal(isParkedAttachmentName(name), false, `${name} should never be a candidate`)
  }
})

test('REFERENCES ARE COMPARED BY NAME, so moving the data directory loses nothing', () => {
  // Moving the data directory copies the attachments across but leaves every
  // stored path pointing at the old location. Comparing full paths would find
  // no reference to anything in the new folder and propose deleting all of it.
  const names = referencedNames({
    transcripts: {
      s1: [{ attachments: [{ path: '/somewhere/else/entirely/attachments/abc.png' }] }]
    }
  })
  assert.deepEqual([...names], ['abc.png'])
})

test('a malformed transcript yields fewer references, never a throw', () => {
  for (const raw of [
    null,
    undefined,
    42,
    'nope',
    {},
    { transcripts: null },
    { transcripts: 7 },
    { transcripts: { s: 'not an array' } },
    { transcripts: { s: [null, 3, { attachments: 'no' }] } },
    { transcripts: { s: [{ attachments: [null, {}, { path: 5 }, { path: '' }] }] } }
  ]) {
    assert.deepEqual([...referencedNames(raw)], [], `${JSON.stringify(raw)} should yield nothing`)
  }
})

test('a file is removed only when it clears all four guards', () => {
  const now = 1_000_000_000
  const old = now - MIN_AGE_MS - 1
  const parked = `${'a'.repeat(32)}.png`
  const other = `${'b'.repeat(32)}.png`
  const file = (name: string, mtimeMs: number, isFile = true) => ({ name, mtimeMs, isFile })

  assert.deepEqual(
    sweepPlan({ files: [file(parked, old)], referenced: new Set(), now }),
    [parked],
    'an old, unreferenced, app-written regular file should go'
  )

  assert.deepEqual(
    sweepPlan({ files: [file(parked, old)], referenced: new Set([parked]), now }),
    [],
    'a referenced file must stay'
  )

  assert.deepEqual(
    sweepPlan({ files: [file(parked, now)], referenced: new Set(), now }),
    [],
    'a file written moments ago must stay: a save may be about to reference it'
  )

  assert.deepEqual(
    sweepPlan({ files: [file('holiday.png', old)], referenced: new Set(), now }),
    [],
    'a file this app did not write must stay'
  )

  // The symlink and directory cases, on every platform. As a check inside the
  // directory walk this had no coverage on Windows at all, because a symlink
  // cannot be created there without elevation.
  assert.deepEqual(
    sweepPlan({ files: [file(parked, old, false)], referenced: new Set(), now }),
    [],
    'anything that is not a regular file must stay, whatever it is called'
  )

  assert.deepEqual(
    sweepPlan({
      files: [file(parked, old), file(other, old)],
      referenced: new Set([other]),
      now
    }),
    [parked],
    'the referenced one of a pair should be the one kept'
  )
})

// ── On a real disk ──────────────────────────────────────────────────────────

test('THE REPORTED BUG: deleting a session removes the picture it parked', async () => {
  const name = sessionWithImage('s1')
  deleteSession('s1')
  rollBackupForward()
  ageFiles()

  const result = await sweepAttachments()

  assert.equal(result.refused, null)
  assert.equal(result.removed, 1)
  assert.equal(fs.existsSync(path.join(attachDir(), name)), false)
})

test('A DELETED SESSION TAKES ITS PICTURES WITH IT', async () => {
  // This used to wait a generation, because the store's backup still held the
  // conversation and recovering from it had to bring the images back. Conversations
  // are one file each now and the file is the only copy, so a deleted session is
  // not recoverable and nothing is waiting for.
  //
  // The rule has not changed — it was never "wait a generation", it was "do not
  // collect a picture something can still restore". What changed is that after a
  // delete, nothing can.
  const name = sessionWithImage('s1')
  deleteSession('s1')
  ageFiles()

  const result = await sweepAttachments()
  assert.equal(result.removed, 1, 'nothing can restore that conversation, so the picture should go')
  assert.equal(fs.existsSync(path.join(attachDir(), name)), false)
})

test('TWO SESSIONS SHARING ONE FILE: deleting either must not take the other picture', async () => {
  // The name is the content hash, so the same image in two conversations is one
  // file on disk. Deleting per session rather than per reference is exactly how
  // this goes wrong, and the user loses an image from a session they kept.
  const shared = sessionWithImage('s1')
  const alsoShared = sessionWithImage('s2')
  assert.equal(shared, alsoShared, 'the fixture failed to make them share a file')

  deleteSession('s1')
  rollBackupForward()
  ageFiles()
  const first = await sweepAttachments()
  assert.equal(first.removed, 0, 'a picture still shown by another session was deleted')
  assert.equal(fs.existsSync(path.join(attachDir(), shared)), true)

  deleteSession('s2')
  rollBackupForward()
  ageFiles()
  const second = await sweepAttachments()
  assert.equal(second.removed, 1, 'the last reference went and the file stayed')
  assert.equal(fs.existsSync(path.join(attachDir(), shared)), false)
})

test('a session that is merely archived keeps its pictures', async () => {
  const name = sessionWithImage('s1')
  ageFiles()
  const result = await sweepAttachments()
  assert.equal(result.removed, 0)
  assert.equal(fs.existsSync(path.join(attachDir(), name)), true)
})

test('A CORRUPT STORE DOES NOT COST YOU A CONVERSATION OR ITS PICTURES', async () => {
  // The backup used to be where a conversation survived a corrupt store, which is
  // why a picture referenced only there had to survive too. Conversations are
  // their own files now, so they do not depend on the store's health at all —
  // which is stronger, not weaker: a corrupt store loses sessions and settings and
  // leaves every conversation intact.
  const name = sessionWithImage('s1')
  fs.writeFileSync(storeFile(), '{ not json', 'utf8')
  ageFiles()

  const result = await sweepAttachments()

  assert.equal(result.removed, 0, 'an unreadable store must never authorise deleting')
  assert.equal(fs.existsSync(path.join(attachDir(), name)), true)
})

test('AN UNREADABLE STORE REMOVES NOTHING: an empty reference set is not proof', async () => {
  // The dangerous shape. A store that fails to parse yields no references, and
  // acting on that would propose deleting every attachment on disk.
  const name = sessionWithImage('s1')
  ageFiles()
  fs.writeFileSync(storeFile(), '{ this is not json')

  const result = await sweepAttachments()

  assert.equal(result.refused, 'store-unreadable')
  assert.equal(result.removed, 0)
  assert.equal(fs.existsSync(path.join(attachDir(), name)), true)
})

test('A MISSING STORE REMOVES NOTHING: absent is weaker evidence than unreadable', async () => {
  // The dangerous sibling of the test above, and the one that was missing.
  // An unreadable store refused; an absent one produced an empty reference set,
  // which reads as "nothing is referenced, remove it all".
  //
  // Reachable while the real store is alive somewhere else: the data-directory
  // pointer falls back to the default on a read error, and after a relocation
  // that aims the sweep at the old folder, where the images are still sitting
  // and the store and backup are not.
  const name = sessionWithImage('s1')
  ageFiles()
  fs.rmSync(storeFile())
  fs.rmSync(backupFile(), { force: true })

  const result = await sweepAttachments()

  assert.equal(result.refused, 'store-missing')
  assert.equal(result.removed, 0)
  assert.equal(fs.existsSync(path.join(attachDir(), name)), true)
})

test('a missing store refuses even when the backup is readable', async () => {
  const name = sessionWithImage('s1')
  fs.copyFileSync(storeFile(), backupFile())
  ageFiles()
  fs.rmSync(storeFile())

  const result = await sweepAttachments()

  assert.equal(result.refused, 'store-missing')
  assert.equal(fs.existsSync(path.join(attachDir(), name)), true)
})

/**
 * A quarantine file in the shape an older build left behind: the store with its
 * transcripts inline.
 *
 * Conversations are their own files now, so a quarantine copy taken today carries
 * no transcripts and names no images. A copy taken before the split does, and it
 * is exactly the file a manual rescue would reach for — so it is still a reference
 * source, and that is what these two tests are about.
 */
function legacyQuarantine(stamp: string, sessionId: string, imageName: string): string {
  const file = path.join(userData, `gronk-store.corrupt-${stamp}.json`)
  const store = JSON.parse(fs.readFileSync(storeFile(), 'utf8')) as Record<string, unknown>
  // Transcripts first, so a test that truncates the tail still has the name to
  // look for. The previous ordering put the attachment path in the last handful
  // of characters and the truncation removed it — caught by the fixture's own
  // guard, which is why that guard is there.
  const text = JSON.stringify({
    transcripts: {
      [sessionId]: [
        {
          id: `${sessionId}-m1`,
          role: 'user',
          text: 'here is a picture',
          createdAt: 1,
          attachments: [
            { id: 'a1', kind: 'image', name: 'paste.png', path: path.join(attachDir(), imageName) }
          ]
        }
      ]
    },
    ...store
  })
  fs.writeFileSync(file, text)
  return text
}

test('A QUARANTINED STORE STILL COUNTS: a rescue must not find the images gone', async () => {
  // writeStore keeps an unreadable store under gronk-store.corrupt-<ts>.json so
  // a manual rescue is possible. While the corrupt bytes sit at the live path
  // the sweep refuses; the moment they are renamed to the quarantine name that
  // caution used to evaporate, and everything only they referenced became
  // collectable.
  const name = sessionWithImage('s1')
  legacyQuarantine('1754500000000', 's1', name)
  deleteSession('s1')
  rollBackupForward()
  ageFiles()

  const result = await sweepAttachments()

  assert.equal(result.refused, null, 'a quarantine file must not stop collection altogether')
  assert.equal(result.removed, 0, 'an image the quarantined store still names was deleted')
  assert.equal(fs.existsSync(path.join(attachDir(), name)), true)
})

test('a quarantined store is read as text, because it is corrupt by definition', async () => {
  // The point of reading rather than parsing. JSON.parse fails on most of these
  // files, and a parse that fails contributes no references, which is exactly
  // the "found nothing" this module must never treat as "there is nothing".
  const name = sessionWithImage('s1')
  const whole = legacyQuarantine('1754500000001', 's1', name)
  const truncated = whole.slice(0, -40)
  assert.throws(() => JSON.parse(truncated), 'the fixture is not actually corrupt')
  assert.ok(truncated.includes(name), 'the fixture lost the name before the test could use it')
  fs.writeFileSync(path.join(userData, 'gronk-store.corrupt-1754500000001.json'), truncated)
  deleteSession('s1')
  rollBackupForward()
  ageFiles()

  const result = await sweepAttachments()

  assert.equal(result.removed, 0)
  assert.equal(fs.existsSync(path.join(attachDir(), name)), true)
})

test('a quarantined store that cannot be read refuses, like any other uncertainty', async () => {
  const name = sessionWithImage('s1')
  const quarantine = path.join(userData, 'gronk-store.corrupt-1754500000002.json')
  // A directory under the quarantine name: readFile fails with EISDIR, which is
  // "cannot tell what this referenced" rather than "it referenced nothing".
  fs.mkdirSync(quarantine)
  deleteSession('s1')
  rollBackupForward()
  ageFiles()

  const result = await sweepAttachments()

  assert.equal(result.refused, 'quarantine-unreadable')
  assert.equal(fs.existsSync(path.join(attachDir(), name)), true)
})

test('A NAME SPLIT ACROSS A READ BOUNDARY IS STILL FOUND', async () => {
  // The file is streamed, so a name straddling a chunk edge is the way a
  // reference goes missing without anything erroring. A missed reference is an
  // image deleted, so the overlap carried between chunks is load-bearing.
  const name = sessionWithImage('s1')
  const chunk = 1 << 20
  const quarantine = path.join(userData, 'gronk-store.corrupt-1754500000010.json')
  // Land the name so it begins a few bytes before the first boundary and ends
  // after it.
  const pad = 'x'.repeat(chunk - 8)
  fs.writeFileSync(quarantine, `${pad}"${name}"${'y'.repeat(1024)}`)
  deleteSession('s1')
  rollBackupForward()
  ageFiles()

  const result = await sweepAttachments()

  assert.equal(result.refused, null)
  assert.equal(result.removed, 0, 'a name spanning a chunk boundary was not seen')
  assert.equal(fs.existsSync(path.join(attachDir(), name)), true)
})

test('a quarantined store far larger than one chunk is scanned to the end', async () => {
  const name = sessionWithImage('s1')
  const quarantine = path.join(userData, 'gronk-store.corrupt-1754500000011.json')
  fs.writeFileSync(quarantine, `${'x'.repeat(5 << 20)}"${name}"`)
  deleteSession('s1')
  rollBackupForward()
  ageFiles()

  const result = await sweepAttachments()

  assert.equal(result.removed, 0, 'the scan stopped before the end of the file')
  assert.equal(fs.existsSync(path.join(attachDir(), name)), true)
})

test('A FILE PAST THE SCAN CEILING REFUSES RATHER THAN SKIPPING', async () => {
  // Skipping would contribute no references, which is indistinguishable from a
  // file that referenced nothing. The budget is passed in so the ceiling can be
  // reached without writing half a gigabyte.
  const found = new Set<string>()
  const file = path.join(userData, 'big.json')
  fs.writeFileSync(file, 'x'.repeat(4096))

  assert.equal(await scanFileForNames(file, found, 64), null, 'over budget should refuse')
  assert.equal(typeof (await scanFileForNames(file, found, 1 << 20)), 'number')
})

test('a quarantine file that vanishes between listing and reading is not a refusal', async () => {
  // Nothing can be referenced only by a file that is no longer there.
  const found = new Set<string>()
  const consumed = await scanFileForNames(path.join(userData, 'never-existed.json'), found, 4096)
  assert.equal(consumed, 0)
  assert.equal(found.size, 0)
})

test('ATTACHING AN IMAGE SOMEBODY ELSE ALREADY ATTACHED PROTECTS IT AGAIN', async () => {
  // The shared-file case from the other side. Parking the same bytes twice
  // writes nothing the second time, so without refreshing the timestamp the
  // newest reference to a file looks like the oldest one and the age floor
  // stops covering it. A sweep already under way would then take a picture the
  // store started referencing seconds ago.
  const name = sessionWithImage('s1')
  deleteSession('s1')
  rollBackupForward()
  ageFiles()

  // The second session attaches the same image, which re-uses the file.
  const again = sessionWithImage('s2')
  assert.equal(again, name, 'the fixture failed to re-use the parked file')

  const stat = fs.statSync(path.join(attachDir(), name))
  assert.ok(
    Date.now() - stat.mtimeMs < MIN_AGE_MS,
    'the re-used file still carries its original time, so the age floor no longer covers it'
  )
})

test('the plan spares a file re-parked after the reference set was taken', async () => {
  // The race itself, at the only seam where it can be driven. A sweep reads its
  // references once and unlinks later; a save landing in between re-parks an
  // existing file, which is unreferenced by the set already in hand. The age
  // floor is the only thing left, so it is asked directly with the stale set.
  const name = sessionWithImage('s1')
  deleteSession('s1')
  rollBackupForward()
  ageFiles()

  // The set as a sweep would have read it a moment ago: this file is in nothing.
  const staleReferences = new Set<string>()
  // Then the save lands.
  sessionWithImage('s2')

  const files = fs.readdirSync(attachDir()).map((entry) => {
    const stat = fs.statSync(path.join(attachDir(), entry))
    return { name: entry, mtimeMs: stat.mtimeMs, isFile: stat.isFile() }
  })

  const doomed = sweepPlan({ files, referenced: staleReferences, now: Date.now() })

  assert.equal(
    doomed.includes(name),
    false,
    'a file re-parked seconds ago was selected on a reference set taken before it'
  )
})

test('A FOLDER IS ADOPTED ONLY ON A NAME THIS APP COULD HAVE WRITTEN', async () => {
  // Without the marker, ownership is proved by a referenced name present in the
  // folder. The reference set holds the basename of every attachment path, and
  // a non-image attachment keeps the real path it came from, so ordinary names
  // are in there. One of those colliding must not adopt a stranger's folder.
  upsertSession({ id: 's1', cwd: '/work/alpha', title: 's1' } as never)
  saveTranscript('s1', [
    msg('m1', [
      {
        id: 'a1',
        kind: 'file',
        name: 'report.pdf',
        path: 'C:/somewhere/else/report.pdf'
      } as PromptAttachment
    ])
  ])

  // A folder this app did not fill, holding a file of that same basename plus
  // hash-shaped images belonging to whoever made it.
  fs.mkdirSync(attachDir(), { recursive: true })
  fs.writeFileSync(path.join(attachDir(), 'report.pdf'), 'theirs')
  const theirImage = `${'c'.repeat(32)}.png`
  fs.writeFileSync(path.join(attachDir(), theirImage), 'theirs')
  ageFiles()

  const result = await sweepAttachments()

  assert.equal(result.refused, 'not-our-directory')
  assert.equal(fs.existsSync(path.join(attachDir(), theirImage)), true)
  assert.equal(
    fs.existsSync(path.join(attachDir(), OWNERSHIP_MARKER)),
    false,
    'a folder this app did not fill was claimed'
  )
})

test('A STORE THAT PARSES BUT IS NOT A STORE REMOVES NOTHING', async () => {
  // Valid JSON that is not a store yields no references, which is
  // indistinguishable from a store that refers to nothing. The store's own
  // reader calls these corrupt and keeps the file so a rescue is possible.
  const name = sessionWithImage('s1')
  ageFiles()

  for (const contents of ['[]', '42', '"just a string"', 'null', '{"sessions":"not an array"}']) {
    fs.writeFileSync(storeFile(), contents)
    const result = await sweepAttachments()
    assert.equal(result.refused, 'store-unreadable', `${contents} was accepted as a store`)
    assert.equal(fs.existsSync(path.join(attachDir(), name)), true)
  }
})

test('a thin but genuine store is still read rather than refused', async () => {
  // The other half: a fresh install and one predating a migration are both
  // legitimately sparse, and refusing those would stop collection for good.
  const name = sessionWithImage('s1')
  deleteSession('s1')
  rollBackupForward()
  ageFiles()
  fs.writeFileSync(storeFile(), '{"version":2,"sessions":[],"transcripts":{}}')

  const result = await sweepAttachments()

  assert.equal(result.refused, null, 'a genuine empty store was refused')
  assert.equal(result.removed, 1)
  assert.equal(fs.existsSync(path.join(attachDir(), name)), false)
})

test('an unrelated corrupt-looking name is not mistaken for a quarantined store', async () => {
  sessionWithImage('s1')
  fs.writeFileSync(path.join(userData, 'gronk-store.corrupt-notes.txt'), 'nothing')
  deleteSession('s1')
  rollBackupForward()
  ageFiles()

  const result = await sweepAttachments()

  assert.equal(result.refused, null)
  assert.equal(result.removed, 1)
})

test('A FOLDER THIS APP DID NOT MAKE IS NEVER SWEPT', async () => {
  // dataDir() can be pointed anywhere. A folder that already had an
  // `attachments` subdirectory, holding files that happen to be 32 hex
  // characters and an image extension, was swept because no transcript names
  // them. The name shape is resemblance, not authorship.
  const theirs = `${'a'.repeat(32)}.png`
  fs.mkdirSync(attachDir(), { recursive: true })
  fs.writeFileSync(path.join(attachDir(), theirs), 'someone else s file')
  upsertSession({ id: 's1', cwd: '/work/alpha', title: 's1' } as never)
  saveTranscript('s1', [msg('m1')])
  ageFiles()

  const result = await sweepAttachments()

  assert.equal(result.refused, 'not-our-directory')
  assert.equal(fs.existsSync(path.join(attachDir(), theirs)), true)
})

test('the folder this app made carries a marker, so it is swept', async () => {
  sessionWithImage('s1')
  assert.equal(
    fs.existsSync(path.join(attachDir(), OWNERSHIP_MARKER)),
    true,
    'parking should claim the folder it creates'
  )
  deleteSession('s1')
  rollBackupForward()
  ageFiles()

  const result = await sweepAttachments()

  assert.equal(result.refused, null)
  assert.equal(result.removed, 1)
})

test('the marker itself is never collected', async () => {
  sessionWithImage('s1')
  deleteSession('s1')
  rollBackupForward()
  ageFiles()

  await sweepAttachments()

  assert.equal(fs.existsSync(path.join(attachDir(), OWNERSHIP_MARKER)), true)
})

test('a folder predating the marker earns one from a file the store still names', async () => {
  // An install whose attachments folder was created before the marker existed
  // would otherwise never be collected from again. A file the store still
  // references is proof of authorship, because that name is a hash of bytes
  // this app parked.
  const kept = sessionWithImage('s1')
  sessionWithImage('s2', GIF_B64)
  fs.rmSync(path.join(attachDir(), OWNERSHIP_MARKER))
  deleteSession('s2')
  rollBackupForward()
  ageFiles()

  const result = await sweepAttachments()

  assert.equal(result.refused, null)
  assert.equal(result.removed, 1, 'the orphan from the deleted session should have gone')
  assert.equal(fs.existsSync(path.join(attachDir(), kept)), true)
  assert.equal(
    fs.existsSync(path.join(attachDir(), OWNERSHIP_MARKER)),
    true,
    'having proved the folder is ours, it should say so next time'
  )
})

test('an unreadable backup removes nothing either', async () => {
  const name = sessionWithImage('s1')
  deleteSession('s1')
  ageFiles()
  fs.writeFileSync(backupFile(), 'not json either')

  const result = await sweepAttachments()

  assert.equal(result.refused, 'backup-unreadable')
  assert.equal(fs.existsSync(path.join(attachDir(), name)), true)
})

test('a file the app did not write is never touched, whatever else is swept', async () => {
  const name = sessionWithImage('s1')
  const foreign = path.join(attachDir(), 'holiday-photo.png')
  const subdir = path.join(attachDir(), 'my-stuff')
  fs.writeFileSync(foreign, 'not ours')
  fs.mkdirSync(subdir)
  deleteSession('s1')
  rollBackupForward()
  ageFiles()
  fs.utimesSync(foreign, new Date(0), new Date(0))

  const result = await sweepAttachments()

  assert.equal(result.removed, 1, 'only the parked file should have gone')
  assert.equal(fs.existsSync(path.join(attachDir(), name)), false)
  assert.equal(fs.existsSync(foreign), true, 'a file the user put here was deleted')
  assert.equal(fs.existsSync(subdir), true, 'a directory was removed')
})

test('a DIRECTORY named like a parked file is not removed', async (t) => {
  // The name guard cannot help here, so what is left is the file-type check.
  // Measured honestly: this test still passes with that check deleted, because
  // `unlink` refuses a directory by itself. It pins the property rather than
  // the mechanism, and the property is what matters if the mechanism moves.
  const decoy = path.join(attachDir(), `${'c'.repeat(32)}.png`)
  sessionWithImage('s1')
  fs.mkdirSync(decoy)
  deleteSession('s1')
  rollBackupForward()
  ageFiles()

  const result = await sweepAttachments()

  assert.equal(fs.existsSync(decoy), true, 'a directory was swept')
  assert.equal(fs.statSync(decoy).isDirectory(), true)
  assert.equal(result.removed, 1, 'the real parked file should still have gone')
  t.diagnostic(`removed ${result.removed}, kept ${result.kept}`)
})

test('a SYMLINK named like a parked file is left alone', async (t) => {
  // The claim is narrow on purpose. `unlink` never follows a link, so the
  // TARGET was never reachable from here and asserting it survives proves
  // nothing about this code. What the file-type check buys is that the link
  // itself is not removed, and that is what this asserts.
  //
  // An earlier version of this test could not fail: it aged the link with
  // `utimes`, which stamps the target and leaves the link young, so the age
  // floor spared it before the file-type check was ever reached.
  const outside = path.join(userData, 'precious.png')
  fs.writeFileSync(outside, 'do not touch')
  sessionWithImage('s1')
  const link = path.join(attachDir(), `${'d'.repeat(32)}.png`)
  try {
    fs.symlinkSync(outside, link)
  } catch {
    // Windows refuses without developer mode or elevation. The ubuntu and
    // macOS legs are what really run this.
    t.skip('symlink creation is not permitted here')
    return
  }
  deleteSession('s1')
  rollBackupForward()
  ageFiles()

  await sweepAttachments()

  assert.equal(
    fs.existsSync(link),
    true,
    'the link was unlinked; only the file-type check stands between it and removal'
  )
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true)
})

test('THE SWEEP NEVER WRITES THE STORE, which is why interrupting it needs no recovery', async () => {
  sessionWithImage('s1')
  sessionWithImage('s2', GIF_B64)
  deleteSession('s1')
  ageFiles()
  const before = fs.readFileSync(storeFile())

  await sweepAttachments()

  assert.deepEqual(
    fs.readFileSync(storeFile()),
    before,
    'the sweep modified the store; a half-finished one would then be a repair job'
  )
})

test('sweeping twice removes nothing the second time', async () => {
  sessionWithImage('s1')
  deleteSession('s1')
  rollBackupForward()
  ageFiles()

  const first = await sweepAttachments()
  const second = await sweepAttachments()

  assert.equal(first.removed, 1)
  assert.equal(second.removed, 0)
  assert.equal(second.refused, null)
})

test('an image trimmed off the end of a long transcript is collected too', async () => {
  // Deleting a session is not the only way a picture loses its last reference.
  // saveTranscript keeps the last 200 messages, so an old image falls out of a
  // conversation the user still has open, with nothing to prompt a cleanup.
  upsertSession({ id: 's1', cwd: '/work/alpha', title: 's1' } as never)
  saveTranscript('s1', [msg('m0', [image('a0')])])
  const name = attachmentFileName(PNG_B64, '.png')
  assert.equal(fs.existsSync(path.join(attachDir(), name)), true)

  const long: ChatMessage[] = [msg('m0', [image('a0')])]
  for (let i = 1; i <= 250; i++) long.push(msg(`m${i}`))
  saveTranscript('s1', long)
  rollBackupForward()
  ageFiles()

  const result = await sweepAttachments()

  assert.equal(result.removed, 1, 'the trimmed-off image was left on disk')
  assert.equal(fs.existsSync(path.join(attachDir(), name)), false)
})

test('with no attachments directory the sweep says so rather than failing', async () => {
  // A store has to exist for this to be the reason: an absent store refuses
  // first, and before that check existed this test passed on a directory with
  // nothing in it at all.
  upsertSession({ id: 's1', cwd: '/work/alpha', title: 's1' } as never)
  saveTranscript('s1', [msg('m1')])

  const result = await sweepAttachments()

  assert.equal(result.refused, 'no-attachment-dir')
  assert.equal(result.removed, 0)
})
