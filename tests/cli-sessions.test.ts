import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  excludeKnownTerminalSessions,
  parseSessionList,
  terminalResumeParams
} from '../electron/main/cli-sessions'
import { TERMINAL_SESSION_GROUP, TERMINAL_SESSION_NOTE } from '../shared/types'

test('session/list id + folder + last-updated becomes a TerminalSession', () => {
  const rows = parseSessionList({
    sessions: [
      {
        id: 'cli-1',
        folder: '/work/app',
        'last-updated': '2026-08-21T06:52:43.000Z'
      }
    ]
  })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, 'cli-1')
  assert.equal(rows[0].folder, '/work/app')
  assert.equal(rows[0].updatedAt, Date.parse('2026-08-21T06:52:43.000Z'))
})

test('the ACP sessionId + cwd aliases parse the same way', () => {
  const rows = parseSessionList({
    sessions: [{ sessionId: 'acp-9', cwd: '/tmp/proj', updatedAt: 1_700_000_000_000 }]
  })
  assert.deepEqual(rows, [
    { id: 'acp-9', folder: '/tmp/proj', updatedAt: 1_700_000_000_000, title: undefined }
  ])
})

test('a top-level array is accepted', () => {
  const rows = parseSessionList([{ id: 'a', folder: '/a' }])
  assert.equal(rows[0].id, 'a')
  assert.equal(rows[0].folder, '/a')
})

test('a row without id or folder is dropped, not repaired', () => {
  const rows = parseSessionList({
    sessions: [
      { folder: '/work/app' },
      { id: 'only-id' },
      { id: 'ok', folder: '/work/ok' },
      null,
      'nope'
    ]
  })
  assert.deepEqual(
    rows.map((r) => r.id),
    ['ok']
  )
})

test('duplicate ids keep the first row', () => {
  const rows = parseSessionList({
    sessions: [
      { id: 'same', folder: '/first' },
      { id: 'same', folder: '/second' }
    ]
  })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].folder, '/first')
})

test('garbage payloads become an empty list, not a throw', () => {
  assert.deepEqual(parseSessionList(null), [])
  assert.deepEqual(parseSessionList(undefined), [])
  assert.deepEqual(parseSessionList('sessions'), [])
  assert.deepEqual(parseSessionList({ sessions: {} }), [])
})

test('Gronk-owned ids stay out of the terminal group', () => {
  const listed = parseSessionList({
    sessions: [
      { id: 'gronk-1', folder: '/work/app' },
      { id: 'cli-2', folder: '/tmp/tui' }
    ]
  })
  const shown = excludeKnownTerminalSessions(listed, ['gronk-1'])
  assert.deepEqual(
    shown.map((s) => s.id),
    ['cli-2']
  )
})

test('an empty known set leaves the listed rows intact', () => {
  const listed = [{ id: 'cli-2', folder: '/tmp/tui', updatedAt: 0 }]
  assert.deepEqual(excludeKnownTerminalSessions(listed, []), listed)
})

test('resume sends the session id plus its folder as cwd', () => {
  assert.deepEqual(terminalResumeParams('cli-2', '/tmp/tui'), {
    sessionId: 'cli-2',
    cwd: '/tmp/tui',
    mcpServers: []
  })
})

test('the labeled group and the honest copy are the shipped strings', () => {
  assert.equal(TERMINAL_SESSION_GROUP, 'From terminal')
  assert.match(TERMINAL_SESSION_NOTE, /no local transcript/i)
  assert.match(TERMINAL_SESSION_NOTE, /agent/i)
})

test('a failed terminal resume does not start a new Gronk session', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../electron/main/agent-manager.ts', import.meta.url)),
    'utf8'
  )
  const start = src.indexOf('async resumeTerminalSession(')
  assert.notEqual(start, -1, 'resumeTerminalSession is missing')
  const end = src.indexOf('private static readonly CANCEL_GRACE_MS', start)
  const body = src.slice(start, end)
  assert.match(body, /sessionResume/)
  assert.match(body, /terminalResumeParams/)
  assert.equal(body.includes('this.start('), false)
  assert.equal(body.includes('sessionLoad'), false)
  assert.equal(body.includes('getTranscript'), false)
})
