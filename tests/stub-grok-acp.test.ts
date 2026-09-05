/**
 * Prove session/list display data and session/resume(id, folder) against a
 * fixture grok. This machine has no real TUI sessions and must not ask for
 * login. The stub speaks ACP and records every request.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GrokAcpClient } from '../electron/main/acp/client'
import {
  excludeKnownTerminalSessions,
  fetchTerminalSessionList,
  parseSessionList,
  terminalResumeParams
} from '../electron/main/cli-sessions'

const STUB = fileURLToPath(new URL('./helpers/stub-grok.mjs', import.meta.url))

function startStub(logFile: string, sessions?: unknown) {
  const env = {
    ...process.env,
    GRONK_STUB_LOG: logFile,
    ...(sessions !== undefined ? { GRONK_STUB_SESSIONS: JSON.stringify(sessions) } : {})
  }
  const client = new GrokAcpClient(process.execPath, [STUB])
  client.start(env)
  return client
}

function loggedCalls(logFile: string): Array<{ method?: string; params?: Record<string, unknown> }> {
  if (!fs.existsSync(logFile)) return []
  return fs
    .readFileSync(logFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

test('the stub grok lists canned terminal sessions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gronk-stub-list-'))
  const logFile = path.join(dir, 'calls.jsonl')
  const client = startStub(logFile, [
    { id: 'cli-alpha', folder: '/tmp/tui-alpha', title: 'fix the parser', updatedAt: 9 },
    { id: 'already-ours', folder: '/work/app', updatedAt: 8 }
  ])
  try {
    await client.initialize()
    const raw = await client.sessionList()
    const listed = parseSessionList(raw)
    assert.deepEqual(
      listed.map((s) => s.id),
      ['cli-alpha', 'already-ours']
    )
    const shown = excludeKnownTerminalSessions(listed, ['already-ours'])
    assert.deepEqual(
      shown.map((s) => ({ id: s.id, folder: s.folder, title: s.title })),
      [{ id: 'cli-alpha', folder: '/tmp/tui-alpha', title: 'fix the parser' }]
    )
    const methods = loggedCalls(logFile).map((c) => c.method)
    assert.ok(methods.includes('session/list'), 'session/list was never sent')
  } finally {
    await client.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('session/resume sends the listed id plus its folder', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gronk-stub-resume-'))
  const logFile = path.join(dir, 'calls.jsonl')
  const client = startStub(logFile)
  try {
    await client.initialize()
    const listed = parseSessionList(await client.sessionList())
    assert.equal(listed[0].id, 'cli-alpha')
    assert.equal(listed[0].folder, '/tmp/tui-alpha')
    const params = terminalResumeParams(listed[0].id, listed[0].folder)
    const result = await client.sessionResume(params.sessionId, params.cwd, params.mcpServers)
    assert.equal(result.sessionId, 'cli-alpha')
    const resume = loggedCalls(logFile).find((c) => c.method === 'session/resume')
    assert.ok(resume, 'session/resume was never sent')
    assert.equal(resume.params?.sessionId, 'cli-alpha')
    assert.equal(resume.params?.cwd, '/tmp/tui-alpha')
  } finally {
    await client.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('fetchTerminalSessionList hides Gronk-owned ids and returns the rest', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gronk-stub-fetch-'))
  const logFile = path.join(dir, 'calls.jsonl')
  const shown = await fetchTerminalSessionList({
    binary: process.execPath,
    args: [STUB],
    env: {
      ...process.env,
      GRONK_STUB_LOG: logFile,
      GRONK_STUB_SESSIONS: JSON.stringify([
        { id: 'gronk-1', folder: '/work/app' },
        { id: 'cli-alpha', folder: '/tmp/tui-alpha', title: 'from the TUI' }
      ])
    },
    knownIds: ['gronk-1']
  })
  try {
    assert.deepEqual(
      shown.map((s) => ({ id: s.id, folder: s.folder })),
      [{ id: 'cli-alpha', folder: '/tmp/tui-alpha' }]
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('an empty canned list stays empty after the known-id filter', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gronk-stub-empty-'))
  const logFile = path.join(dir, 'calls.jsonl')
  const client = startStub(logFile, [])
  try {
    await client.initialize()
    const shown = excludeKnownTerminalSessions(parseSessionList(await client.sessionList()), [
      'anything'
    ])
    assert.deepEqual(shown, [])
  } finally {
    await client.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
