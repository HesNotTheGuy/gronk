/**
 * Turning one composer submission into ACP content blocks and the two transcript
 * messages that open the turn. Free of Electron so the attachment handling —
 * which decides what reaches the agent and what reaches disk — is testable.
 */

import type { ChatMessage, PromptAttachment } from '../../../shared/types'

/**
 * An ACP prompt content block. `text` and `data` are exclusive in practice.
 *
 * A type alias rather than an interface on purpose: the ACP client accepts
 * `Array<{ type: string; [k: string]: unknown }>`, and only an alias picks up the
 * implicit index signature that assignment needs.
 */
export type PromptBlock = {
  type: string
  text?: string
  data?: string
  mimeType?: string
}

export interface PromptPayload {
  /** Blocks in the order the agent receives them: text first, then images. */
  blocks: PromptBlock[]
  /** The prompt text after the attached-file list was folded in. */
  text: string
}

/**
 * Build the ACP prompt for one submission.
 *
 * Files are passed as paths inside the text rather than as inlined content: the
 * agent has its own file tools and reads them under the permission gate, so
 * pasting file bodies into the prompt would both bypass that and burn tokens.
 * Images have no such path, so they go as base64 image blocks.
 *
 * Throws when the submission carries nothing at all — an empty `session/prompt`
 * spends a turn to say nothing.
 */
export function buildPromptPayload(
  text: string,
  attachments: PromptAttachment[] = []
): PromptPayload {
  const blocks: PromptBlock[] = []

  const filePaths = attachments
    .filter((a) => a.kind === 'file' && a.path)
    .map((a) => a.path as string)

  let fullText = text.trim()
  if (filePaths.length) {
    const ctx = filePaths.map((p) => `- ${p}`).join('\n')
    fullText = fullText
      ? `${fullText}\n\nAttached files:\n${ctx}`
      : `Please inspect these files:\n${ctx}`
  }
  if (fullText) {
    blocks.push({ type: 'text', text: fullText })
  }
  for (const img of attachments.filter((a) => a.kind === 'image' && a.data)) {
    blocks.push({
      type: 'image',
      data: img.data,
      mimeType: img.mimeType || 'image/png'
    })
  }

  if (blocks.length === 0) {
    throw new Error('Empty prompt')
  }

  return { blocks, text: fullText }
}

export interface TurnMessagesInput {
  userId: string
  /** Id of the assistant message the stream will fill in. */
  assistantId: string
  /** Prompt text as sent (`PromptPayload.text`). */
  text: string
  /** Fallback when the prompt folded down to nothing but attachments. */
  rawText: string
  attachments: PromptAttachment[]
  now: number
}

/**
 * The user message plus the empty assistant message that a new turn appends to
 * the local transcript.
 *
 * Image payloads are dropped from the stored user message: the base64 is already
 * on its way to the agent, and keeping a copy per attachment would grow the
 * transcript file without giving the UI anything it cannot re-derive.
 */
export function buildTurnMessages(input: TurnMessagesInput): {
  user: ChatMessage
  assistant: ChatMessage
} {
  return {
    user: {
      id: input.userId,
      role: 'user',
      text: input.text || input.rawText,
      createdAt: input.now,
      attachments: input.attachments.map((a) => ({
        ...a,
        data: a.kind === 'image' ? undefined : a.data
      }))
    },
    assistant: {
      id: input.assistantId,
      role: 'assistant',
      text: '',
      thought: '',
      toolCalls: [],
      createdAt: input.now,
      streaming: true
    }
  }
}

/** Seed title for a session that has none yet. Falls back to the folder name. */
export function sessionTitleFromPrompt(text: string, fallback: string): string {
  return text.slice(0, 60) || fallback
}
