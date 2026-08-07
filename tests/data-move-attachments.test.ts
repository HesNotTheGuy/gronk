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
import { readLocalImageSafe } from '../electron/main/ipc/images'
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

test('a parked name that was never parked is still missing after a move', async () => {
  const dest = tempDir('gronk-dest-')
  await moveDataDir(dest)
  const madeUp = path.join(attachmentsIn(defaultDir), `${'a'.repeat(32)}.png`)

  const result = readLocalImageSafe(madeUp)

  assert.notEqual(result.error, undefined)
})
