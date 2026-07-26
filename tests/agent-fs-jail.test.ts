import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveInsideJail, sliceLines } from '../electron/main/agent/fs-bridge'

let scratch = ''
let root = ''

before(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gronk-jail-'))
  root = path.join(scratch, 'project')
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'export {}\n', 'utf8')
  // Sibling whose name starts with the root's: a plain string prefix check lets
  // this one through.
  fs.mkdirSync(path.join(scratch, 'project-evil'), { recursive: true })
  fs.writeFileSync(path.join(scratch, 'project-evil', 'secrets.txt'), 'nope\n', 'utf8')
  fs.writeFileSync(path.join(scratch, 'outside.txt'), 'nope\n', 'utf8')
})

after(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

test('a file inside the project resolves to its real path', () => {
  const safe = resolveInsideJail(root, 'src/app.ts')
  assert.ok(safe)
  assert.equal(fs.readFileSync(safe, 'utf8'), 'export {}\n')
})

test('the project root itself is inside the jail', () => {
  assert.ok(resolveInsideJail(root, '.'))
})

// Creating a file is allowed as long as the deepest folder that does exist is
// inside the project.
test('a file that does not exist yet is allowed inside the project', () => {
  const safe = resolveInsideJail(root, 'src/new/deeper/file.ts')
  assert.ok(safe)
  assert.ok(safe.startsWith(fs.realpathSync(root) + path.sep))
})

test('walking out of the project with .. is refused', () => {
  assert.equal(resolveInsideJail(root, '../outside.txt'), null)
  assert.equal(resolveInsideJail(root, 'src/../../outside.txt'), null)
})

test('an absolute path outside the project is refused', () => {
  assert.equal(resolveInsideJail(root, path.join(scratch, 'outside.txt')), null)
})

// The reason the check is `=== root || startsWith(root + sep)` rather than a
// bare prefix test.
test('a sibling folder whose name merely starts with the root name is refused', () => {
  assert.equal(resolveInsideJail(root, '../project-evil/secrets.txt'), null)
})

// "No project root" would otherwise mean "any path on the machine".
test('with no project root, nothing resolves', () => {
  assert.equal(resolveInsideJail(null, 'src/app.ts'), null)
  assert.equal(resolveInsideJail('', 'src/app.ts'), null)
})

test('a project root that does not exist resolves nothing', () => {
  assert.equal(resolveInsideJail(path.join(scratch, 'gone'), 'app.ts'), null)
})

test('an absolute path inside the project is accepted as given', () => {
  const safe = resolveInsideJail(root, path.join(root, 'src', 'app.ts'))
  assert.equal(safe, path.join(fs.realpathSync(root), 'src', 'app.ts'))
})

// ── line windows ───────────────────────────────────────────────────────────

const FILE = 'one\ntwo\nthree\nfour'

test('no window means the file is returned untouched', () => {
  assert.equal(sliceLines('a\r\nb'), 'a\r\nb')
})

test('the line number is 1-based, as the protocol defines it', () => {
  assert.equal(sliceLines(FILE, 2), 'two\nthree\nfour')
  assert.equal(sliceLines(FILE, 1), FILE)
})

test('a limit counts lines from the start of the window', () => {
  assert.equal(sliceLines(FILE, 2, 2), 'two\nthree')
  assert.equal(sliceLines(FILE, undefined, 2), 'one\ntwo')
})

test('a window past the end of the file yields what there is', () => {
  assert.equal(sliceLines(FILE, 10, 5), '')
  assert.equal(sliceLines(FILE, 4, 99), 'four')
})

test('a nonsense line number clamps to the start rather than throwing', () => {
  assert.equal(sliceLines(FILE, 0, 1), 'one')
  assert.equal(sliceLines(FILE, -5, 1), 'one')
})

test('CRLF input is windowed by line, not by byte', () => {
  assert.equal(sliceLines('a\r\nb\r\nc', 2, 1), 'b')
})
