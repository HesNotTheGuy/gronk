import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CHAT_RULES,
  CHAT_SYSTEM_PROMPT,
  buildAgentArgs,
  type BuildAgentArgsOptions
} from '../electron/main/agent-args'
import type { PermissionMode } from '../shared/types'

const ALL_MODES: PermissionMode[] = [
  'default',
  'acceptEdits',
  'auto',
  'dontAsk',
  'bypassPermissions',
  'plan'
]

function build(options: BuildAgentArgsOptions = {}) {
  return buildAgentArgs(options)
}

/** Value that follows `flag` in argv, or undefined when the flag is absent. */
function valueAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i === -1 ? undefined : args[i + 1]
}

// ── The mode flag is never omitted (HIGH severity regression) ───────

// A build that dropped `--permission-mode` for 'default' shipped: with no flag the
// CLI reads ~/.grok/config.toml `permission_mode` (commonly "auto") and auto-approves
// every tool while Grocky's UI still shows the gated Default mode.
test('the default mode is still passed explicitly, never left to the CLI config file', () => {
  const { args } = build({ permissionMode: 'default' })
  assert.equal(valueAfter(args, '--permission-mode'), 'default')
})

test('an absent or empty mode still emits --permission-mode default', () => {
  assert.equal(valueAfter(build().args, '--permission-mode'), 'default')
  assert.equal(
    valueAfter(build({ permissionMode: '' as unknown as PermissionMode }).args, '--permission-mode'),
    'default'
  )
})

test('every permission mode round-trips into argv', () => {
  for (const mode of ALL_MODES) {
    const { args, permissionMode } = build({ permissionMode: mode, alwaysApproveAck: true })
    assert.equal(permissionMode, mode, `${mode} must survive derivation`)
    assert.equal(valueAfter(args, '--permission-mode'), mode)
    assert.equal(args.filter((a) => a === '--permission-mode').length, 1)
  }
})

// ── Flag ordering (grok rejects globals after the subcommand) ───────

test('global flags come before `agent`, -m and --always-approve after it, stdio last', () => {
  const { args } = build({
    permissionMode: 'bypassPermissions',
    alwaysApprove: true,
    alwaysApproveAck: true,
    model: 'grok-4-fast',
    surface: 'chat'
  })
  assert.deepEqual(args, [
    '--permission-mode',
    'bypassPermissions',
    '--system-prompt-override',
    CHAT_SYSTEM_PROMPT,
    '--rules',
    CHAT_RULES,
    'agent',
    '-m',
    'grok-4-fast',
    '--always-approve',
    'stdio'
  ])
})

test('ordering holds for the plain project boot too', () => {
  const { args } = build({ permissionMode: 'acceptEdits', model: 'grok-4' })
  assert.deepEqual(args, ['--permission-mode', 'acceptEdits', 'agent', '-m', 'grok-4', 'stdio'])
})

test('the subcommand and stdio are always present exactly once, in that order', () => {
  for (const mode of ALL_MODES) {
    for (const surface of ['chat', 'project'] as const) {
      const { args } = build({ permissionMode: mode, alwaysApproveAck: true, surface })
      assert.equal(args.filter((a) => a === 'agent').length, 1)
      assert.equal(args[args.length - 1], 'stdio')
      assert.ok(args.indexOf('agent') < args.length - 1)
    }
  }
})

// ── YOLO requires a persisted acknowledgement ───────────────────────

test('alwaysApprove is refused when no acknowledgement exists', () => {
  const result = build({ alwaysApprove: true })
  assert.equal(result.alwaysApprove, false)
  assert.equal(result.permissionMode, 'default')
  assert.ok(!result.args.includes('--always-approve'))
})

test('bypassPermissions without an ack downgrades to default and stays gated', () => {
  const result = build({ permissionMode: 'bypassPermissions' })
  assert.equal(result.permissionMode, 'default')
  assert.equal(valueAfter(result.args, '--permission-mode'), 'default')
  assert.ok(!result.args.includes('--always-approve'))
})

test('alwaysApprove with an ack forces bypassPermissions and emits --always-approve', () => {
  const result = build({ permissionMode: 'default', alwaysApprove: true, alwaysApproveAck: true })
  assert.equal(result.alwaysApprove, true)
  assert.equal(result.permissionMode, 'bypassPermissions')
  assert.equal(valueAfter(result.args, '--permission-mode'), 'bypassPermissions')
  assert.equal(result.args.filter((a) => a === '--always-approve').length, 1)
})

test('an acknowledged bypassPermissions mode also emits --always-approve on its own', () => {
  const result = build({ permissionMode: 'bypassPermissions', alwaysApproveAck: true })
  assert.equal(result.alwaysApprove, false, 'the YOLO toggle itself stays off')
  assert.ok(result.args.includes('--always-approve'))
})

test('an ack alone never enables anything', () => {
  const result = build({ alwaysApproveAck: true })
  assert.equal(result.alwaysApprove, false)
  assert.equal(result.permissionMode, 'default')
  assert.ok(!result.args.includes('--always-approve'))
})

test('--always-approve appears only for a bypassPermissions boot', () => {
  for (const mode of ALL_MODES) {
    const { args } = build({ permissionMode: mode, alwaysApproveAck: true })
    assert.equal(
      args.includes('--always-approve'),
      mode === 'bypassPermissions',
      `mode ${mode} must not auto-approve`
    )
  }
})

// ── Surfaces ────────────────────────────────────────────────────────

test('the chat surface injects the conversational persona and rules', () => {
  const { args, surface } = build({ surface: 'chat' })
  assert.equal(surface, 'chat')
  assert.equal(valueAfter(args, '--system-prompt-override'), CHAT_SYSTEM_PROMPT)
  assert.equal(valueAfter(args, '--rules'), CHAT_RULES)
  assert.ok(args.indexOf('--rules') < args.indexOf('agent'), 'both are global flags')
})

test('the project surface injects neither prompt override nor rules', () => {
  const { args, surface } = build({ surface: 'project' })
  assert.equal(surface, 'project')
  assert.ok(!args.includes('--system-prompt-override'))
  assert.ok(!args.includes('--rules'))
})

test('an absent or unknown surface falls back to project', () => {
  const unknownSurface = 'preview' as unknown as 'chat'
  assert.equal(build().surface, 'project')
  assert.equal(build({ surface: unknownSurface }).surface, 'project')
  assert.ok(!build({ surface: unknownSurface }).args.includes('--rules'))
})

// ── Model ───────────────────────────────────────────────────────────

test('no model means no -m flag, leaving the choice to the CLI', () => {
  assert.ok(!build().args.includes('-m'))
  assert.ok(!build({ model: '' }).args.includes('-m'))
  assert.ok(!build({ model: undefined }).args.includes('-m'))
})

test('a model is passed after the agent subcommand', () => {
  const { args } = build({ model: 'grok-code-fast-1' })
  assert.equal(valueAfter(args, '-m'), 'grok-code-fast-1')
  assert.ok(args.indexOf('-m') > args.indexOf('agent'))
})

// ── argv hygiene ────────────────────────────────────────────────────

test('no argv element is ever undefined, empty or multi-line', () => {
  for (const mode of [...ALL_MODES, undefined]) {
    for (const surface of ['chat', 'project', undefined] as const) {
      for (const model of ['grok-4', undefined]) {
        for (const alwaysApprove of [true, false]) {
          for (const alwaysApproveAck of [true, false]) {
            const { args } = build({
              permissionMode: mode,
              surface,
              model,
              alwaysApprove,
              alwaysApproveAck
            })
            for (const [i, a] of args.entries()) {
              assert.equal(typeof a, 'string', `args[${i}] must be a string`)
              assert.notEqual(a, '', `args[${i}] must not be empty`)
              assert.ok(!/[\r\n]/.test(a), `args[${i}] must not contain a newline`)
            }
          }
        }
      }
    }
  }
})

test('every flag in the argv is followed by a value, not another flag or the end', () => {
  const { args } = build({
    permissionMode: 'plan',
    model: 'grok-4',
    surface: 'chat',
    alwaysApproveAck: true
  })
  for (const flag of ['--permission-mode', '--system-prompt-override', '--rules', '-m']) {
    const value = valueAfter(args, flag)
    assert.ok(value, `${flag} must have a value`)
    assert.ok(!value.startsWith('-'), `${flag} value must not look like a flag`)
  }
})
