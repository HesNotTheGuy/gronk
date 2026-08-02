import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { __freshUserData, __setPath, __reset } from './stubs/electron'
import { readLocalImageSafe } from '../electron/main/ipc/images'

/**
 * readLocalImageSafe decides whether bytes from disk are allowed to leave the
 * main process, on a path the agent supplied. It had no tests.
 *
 * The agent hands back bare filenames and relative paths, so resolution has to
 * probe several roots. That is exactly why every resolved path is re-checked
 * against an allow-list before anything is read. These tests pin the checks that
 * matter: extension, containment, size, and the realpath step that stops a
 * symlink pointing out of an allowed root.
 *
 * The stub's app.getPath throws unless configured, so every test sets userData
 * to a fresh temp directory first. That directory IS an allowed root, which is
 * what makes the negative cases meaningful: the same file is readable inside it
 * and refused outside it.
 */

const tempDirs: string[] = []

function scratch(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** A 1x1 PNG, so the reader sees real bytes rather than an empty file. */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

function setup(): { userData: string; outside: string } {
  const userData = __freshUserData('gronk-img-')
  tempDirs.push(userData)
  // data-dir reads these; point them somewhere harmless and inside the sandbox.
  __setPath('home', userData)
  __setPath('appData', userData)
  const outside = scratch('gronk-outside-')
  return { userData, outside }
}

test.after(() => {
  __reset()
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
})

test('reads an image that sits inside an allowed root', () => {
  const { userData } = setup()
  const file = path.join(userData, 'shot.png')
  fs.writeFileSync(file, PNG_1PX)

  const result = readLocalImageSafe(file)
  assert.equal(result.error, undefined, `unexpected error: ${result.error}`)
  assert.ok(result.dataUrl?.startsWith('data:image/png;base64,'), result.dataUrl?.slice(0, 40))
  assert.equal(result.mimeType, 'image/png')
})

test('refuses an image outside every allowed root', () => {
  const { outside } = setup()
  const file = path.join(outside, 'elsewhere.png')
  fs.writeFileSync(file, PNG_1PX)

  const result = readLocalImageSafe(file)
  // The file exists and is a valid PNG. Only containment stops it.
  assert.equal(result.dataUrl, undefined, 'leaked bytes from outside the allowed roots')
  assert.match(String(result.error), /outside allowed image roots/i)
})

test('refuses a non-image extension even inside an allowed root', () => {
  const { userData } = setup()
  // Contents are a real PNG; only the extension differs. The check is on the
  // extension, so this documents that the guard is not content sniffing.
  const file = path.join(userData, 'secrets.txt')
  fs.writeFileSync(file, PNG_1PX)

  const result = readLocalImageSafe(file)
  assert.equal(result.dataUrl, undefined)
  assert.match(String(result.error), /not an image file/i)
})

test('refuses a file with no extension', () => {
  const { userData } = setup()
  const file = path.join(userData, 'noext')
  fs.writeFileSync(file, PNG_1PX)

  const result = readLocalImageSafe(file)
  assert.equal(result.dataUrl, undefined)
  assert.match(String(result.error), /not an image file/i)
})

test('reports a missing file rather than throwing', () => {
  const { userData } = setup()
  const result = readLocalImageSafe(path.join(userData, 'does-not-exist.png'))
  assert.equal(result.dataUrl, undefined)
  assert.match(String(result.error), /not found/i)
})

test('a symlink inside an allowed root cannot reach a file outside it', (t) => {
  const { userData, outside } = setup()
  const target = path.join(outside, 'secret.png')
  fs.writeFileSync(target, PNG_1PX)
  const link = path.join(userData, 'innocent.png')

  try {
    fs.symlinkSync(target, link)
  } catch {
    // Windows needs elevation or developer mode for symlinks. Skipping is
    // honest; silently passing would claim coverage that did not run.
    t.skip('symlink creation not permitted on this machine')
    return
  }

  const result = readLocalImageSafe(link)
  // The link sits in an allowed root; realpath is what defeats it.
  assert.equal(result.dataUrl, undefined, 'a symlink escaped the allowed roots')
  assert.match(String(result.error), /outside allowed image roots/i)
})

test('an allowed root reached through a symlink still matches', (t) => {
  const { userData } = setup()
  const real = path.join(userData, 'real-root')
  fs.mkdirSync(real)
  const file = path.join(real, 'inside.png')
  fs.writeFileSync(file, PNG_1PX)

  const linkedRoot = path.join(userData, 'linked-root')
  try {
    fs.symlinkSync(real, linkedRoot, 'dir')
  } catch {
    t.skip('symlink creation not permitted on this machine')
    return
  }

  // Reaching the same file through the link. The candidate realpaths to
  // .../real-root/inside.png while the root is .../linked-root, so comparing a
  // resolved candidate against an unresolved root refused it. This is exactly
  // what happens on macOS, where the temp dir lives behind /private.
  const result = readLocalImageSafe(path.join(linkedRoot, 'inside.png'))
  assert.equal(result.error, undefined, `symlinked root was refused: ${result.error}`)
  assert.ok(result.dataUrl?.startsWith('data:image/png;base64,'))
})

test('refuses a file over the size cap', () => {
  const { userData } = setup()
  const file = path.join(userData, 'huge.png')
  // MAX_IMAGE_BYTES is enforced from stat, so the content need not be a real
  // image; the size check runs before any decode.
  fs.writeFileSync(file, Buffer.alloc(64 * 1024 * 1024, 0))

  const result = readLocalImageSafe(file)
  assert.equal(result.dataUrl, undefined)
  assert.match(String(result.error), /too large/i)
})

test('strips surrounding quotes the agent may include', () => {
  const { userData } = setup()
  const file = path.join(userData, 'quoted.png')
  fs.writeFileSync(file, PNG_1PX)

  // The agent frequently writes paths as "…" in prose; resolution trims them.
  const result = readLocalImageSafe(`"${file}"`)
  assert.equal(result.error, undefined, `unexpected error: ${result.error}`)
  assert.ok(result.dataUrl?.startsWith('data:image/png;base64,'))
})
