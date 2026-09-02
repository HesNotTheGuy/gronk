#!/usr/bin/env node
/**
 * Fixture grok for session/list + session/resume. Not the shipping CLI.
 *
 * Speaks JSON-RPC on stdio. Canned list from GRONK_STUB_SESSIONS (JSON array
 * or { sessions: [...] }). Every request is appended to GRONK_STUB_LOG when
 * that path is set, so a test can assert resume sent id + folder.
 */
import fs from 'node:fs'
import readline from 'node:readline'

const logPath = (process.env.GRONK_STUB_LOG || '').trim()

function cannedSessions() {
  const raw = (process.env.GRONK_STUB_SESSIONS || '').trim()
  if (!raw) {
    return [
      {
        id: 'cli-alpha',
        folder: '/tmp/tui-alpha',
        title: 'fix the parser',
        updatedAt: 1_700_000_000_000
      }
    ]
  }
  const parsed = JSON.parse(raw)
  return Array.isArray(parsed) ? parsed : parsed
}

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}

function fail(id, message) {
  process.stdout.write(
    JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message } }) + '\n'
  )
}

function record(msg) {
  if (!logPath) return
  fs.appendFileSync(logPath, JSON.stringify(msg) + '\n')
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let msg
  try {
    msg = JSON.parse(trimmed)
  } catch {
    return
  }
  record(msg)
  if (msg.method && msg.id !== undefined) {
    if (msg.method === 'initialize') {
      reply(msg.id, { protocolVersion: 1, _meta: {} })
      return
    }
    if (msg.method === 'session/list') {
      reply(msg.id, { sessions: cannedSessions() })
      return
    }
    if (msg.method === 'session/resume') {
      const sessionId = msg.params?.sessionId
      const cwd = msg.params?.cwd ?? msg.params?.folder
      if (!sessionId || !cwd) {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32602, message: 'session/resume needs sessionId and cwd' }
          }) + '\n'
        )
        return
      }
      reply(msg.id, { sessionId })
      return
    }
    if (
      msg.method === 'session/new' ||
      msg.method === 'session/load' ||
      msg.method === 'session/close' ||
      msg.method === 'session/cancel'
    ) {
      reply(msg.id, { sessionId: msg.params?.sessionId || 'stub-session' })
      return
    }
    fail(msg.id, `not implemented: ${msg.method}`)
  }
})
