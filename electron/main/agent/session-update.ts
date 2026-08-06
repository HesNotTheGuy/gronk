/**
 * Pure routing for one ACP `session/update` notification.
 *
 * Deliberately free of Electron and of AgentManager state: this dispatch decides
 * whether a chunk rebuilds history, extends the live turn, or is dropped
 * entirely, and every one of those branches has been a bug at least once (the
 * duplicated-history one shipped). Keeping it as data-in/data-out is what makes
 * those branches assertable in `npm test`. AgentManager applies the returned
 * action and must not re-derive any part of it.
 */

import { mergeToolCall, parseToolCallFromUpdate } from '../acp/client'
import type { ToolCallInfo } from '../../../shared/types'

/** The AgentManager state the routing decision depends on. */
export interface SessionUpdateContext {
  /** Live session id, used when the notification omits one. */
  sessionId: string | null
  /** A session/load replay is in progress: chunks rebuild history, not the live turn. */
  replayingHistory: boolean
  /**
   * A complete local transcript is already on screen, so the agent's echo of the
   * same turns during session/load must be dropped instead of appended.
   */
  suppressHistoryReplay: boolean
}

export type SessionUpdateAction =
  /** End-of-turn accounting. Carries the raw update because the usage parser reads it. */
  | { type: 'usage'; update: Record<string, unknown> }
  /** Drop it: nothing to render and no assistant message to open. */
  | { type: 'ignore' }
  /** Replayed user turn. `messageId` is absent when the update carried no id. */
  | { type: 'history-user-chunk'; text: string; messageId?: string }
  | { type: 'text'; text: string }
  | { type: 'thought'; text: string }
  /** `initial` distinguishes `tool_call` (new card) from `tool_call_update` (patch). */
  | { type: 'tool-call'; toolCall: ToolCallInfo; initial: boolean }
  | { type: 'plan'; plan: Record<string, unknown> }
  /** Assistant-scoped but nothing to emit: empty chunk, unparseable tool call, unknown kind. */
  | { type: 'noop' }

export interface RoutedSessionUpdate {
  sessionId: string
  /**
   * True once routing passed the history gates. The caller must resolve an
   * assistant message id before acting — including for `noop`, because minting
   * that id is what opens a replayed turn's bubble, and the original dispatch
   * did it for every kind that reached this far.
   */
  assistantScoped: boolean
  /** A message id carried by the update itself, when it had one. */
  explicitMessageId?: string
  action: SessionUpdateAction
}

/**
 * Text out of a chunk update.
 *
 * The CLI has sent all three shapes: `content` as a bare string, `content.text`,
 * and a top-level `text`.
 */
export function extractChunkText(update: Record<string, unknown>): string {
  const content = update.content as { text?: string } | string | undefined
  if (typeof content === 'string') return content
  return content?.text || (update.text as string) || ''
}

/** Classify one `session/update` payload. No state is read or written. */
export function routeSessionUpdate(
  params: Record<string, unknown>,
  context: SessionUpdateContext
): RoutedSessionUpdate {
  const update = (params.update ?? params) as Record<string, unknown>
  const sessionId = (params.sessionId as string) || context.sessionId || ''
  const kind = (update.sessionUpdate as string) || ''
  const explicitMessageId = (update.messageId as string) || undefined

  // Accounting is handled before anything else touches the assistant message: a
  // turn_completed carries no content, so opening a bubble for it would leave an
  // empty one behind during replay.
  if (kind === 'turn_completed') {
    return { sessionId, assistantScoped: false, action: { type: 'usage', update } }
  }

  // A live turn already has its user bubble (renderer optimistic write +
  // sendPrompt), and the agent echoes the prompt back as user_message_chunk.
  // Only rebuild user turns while replaying, and only when the local transcript
  // did not already supply them.
  if (kind === 'user_message_chunk') {
    if (!context.replayingHistory || context.suppressHistoryReplay) {
      return { sessionId, assistantScoped: false, action: { type: 'ignore' } }
    }
    const text = extractChunkText(update)
    if (!text) {
      return { sessionId, assistantScoped: false, action: { type: 'ignore' } }
    }
    return {
      sessionId,
      assistantScoped: false,
      action: {
        type: 'history-user-chunk',
        text,
        messageId: explicitMessageId || (update.id as string) || undefined
      }
    }
  }

  // The local transcript is authoritative, so everything the agent echoes back
  // during session/load is a copy of something already on screen.
  //
  // Tool calls belong in this list and were missing from it. Text and thoughts
  // were dropped while the echoed tool calls fell through to the live routing
  // fifteen lines below and were appended to a fresh message, so every reopen
  // re-added a session's entire tool-call history. The duplicates share a
  // toolCallId, which is what makes them removable.
  if (
    context.suppressHistoryReplay &&
    (kind === 'agent_message_chunk' ||
      kind === 'agent_thought_chunk' ||
      kind === 'tool_call' ||
      kind === 'tool_call_update')
  ) {
    return { sessionId, assistantScoped: false, action: { type: 'ignore' } }
  }

  const base = { sessionId, assistantScoped: true, explicitMessageId }

  if (kind === 'agent_message_chunk') {
    const text = extractChunkText(update)
    return { ...base, action: text ? { type: 'text', text } : { type: 'noop' } }
  }

  if (kind === 'agent_thought_chunk') {
    const text = extractChunkText(update)
    return { ...base, action: text ? { type: 'thought', text } : { type: 'noop' } }
  }

  if (kind === 'tool_call' || kind === 'tool_call_update') {
    const toolCall = parseToolCallFromUpdate(update)
    return {
      ...base,
      action: toolCall
        ? { type: 'tool-call', toolCall, initial: kind === 'tool_call' }
        : { type: 'noop' }
    }
  }

  if (kind === 'plan') {
    return { ...base, action: { type: 'plan', plan: update } }
  }

  // An unrecognised kind is NOT assistant-scoped. A `noop` here still resolved an
  // assistant id, which during replay opened an empty bubble and emitted a
  // message event for it — so any update type the CLI adds later (
  // `available_commands_update`, say) silently littered restored history with
  // blank messages. A known kind with an empty payload keeps its `noop`, because
  // an empty agent chunk really does mean an assistant turn has started.
  return { sessionId, assistantScoped: false, action: { type: 'ignore' } }
}

/**
 * Fold a parsed tool call into a message's list.
 *
 * Returns the merged entry as well as the new list because the renderer event
 * must carry the merged value, not the incoming one: Grok sends the real
 * identity once and then streams status-only updates, so emitting `parsed`
 * would re-broadcast the placeholder title that mergeToolCall just rejected.
 */
export function upsertToolCall(
  existing: ToolCallInfo[] | undefined,
  parsed: ToolCallInfo
): { toolCalls: ToolCallInfo[]; merged: ToolCallInfo } {
  const toolCalls = [...(existing || [])]
  const idx = toolCalls.findIndex((t) => t.toolCallId === parsed.toolCallId)
  if (idx < 0) {
    toolCalls.push(parsed)
    return { toolCalls, merged: parsed }
  }
  const merged = mergeToolCall(toolCalls[idx], parsed)
  toolCalls[idx] = merged
  return { toolCalls, merged }
}
