/**
 * Session restore decisions, free of Electron.
 *
 * Restoring a conversation reads from two sources — the local transcript cache
 * and the agent's own replay over session/load — and the rule for combining them
 * is the whole module: whichever one is authoritative, the other must be
 * suppressed. Getting that wrong is what made every message appear twice, so the
 * rule lives here where it can be asserted.
 */

import type { ChatMessage, ConnectionState } from '../../../shared/types'

/** Where the restored conversation came from, for the `history-done` event. */
export type HistorySource = 'acp' | 'local' | 'empty'

export interface HistoryReplayPlan {
  /** Seed for the live transcript: the cached messages, marked as history. */
  messages: ChatMessage[]
  /**
   * True when the local cache is authoritative, so the agent's echo of the same
   * turns during session/load must be dropped rather than appended.
   */
  suppressHistoryReplay: boolean
}

/** Mark cached messages as settled history (never mid-stream, never live). */
export function toHistoryMessages(local: ChatMessage[]): ChatMessage[] {
  return local.map((m) => ({ ...m, streaming: false, fromHistory: true }))
}

/**
 * Decide how to restore, given whatever the local cache holds.
 *
 * A non-empty cache wins: it is already de-duplicated by the store and contains
 * attachments and tool payloads that the ACP replay does not carry.
 */
export function planHistoryReplay(local: ChatMessage[]): HistoryReplayPlan {
  return {
    messages: toHistoryMessages(local),
    suppressHistoryReplay: local.length > 0
  }
}

/**
 * Which source actually produced the restored messages.
 *
 * `restoredCount` is the live transcript length after the replay finished, so it
 * only means "ACP filled it" when the local cache was empty to begin with.
 */
export function historySource(localCount: number, restoredCount: number): HistorySource {
  if (localCount > 0) return 'local'
  return restoredCount > 0 ? 'acp' : 'empty'
}

export interface BootDecisionInput {
  /** Is an agent process currently attached? */
  hasClient: boolean
  state: ConnectionState
  /** Normalized cwd of the running agent, if any. */
  currentCwd: string | null
  /** Normalized cwd the session is being restored into. */
  targetCwd: string
}

/**
 * Must a fresh agent process be started before session/load?
 *
 * A live agent is reused only when it is healthy AND already bound to the same
 * folder: an ACP session belongs to the cwd it was created under, so loading one
 * into a process rooted elsewhere resolves its file paths against the wrong tree.
 */
export function needsAgentBoot(input: BootDecisionInput): boolean {
  return (
    !input.hasClient ||
    input.state === 'error' ||
    input.state === 'idle' ||
    input.state === 'stopped' ||
    !input.currentCwd ||
    input.currentCwd !== input.targetCwd
  )
}

/**
 * May a replayed user chunk extend the previous bubble instead of opening a new one?
 *
 * Only an open history user message qualifies. `streaming === false` marks a
 * message the store already settled, and appending to one of those would rewrite
 * a turn the user has already read.
 */
export function canAppendHistoryUserChunk(
  last: ChatMessage | undefined
): last is ChatMessage {
  return !!last && last.role === 'user' && !!last.fromHistory && last.streaming !== false
}

/**
 * Did this assistant turn produce anything at all?
 *
 * A prompt creates the assistant message before the agent answers, so the caret has
 * somewhere to appear. If the call then fails, that shell is all there is — and keeping
 * it puts an empty bubble in the transcript and writes it to disk, so every failed
 * attempt adds another permanent blank. Two showed up in one real session from a single
 * retry, on a plan whose weekly limit had run out.
 *
 * Anything the agent managed to say before failing counts, including a thought or a tool
 * call with no prose: partial output is worth more than a tidy transcript.
 */
export function assistantSaidNothing(message: {
  text?: string
  thought?: string
  parts?: unknown[]
  toolCalls?: unknown[]
}): boolean {
  return (
    !message.text?.trim() &&
    !message.thought?.trim() &&
    (message.parts?.length ?? 0) === 0 &&
    (message.toolCalls?.length ?? 0) === 0
  )
}
