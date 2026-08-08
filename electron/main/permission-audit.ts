/**
 * Permission decision audit trail — its own small file in userData.
 *
 * Lives outside gronk-store.json on purpose: each append used to re-read, back
 * up, pretty-print and rewrite the whole store (transcripts included), which
 * blocked the main process for a beat that grew with session history. Two
 * hundred capped audit rows serialize in microseconds; they do not need the
 * store's backup roll.
 *
 * Not a transcript. Not backed up, not exported, not revealed. One write per
 * decision, durable and synchronous — no debounce.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { PermissionAuditEntry } from '../../shared/types'
import { dataDir, storePath, writeFileAtomicSync } from './data-dir'
import { applyRedactionPolicy, redactPreview, redactValue, type RedactionPolicy } from './redact'

export const PERMISSION_AUDIT_FILE = 'gronk-permission-audit.json'
const AUDIT_CAP = 200
const FILE_VERSION = 1

interface AuditFile {
  version: number
  entries: PermissionAuditEntry[]
}

/** Absolute path of the audit file under the active data directory. */
export function permissionAuditPath(): string {
  return path.join(dataDir(), PERMISSION_AUDIT_FILE)
}

function emptyFile(): AuditFile {
  return { version: FILE_VERSION, entries: [] }
}

function isEntry(value: unknown): value is PermissionAuditEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const e = value as Record<string, unknown>
  return (
    typeof e.id === 'string' &&
    typeof e.at === 'number' &&
    typeof e.sessionId === 'string' &&
    typeof e.cwd === 'string' &&
    typeof e.toolCallId === 'string' &&
    typeof e.title === 'string' &&
    typeof e.decision === 'string'
  )
}

function parseAuditText(text: string): PermissionAuditEntry[] {
  const parsed = JSON.parse(text) as unknown
  if (Array.isArray(parsed)) {
    return parsed.filter(isEntry).slice(0, AUDIT_CAP)
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const entries = (parsed as { entries?: unknown }).entries
    if (Array.isArray(entries)) return entries.filter(isEntry).slice(0, AUDIT_CAP)
  }
  return []
}

function readAuditFile(): PermissionAuditEntry[] {
  const file = permissionAuditPath()
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    return []
  }
  try {
    return parseAuditText(text)
  } catch {
    return []
  }
}

function writeAuditFile(entries: PermissionAuditEntry[]): void {
  const payload: AuditFile = {
    version: FILE_VERSION,
    entries: entries.slice(0, AUDIT_CAP)
  }
  writeFileAtomicSync(permissionAuditPath(), JSON.stringify(payload))
}

/**
 * One-shot per process: if the dedicated file is missing and gronk-store.json
 * still carries `permissionAudit`, copy those entries into the new file.
 *
 * Does not rewrite the store here — the key is dropped on the store's next
 * ordinary write (StoreData no longer includes it).
 */
let migrationChecked = false

function peekLegacyFromStore(): PermissionAuditEntry[] | null {
  let text: string
  try {
    text = fs.readFileSync(storePath(), 'utf8')
  } catch {
    return null
  }
  try {
    const raw = JSON.parse(text) as { permissionAudit?: unknown }
    if (!Array.isArray(raw.permissionAudit)) return null
    return raw.permissionAudit.filter(isEntry).slice(0, AUDIT_CAP)
  } catch {
    return null
  }
}

function ensureMigrated(): void {
  if (migrationChecked) return
  migrationChecked = true

  const file = permissionAuditPath()
  if (fs.existsSync(file)) return

  const legacy = peekLegacyFromStore()
  if (legacy && legacy.length > 0) {
    writeAuditFile(legacy)
  }
}

/**
 * What is written for each field of an entry.
 *
 * The two that carry agent-supplied text are handled below rather than here,
 * because they are truncated as well as redacted. Everything else is the app's
 * own record of the decision.
 *
 * The exhaustive `Record` is the part that matters beyond today's fields: adding
 * one to `PermissionAuditEntry` fails `npm run typecheck` here until somebody
 * chooses what happens to it, rather than it being written out because it was on
 * the object.
 */
const AUDIT_POLICY: RedactionPolicy<PermissionAuditEntry> = {
  id: 'keep',
  at: 'keep',
  sessionId: 'keep',
  cwd: 'keep',
  toolCallId: 'keep',
  title: 'redact',
  kind: 'keep',
  decision: 'keep',
  rawInputPreview: 'redact'
}

/** Sanitize one entry the same way the store path always did. */
function sanitize(entry: PermissionAuditEntry): PermissionAuditEntry {
  // Built from the policy, so a field absent from it is not carried at all.
  const safe = applyRedactionPolicy(entry, AUDIT_POLICY)
  return {
    ...safe,
    rawInputPreview: entry.rawInputPreview
      ? redactPreview(entry.rawInputPreview, 500)
      : undefined,
    title: entry.title ? String(redactValue(entry.title)).slice(0, 200) : entry.title
  }
}

/**
 * Prepend one decision. Synchronous and durable — readable on the next call.
 */
export function appendPermissionAudit(entry: PermissionAuditEntry): PermissionAuditEntry[] {
  ensureMigrated()
  const safe = sanitize(entry)
  const next = [safe, ...readAuditFile()].slice(0, AUDIT_CAP)
  writeAuditFile(next)
  return next
}

/** Newest first. Migrates from the store file on first access when needed. */
export function getPermissionAudit(): PermissionAuditEntry[] {
  ensureMigrated()
  return readAuditFile()
}

/** Test seam: allow a fresh userData to re-run migration in the same process. */
export function __resetPermissionAuditMigrationForTests(): void {
  migrationChecked = false
}
