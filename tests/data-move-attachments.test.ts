import test, { afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { __setPath } from './stubs/electron'
import {
  ATTACHMENT_DIR,
  DATA_DIR_NAME,
  dataDir,
  moveDataDir,
  resetDataDir
} from '../electron/main/data-dir'
import { parkAttachmentBytes } from '../electron/main/transcript-repair'
import { readLocalImageSafe, revealLocalPathSafe } from '../electron/main/ipc/images'
import type { PromptAttachment } from '../shared/types'

/**
 * Moving the data folder has to take the attached images with it.
 *
 * The store, its backup and the chat sandbox already moved. `attachments` did
 * not, and every transcript in the relocated store still held a path pointing
 * back at the old folder. It kept working only because the old folder was
 * inside userData, which the image allow-list happens to accept — so the
 * failure was invisible until the old location went away.
 *
 * Two halves, and both are needed: the bytes have to arrive at the new folder,
 * and a path written before the move has to still find them.
 */

let scratch: string[] = []
let appDataRoot = ''
let defaultDir = ''

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  scratch.push(dir)
  return dir
}

beforeEach(() => {
  appDataRoot = tempDir('gronk-appdata-')
  defaultDir = path.join(appDataRoot, DATA_DIR_NAME)
  fs.mkdirSync(defaultDir, { recursive: true })
  __setPath('appData', appDataRoot)
  __setPath('userData', defaultDir)
})

afterEach(() => {
  for (const dir of scratch) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* a leftover temp dir must not fail the suite */
    }
  }
  scratch = []
})

/** A 1x1 PNG, so what is parked is a real image. */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

/** Park an image the way saveTranscript does, and hand back its stored path. */
function parkImage(data = PNG_B64): string {
  const attachment = {
    id: 'a1',
    kind: 'image',
    name: 'paste.png',
    mimeType: 'image/png',
    data
  } as PromptAttachment
  const parked = parkAttachmentBytes(attachment)
  assert.ok(parked, 'the fixture failed to park anything')
  return parked
}

const attachmentsIn = (dir: string) => path.join(dir, ATTACHMENT_DIR)

/**
 * Canonicalised, for comparing against a path the app has already realpathed.
 *
 * On macOS a temp directory under `/var/folders/...` really lives at
 * `/private/var/folders/...`, and `readLocalImageSafe` returns the resolved
 * form. Comparing it to the raw path fails there and nowhere else.
 */
function realpath(target: string): string {
  try {
    return fs.realpathSync(target)
  } catch {
    return target
  }
}

// ── The bytes have to move ──────────────────────────────────────────────────

test('THE REPORTED BUG: a move carries the attachments with everything else', async () => {
  const stored = parkImage()
  const name = path.basename(stored)
  const dest = tempDir('gronk-dest-')

  const result = await moveDataDir(dest)

  assert.equal(result.ok, true, result.message)
  assert.equal(
    fs.existsSync(path.join(attachmentsIn(dest), name)),
    true,
    'the image did not arrive at the new data folder'
  )
})

test('the old copy is removed once the move is verified', async () => {
  parkImage()
  const before = attachmentsIn(dataDir())
  const dest = tempDir('gronk-dest-')

  await moveDataDir(dest)

  assert.equal(fs.existsSync(before), false, 'the images were copied but never removed')
})

test('every parked file arrives, not just the first', async () => {
  const names = [
    parkImage(PNG_B64),
    parkImage('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7')
  ].map((p) => path.basename(p))
  // The second is a GIF's bytes under a .png name, which is fine: the name is a
  // content hash, so these are two distinct files either way.
  assert.notEqual(names[0], names[1])
  const dest = tempDir('gronk-dest-')

  await moveDataDir(dest)

  for (const name of names) {
    assert.equal(fs.existsSync(path.join(attachmentsIn(dest), name)), true, `${name} was left behind`)
  }
})

test('a move with no attachments folder still succeeds', async () => {
  const dest = tempDir('gronk-dest-')
  const result = await moveDataDir(dest)
  assert.equal(result.ok, true, result.message)
  assert.equal(fs.existsSync(attachmentsIn(dest)), false)
})

test('reset back to the default brings the attachments home', async () => {
  const stored = parkImage()
  const name = path.basename(stored)
  const dest = tempDir('gronk-dest-')
  await moveDataDir(dest)

  const result = await resetDataDir()

  assert.equal(result.ok, true, result.message)
  assert.equal(fs.existsSync(path.join(attachmentsIn(defaultDir), name)), true)
  assert.equal(fs.existsSync(path.join(attachmentsIn(dest), name)), false)
})

// ── Failing safely ──────────────────────────────────────────────────────────

test('A DESTINATION THAT ALREADY HAS AN ATTACHMENTS FOLDER IS REFUSED', async () => {
  // That pool belongs to another install and nothing here can tell which of its
  // transcripts reference which file, so it is refused rather than merged, the
  // same as a store or a chat sandbox.
  const stored = parkImage()
  const dest = tempDir('gronk-dest-')
  fs.mkdirSync(attachmentsIn(dest), { recursive: true })
  fs.writeFileSync(path.join(attachmentsIn(dest), 'theirs.png'), 'not ours')

  const result = await moveDataDir(dest)

  assert.equal(result.ok, false)
  // The specific refusal, not merely a failure. Without the check the move gets
  // as far as trying to rename onto the existing folder and fails anyway, with a
  // message that still mentions the path — so a loose assertion here passes
  // while the destination has already been staged into.
  assert.match(result.message, /already holds an attachments folder/)
  assert.equal(fs.existsSync(stored), true, 'a refused move must leave the original alone')
  assert.equal(
    fs.readFileSync(path.join(attachmentsIn(dest), 'theirs.png'), 'utf8'),
    'not ours',
    "a refused move must not touch the destination's own files"
  )
  assert.deepEqual(
    fs.readdirSync(dest).sort(),
    [ATTACHMENT_DIR],
    'nothing should have been staged or placed at a destination that was refused'
  )
})

test('a refused move leaves the data directory where it was', async () => {
  parkImage()
  const was = dataDir()
  const dest = tempDir('gronk-dest-')
  fs.mkdirSync(attachmentsIn(dest), { recursive: true })

  await moveDataDir(dest)

  assert.equal(dataDir(), was)
})

test('a move leaves no staging directory behind', async () => {
  parkImage()
  const dest = tempDir('gronk-dest-')
  await moveDataDir(dest)
  assert.deepEqual(
    fs.readdirSync(dest).filter((n) => n.startsWith('.gronk-move-')),
    []
  )
})

// ── A path written before the move still finds its file ─────────────────────

test('AN IMAGE STILL RENDERS FROM THE PATH STORED BEFORE THE MOVE', async () => {
  // The half that a copy alone does not fix. Stored paths are absolute and were
  // written when the data folder was somewhere else, so after a move every one
  // of them names a file that is no longer there.
  const storedBefore = parkImage()
  const dest = tempDir('gronk-dest-')
  await moveDataDir(dest)
  assert.equal(fs.existsSync(storedBefore), false, 'the fixture did not actually move the file')

  const result = readLocalImageSafe(storedBefore)

  assert.equal(result.error, undefined, `expected the image to resolve, got ${result.error}`)
  assert.match(result.dataUrl ?? '', /^data:image\/png;base64,/)
  assert.equal(
    realpath(path.dirname(result.path ?? '')),
    realpath(attachmentsIn(dest)),
    'it resolved to something other than the relocated attachments folder'
  )
})

test('the relocated attachments folder is inside the allow-list, not merely found', async () => {
  // Resolution and permission are separate steps, and the folder is outside
  // userData after a move. Reading the bytes back is the only proof it passes
  // both.
  const storedBefore = parkImage()
  const dest = tempDir('gronk-dest-')
  await moveDataDir(dest)

  const result = readLocalImageSafe(path.join(attachmentsIn(dest), path.basename(storedBefore)))

  assert.equal(result.error, undefined, `the allow-list refused the moved folder: ${result.error}`)
})

test('the fallback is scoped to attachment paths and finds nothing else', async () => {
  // The extra candidate applies only to a path whose parent folder is the
  // attachments folder. A file somewhere else that happens to share a name must
  // not start resolving to a parked image.
  parkImage()
  const stored = parkImage()
  const elsewhere = path.join(tempDir('gronk-other-'), path.basename(stored))

  const result = readLocalImageSafe(elsewhere)

  assert.notEqual(result.error, undefined, 'an unrelated path resolved to a parked attachment')
})

// ── The folder is not evidence of who filled it ─────────────────────────────

test("A FILE THIS APP DID NOT WRITE IS NOT READABLE JUST FOR SITTING THERE", async () => {
  // The data directory is user-chosen, so a folder that already had an
  // `attachments` child before it was picked says nothing about who put what in
  // it. Containment alone would make that whole subtree readable.
  const dest = tempDir('gronk-dest-')
  fs.mkdirSync(attachmentsIn(dest), { recursive: true })
  fs.writeFileSync(path.join(attachmentsIn(dest), 'holiday.png'), 'theirs')
  fs.writeFileSync(path.join(attachmentsIn(dest), 'notes.txt'), 'theirs')
  fs.mkdirSync(path.join(attachmentsIn(dest), 'private'), { recursive: true })
  fs.writeFileSync(path.join(attachmentsIn(dest), 'private', 'deep.png'), 'theirs')
  // Reached through the pointer, the way an older build would have left it: the
  // move itself refuses this destination, and that refusal cannot reach a
  // pointer already written.
  fs.writeFileSync(
    path.join(defaultDir, 'gronk-data-location.json'),
    JSON.stringify({ version: 1, dataDir: dest })
  )
  assert.equal(dataDir(), dest, 'the fixture did not relocate the data directory')

  for (const name of ['holiday.png', 'notes.txt', path.join('private', 'deep.png')]) {
    const result = readLocalImageSafe(path.join(attachmentsIn(dest), name))
    assert.notEqual(result.error, undefined, `${name} was served out of a folder we did not fill`)
    assert.equal(result.dataUrl, undefined)
  }
})

test('a PARKED-LOOKING name nested below the folder is still refused', async () => {
  // Isolates the direct-child half. The test above is carried by the name check
  // alone, because nothing in it is named the way this app names a file; a
  // subdirectory holding one that is would pass a recursive test.
  const dest = tempDir('gronk-dest-')
  const nested = path.join(attachmentsIn(dest), 'nested')
  fs.mkdirSync(nested, { recursive: true })
  const lookalike = path.join(nested, `${'a'.repeat(32)}.png`)
  fs.writeFileSync(lookalike, 'theirs')
  fs.writeFileSync(
    path.join(defaultDir, 'gronk-data-location.json'),
    JSON.stringify({ version: 1, dataDir: dest })
  )

  const result = readLocalImageSafe(lookalike)

  assert.notEqual(result.error, undefined, 'a nested lookalike was served')
  assert.equal(result.dataUrl, undefined)
})

test('a parked name in that same folder is still readable', async () => {
  // The other half: narrowing must not break the thing the root exists for.
  const dest = tempDir('gronk-dest-')
  fs.mkdirSync(attachmentsIn(dest), { recursive: true })
  fs.writeFileSync(path.join(attachmentsIn(dest), 'holiday.png'), 'theirs')
  fs.writeFileSync(
    path.join(defaultDir, 'gronk-data-location.json'),
    JSON.stringify({ version: 1, dataDir: dest })
  )
  const parked = parkImage()

  const result = readLocalImageSafe(parked)

  assert.equal(result.error, undefined, `a parked image was refused: ${result.error}`)
  assert.match(result.dataUrl ?? '', /^data:image\/png;base64,/)
})

test('reveal is bounded by the same rule, not only by containment', async () => {
  // revealLocalPathSafe has no extension check and does not require a file, so
  // containment was the only thing bounding it inside this root.
  const dest = tempDir('gronk-dest-')
  fs.mkdirSync(path.join(attachmentsIn(dest), 'private'), { recursive: true })
  fs.writeFileSync(path.join(attachmentsIn(dest), 'notes.txt'), 'theirs')
  fs.writeFileSync(
    path.join(defaultDir, 'gronk-data-location.json'),
    JSON.stringify({ version: 1, dataDir: dest })
  )

  for (const target of [path.join(attachmentsIn(dest), 'notes.txt'), path.join(attachmentsIn(dest), 'private')]) {
    const res = revealLocalPathSafe(target)
    assert.equal(res.ok, false, `${target} was revealed out of a folder we did not fill`)
  }
})

// ── Reset must not be wedged by what an older version left behind ───────────

test('RESET STILL WORKS WHEN THE DEFAULT ALREADY HOLDS AN ATTACHMENTS FOLDER', async () => {
  // A version that moved the store without the attachments left one at the
  // default location. Refusing there makes Reset permanently dead, and Reset
  // has a fixed target with no picker, so the message names nothing the user
  // can do.
  const stored = parkImage()
  const name = path.basename(stored)
  const dest = tempDir('gronk-dest-')
  await moveDataDir(dest)
  // The orphan the previous version would have left behind.
  fs.mkdirSync(attachmentsIn(defaultDir), { recursive: true })
  fs.writeFileSync(path.join(attachmentsIn(defaultDir), 'older-build.png'), 'left behind')

  const result = await resetDataDir()

  assert.equal(result.ok, true, result.message)
  assert.equal(dataDir(), defaultDir)
  assert.equal(
    fs.existsSync(path.join(attachmentsIn(defaultDir), name)),
    true,
    'the moved image did not arrive'
  )
  assert.equal(
    fs.existsSync(path.join(attachmentsIn(defaultDir), 'older-build.png')),
    true,
    'the folder it merged into lost a file'
  )
})

test('merging keeps the copy already in place, since the name is the content', async () => {
  const stored = parkImage()
  const name = path.basename(stored)
  const dest = tempDir('gronk-dest-')
  await moveDataDir(dest)
  fs.mkdirSync(attachmentsIn(defaultDir), { recursive: true })
  fs.writeFileSync(path.join(attachmentsIn(defaultDir), name), 'ALREADY HERE')

  const result = await resetDataDir()

  assert.equal(result.ok, true, result.message)
  assert.equal(fs.readFileSync(path.join(attachmentsIn(defaultDir), name), 'utf8'), 'ALREADY HERE')
})

test('a user-picked destination holding attachments is still refused', async () => {
  // The narrowing above is for the default target only. Everywhere else the
  // refusal stands.
  parkImage()
  const dest = tempDir('gronk-dest-')
  fs.mkdirSync(attachmentsIn(dest), { recursive: true })

  const result = await moveDataDir(dest)

  assert.equal(result.ok, false)
  assert.match(result.message, /already holds an attachments folder/)
})

// ── A directory predating the rename ────────────────────────────────────────

test('A LEGACY-NAMED STORE MOVES WITH ITS ATTACHMENTS', async () => {
  // holdsStore and storePath both honour the pre-rename name, so a directory on
  // it is live. Carrying the attachments and leaving the store behind is the
  // half of this that becomes destructive once something collects unreferenced
  // images.
  const stored = parkImage()
  const name = path.basename(stored)
  fs.writeFileSync(path.join(defaultDir, 'grocky-store.json'), '{"sessions":[],"transcripts":{}}')
  fs.writeFileSync(path.join(defaultDir, 'grocky-store.backup.json'), '{"sessions":[]}')
  fs.rmSync(path.join(defaultDir, 'gronk-store.json'), { force: true })
  fs.rmSync(path.join(defaultDir, 'gronk-store.backup.json'), { force: true })
  const dest = tempDir('gronk-dest-')

  const result = await moveDataDir(dest)

  assert.equal(result.ok, true, result.message)
  assert.equal(
    fs.existsSync(path.join(dest, 'grocky-store.json')),
    true,
    'the legacy store was left behind while its attachments moved'
  )
  assert.equal(fs.existsSync(path.join(dest, 'grocky-store.backup.json')), true)
  assert.equal(fs.existsSync(path.join(attachmentsIn(dest), name)), true)
  assert.equal(fs.existsSync(path.join(defaultDir, 'grocky-store.json')), false)
})

test('a parked name that was never parked is still missing after a move', async () => {
  const dest = tempDir('gronk-dest-')
  await moveDataDir(dest)
  const madeUp = path.join(attachmentsIn(defaultDir), `${'a'.repeat(32)}.png`)

  const result = readLocalImageSafe(madeUp)

  assert.notEqual(result.error, undefined)
})
