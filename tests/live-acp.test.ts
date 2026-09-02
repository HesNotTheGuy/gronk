/**
 * Live ACP contract test — OPT-IN, and it spends nothing.
 *
 * `live-cli.test.ts` next door checks the shapes the CLI prints on stdout. This checks
 * the shapes it speaks over `grok agent stdio`, which is where every assumption added
 * for grok 4.6 lives: the model list, the reasoning-effort levels, the id field
 * `session/set_model` demands, and the placement of `--reasoning-effort` on argv.
 *
 * Why this file can exist at all: **a protocol call is not a prompt.** initialize,
 * session/new and session/set_model make no model request and cost no usage. That is not
 * a guess — every one of these was first run against an account already over its limit
 * and being refused on session/prompt. It is what makes this runnable when the app
 * itself cannot be.
 *
 * How to run:
 *   npm test                    → SKIPPED
 *   GRONK_LIVE_CLI=1 npm test   → spawns the real CLI
 *   (PowerShell: $env:GRONK_LIVE_CLI = '1'; npm test)
 *
 * Rules this file must keep:
 * 1. NEVER send `session/prompt`. It is the only call here that would spend usage, and
 *    it is refused by construction in `rpc()` rather than by discipline. Do not add an
 *    exception "just to check the reply" — that is the whole reason this is free.
 * 2. Skipped, never failed, when no binary resolves or the agent will not start. A
 *    machine with no CLI is not a regression.
 * 3. Assertions target the assumption Gronk makes, not a snapshot of today's payload.
 *    A new model or an extra level is a PASS; a renamed or vanished field is a FAIL.
 * 4. Every spawn is argv with a timeout, and the child is killed in a finally.
 * 5. Nothing from the agent reaches an assertion message unredacted.
 *
 * This is also the upgrade canary. The CLI is on a 1.x line now and everything Gronk
 * assumes was verified against 0.2.112 — run this first after any CLI update.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseAvailableCommands,
  parseModelState,
  parseSetModelResult,
  resolveGrokBinary
} from '../electron/main/acp/client'
import { buildAgentArgs } from '../electron/main/agent-args'
import { redactSecrets } from '../electron/main/redact'
import type { ReasoningEffort } from '../shared/types'

const OPTED_IN = /^(1|true|yes|on)$/i.test((process.env.GRONK_LIVE_CLI ?? '').trim())
const BINARY = OPTED_IN ? resolveGrokBinary(process.env.GRONK_GROK_BINARY) : null
const REASON = !OPTED_IN ? 'set GRONK_LIVE_CLI=1 to run' : !BINARY ? 'no grok binary resolved' : ''

/** The one call that would cost money. Refused here so it cannot be added by accident. */
const FORBIDDEN = 'session/prompt'

interface Agent {
  rpc: (method: string, params: unknown) => Promise<{ result?: any; error?: any }>
  stop: () => void
}

/** Boot `grok agent stdio` with the argv Gronk itself would build. */
async function startAgent(
  extra: { reasoningEffort?: ReasoningEffort } = {}
): Promise<{ agent: Agent; cwd: string }> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gronk-live-acp-'))
  // Through buildAgentArgs on purpose: this is about whether OUR argv works, so
  // hand-writing it here would prove something about a string nobody ships.
  const { args } = buildAgentArgs({ permissionMode: 'default', ...extra })
  const proc: ChildProcessWithoutNullStreams = spawn(BINARY as string, args, {
    cwd,
    windowsHide: true,
    env: { ...process.env, GROK_DISABLE_AUTOUPDATER: '1' }
  })

  let nextId = 1
  const pending = new Map<number, (msg: any) => void>()
  createInterface({ input: proc.stdout }).on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    let msg: any
    try {
      msg = JSON.parse(trimmed)
    } catch {
      return
    }
    if (msg.id !== undefined && !msg.method) {
      const settle = pending.get(msg.id)
      if (settle) {
        pending.delete(msg.id)
        settle(msg)
      }
      return
    }
    // The agent asks us things too; refuse rather than leave it waiting on a client
    // that implements nothing.
    if (msg.method && msg.id !== undefined) {
      const refusal = { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not implemented' } }
      proc.stdin.write(JSON.stringify(refusal) + '\n')
    }
  })

  const rpc = (method: string, params: unknown) => {
    assert.notEqual(method, FORBIDDEN, 'this file must never spend usage')
    const id = nextId++
    return new Promise<{ result?: any; error?: any }>((resolve) => {
      pending.set(id, resolve)
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      setTimeout(() => {
        if (pending.delete(id)) resolve({ error: { message: `TIMEOUT on ${method}` } })
      }, 30_000)
    })
  }

  return { agent: { rpc, stop: () => proc.kill() }, cwd }
}

const INIT_PARAMS = {
  protocolVersion: 1,
  clientInfo: { name: 'Gronk', version: '0.1.0' },
  clientCapabilities: {}
}

const live = (name: string, fn: (t: any) => Promise<void>) =>
  test(name, async (t: any) => {
    if (REASON) return t.skip(REASON)
    await fn(t)
  })

live('THE AGENT STILL DESCRIBES ITS MODELS THE WAY THE APP READS THEM', async (t) => {
  const { agent } = await startAgent()
  try {
    const init = await agent.rpc('initialize', INIT_PARAMS)
    if (init.error) {
      return t.skip(`agent would not initialize: ${redactSecrets(String(init.error.message ?? ''))}`)
    }

    // Parsed by the SAME function the app uses, so a rename fails here rather than
    // silently producing an empty picker in the running app.
    const { models, current } = parseModelState(init.result?._meta)
    assert.ok(models.length > 0, 'the agent reported no models at all')
    assert.ok(current, 'no current model reported')
    assert.ok(
      models.some((m) => m.id === current),
      'the model named as current is not in the list'
    )

    // Effort is what 4.6 added. If no model reports levels any more, the Settings
    // control silently disappears — that must fail loudly, not vanish quietly.
    const withEffort = models.filter((m) => m.reasoningEfforts?.length)
    assert.ok(
      withEffort.length > 0,
      `no model reported reasoning levels; ids seen: ${models.map((m) => m.id).join(', ')}`
    )
    for (const m of withEffort) {
      assert.ok(m.contextTokens && m.contextTokens > 0, `${m.id} reported no context window`)
    }
  } finally {
    agent.stop()
  }
})

live('SWITCHING MODEL STILL ANSWERS THE WAY THE APP READS IT', async (t) => {
  const { agent, cwd } = await startAgent()
  try {
    const init = await agent.rpc('initialize', INIT_PARAMS)
    if (init.error) return t.skip('agent would not initialize')
    const { models, current } = parseModelState(init.result?._meta)

    const created = await agent.rpc('session/new', { cwd, mcpServers: [] })
    if (created.error) {
      return t.skip(`session/new refused: ${redactSecrets(String(created.error.data ?? ''))}`)
    }
    const sessionId = created.result?.sessionId
    assert.ok(sessionId, 'session/new returned no sessionId')

    const target = models.find((m) => m.id !== current)?.id ?? (current as string)
    const reply = await agent.rpc('session/set_model', { sessionId, modelId: target })
    assert.ok(!reply.error, `set_model failed: ${redactSecrets(JSON.stringify(reply.error ?? {}))}`)

    // Read with the app's own parser: the reply is a serde Result under _meta.model, and
    // if that moves, the app reports a switch that did not happen.
    const parsed = parseSetModelResult(reply.result)
    assert.equal(parsed.ok, true, parsed.ok === false ? parsed.message : '')
    assert.equal(parsed.ok === true ? parsed.modelId : '', target)

    // The field name is load-bearing and has no forgiving alias today. If one ever
    // appears, the strictness this relies on is gone and the app should know.
    const wrong = await agent.rpc('session/set_model', { sessionId, model: target })
    assert.ok(wrong.error, 'the agent accepted a set_model request with no `modelId`')
  } finally {
    agent.stop()
  }
})

live('INITIALIZE STILL ADVERTISES WORKFLOW SLASH COMMANDS', async (t) => {
  const { agent } = await startAgent()
  try {
    const init = await agent.rpc('initialize', INIT_PARAMS)
    if (init.error) {
      return t.skip(`agent would not initialize: ${redactSecrets(String(init.error.message ?? ''))}`)
    }
    const commands = parseAvailableCommands(init.result?._meta)
    const names = commands.map((c) => c.name)
    assert.ok(names.includes('workflow'), `workflow missing; saw ${names.join(', ') || '(none)'}`)
    assert.ok(
      names.includes('deep-research'),
      `deep-research missing; saw ${names.join(', ') || '(none)'}`
    )
  } finally {
    agent.stop()
  }
})

live('THE REASONING-EFFORT FLAG IS STILL IN A PLACE THAT WORKS', async (t) => {
  // The trap this exists for: the flag is documented under both `grok --help` and
  // `grok agent --help`, and placing it before `agent` is accepted, exits 0, and is
  // silently ignored. Nothing inside the app can tell those apart — only the session
  // config can, so this boots with the flag and reads the level back.
  const { agent, cwd } = await startAgent({ reasoningEffort: 'low' })
  try {
    const init = await agent.rpc('initialize', INIT_PARAMS)
    if (init.error) return t.skip('agent would not initialize')

    const created = await agent.rpc('session/new', { cwd, mcpServers: [] })
    if (created.error) return t.skip('session/new refused')

    const config = created.result?._meta?.['x.ai/sessionConfig']
    if (!config) return t.skip('this agent reports no session config to read the level back from')

    const selected = (config.options ?? [])
      .filter((o: any) => o?.selected)
      .map((o: any) => String(o?.id))
    assert.ok(
      selected.includes('low'),
      `booted with --reasoning-effort low, session reports: ${selected.join(', ') || '(nothing selected)'}`
    )
  } finally {
    agent.stop()
  }
})
