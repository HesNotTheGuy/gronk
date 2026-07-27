import test from 'node:test'
import assert from 'node:assert/strict'
import {
  cloudSyncServiceFor,
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

// ── cloud sync detection ───────────────────────────────────────────────────
// Transcripts are stored as readable text, so relocating the data directory into
// a synced folder uploads every conversation to a third party. This drives a
// warning only, so the cost of being wrong is one dismissable notice.

test('the common sync roots are recognised on Windows and macOS', () => {
  const cases: Array<[string, string]> = [
    ['C:/Users/sam/OneDrive/gronk', 'OneDrive'],
    ['C:\\Users\\sam\\OneDrive\\gronk', 'OneDrive'],
    ['C:/Users/sam/Dropbox/gronk', 'Dropbox'],
    ['/Users/sam/Dropbox/gronk', 'Dropbox'],
    ['/Users/sam/Google Drive/gronk', 'Google Drive'],
    ['C:/Users/sam/Nextcloud/data', 'Nextcloud'],
    ['/Users/sam/Library/Mobile Documents/com~apple~CloudDocs/gronk', 'iCloud Drive']
  ]
  for (const [dir, service] of cases) {
    assert.equal(cloudSyncServiceFor(dir), service, dir)
  }
})

// Every provider decorates the folder with the account name, so an exact-match
// check would miss the majority of real installs.
test('a sync root carrying an account suffix is still recognised', () => {
  assert.equal(cloudSyncServiceFor('C:/Users/sam/OneDrive - Contoso/gronk'), 'OneDrive')
  assert.equal(cloudSyncServiceFor('C:/Users/sam/Dropbox (Personal)/gronk'), 'Dropbox')
  assert.equal(cloudSyncServiceFor('/Users/sam/Library/CloudStorage/OneDrive-Personal/x'), 'OneDrive')
  assert.equal(
    cloudSyncServiceFor('/Users/sam/Library/CloudStorage/GoogleDrive-sam@example.com/x'),
    'Google Drive'
  )
})

// macOS routes every provider through Library/CloudStorage, so the parent proves
// it is synced even for a provider this list has never heard of.
test('an unknown provider under macOS CloudStorage is still flagged', () => {
  assert.equal(
    cloudSyncServiceFor('/Users/sam/Library/CloudStorage/SomeNewThing-account/x'),
    'a cloud-synced folder'
  )
})

test('an ordinary local directory is not flagged', () => {
  for (const dir of [
    'C:/Users/sam/AppData/Roaming/gronk',
    'C:/gronk-data',
    '/home/sam/.config/gronk',
    '/Users/sam/Documents/gronk',
    ''
  ]) {
    assert.equal(cloudSyncServiceFor(dir), null, dir)
  }
})

// A false positive nags someone who did nothing wrong, so the match cannot be a
// bare substring: these all CONTAIN a provider name without being one.
test('a folder that merely contains a provider name is not a sync root', () => {
  for (const dir of [
    'C:/projects/dropbox-clone/data',
    'C:/projects/my-onedrive-backup-tool/data',
    '/home/sam/boxes/gronk',
    '/home/sam/megaproject/gronk'
  ]) {
    assert.equal(cloudSyncServiceFor(dir), null, dir)
  }
})
