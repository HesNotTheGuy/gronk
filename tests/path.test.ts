import test from 'node:test'
import assert from 'node:assert/strict'
import {
  folderName,
  isChatSession,
  isChatWorkspace,
  isWorkspaceSession,
  normalizePath,
  pathsEqual
} from '../shared/path'

const CHAT_ROOT = 'C:/Users/x/AppData/Roaming/gronk/chat-workspace'

test('normalizePath converts backslashes and strips trailing slashes', () => {
  assert.equal(normalizePath('C:\\work\\app'), 'C:/work/app')
  assert.equal(normalizePath('C:/work/app///'), 'C:/work/app')
  assert.equal(normalizePath('/usr/local/'), '/usr/local')
  assert.equal(normalizePath(''), '')
})

test('Windows-looking paths compare case-insensitively', () => {
  assert.equal(pathsEqual('C:\\Work\\App', 'c:/work/app'), true)
  assert.equal(pathsEqual('//server/share', '//SERVER/share'), true)
})

test('POSIX paths stay case-sensitive unless told otherwise', () => {
  assert.equal(pathsEqual('/home/x/App', '/home/x/app'), false)
  assert.equal(pathsEqual('/home/x/App', '/home/x/app', { ignoreCase: true }), true)
})

test('folderName returns the last segment', () => {
  assert.equal(folderName('C:\\work\\my-app'), 'my-app')
  assert.equal(folderName('/home/x/proj/'), 'proj')
  assert.equal(folderName('solo'), 'solo')
})

// ── Chat sandbox detection ──────────────────────────────────────────
// Chat sessions must never surface in the Build (project) lists. The path is
// authoritative so a wrong or missing `surface` field cannot leak them across.

test('the configured chat root is recognised', () => {
  assert.equal(isChatWorkspace(CHAT_ROOT, CHAT_ROOT), true)
  assert.equal(isChatWorkspace('C:\\Users\\x\\AppData\\Roaming\\gronk\\chat-workspace', CHAT_ROOT), true)
})

test('the sandbox is recognised without knowing the root', () => {
  assert.equal(isChatWorkspace('/home/x/.config/gronk/chat-workspace', null), true)
  assert.equal(isChatWorkspace('chat-workspace', null), true)
  assert.equal(isChatWorkspace('D:/somewhere/gronk/chat-workspace/sub', null), true)
})

test('ordinary project folders are not the sandbox', () => {
  assert.equal(isChatWorkspace('C:/work/app', null), false)
  assert.equal(isChatWorkspace('C:/work/chat-workspace-notes', null), false)
  assert.equal(isChatWorkspace('', null), false)
})

test('a sandbox path wins over a wrong surface field', () => {
  const leaked = { cwd: CHAT_ROOT, surface: 'project' as const }
  assert.equal(isChatSession(leaked), true, 'must not leak into Build lists')
  assert.equal(isWorkspaceSession(leaked), false)
})

test('surface=chat is honoured for a session outside the sandbox', () => {
  assert.equal(isChatSession({ cwd: 'C:/work/app', surface: 'chat' }), true)
})

test('a project session with no surface is a workspace session', () => {
  assert.equal(isWorkspaceSession({ cwd: 'C:/work/app' }), true)
  assert.equal(isChatSession({ cwd: 'C:/work/app' }), false)
})

test('chat and workspace classification are exact inverses', () => {
  const rows = [
    { cwd: CHAT_ROOT },
    { cwd: CHAT_ROOT, surface: 'project' as const },
    { cwd: 'C:/work/app' },
    { cwd: 'C:/work/app', surface: 'chat' as const }
  ]
  for (const r of rows) {
    assert.notEqual(isChatSession(r, CHAT_ROOT), isWorkspaceSession(r, CHAT_ROOT))
  }
})
