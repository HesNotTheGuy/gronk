/**
 * CLI/terminal sessions from ACP session/list.
 *
 * Parsers are pure. fetchTerminalSessionList is the one spawn: a short-lived
 * agent that only calls session/list, then dies. It must not touch the live
 * conversation.
 */

import type { TerminalSession } from '../../shared/types'
import { GrokAcpClient } from './acp/client'

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function readId(row: Record<string, unknown>): string | null {
  for (const key of ['sessionId', 'id']) {
    const value = row[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function readFolder(row: Record<string, unknown>): string | null {
  for (const key of ['folder', 'cwd', 'cwdPath', 'workingDirectory']) {
    const value = row[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function readUpdatedAt(row: Record<string, unknown>): number {
  for (const key of ['updatedAt', 'lastUpdated', 'last-updated', 'mtimeMs', 'modifiedAt']) {
    const value = row[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
    if (typeof value === 'string' && value.trim()) {
      const asNumber = Number(value)
      if (Number.isFinite(asNumber) && asNumber > 0) return asNumber
      const asDate = Date.parse(value)
      if (Number.isFinite(asDate) && asDate > 0) return asDate
    }
  }
  return 0
}

function readTitle(row: Record<string, unknown>): string | undefined {
  for (const key of ['title', 'name']) {
    const value = row[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function parseRow(raw: unknown): TerminalSession | null {
  const row = asRecord(raw)
  if (!row) return null
  const id = readId(row)
  const folder = readFolder(row)
  if (!id || !folder) return null
  return {
    id,
    folder,
    updatedAt: readUpdatedAt(row),
    title: readTitle(row)
  }
}

function rowsFromPayload(result: unknown): unknown[] {
  if (Array.isArray(result)) return result
  const obj = asRecord(result)
  if (!obj) return []
  for (const key of ['sessions', 'items', 'data']) {
    const value = obj[key]
    if (Array.isArray(value)) return value
  }
  return []
}

/**
 * Narrow an ACP session/list payload into TerminalSession rows.
 *
 * The CLI 1.0.5 shape is id + folder + last-updated. Field names have already
 * drifted across grok versions (`sessionId`/`cwd` vs `id`/`folder`), so both
 * are accepted. A row missing id or folder is dropped, not repaired.
 */
export function parseSessionList(result: unknown): TerminalSession[] {
  const out: TerminalSession[] = []
  const seen = new Set<string>()
  for (const raw of rowsFromPayload(result)) {
    const row = parseRow(raw)
    if (!row || seen.has(row.id)) continue
    seen.add(row.id)
    out.push(row)
  }
  return out
}

/**
 * session/list returns every native grok session, including ones Gronk already
 * owns. Those stay in Gronk's own list. The labeled group is the remainder.
 */
export function excludeKnownTerminalSessions(
  listed: readonly TerminalSession[],
  knownIds: Iterable<string>
): TerminalSession[] {
  const known = new Set<string>()
  for (const id of knownIds) {
    if (id) known.add(id)
  }
  return listed.filter((row) => !known.has(row.id))
}

/**
 * session/resume takes the session id plus its folder.
 *
 * cwd is the ACP name for that folder (same field session/load already sends).
 * mcpServers is required on the sibling load call; omitting it here would be
 * the same Invalid params failure.
 */
export function terminalResumeParams(
  sessionId: string,
  folder: string
): { sessionId: string; cwd: string; mcpServers: unknown[] } {
  return { sessionId, cwd: folder, mcpServers: [] }
}

/**
 * Boot grok, call session/list, drop ids Gronk already owns, kill the child.
 *
 * Failures become []. The sidebar must not die because the CLI is missing or
 * session/list is not on this build.
 */
export async function fetchTerminalSessionList(options: {
  binary: string
  args: string[]
  env?: NodeJS.ProcessEnv
  knownIds: Iterable<string>
}): Promise<TerminalSession[]> {
  const client = new GrokAcpClient(options.binary, options.args)
  try {
    client.start(options.env)
    await client.initialize()
    return excludeKnownTerminalSessions(
      parseSessionList(await client.sessionList()),
      options.knownIds
    )
  } catch {
    return []
  } finally {
    await client.dispose()
  }
}
