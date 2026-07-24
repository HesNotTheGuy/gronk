import type { ChatMessage, PromptAttachment } from '../../shared/types'

export function createUserMessage(
  text: string,
  attachments?: PromptAttachment[],
  sendStatus: ChatMessage['sendStatus'] = 'sending'
): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    text,
    createdAt: Date.now(),
    attachments,
    sendStatus
  }
}

export function createAssistantPlaceholder(id: string): ChatMessage {
  return {
    id,
    role: 'assistant',
    text: '',
    thought: '',
    toolCalls: [],
    createdAt: Date.now(),
    streaming: true
  }
}

/**
 * True if this user message already has an assistant turn after it.
 * Used by send/retry and by MessageList retry affordances — keep one definition.
 */
export function hasAssistantReplyAfter(
  messages: ChatMessage[],
  userIdx: number
): boolean {
  for (let i = userIdx + 1; i < messages.length; i++) {
    const m = messages[i]
    if (m.role === 'user') break
    if (m.role === 'assistant') {
      if (m.streaming) return true
      if (
        (m.text && m.text.trim()) ||
        (m.toolCalls && m.toolCalls.length > 0) ||
        m.thought
      ) {
        return true
      }
      // Empty finished placeholder still counts as a turn attempted
      // (except explicit failed send on assistant — rare)
      if (!m.streaming && m.sendStatus !== 'failed') return true
    }
  }
  return false
}
