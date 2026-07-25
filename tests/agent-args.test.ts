import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CHAT_RULES,
  CHAT_SYSTEM_PROMPT,
  buildAgentArgs,
  isAutoApproveActive,
  normalizePermissionMode,
  type BuildAgentArgsOptions
} from '../electron/main/agent-args'
import { PERMISSION_MODE_OPTIONS, type PermissionMode } from '../shared/types'

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

// ── Only a mode grok knows may reach argv ───────────────────────────

// permissionMode is read from a user-writable JSON file and becomes the value of
// --permission-mode. A mode grok does not recognise makes it fall back to
// ~/.grok/config.toml (commonly permission_mode = "auto"), silently auto-approving
// every tool while the UI shows something gated.

test('the mode list used here is the authoritative one from shared/types', () => {
  assert.deepEqual([...ALL_MODES].sort(), PERMISSION_MODE_OPTIONS.map((o) => o.id).sort())
})

test('every authoritative mode is accepted unchanged', () => {
  for (const mode of ALL_MODES) {
    assert.equal(normalizePermissionMode(mode), mode)
  }
})

test('anything not on the list fails safe to the gated default mode', () => {
  const bogus: unknown[] = [
    'auto-approve',
    'yolo',
    'AUTO',
    'bypasspermissions',
    ' default',
    'default ',
    '',
    undefined,
    null,
    42,
    true,
    {},
    ['auto']
  ]
  for (const value of bogus) {
    assert.equal(normalizePermissionMode(value), 'default', `${JSON.stringify(value)}`)
  }
})

test('a corrupted stored mode never reaches argv, ack or no ack', () => {
  for (const alwaysApproveAck of [true, false]) {
    const result = build({
      permissionMode: 'auto-approve' as unknown as PermissionMode,
      alwaysApproveAck
    })
    assert.equal(result.permissionMode, 'default')
    assert.equal(valueAfter(result.args, '--permission-mode'), 'default')
    assert.ok(!result.args.includes('auto-approve'), 'the bogus value must not appear in argv')
    assert.ok(!result.args.includes('--always-approve'))
    assert.equal(result.alwaysApprove, false)
  }
})

test('argv only ever carries a mode grok knows', () => {
  const inputs: unknown[] = [...ALL_MODES, undefined, '', 'auto-approve', null, 7]
  for (const input of inputs) {
    const { args } = build({
      permissionMode: input as PermissionMode,
      alwaysApproveAck: true
    })
    const emitted = valueAfter(args, '--permission-mode')
    assert.ok(
      ALL_MODES.includes(emitted as PermissionMode),
      `emitted ${String(emitted)} for input ${JSON.stringify(input)}`
    )
  }
})

// ── The runtime gate follows the posture the child booted with ──────

// Boot posture and the mid-session gate used to be derived independently, so a
// session could drift from how it was spawned. Both must now agree.

test('a gated boot does not auto-approve when YOLO is switched on mid-session', () => {
  // The child is still asking for permission; answering for the user would grant
  // this session more access than it was started with. Applies on the next boot.
  assert.equal(isAutoApproveActive(false, { alwaysApprove: true, alwaysApproveAck: true }), false)
})

test('a bypass boot stops auto-approving the moment YOLO is switched off', () => {
  // De-escalation is always safe to honour immediately, even though the child
  // keeps its --always-approve until it is respawned.
  assert.equal(isAutoApproveActive(true, { alwaysApprove: false, alwaysApproveAck: true }), false)
})

test('auto-approve needs the boot posture, the live toggle and the acknowledgement', () => {
  assert.equal(isAutoApproveActive(true, { alwaysApprove: true, alwaysApproveAck: true }), true)
  assert.equal(isAutoApproveActive(true, { alwaysApprove: true, alwaysApproveAck: false }), false)
  assert.equal(isAutoApproveActive(true, { alwaysApprove: true }), false, 'a revoked ack closes it')
  assert.equal(isAutoApproveActive(false, { alwaysApprove: false, alwaysApproveAck: true }), false)
})

test('the gate matches the emitted argv for an unchanged session', () => {
  for (const mode of ALL_MODES) {
    const built = build({ permissionMode: mode, alwaysApproveAck: true })
    assert.equal(
      isAutoApproveActive(built.alwaysApprove, {
        alwaysApprove: built.alwaysApprove,
        alwaysApproveAck: true
      }),
      built.args.includes('--always-approve'),
      `mode ${mode}`
    )
  }
})

// ── Flag ordering (grok rejects globals after the subcommand) ───────

test('global flags come before `agent`, -m and --always-approve after it, stdio last', () => {
  const { args } = build({
    permissionMode: 'bypassPermissions',
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

test('bypassPermissions without an ack downgrades to default and stays gated', () => {
  const result = build({ permissionMode: 'bypassPermissions' })
  assert.equal(result.permissionMode, 'default')
  assert.equal(result.alwaysApprove, false)
  assert.equal(valueAfter(result.args, '--permission-mode'), 'default')
  assert.ok(!result.args.includes('--always-approve'))
})

test('an acknowledged bypassPermissions boot emits --always-approve exactly once', () => {
  const result = build({ permissionMode: 'bypassPermissions', alwaysApproveAck: true })
  assert.equal(result.alwaysApprove, true)
  assert.equal(result.permissionMode, 'bypassPermissions')
  assert.equal(valueAfter(result.args, '--permission-mode'), 'bypassPermissions')
  assert.equal(result.args.filter((a) => a === '--always-approve').length, 1)
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

// The returned alwaysApprove used to be an independent input, so argv and the
// value the caller mirrored could disagree: a bypassPermissions boot emitted
// --always-approve while reporting alwaysApprove: false. It is now a pure view
// of the resolved mode, and these three must agree for every combination.
test('alwaysApprove is a view of the resolved mode and of the emitted argv', () => {
  for (const mode of [...ALL_MODES, undefined]) {
    for (const alwaysApproveAck of [true, false]) {
      const result = build({ permissionMode: mode, alwaysApproveAck })
      const bypass = result.permissionMode === 'bypassPermissions'
      assert.equal(result.alwaysApprove, bypass, `mode ${mode} ack ${alwaysApproveAck}`)
      assert.equal(result.args.includes('--always-approve'), bypass)
      assert.equal(valueAfter(result.args, '--permission-mode'), result.permissionMode)
    }
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
        for (const alwaysApproveAck of [true, false]) {
          const { args } = build({
            permissionMode: mode,
            surface,
            model,
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
