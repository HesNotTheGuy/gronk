import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  getTranscript,
  listSessions,
  repairStoreOnStartup,
  saveTranscript,
  upsertSession
} from '../electron/main/store'
import { __freshUserData } from './stubs/electron'
import type { ChatMessage, SessionInfo } from '../shared/types'

/**
 * One conversation per file, so saving a turn costs that conversation.
 *
 * Transcripts used to be a map inside the store, so a save serialised and wrote
 * every conversation the user had. Measured on a 7.5 MB store: stringify 16.3 ms,
 * write and fsync 15.6 ms, per turn, growing with the total rather than with what
 * changed. After: 11.2 ms at 6.7 MB and flat — 9.9 ms at 0.1 MB, so it no longer
 * tracks the total at all.
 *
 * Timing is not asserted here, because a test that fails on a busy machine
 * teaches people to re-run it. What is asserted is the property the timing came
 * from: a save touches the conversation that changed and nothing else.
 */

let userData: string

beforeEach(() => {
  userData = __freshUserData()
})

const dir = () => path.join(userData, 'transcripts')
const files = () => (fs.existsSync(dir()) ? fs.readdirSync(dir()).sort() : [])

const session = (id: string): SessionInfo =>
  ({ id, cwd: '/work/alpha', title: id, createdAt: 1, updatedAt: 1, surface: 'project' }) as SessionInfo

const msg = (id: string): ChatMessage =>
  ({ id, role: 'user', text: `text of ${id}`, createdAt: 1 }) as ChatMessage

test('A SAVE TOUCHES ONLY THE CONVERSATION THAT CHANGED', () => {
  upsertSession(session('a'))
  upsertSession(session('b'))
  saveTranscript('a', [msg('a1')])
  saveTranscript('b', [msg('b1')])
  assert.equal(files().length, 2, 'one file per conversation')

  const before = files().map((n) => fs.statSync(path.join(dir(), n)).mtimeMs)
  saveTranscript('a', [msg('a1'), msg('a2')])
  const after = files().map((n) => fs.statSync(path.join(dir(), n)).mtimeMs)

  const changed = before.filter((m, i) => m !== after[i]).length
  assert.equal(changed, 1, 'saving one conversation rewrote another')
})

test('the store file no longer carries conversations', () => {
  upsertSession(session('a'))
  saveTranscript('a', [msg('a1')])
  const store = JSON.parse(fs.readFileSync(path.join(userData, 'gronk-store.json'), 'utf8'))
  assert.equal(store.transcripts, undefined, 'transcripts are still inside the store')
  assert.ok(store.sessions.length === 1, 'but the session record is')
})

test('a conversation survives a round trip through its own file', () => {
  upsertSession(session('a'))
  const messages = [msg('a1'), msg('a2'), msg('a3')]
  saveTranscript('a', messages)
  assert.deepEqual(
    getTranscript('a').map((m) => m.id),
    ['a1', 'a2', 'a3']
  )
})

test('A STORE WRITTEN BEFORE THE SPLIT IS MIGRATED, LOSING NOTHING', () => {
  fs.mkdirSync(userData, { recursive: true })
  fs.writeFileSync(
    path.join(userData, 'gronk-store.json'),
    JSON.stringify({
      version: 2,
      sessions: [session('a'), session('b')],
      transcripts: {
        a: [msg('a1'), msg('a2')],
        b: [msg('b1')]
      },
      settings: {}
    })
  )

  repairStoreOnStartup()

  assert.deepEqual(files().length, 2, 'each conversation should have become a file')
  assert.deepEqual(getTranscript('a').map((m) => m.id), ['a1', 'a2'])
  assert.deepEqual(getTranscript('b').map((m) => m.id), ['b1'])
  const store = JSON.parse(fs.readFileSync(path.join(userData, 'gronk-store.json'), 'utf8'))
  assert.equal(store.transcripts, undefined, 'and the store should no longer carry them')
  assert.equal(listSessions().length, 2, 'without losing a session on the way')
})

test('migrating twice is not a second migration', () => {
  fs.mkdirSync(userData, { recursive: true })
  fs.writeFileSync(
    path.join(userData, 'gronk-store.json'),
    JSON.stringify({ version: 2, sessions: [session('a')], transcripts: { a: [msg('a1')] }, settings: {} })
  )
  repairStoreOnStartup()
  const first = fs.statSync(path.join(userData, 'gronk-store.json')).mtimeMs
  repairStoreOnStartup()
  assert.equal(
    fs.statSync(path.join(userData, 'gronk-store.json')).mtimeMs,
    first,
    'a second startup rewrote a store that was already split'
  )
})
