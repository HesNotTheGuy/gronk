import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { __freshUserData } from './stubs/electron'
import {
  appendPermissionAudit,
  getPermissionAudit,
  PERMISSION_AUDIT_FILE,
  permissionAuditPath,
  __resetPermissionAuditMigrationForTests
} from '../electron/main/permission-audit'
import { setSettings, upsertSession } from '../electron/main/store'
import type { PermissionAuditEntry } from '../shared/types'

let userData = ''

beforeEach(() => {
  userData = __freshUserData()
  __resetPermissionAuditMigrationForTests()
})

function storeFile(): string {
  return path.join(userData, 'gronk-store.json')
}

function auditFile(): string {
  return path.join(userData, PERMISSION_AUDIT_FILE)
}

function entry(
  partial: Partial<PermissionAuditEntry> & Pick<PermissionAuditEntry, 'id' | 'at'>
): PermissionAuditEntry {
  return {
    sessionId: 's1',
    cwd: 'C:/work/app',
    toolCallId: 't1',
    title: 'Read package.json',
    decision: 'allow-once',
    ...partial
  }
}

/**
 * Real old-format store on disk — not an in-memory object handed to a helper.
 * Migration must open this path the way a shipping build does.
 */
function writeLegacyStore(entries: PermissionAuditEntry[]): void {
  fs.mkdirSync(userData, { recursive: true })
  fs.writeFileSync(
    storeFile(),
    JSON.stringify(
      {
        version: 1,
        settings: { permissionMode: 'default', theme: 'dark' },
        recentProjects: [],
        sessions: [{ id: 's1', cwd: 'C:/work/app', createdAt: 1, updatedAt: 1, title: 'One' }],
        transcripts: {
          s1: [{ id: 'm1', role: 'user', text: 'hello', createdAt: 1 }]
        },
        permissionAudit: entries
      },
      null,
      2
    ),
    'utf8'
  )
}

// ── Migration from gronk-store.json ─────────────────────────────────

test('migration: entries move off a real on-disk legacy store with field parity', () => {
  const legacy = [
    entry({
      id: 'a-old',
      at: 100,
      title: 'Shell npm test',
      kind: 'execute',
      decision: 'allow-once',
      rawInputPreview: 'npm test'
    }),
    entry({
      id: 'b-old',
      at: 90,
      title: 'Read src/index.ts',
      decision: 'auto-allow',
      toolCallId: 't2'
    }),
    entry({
      id: 'c-old',
      at: 80,
      title: 'Write out.txt',
      decision: 'reject-once',
      sessionId: 's2',
      cwd: 'C:/other'
    })
  ]
  writeLegacyStore(legacy)
  assert.equal(fs.existsSync(auditFile()), false, 'no audit file before first read')

  // First access through the public API — not a hand-built in-memory store.
  const migrated = getPermissionAudit()

  assert.equal(migrated.length, 3, 'same count after migration')
  assert.deepEqual(
    migrated.map((e) => e.id),
    ['a-old', 'b-old', 'c-old'],
    'same order after migration'
  )
  for (let i = 0; i < legacy.length; i++) {
    assert.deepEqual(migrated[i], legacy[i], `field values preserved for ${legacy[i].id}`)
  }
  assert.equal(fs.existsSync(auditFile()), true, 'audit file created on disk')
  assert.equal(permissionAuditPath(), auditFile())
})

test('migration: next store write drops permissionAudit; second startup does not re-migrate or duplicate', () => {
  const legacy = [
    entry({ id: 'keep-1', at: 10 }),
    entry({ id: 'keep-2', at: 9 })
  ]
  writeLegacyStore(legacy)

  const first = getPermissionAudit()
  assert.equal(first.length, 2)

  // Next ordinary store write must omit the legacy key.
  assert.ok(
    Object.prototype.hasOwnProperty.call(
      JSON.parse(fs.readFileSync(storeFile(), 'utf8')),
      'permissionAudit'
    ),
    'precondition: legacy key still on store before a store write'
  )
  setSettings({ theme: 'light' })
  const afterWrite = JSON.parse(fs.readFileSync(storeFile(), 'utf8')) as Record<string, unknown>
  assert.equal(
    Object.prototype.hasOwnProperty.call(afterWrite, 'permissionAudit'),
    false,
    'permissionAudit key gone from gronk-store.json after the next write'
  )
  assert.equal((afterWrite.settings as { theme?: string }).theme, 'light')

  // Simulate a second process startup: clear the one-shot flag, do not delete the
  // audit file, read again — must not re-copy from a (now absent) store key or
  // invent duplicates from a leftover key.
  __resetPermissionAuditMigrationForTests()
  const second = getPermissionAudit()
  assert.equal(second.length, 2, 'no duplicate on second startup')
  assert.deepEqual(
    second.map((e) => e.id),
    ['keep-1', 'keep-2']
  )

  // Even if a store somehow still had the key, existing audit file wins and
  // must not be re-seeded from store (would double). Plant a fake key and re-check.
  const raw = JSON.parse(fs.readFileSync(storeFile(), 'utf8')) as Record<string, unknown>
  raw.permissionAudit = [entry({ id: 'should-not-appear', at: 1 })]
  fs.writeFileSync(storeFile(), JSON.stringify(raw, null, 2), 'utf8')
  __resetPermissionAuditMigrationForTests()
  const third = getPermissionAudit()
  assert.equal(third.length, 2)
  assert.ok(!third.some((e) => e.id === 'should-not-appear'))
})

// ── Durability ──────────────────────────────────────────────────────

test('durability: one entry per decision, readable immediately, no debounce', () => {
  appendPermissionAudit(entry({ id: 'first', at: 1, decision: 'allow-once' }))
  const afterOne = getPermissionAudit()
  assert.equal(afterOne.length, 1)
  assert.equal(afterOne[0].id, 'first')
  assert.ok(fs.existsSync(auditFile()), 'file on disk after first write')

  appendPermissionAudit(entry({ id: 'second', at: 2, decision: 'auto-allow' }))
  const afterTwo = getPermissionAudit()
  assert.equal(afterTwo.length, 2, 'both entries readable with no wait')
  assert.deepEqual(
    afterTwo.map((e) => e.id),
    ['second', 'first'],
    'newest first'
  )

  // Survive a process-boundary style re-read (migration flag reset, same files).
  __resetPermissionAuditMigrationForTests()
  const reloaded = getPermissionAudit()
  assert.equal(reloaded.length, 2)
  assert.deepEqual(
    reloaded.map((e) => e.id),
    ['second', 'first']
  )
})

// ── Existing redaction / cap contract ───────────────────────────────

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
  const [one] = getPermissionAudit()
  assert.ok(!one.title.includes('SUPERSECRET123'))
  assert.ok(!(one.rawInputPreview || '').includes('xai-abcdefgh1234567890'))

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

test('audit file is not the store and is not written into the store backup', () => {
  appendPermissionAudit(entry({ id: 'solo', at: 1 }))
  upsertSession({
    id: 's1',
    cwd: 'C:/work/app',
    createdAt: 1,
    updatedAt: 1,
    title: 'S'
  })
  // Force a second store write so a backup exists.
  setSettings({ theme: 'dark' })

  const storeNames = fs.readdirSync(userData)
  assert.ok(storeNames.includes(PERMISSION_AUDIT_FILE))
  assert.ok(storeNames.includes('gronk-store.json'))

  if (fs.existsSync(path.join(userData, 'gronk-store.backup.json'))) {
    const backup = JSON.parse(
      fs.readFileSync(path.join(userData, 'gronk-store.backup.json'), 'utf8')
    ) as Record<string, unknown>
    assert.equal(
      Object.prototype.hasOwnProperty.call(backup, 'permissionAudit'),
      false,
      'backup must not carry the audit trail'
    )
  }
  const main = JSON.parse(fs.readFileSync(storeFile(), 'utf8')) as Record<string, unknown>
  assert.equal(Object.prototype.hasOwnProperty.call(main, 'permissionAudit'), false)
})
