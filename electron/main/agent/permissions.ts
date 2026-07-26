/**
 * Pending permission bookkeeping, free of Electron.
 *
 * The agent can have several permission requests outstanding at once, each keyed
 * by its JSON-RPC id, while the UI only ever shows one. Every one of them must
 * eventually get a response or the turn freezes, so losing an entry here is not
 * a cosmetic bug — hence a real module with tests rather than a Map and an array
 * inline in AgentManager.
 *
 * The auto-approve decision is NOT here: it lives in agent-args.isAutoApproveActive,
 * which owns the boot-posture rule.
 */

import type { JsonRpcId, PermissionOption } from '../acp/client'
import type { ToolCallInfo } from '../../../shared/types'

export interface PendingPermission {
  requestId: JsonRpcId
  options: PermissionOption[]
  toolCallId?: string
  title: string
  kind?: string
  rawInput?: unknown
  /** When set, resolve ACP fs/write after user decision */
  fsWrite?: { path: string; content: string }
}

/** JSON-RPC ids are numbers or strings; the map is keyed by their string form. */
export function permissionKey(id: JsonRpcId): string {
  return String(id)
}

export interface ParsedPermissionRequest {
  pending: PendingPermission
  /**
   * Patch that marks the matching tool card as awaiting consent, or null when
   * the request named no tool call to attach it to.
   */
  toolCallPatch: (Partial<ToolCallInfo> & { toolCallId: string }) | null
}

/**
 * Read one `session/request_permission` payload.
 *
 * Field names differ between agent versions (camelCase, snake_case, bare `id`),
 * and the title is what the user reads before granting access, so a missing one
 * falls back through the raw input rather than rendering an empty prompt.
 */
export function parsePermissionRequest(
  requestId: JsonRpcId,
  params: Record<string, unknown>
): ParsedPermissionRequest {
  const toolCall = (params.toolCall ?? params.tool_call ?? {}) as Record<string, unknown>
  const options = (Array.isArray(params.options) ? params.options : []) as PermissionOption[]

  const toolCallId =
    (toolCall.toolCallId as string) ||
    (toolCall.tool_call_id as string) ||
    (toolCall.id as string)

  const title =
    (toolCall.title as string) ||
    (params.title as string) ||
    (typeof toolCall.rawInput === 'string' ? toolCall.rawInput.slice(0, 80) : null) ||
    'Allow tool?'

  return {
    pending: {
      requestId,
      options,
      toolCallId,
      title,
      kind: toolCall.kind as string | undefined,
      rawInput: toolCall.rawInput ?? toolCall.input ?? params.rawInput
    },
    // The card shows only what the tool call itself declared. The dialog's
    // rawInput has one more fallback (a top-level `rawInput` on the request), so
    // the two can differ — kept as-is rather than unified, since which of the two
    // is right is a product question, not a refactor one.
    toolCallPatch: toolCallId
      ? {
          toolCallId,
          title,
          status: 'pending',
          rawInput: toolCall.rawInput ?? toolCall.input
        }
      : null
  }
}

/**
 * FIX-9: one pending permission per request id, displayed FIFO.
 *
 * Insertion order is display order; answering an entry that is not at the front
 * (the renderer can hold a stale id) removes it without disturbing the rest.
 */
export class PermissionQueue {
  // Plain field assignment, no constructor parameter properties: `node --test`
  // strips types without transforming them.
  private pending = new Map<string, PendingPermission>()
  private order: string[] = []

  get size(): number {
    return this.pending.size
  }

  /** Add or replace an entry. Re-adding a known id keeps its place in the queue. */
  add(pending: PendingPermission): string {
    const key = permissionKey(pending.requestId)
    this.pending.set(key, pending)
    if (!this.order.includes(key)) this.order.push(key)
    return key
  }

  /** Remove and return an entry, or undefined when the id is unknown. */
  take(id: JsonRpcId): PendingPermission | undefined {
    const key = permissionKey(id)
    const pending = this.pending.get(key)
    if (!pending) return undefined
    this.pending.delete(key)
    this.order = this.order.filter((k) => k !== key)
    return pending
  }

  /**
   * The entry the UI should be showing. Queue keys whose entry is already gone
   * are dropped on the way — the head is not trustworthy on its own.
   */
  front(): PendingPermission | undefined {
    while (this.order.length) {
      const pending = this.pending.get(this.order[0])
      if (pending) return pending
      this.order.shift()
    }
    return undefined
  }

  /** Every outstanding entry, for cancel-everything paths. */
  all(): PendingPermission[] {
    return [...this.pending.values()]
  }

  clear(): void {
    this.pending.clear()
    this.order = []
  }
}
