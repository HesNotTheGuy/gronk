import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { __freshUserData } from './stubs/electron'
import {
  addRecentProject,
  appendPermissionAudit,
  archiveSession,
  dedupeTranscriptMessages,
  deleteSession,
  getPermissionAudit,
  getRecentProjects,
  getSettings,
  getTranscript,
  listSessions,
  normalizeCwd,
  renameSession,
  saveTranscript,
  setSettings,
  upsertSession
} from '../electron/main/store'
import { PERMISSION_MODE_OPTIONS, type ChatMessage, type SessionInfo } from '../shared/types'

let userData = ''

// Every test gets its own userData directory, so nothing leaks between cases
// and the developer's real grocky-store.json is never touched.
beforeEach(() => {
  userData = __freshUserData()
})

function storeFile(): string {
  return path.join(userData, 'grocky-store.json')
}

/** Settings block exactly as it sits on disk (legacy files may carry extra keys). */
function readStoredSettings(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(storeFile(), 'utf8')).settings
}

/** Plant a store file, including shapes only older builds could have written. */
function writeStoredSettings(settings: Record<string, unknown>): void {
  fs.mkdirSync(userData, { recursive: true })
  fs.writeFileSync(storeFile(), JSON.stringify({ settings }), 'utf8')
}

function session(partial: Partial<SessionInfo> & { id: string }): SessionInfo {
  return { cwd: 'C:/work/app', createdAt: 1000, updatedAt: 1000, ...partial }
}

function msg(partial: Partial<ChatMessage> & { id: string; role: ChatMessage['role'] }): ChatMessage {
  return { text: '', createdAt: 1, ...partial }
}

// ── Settings + the YOLO acknowledgement guard (FIX-14) ──────────────

test('defaults are returned when no store file exists', () => {
  assert.equal(fs.existsSync(storeFile()), false)
  const s = getSettings()
  assert.equal(s.permissionMode, 'default')
  assert.equal(s.alwaysApprove, false)
})

test('YOLO cannot be enabled without an acknowledgement already on disk', () => {
  const after = setSettings({ alwaysApprove: true })
  assert.equal(after.alwaysApprove, false, 'must not enable on an unacknowledged install')
  assert.equal(after.permissionMode, 'default')
})

test('ack and enable in the SAME call must not enable YOLO', () => {
  // The whole point of FIX-14: a single malicious/buggy call cannot self-authorize.
  const after = setSettings({ alwaysApproveAck: true, alwaysApprove: true })
  assert.equal(after.alwaysApprove, false)
  assert.equal(after.permissionMode, 'default')
})

test('YOLO enables only after a separate acknowledgement was persisted', () => {
  setSettings({ alwaysApproveAck: true })
  const after = setSettings({ alwaysApprove: true })
  assert.equal(after.alwaysApprove, true)
  assert.equal(after.permissionMode, 'bypassPermissions')
})

test('bypassPermissions mode is downgraded without a prior ack', () => {
  assert.equal(setSettings({ permissionMode: 'bypassPermissions' }).permissionMode, 'default')
  setSettings({ alwaysApproveAck: true })
  assert.equal(
    setSettings({ permissionMode: 'bypassPermissions' }).permissionMode,
    'bypassPermissions'
  )
})

test('turning YOLO off also leaves bypassPermissions mode', () => {
  setSettings({ alwaysApproveAck: true })
  setSettings({ alwaysApprove: true })
  const off = setSettings({ alwaysApprove: false })
  assert.equal(off.alwaysApprove, false)
  assert.equal(off.permissionMode, 'default')
})

test('choosing any non-bypass mode clears alwaysApprove', () => {
  setSettings({ alwaysApproveAck: true })
  setSettings({ alwaysApprove: true })
  assert.equal(setSettings({ permissionMode: 'acceptEdits' }).alwaysApprove, false)
})

test('empty grokBinary / model clears the override instead of storing ""', () => {
  setSettings({ grokBinary: 'C:/custom/grok.exe', model: 'grok-4.5' })
  const cleared = setSettings({ grokBinary: '', model: '' })
  assert.equal('grokBinary' in cleared, false)
  assert.equal('model' in cleared, false)
})

test('a corrupt store file falls back to defaults rather than throwing', () => {
  fs.mkdirSync(userData, { recursive: true })
  fs.writeFileSync(storeFile(), '{ not json', 'utf8')
  assert.equal(getSettings().permissionMode, 'default')
})

// ── permissionMode is the only stored permission fact ───────────────

test('alwaysApprove is derived on read, never persisted', () => {
  setSettings({ alwaysApproveAck: true })
  setSettings({ alwaysApprove: true })
  const stored = readStoredSettings()
  assert.equal('alwaysApprove' in stored, false, 'the derived field must not reach disk')
  assert.equal(stored.permissionMode, 'bypassPermissions')
  assert.equal(getSettings().alwaysApprove, true)
})

test('a derived read matches the mode for every mode', () => {
  setSettings({ alwaysApproveAck: true })
  for (const mode of PERMISSION_MODE_OPTIONS.map((o) => o.id)) {
    const after = setSettings({ permissionMode: mode })
    assert.equal(after.permissionMode, mode)
    assert.equal(after.alwaysApprove, mode === 'bypassPermissions', `mode ${mode}`)
    assert.equal(getSettings().alwaysApprove, after.alwaysApprove, `mode ${mode} on re-read`)
    assert.equal('alwaysApprove' in readStoredSettings(), false, `mode ${mode} on disk`)
  }
})

test('an unrelated setting change never disturbs the permission mode', () => {
  setSettings({ alwaysApproveAck: true })
  setSettings({ alwaysApprove: true })
  const after = setSettings({ theme: 'light' })
  assert.equal(after.permissionMode, 'bypassPermissions')
  assert.equal(after.alwaysApprove, true)
})

// A patch that contradicts itself is a bug somewhere upstream; resolve it towards
// less access so no call can turn bypass on as a side effect of something else.
test('a patch that disagrees with itself resolves to the safer value', () => {
  setSettings({ alwaysApproveAck: true })
  const gated = setSettings({ permissionMode: 'acceptEdits', alwaysApprove: true })
  assert.equal(gated.permissionMode, 'acceptEdits')
  assert.equal(gated.alwaysApprove, false)

  setSettings({ alwaysApprove: true })
  const off = setSettings({ permissionMode: 'bypassPermissions', alwaysApprove: false })
  assert.equal(off.permissionMode, 'default')
  assert.equal(off.alwaysApprove, false)
})

test('the UI two-step (ack, then mode + toggle together) still enables YOLO', () => {
  // Exactly what useGrocky.confirmYolo sends.
  setSettings({ alwaysApproveAck: true })
  const after = setSettings({ alwaysApprove: true, permissionMode: 'bypassPermissions' })
  assert.equal(after.permissionMode, 'bypassPermissions')
  assert.equal(after.alwaysApprove, true)
})

test('revoking the acknowledgement drops YOLO in the same call', () => {
  setSettings({ alwaysApproveAck: true })
  setSettings({ alwaysApprove: true })
  const revoked = setSettings({ alwaysApproveAck: false })
  assert.equal(revoked.permissionMode, 'default')
  assert.equal(revoked.alwaysApprove, false)
})

// ── Migration of stores written before the collapse ─────────────────
// Older builds persisted both fields, so any combination can be on disk. When
// they disagree the safer value wins, and bypass always needs the ack.

test('a consistent acknowledged bypass store survives untouched', () => {
  writeStoredSettings({
    permissionMode: 'bypassPermissions',
    alwaysApprove: true,
    alwaysApproveAck: true
  })
  const s = getSettings()
  assert.equal(s.permissionMode, 'bypassPermissions')
  assert.equal(s.alwaysApprove, true)
})

test('a store written by this build (no alwaysApprove key) keeps its bypass mode', () => {
  writeStoredSettings({ permissionMode: 'bypassPermissions', alwaysApproveAck: true })
  assert.equal(getSettings().permissionMode, 'bypassPermissions')
  assert.equal(getSettings().alwaysApprove, true)
})

test('bypassPermissions beside alwaysApprove:false resolves to the gated mode', () => {
  // The drift the collapse removes: this store used to spawn --always-approve
  // while the in-app toggle read off.
  writeStoredSettings({
    permissionMode: 'bypassPermissions',
    alwaysApprove: false,
    alwaysApproveAck: true
  })
  const s = getSettings()
  assert.equal(s.permissionMode, 'default')
  assert.equal(s.alwaysApprove, false)
})

test('a stray alwaysApprove:true never promotes a gated mode to bypass', () => {
  writeStoredSettings({
    permissionMode: 'acceptEdits',
    alwaysApprove: true,
    alwaysApproveAck: true
  })
  const s = getSettings()
  assert.equal(s.permissionMode, 'acceptEdits')
  assert.equal(s.alwaysApprove, false)
})

test('alwaysApprove:true with no mode at all stays on the default mode', () => {
  writeStoredSettings({ alwaysApprove: true, alwaysApproveAck: true })
  assert.equal(getSettings().permissionMode, 'default')
  assert.equal(getSettings().alwaysApprove, false)
})

test('a store claiming YOLO but never acknowledged cannot launch into bypass', () => {
  writeStoredSettings({ permissionMode: 'bypassPermissions', alwaysApprove: true })
  const s = getSettings()
  assert.equal(s.permissionMode, 'default')
  assert.equal(s.alwaysApprove, false)
  assert.equal(!!s.alwaysApproveAck, false)

  // Acknowledging afterwards must not resurrect the mode the file claimed: the
  // downgrade already happened, so YOLO still needs its own explicit enable.
  const acked = setSettings({ alwaysApproveAck: true })
  assert.equal(acked.permissionMode, 'default')
  assert.equal(acked.alwaysApprove, false)
})

test('the legacy field is dropped from disk on the next write', () => {
  writeStoredSettings({
    permissionMode: 'bypassPermissions',
    alwaysApprove: true,
    alwaysApproveAck: true
  })
  setSettings({ theme: 'light' })
  const stored = readStoredSettings()
  assert.equal('alwaysApprove' in stored, false)
  assert.equal(stored.permissionMode, 'bypassPermissions')
})

// ── Recent projects: the chat sandbox is never a coding folder ───────

test('the chat sandbox is never recorded as a recent project', () => {
  const projects = addRecentProject('C:/Users/x/AppData/Roaming/grocky/chat-workspace')
  assert.deepEqual(projects, [])
  assert.deepEqual(getRecentProjects(), [])
})

test('recent projects are normalized, de-duplicated and most-recent-first', () => {
  addRecentProject('C:/work/alpha')
  addRecentProject('C:/work/beta')
  const list = addRecentProject('C:\\work\\alpha')
  assert.equal(list.length, 2)
  assert.equal(list[0].cwd, normalizeCwd('C:/work/alpha'))
  assert.equal(list[0].name, 'alpha')
})

test('recent projects are capped at 12', () => {
  for (let i = 0; i < 20; i++) addRecentProject(`C:/work/p${i}`)
  assert.equal(getRecentProjects().length, 12)
})

// ── Sessions ────────────────────────────────────────────────────────

test('a session in the chat sandbox is always surface=chat, whatever was passed', () => {
  const saved = upsertSession(
    session({ id: 's1', cwd: 'C:/Users/x/grocky/chat-workspace', surface: 'project' })
  )
  assert.equal(saved.surface, 'chat')
})

test('a session with no surface is migrated to project on read', () => {
  upsertSession(session({ id: 's1', cwd: 'C:/work/app' }))
  assert.equal(listSessions()[0].surface, 'project')
})

test('upsert keeps the original createdAt and the previous title', () => {
  upsertSession(session({ id: 's1', createdAt: 100, updatedAt: 100, title: 'First' }))
  const updated = upsertSession(session({ id: 's1', createdAt: 999, updatedAt: 200 }))
  assert.equal(updated.createdAt, 100)
  assert.equal(updated.title, 'First')
})

test('upsert of an existing id keeps the first createdAt and takes the newer title', () => {
  upsertSession(session({ id: 's1', createdAt: 100, updatedAt: 100 }))
  upsertSession(session({ id: 's1', createdAt: 50, updatedAt: 300, title: 'Newer' }))
  const rows = listSessions().filter((s) => s.id === 's1')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].createdAt, 100, 'first-seen createdAt wins on upsert')
  assert.equal(rows[0].title, 'Newer')
})

// Duplicate rows can already exist on disk from older builds; listSessions has
// to collapse them rather than show the session twice.
test('duplicate rows already on disk collapse to the newest, keeping the earliest createdAt', () => {
  fs.mkdirSync(userData, { recursive: true })
  fs.writeFileSync(
    storeFile(),
    JSON.stringify({
      sessions: [
        { id: 's1', cwd: 'C:/work/app', createdAt: 100, updatedAt: 100, title: 'Older' },
        { id: 's1', cwd: 'C:/work/app', createdAt: 50, updatedAt: 300, title: 'Newer' }
      ]
    }),
    'utf8'
  )
  const rows = listSessions().filter((s) => s.id === 's1')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].createdAt, 50, 'earliest createdAt survives the collapse')
  assert.equal(rows[0].title, 'Newer')
})

test('paths differing only by slash direction are the same session', () => {
  upsertSession(session({ id: 's1', cwd: 'C:\\work\\app' }))
  assert.equal(listSessions()[0].cwd, normalizeCwd('C:/work/app'))
})

test('sessions are listed newest-first and capped at 50', () => {
  for (let i = 0; i < 60; i++) {
    upsertSession(session({ id: `s${i}`, updatedAt: i }))
  }
  const list = listSessions()
  assert.equal(list.length, 50)
  assert.ok(list[0].updatedAt > list[1].updatedAt)
})

test('rename trims, caps at 120 chars and ignores a blank title', () => {
  upsertSession(session({ id: 's1', title: 'Original' }))
  assert.equal(renameSession('s1', '  Renamed  ')?.title, 'Renamed')
  assert.equal(renameSession('s1', '   ')?.title, 'Renamed', 'blank must not wipe the title')
  assert.equal(renameSession('s1', 'x'.repeat(200))?.title?.length, 120)
  assert.equal(renameSession('missing', 'X'), null)
})

test('archive round-trips and clears archivedAt on restore', () => {
  upsertSession(session({ id: 's1' }))
  const archived = archiveSession('s1', true)
  assert.equal(archived?.archived, true)
  assert.ok(archived?.archivedAt)
  const restored = archiveSession('s1', false)
  assert.equal(restored?.archived, false)
  assert.equal(restored?.archivedAt, undefined)
})

test('deleting a session also drops its transcript', () => {
  upsertSession(session({ id: 's1' }))
  saveTranscript('s1', [msg({ id: 'm1', role: 'user', text: 'hello' })])
  assert.equal(getTranscript('s1').length, 1)
  deleteSession('s1')
  assert.deepEqual(getTranscript('s1'), [])
  assert.equal(listSessions().find((s) => s.id === 's1'), undefined)
})

// ── Transcripts: FIX-R7 duplication and FIX-R1 redaction corruption ──

test('an echoed user turn is dropped (FIX-R7)', () => {
  const cleaned = dedupeTranscriptMessages([
    msg({ id: 'a', role: 'user', text: 'do the thing' }),
    msg({ id: 'b', role: 'assistant', text: 'ok' }),
    msg({ id: 'c', role: 'user', text: 'do the thing' })
  ])
  assert.equal(cleaned.length, 2)
  assert.deepEqual(cleaned.map((m) => m.role), ['user', 'assistant'])
})

test('a genuine repeat after another user turn is kept', () => {
  const cleaned = dedupeTranscriptMessages([
    msg({ id: 'a', role: 'user', text: 'again' }),
    msg({ id: 'b', role: 'assistant', text: 'ok' }),
    msg({ id: 'c', role: 'user', text: 'something else' }),
    msg({ id: 'd', role: 'user', text: 'again' })
  ])
  assert.equal(cleaned.length, 4)
})

test('two identical user turns back to back are kept (no assistant between)', () => {
  const cleaned = dedupeTranscriptMessages([
    msg({ id: 'a', role: 'user', text: 'ping' }),
    msg({ id: 'b', role: 'user', text: 'ping' })
  ])
  assert.equal(cleaned.length, 2)
})

test('empty user turns are never de-duplicated against each other', () => {
  const cleaned = dedupeTranscriptMessages([
    msg({ id: 'a', role: 'user', text: '' }),
    msg({ id: 'b', role: 'assistant', text: 'ok' }),
    msg({ id: 'c', role: 'user', text: '' })
  ])
  assert.equal(cleaned.length, 3)
})

// FIX-R1: redacting message text corrupted transcripts on reload. Only tool
// payloads may be redacted — the conversation is the user's own local data.
test('message text and thought are persisted verbatim', () => {
  const text = 'my email is user@example.com and the password=hunter2'
  const thought = 'x'.repeat(6000)
  saveTranscript('s1', [msg({ id: 'm1', role: 'assistant', text, thought })])
  const [restored] = getTranscript('s1')
  assert.equal(restored.text, text)
  assert.equal(restored.thought, thought)
})

test('tool payloads ARE redacted on save', () => {
  saveTranscript('s1', [
    msg({
      id: 'm1',
      role: 'assistant',
      text: 'ran a tool',
      toolCalls: [
        {
          toolCallId: 't1',
          title: 'Bash',
          status: 'completed',
          rawInput: { apiKey: 'xai-abcdefgh1234567890' },
          content: 'api_key=SUPERSECRET123'
        }
      ]
    })
  ])
  const raw = fs.readFileSync(storeFile(), 'utf8')
  assert.ok(!raw.includes('SUPERSECRET123'))
  assert.ok(!raw.includes('xai-abcdefgh1234567890'))
})

test('transcripts are capped at the last 200 messages', () => {
  const many = Array.from({ length: 250 }, (_, i) =>
    msg({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', text: `line ${i}` })
  )
  saveTranscript('s1', many)
  const saved = getTranscript('s1')
  assert.equal(saved.length, 200)
  assert.equal(saved[saved.length - 1].text, 'line 249')
})

test('streaming state is not persisted and send status settles to sent', () => {
  saveTranscript('s1', [
    msg({ id: 'm1', role: 'user', text: 'hi', streaming: true, sendStatus: 'sending' })
  ])
  const [restored] = getTranscript('s1')
  assert.equal(restored.streaming, false)
  assert.equal(restored.sendStatus, 'sent')
})

test('a failed send is preserved as failed', () => {
  saveTranscript('s1', [msg({ id: 'm1', role: 'user', text: 'hi', sendStatus: 'failed' })])
  assert.equal(getTranscript('s1')[0].sendStatus, 'failed')
})

test('saving a transcript updates the session activity counters', () => {
  upsertSession(session({ id: 's1' }))
  saveTranscript('s1', [
    msg({ id: 'm1', role: 'user', text: 'a' }),
    msg({ id: 'm2', role: 'assistant', text: 'b' }),
    msg({ id: 'm3', role: 'user', text: 'c' })
  ])
  const row = listSessions().find((s) => s.id === 's1')
  assert.equal(row?.messageCount, 3)
  assert.equal(row?.userTurns, 2)
})

test('a store that already holds duplicated turns heals itself on read', () => {
  fs.mkdirSync(userData, { recursive: true })
  fs.writeFileSync(
    storeFile(),
    JSON.stringify({
      transcripts: {
        s1: [
          { id: 'a', role: 'user', text: 'dup', createdAt: 1 },
          { id: 'b', role: 'assistant', text: 'ok', createdAt: 2 },
          { id: 'c', role: 'user', text: 'dup', createdAt: 3 }
        ]
      }
    }),
    'utf8'
  )
  assert.equal(getTranscript('s1').length, 2)
  // Healed in place, not just filtered on the way out.
  assert.equal(JSON.parse(fs.readFileSync(storeFile(), 'utf8')).transcripts.s1.length, 2)
})

// ── Permission audit ────────────────────────────────────────────────

test('audit entries are redacted and capped at 200', () => {
  appendPermissionAudit({
    id: 'a1',
    at: 1,
    sessionId: 's1',
    cwd: 'C:/work/app',
    toolCallId: 't1',
    title: 'Read api_key=SUPERSECRET123',
    decision: 'allow-once',
    rawInputPreview: 'token: xai-abcdefgh1234567890'
  })
  const [entry] = getPermissionAudit()
  assert.ok(!entry.title.includes('SUPERSECRET123'))
  assert.ok(!(entry.rawInputPreview || '').includes('xai-abcdefgh1234567890'))

  for (let i = 0; i < 250; i++) {
    appendPermissionAudit({
      id: `x${i}`,
      at: i,
      sessionId: 's1',
      cwd: 'C:/work/app',
      toolCallId: 't',
      title: 'Read',
      decision: 'allow-once'
    })
  }
  assert.equal(getPermissionAudit().length, 200)
})

test('the newest audit entry is first', () => {
  appendPermissionAudit({
    id: 'old', at: 1, sessionId: 's', cwd: 'C:/w', toolCallId: 't', title: 'A', decision: 'allow-once'
  })
  appendPermissionAudit({
    id: 'new', at: 2, sessionId: 's', cwd: 'C:/w', toolCallId: 't', title: 'B', decision: 'reject-once'
  })
  assert.equal(getPermissionAudit()[0].id, 'new')
})
