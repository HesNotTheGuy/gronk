import test, { afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { __setPath } from './stubs/electron'
import {
  DATA_DIR_NAME,
  chatWorkspacePath,
  dataDir,
  defaultDataDir,
  getDataLocation,
  moveDataDir,
  previousChatWorkspacePaths,
  resetDataDir,
  storePath,
  writeFileAtomicSync
} from '../electron/main/data-dir'
import {
  getTranscript,
  listSessions,
  saveTranscript,
  upsertSession
} from '../electron/main/store'
import type { ChatMessage, SessionInfo } from '../shared/types'

const POINTER_FILE = 'grocky-data-location.json'

/** Every temp tree made by a test, removed afterwards. */
let scratch: string[] = []
let appDataRoot = ''
let defaultDir = ''

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  scratch.push(dir)
  return dir
}

// A real Electron app resolves userData as <appData>/<app name>. Both are
// configured here so a test can prove the data directory follows appData and
// ignores the app-name-derived path.
beforeEach(() => {
  appDataRoot = tempDir('grocky-appdata-')
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

function session(partial: Partial<SessionInfo> & { id: string }): SessionInfo {
  return { cwd: 'C:/work/app', createdAt: 1000, updatedAt: 1000, ...partial }
}

function msg(partial: Partial<ChatMessage> & { id: string; role: ChatMessage['role'] }): ChatMessage {
  return { text: '', createdAt: 1, ...partial }
}

/** Seed a store plus a chat-workspace file, so a move has something to lose. */
function seedData(): void {
  upsertSession(session({ id: 's1', title: 'First' }))
  upsertSession(session({ id: 's2', title: 'Second', updatedAt: 2000 }))
  saveTranscript('s1', [
    msg({ id: 'm1', role: 'user', text: 'hello' }),
    msg({ id: 'm2', role: 'assistant', text: 'hi there' })
  ])
  saveTranscript('s2', [msg({ id: 'm3', role: 'user', text: 'second session' })])
  const chat = chatWorkspacePath()
  fs.mkdirSync(path.join(chat, 'notes'), { recursive: true })
  fs.writeFileSync(path.join(chat, 'notes', 'scratch.txt'), 'sandbox file', 'utf8')
}

function readPointer(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(defaultDir, POINTER_FILE), 'utf8'))
}

function tmpFilesIn(dir: string): string[] {
  return fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))
}

// ── The default directory must not follow the app name ──────────────

// app.getPath('userData') is <appData>/<app.getName()>, and getName() returns
// "grocky" only because package.json has a `name` and no top-level
// `productName`. If the data directory were derived from it, renaming the
// product would move userData and every existing user's sessions would be gone
// with no error at all. The segment is pinned instead.

test('the default data directory is the pinned segment under appData', () => {
  assert.equal(defaultDataDir(), path.join(appDataRoot, DATA_DIR_NAME))
  assert.equal(DATA_DIR_NAME, 'grocky', 'changing this is a data migration, not a rename')
})

test('renaming the app does not move the default data directory', () => {
  const before = defaultDataDir()
  // Exactly what a top-level productName would do to userData.
  __setPath('userData', path.join(appDataRoot, 'Grocky Desktop'))
  assert.equal(defaultDataDir(), before, 'the store must not follow the app name')
  assert.equal(getDataLocation().dataDir, before)
  assert.equal(storePath(), path.join(before, 'grocky-store.json'))
})

test('data-dir never asks Electron for the app name', () => {
  const source = fs.readFileSync(
    fileURLToPath(new URL('../electron/main/data-dir.ts', import.meta.url)),
    'utf8'
  )
  // Comments discuss getName() at length — only real calls matter.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  assert.equal(code.includes('getName'), false, 'the app name must not reach a path')
})

// package.json is read here, never written. A top-level productName silently
// repoints Electron's userData; the pinned segment above protects the store, but
// the change would still relocate every OTHER file Chromium keeps there, so it
// must be a deliberate, reviewed edit rather than a drive-by.
test('package.json must not grow a top-level productName', () => {
  const pkg = JSON.parse(
    fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')
  ) as Record<string, unknown>
  assert.equal(
    'productName' in pkg,
    false,
    'a top-level productName changes app.getName() and moves %APPDATA%\\grocky'
  )
  assert.equal(pkg.name, 'grocky', 'app.getName() falls back to `name` — keep it stable')
})

// ── Resolved paths ──────────────────────────────────────────────────

test('the store and chat sandbox live inside the data directory', () => {
  const location = getDataLocation()
  assert.equal(location.isDefault, true)
  assert.equal(location.dataDir, defaultDir)
  assert.equal(location.defaultDir, defaultDir)
  assert.equal(location.storePath, path.join(defaultDir, 'grocky-store.json'))
  assert.equal(location.chatWorkspacePath, path.join(defaultDir, 'chat-workspace'))
  assert.equal(location.previousChatWorkspaces, undefined)
})

test('storeBytes reports the store size once one exists', () => {
  assert.equal(getDataLocation().storeBytes, undefined)
  seedData()
  const bytes = getDataLocation().storeBytes
  assert.ok(typeof bytes === 'number' && bytes > 0)
  assert.equal(bytes, fs.statSync(storePath()).size)
})

// ── The pointer file ────────────────────────────────────────────────

test('a corrupt pointer file falls back to the default directory', () => {
  fs.writeFileSync(path.join(defaultDir, POINTER_FILE), '{ not json', 'utf8')
  assert.equal(dataDir(), defaultDir)
  assert.equal(getDataLocation().isDefault, true)
})

test('a relative path in the pointer is ignored', () => {
  // It would resolve against whatever cwd the app was launched with.
  fs.writeFileSync(
    path.join(defaultDir, POINTER_FILE),
    JSON.stringify({ version: 1, dataDir: 'grocky-data' }),
    'utf8'
  )
  assert.equal(dataDir(), defaultDir)
})

test('a pointer to a directory that is not there is still honoured', () => {
  // An unplugged external drive must not silently redirect writes into a second,
  // empty store — the read comes up empty, which is recoverable; writing new
  // transcripts to the wrong place is not.
  const gone = path.join(appDataRoot, 'unplugged', 'grocky-data')
  fs.writeFileSync(
    path.join(defaultDir, POINTER_FILE),
    JSON.stringify({ version: 1, dataDir: gone }),
    'utf8'
  )
  assert.equal(dataDir(), gone)
  assert.equal(getDataLocation().isDefault, false)
})

// ── Moving ──────────────────────────────────────────────────────────

test('a successful move preserves every session and transcript', async () => {
  seedData()
  const before = listSessions()
  const target = tempDir('grocky-target-')

  const result = await moveDataDir(target)
  assert.equal(result.ok, true, result.message)
  assert.equal(result.location.dataDir, target)
  assert.equal(result.location.isDefault, false)

  assert.equal(storePath(), path.join(target, 'grocky-store.json'))
  assert.equal(fs.existsSync(path.join(target, 'grocky-store.json')), true)
  assert.equal(
    fs.readFileSync(path.join(target, 'chat-workspace', 'notes', 'scratch.txt'), 'utf8'),
    'sandbox file'
  )

  assert.deepEqual(listSessions(), before, 'every session survives the move')
  assert.equal(getTranscript('s1').length, 2)
  assert.equal(getTranscript('s1')[1].text, 'hi there')
  assert.equal(getTranscript('s2').length, 1)
})

test('the source copy is removed once the move is verified', async () => {
  seedData()
  const target = tempDir('grocky-target-')
  assert.equal((await moveDataDir(target)).ok, true)
  assert.equal(fs.existsSync(path.join(defaultDir, 'grocky-store.json')), false)
  assert.equal(fs.existsSync(path.join(defaultDir, 'chat-workspace')), false)
  // The pointer stays behind: it is the only way back to the data.
  assert.equal(fs.existsSync(path.join(defaultDir, POINTER_FILE)), true)
  assert.equal(readPointer().dataDir, target)
})

test('a move leaves no staging directory behind', async () => {
  seedData()
  const target = tempDir('grocky-target-')
  assert.equal((await moveDataDir(target)).ok, true)
  const staged = fs.readdirSync(target).filter((n) => n.startsWith('.grocky-move-'))
  assert.deepEqual(staged, [])
})

test('a move to a folder that already holds a store is refused', async () => {
  seedData()
  const target = tempDir('grocky-target-')
  fs.writeFileSync(path.join(target, 'grocky-store.json'), '{"sessions":[]}', 'utf8')

  const result = await moveDataDir(target)
  assert.equal(result.ok, false)
  assert.match(result.message, /already holds a Grocky store/)
  // Silently merging or clobbering another install's data is not recoverable.
  assert.equal(fs.readFileSync(path.join(target, 'grocky-store.json'), 'utf8'), '{"sessions":[]}')
  assert.equal(result.location.dataDir, defaultDir)
  assert.equal(listSessions().length, 2, 'the original data is untouched')
})

test('a move to a folder that already holds a chat sandbox is refused', async () => {
  seedData()
  const target = tempDir('grocky-target-')
  fs.mkdirSync(path.join(target, 'chat-workspace'), { recursive: true })
  const result = await moveDataDir(target)
  assert.equal(result.ok, false)
  assert.match(result.message, /chat-workspace/)
  assert.equal(dataDir(), defaultDir)
})

test('a move into the current data directory is refused', async () => {
  seedData()
  const result = await moveDataDir(path.join(defaultDir, 'inner'))
  assert.equal(result.ok, false)
  assert.match(result.message, /inside the current data folder/)
  assert.equal(dataDir(), defaultDir)
})

test('a relative target is refused', async () => {
  const result = await moveDataDir('grocky-data')
  assert.equal(result.ok, false)
  assert.match(result.message, /absolute path/)
  assert.equal(dataDir(), defaultDir)
})

test('an empty target is refused', async () => {
  const result = await moveDataDir('   ')
  assert.equal(result.ok, false)
  assert.equal(dataDir(), defaultDir)
})

test('a target that is a file is refused', async () => {
  seedData()
  const file = path.join(tempDir('grocky-target-'), 'not-a-folder.txt')
  fs.writeFileSync(file, 'x', 'utf8')
  const result = await moveDataDir(file)
  assert.equal(result.ok, false)
  assert.match(result.message, /is a file, not a folder/)
  assert.equal(dataDir(), defaultDir)
})

test('a failed move leaves the original intact and says nothing changed', async () => {
  seedData()
  const before = listSessions()
  const root = tempDir('grocky-target-')
  const blocker = path.join(root, 'blocker')
  fs.writeFileSync(blocker, 'a file where a parent folder would have to be', 'utf8')

  const result = await moveDataDir(path.join(blocker, 'grocky-data'))
  assert.equal(result.ok, false)
  assert.match(result.message, /Cannot write to|Cannot use/)
  assert.equal(result.location.dataDir, defaultDir)
  assert.equal(dataDir(), defaultDir)
  assert.deepEqual(listSessions(), before)
  assert.equal(getTranscript('s1').length, 2)
  assert.equal(fs.existsSync(path.join(defaultDir, POINTER_FILE)), false, 'no pointer was written')
})

test('moving to the directory the data is already in reports success and changes nothing', async () => {
  seedData()
  const result = await moveDataDir(defaultDir)
  assert.equal(result.ok, true)
  assert.match(result.message, /already/)
  assert.equal(dataDir(), defaultDir)
  assert.equal(listSessions().length, 2)
})

// ── Previous chat workspaces ────────────────────────────────────────

// The Grok CLI keys its session folders by cwd, so images from earlier chats
// live under the OLD chat-workspace key. Losing these paths orphans them.

test('a move remembers the chat workspace it left behind', async () => {
  seedData()
  const first = tempDir('grocky-target-')
  assert.equal((await moveDataDir(first)).ok, true)

  const location = getDataLocation()
  assert.deepEqual(location.previousChatWorkspaces, [path.join(defaultDir, 'chat-workspace')])
  assert.equal(location.chatWorkspacePath, path.join(first, 'chat-workspace'))
})

test('previous chat workspaces accumulate newest-first without the live one', async () => {
  seedData()
  const first = tempDir('grocky-target-')
  const second = tempDir('grocky-target-')
  assert.equal((await moveDataDir(first)).ok, true)
  assert.equal((await moveDataDir(second)).ok, true)

  assert.deepEqual(previousChatWorkspacePaths(), [
    path.join(first, 'chat-workspace'),
    path.join(defaultDir, 'chat-workspace')
  ])
  assert.equal(
    previousChatWorkspacePaths().includes(chatWorkspacePath()),
    false,
    'the live sandbox is not a previous one'
  )
})

test('the remembered workspace list is capped so it cannot grow forever', async () => {
  seedData()
  for (let i = 0; i < 11; i++) {
    const next = tempDir('grocky-target-')
    assert.equal((await moveDataDir(next)).ok, true, `move ${i}`)
  }
  const previous = previousChatWorkspacePaths()
  assert.ok(previous.length <= 8, `expected a cap, got ${previous.length}`)
  assert.equal(new Set(previous).size, previous.length, 'no duplicates')
})

// ── Reset ───────────────────────────────────────────────────────────

test('reset returns the data to the default directory', async () => {
  seedData()
  const target = tempDir('grocky-target-')
  assert.equal((await moveDataDir(target)).ok, true)
  assert.equal(getDataLocation().isDefault, false)

  const result = await resetDataDir()
  assert.equal(result.ok, true, result.message)
  assert.equal(result.location.isDefault, true)
  assert.equal(result.location.dataDir, defaultDir)
  assert.equal(fs.existsSync(path.join(defaultDir, 'grocky-store.json')), true)
  assert.equal(fs.existsSync(path.join(target, 'grocky-store.json')), false)
  assert.equal(listSessions().length, 2)
  assert.equal(getTranscript('s1').length, 2)
})

test('reset keeps the chat workspaces it passed through', async () => {
  seedData()
  const target = tempDir('grocky-target-')
  assert.equal((await moveDataDir(target)).ok, true)
  assert.equal((await resetDataDir()).ok, true)

  // Back at the default, so the default sandbox is live again and only the
  // relocated one is remembered — still enough to find its CLI-side images.
  assert.deepEqual(previousChatWorkspacePaths(), [path.join(target, 'chat-workspace')])
  assert.equal(readPointer().dataDir, undefined, 'the default needs no dataDir')
})

test('reset while already at the default is a no-op', async () => {
  seedData()
  const result = await resetDataDir()
  assert.equal(result.ok, true)
  assert.equal(result.location.isDefault, true)
  assert.equal(listSessions().length, 2)
})

// ── The atomic write primitive ──────────────────────────────────────

test('an atomic write replaces the file and leaves no temp file behind', () => {
  const file = path.join(defaultDir, 'atomic.json')
  writeFileAtomicSync(file, '{"a":1}')
  writeFileAtomicSync(file, '{"a":2}')
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":2}')
  assert.deepEqual(tmpFilesIn(defaultDir), [])
})

test('a failed atomic write throws and cleans up its temp file', () => {
  // A directory where the file should be: the temp file is created, the rename
  // over it cannot succeed, and the failure must not leave debris.
  const blocked = path.join(defaultDir, 'blocked')
  fs.mkdirSync(blocked, { recursive: true })
  assert.throws(() => writeFileAtomicSync(blocked, 'payload'))
  assert.deepEqual(tmpFilesIn(defaultDir), [])
  assert.equal(fs.statSync(blocked).isDirectory(), true)
})

test('an atomic write that cannot create its directory writes nothing', () => {
  const blocker = path.join(defaultDir, 'file-not-a-dir')
  fs.writeFileSync(blocker, 'x', 'utf8')
  assert.throws(() => writeFileAtomicSync(path.join(blocker, 'nested.json'), 'payload'))
  assert.equal(fs.readFileSync(blocker, 'utf8'), 'x')
})
