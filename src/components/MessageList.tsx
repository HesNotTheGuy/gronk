import { useState } from 'react'
import type { ChatMessage } from '../../shared/types'
import { extractImageRefsFromTools } from '../lib/image-refs'
import { hasAssistantReplyAfter } from '../lib/messages'
import { Markdown } from './Markdown'
import { ToolActivity } from './ToolActivity'

interface Props {
  messages: ChatMessage[]
  onRetry?: (messageId: string) => void
  canRetry?: boolean
}

function ThoughtBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`thought-wrap ${open ? 'open' : ''}`}>
      <button type="button" className="thought-toggle" onClick={() => setOpen((v) => !v)}>
        <span>THINK</span>
        <span className="thought-meta">{open ? 'hide' : 'show'} · {text.length} chars</span>
      </button>
      {open ? <div className="thought">{text}</div> : null}
    </div>
  )
}

function shouldShowRetry(
  messages: ChatMessage[],
  idx: number,
  canRetry: boolean | undefined
): boolean {
  if (!canRetry) return false
  const m = messages[idx]
  if (m.role !== 'user') return false
  if (m.sendStatus === 'sending') return false
  if (m.sendStatus === 'failed') return true
  // Only offer retry if this is the last user turn and nothing answered it yet
  for (let i = idx + 1; i < messages.length; i++) {
    if (messages[i].role === 'user') return false
  }
  return !hasAssistantReplyAfter(messages, idx)
}

export function MessageList({ messages, onRetry, canRetry }: Props) {
  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="chat-inner">
      {messages.map((m, idx) => {
        const showRetry = shouldShowRetry(messages, idx, canRetry) && !!onRetry
        const failed = m.role === 'user' && m.sendStatus === 'failed'
        const sending = m.role === 'user' && m.sendStatus === 'sending'

        return (
          <div
            key={m.id}
            className={`message ${m.role} ${failed ? 'failed' : ''} ${sending ? 'sending' : ''}`}
          >
            <div className="message-role">
              <span>
                {m.role === 'user'
                  ? 'You'
                  : m.role === 'assistant'
                    ? 'Grok'
                    : 'System'}
                {sending ? ' · sending…' : null}
                {failed ? ' · not sent' : null}
              </span>
              {m.text ? (
                <div className="message-actions">
                  <button
                    type="button"
                    className="btn-mini"
                    onClick={() => void copyText(m.text)}
                    title="Copy message"
                  >
                    Copy
                  </button>
                  {showRetry ? (
                    <button
                      type="button"
                      className="btn-mini"
                      onClick={() => onRetry!(m.id)}
                      title="Retry sending this prompt (does not duplicate)"
                    >
                      Retry
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>

            {m.attachments && m.attachments.length > 0 ? (
              <div className="msg-attachments">
                {m.attachments.map((a) =>
                  a.kind === 'image' && a.previewUrl ? (
                    <img key={a.id} src={a.previewUrl} alt={a.name} className="msg-attach-img" />
                  ) : (
                    <span key={a.id} className="msg-attach-chip">
                      {a.name}
                    </span>
                  )
                )}
              </div>
            ) : null}

            {m.thought ? <ThoughtBlock text={m.thought} /> : null}

            {m.toolCalls && m.toolCalls.length > 0 ? (
              <ToolActivity tools={m.toolCalls} />
            ) : null}

            {(m.text || m.streaming) && (
              <div className={`bubble ${m.streaming && !m.text ? 'streaming-caret' : ''}`}>
                {m.role === 'assistant' ? (
                  <Markdown
                    text={m.text || (m.streaming ? '' : '')}
                    suppressImagePaths={
                      m.toolCalls?.length
                        ? extractImageRefsFromTools(m.toolCalls).map((r) => r.path)
                        : undefined
                    }
                  />
                ) : (
                  m.text
                )}
                {m.streaming && m.text ? <span className="streaming-caret" /> : null}
              </div>
            )}

            {failed && m.error ? (
              <div className="msg-send-error" title={m.error}>
                {m.error}
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
