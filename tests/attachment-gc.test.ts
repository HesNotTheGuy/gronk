import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { __freshUserData } from './stubs/electron'
import {
  MIN_AGE_MS,
  isParkedAttachmentName,
  referencedNames,
  sweepAttachments,
  sweepPlan
} from '../electron/main/attachment-gc'
import { ATTACHMENT_DIR, attachmentFileName } from '../electron/main/transcript-repair'
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

/** Backdate every parked file past the age floor, as a real one would be. */
function ageFiles(): void {
  const old = new Date(Date.now() - MIN_AGE_MS - 60_000)
  for (const name of fs.readdirSync(attachDir())) {
    fs.utimesSync(path.join(attachDir(), name), old, old)
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

test('a file is removed only when it clears all three guards', () => {
  const now = 1_000_000_000
  const old = now - MIN_AGE_MS - 1
  const parked = `${'a'.repeat(32)}.png`
  const other = `${'b'.repeat(32)}.png`

  assert.deepEqual(
    sweepPlan({
      files: [{ name: parked, mtimeMs: old }],
      referenced: new Set(),
      now
    }),
    [parked],
    'an old, unreferenced, app-written file should go'
  )

  assert.deepEqual(
    sweepPlan({
      files: [{ name: parked, mtimeMs: old }],
      referenced: new Set([parked]),
      now
    }),
    [],
    'a referenced file must stay'
  )

  assert.deepEqual(
    sweepPlan({ files: [{ name: parked, mtimeMs: now }], referenced: new Set(), now }),
    [],
    'a file written moments ago must stay: a save may be about to reference it'
  )

  assert.deepEqual(
    sweepPlan({ files: [{ name: 'holiday.png', mtimeMs: old }], referenced: new Set(), now }),
    [],
    'a file this app did not write must stay'
  )

  assert.deepEqual(
    sweepPlan({
      files: [
        { name: parked, mtimeMs: old },
        { name: other, mtimeMs: old }
      ],
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

test('A DELETED SESSION KEEPS ITS PICTURES WHILE THE BACKUP STILL HAS IT', async () => {
  // The lag, pinned on purpose so shortening it is a decision rather than an
  // accident. Straight after a delete the retained backup is the copy that
  // still contains the session, and recovering from it has to bring the images
  // back too.
  const name = sessionWithImage('s1')
  deleteSession('s1')
  ageFiles()

  const straightAway = await sweepAttachments()
  assert.equal(straightAway.removed, 0, 'collected while the backup could still restore it')
  assert.equal(fs.existsSync(path.join(attachDir(), name)), true)

  rollBackupForward()
  const later = await sweepAttachments()
  assert.equal(later.removed, 1, 'the backup rolled forward and the file still stayed')
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

test('a picture only the backup still refers to survives', async () => {
  // readStore falls back to the backup when the main file cannot be read, so a
  // transcript that exists only there is one the user can still get back. Its
  // images have to come back with it.
  const name = sessionWithImage('s1')
  fs.copyFileSync(storeFile(), backupFile())
  deleteSession('s1')
  ageFiles()

  const result = await sweepAttachments()

  assert.equal(result.removed, 0, 'the backup still refers to this picture')
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

test('a SYMLINK named like a parked file is not followed', async (t) => {
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

  assert.equal(fs.existsSync(outside), true, 'the sweep reached through a link')
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true, 'the link itself was removed')
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
  const result = await sweepAttachments()
  assert.equal(result.refused, 'no-attachment-dir')
  assert.equal(result.removed, 0)
})
