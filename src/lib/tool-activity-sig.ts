import type { ChatMessage } from '../../shared/types'

/**
 * Compact signature of tool-call activity in the recent message window.
 *
 * Streaming text tokens rebuild the `messages` array every time but leave each
 * message's `toolCalls` array (and each call's status) alone. Comparing this
 * string lets SessionTray skip collectAgentUnitsFromMessages + setRetained on
 * pure text tokens — the O(N) scan and the extra React pass both go away.
 */
export function toolActivitySignature(
  messages: readonly ChatMessage[],
  maxMessages = 200
): string {
  const start = Math.max(0, messages.length - maxMessages)
  let out = ''
  for (let i = start; i < messages.length; i++) {
    const tools = messages[i].toolCalls
    if (!tools || tools.length === 0) continue
    out += messages[i].id
    for (const t of tools) {
      out += `\0${t.toolCallId}\0${t.status}`
    }
    out += '\n'
  }
  return out
}
