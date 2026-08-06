import { memo, useMemo, useState } from 'react'
import type { ChatMessage, ToolCallInfo } from '../../shared/types'
import { extractImageRefsFromTools } from '../lib/image-refs'
import { hasAssistantReplyAfter } from '../lib/messages'
import { Markdown } from './Markdown'
import { ToolActivity } from './ToolActivity'
import { AgentDots } from './AgentDots'
import { LocalImage } from './LocalImage'

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

/** One block of a turn as it is drawn: a bubble, or a run of tool cards. */
export type MessageSegment =
  | { kind: 'text'; text: string }
  | { kind: 'tools'; tools: ToolCallInfo[] }

/**
 * What to draw for one message, in order.
 *
 * Two shapes go in. A message with `parts` is drawn in the order the agent
 * produced it, so the sentence that introduces a tool call sits directly above
 * that call. A message without `parts` is every transcript saved before parts
 * existed, and it keeps the layout it was written for: all the tool cards, then
 * the whole text. Neither branch reads the other's field, so nothing has to be
 * migrated and nothing can be lost.
 */
export function buildMessageSegments(message: ChatMessage): MessageSegment[] {
  const tools = message.toolCalls ?? []
  const segments: MessageSegment[] = []

  if (!message.parts || message.parts.length === 0) {
    if (tools.length) segments.push({ kind: 'tools', tools })
    if (message.text) segments.push({ kind: 'text', text: message.text })
    return segments
  }

  const byId = new Map(tools.map((t) => [t.toolCallId, t]))
  const placed = new Set<string>()

  for (const part of message.parts) {
    if (part.kind === 'text') {
      // A run of pure whitespace between two calls would otherwise draw an empty
      // padded bubble. The text itself is not lost: `text` still has all of it.
      if (!part.text.trim()) continue
      segments.push({ kind: 'text', text: part.text })
      continue
    }
    const tool = byId.get(part.toolCallId)
    if (!tool) continue
    placed.add(tool.toolCallId)
    // Consecutive calls share one card, which is how a turn with six reads in a
    // row has always looked. Only a narration between them splits the run.
    const last = segments[segments.length - 1]
    if (last && last.kind === 'tools') last.tools.push(tool)
    else segments.push({ kind: 'tools', tools: [tool] })
  }

  // A call with no part pointing at it still has to be drawn. The two lists are
  // written by different events and a dropped tool card would be a silent loss
  // of the one thing the user most needs to see.
  const unplaced = tools.filter((t) => !placed.has(t.toolCallId))
  if (unplaced.length) segments.push({ kind: 'tools', tools: unplaced })

  return segments
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

/**
 * Module-level so MessageRow memo is not busted by a fresh function every
 * parent render. Clipboard has no React state.
 */
async function copyMessage(text: string): Promise<void> {
  try {
    const { copyText } = await import('../lib/clipboard')
    await copyText(text)
  } catch {
    /* ignore */
  }
}

/**
 * One finished text bubble. Memoized so streaming only re-parses the last
 * segment that actually grew — earlier segments keep their text string and
 * skip the remark pass entirely.
 *
 * Exported so tests can assert `$$typeof === Symbol.for('react.memo')`.
 */
export const MessageTextSegment = memo(function MessageTextSegment({
  text,
  role,
  suppressImagePaths,
  showCaret
}: {
  text: string
  role: ChatMessage['role']
  suppressImagePaths?: string[]
  showCaret: boolean
}) {
  return (
    <div className="bubble">
      {role === 'assistant' ? (
        <Markdown text={text} suppressImagePaths={suppressImagePaths} />
      ) : (
        text
      )}
      {showCaret ? <span className="streaming-caret" /> : null}
    </div>
  )
})

interface MessageRowProps {
  message: ChatMessage
  /** True when this is not the newest message (and thus not live). */
  demoteLive: boolean
  showRetry: boolean
  /** Must be stable across parent renders or memo is decorative. */
  onRetry?: (messageId: string) => void
}

/**
 * One message row. Memoized on prop identity: setMessages already preserves
 * object identity for unchanged messages (`prev.map(m => m.id === X ? {...m} :
 * m)`), so a token on the last turn must not re-run remark for the previous
 * 149 messages.
 *
 * Stabilization checklist (each one busts memo if it is a fresh value every
 * render):
 *  - `onRetry` — hoisted in App with useCallback
 *  - `suppressImagePaths` — derived inside this row from `message.toolCalls`,
 *    not rebuilt in the list map
 *  - `copyMessage` — module-level function, not a component-body closure
 */
export const MessageRow = memo(function MessageRow({
  message: m,
  demoteLive,
  showRetry,
  onRetry
}: MessageRowProps) {
  const failed = m.role === 'user' && m.sendStatus === 'failed'
  const sending = m.role === 'user' && m.sendStatus === 'sending'
  const segments = buildMessageSegments(m)
  const last = segments[segments.length - 1]

  // toolCalls keeps identity across pure text chunks (message-chunk only
  // spreads text/parts), so this array is stable for non-tool tokens and
  // MessageTextSegment memo holds for earlier segments.
  const suppressImagePaths = useMemo(
    () =>
      m.toolCalls?.length
        ? extractImageRefsFromTools(m.toolCalls).map((r) => r.path)
        : undefined,
    [m.toolCalls]
  )

  return (
    <div
      className={`message ${m.role} ${failed ? 'failed' : ''} ${sending ? 'sending' : ''}`}
    >
      <div className="message-role">
        <span>
          {m.role === 'user' ? 'You' : m.role === 'assistant' ? 'Grok' : 'System'}
          {sending ? ' · sending…' : null}
          {failed ? ' · not sent' : null}
        </span>
        {m.text ? (
          <div className="message-actions">
            <button
              type="button"
              className="btn-mini"
              onClick={() => void copyMessage(m.text)}
              title="Copy message"
            >
              Copy
            </button>
            {showRetry && onRetry ? (
              <button
                type="button"
                className="btn-mini"
                onClick={() => onRetry(m.id)}
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
            ) : a.kind === 'image' && a.path ? (
              // A restored image. Its bytes are parked under the data directory
              // rather than carried in the transcript, so it loads the same way
              // every other local image in the app does.
              <LocalImage key={a.id} image={{ path: a.path, label: a.name }} compact />
            ) : (
              <span key={a.id} className="msg-attach-chip">
                {a.name}
              </span>
            )
          )}
        </div>
      ) : null}

      {m.thought ? <ThoughtBlock text={m.thought} /> : null}

      {/*
       * Index keys are safe here and nowhere else in this file: segments
       * are derived from an append-only list, so segment 2 stays segment 2
       * for the life of the message and only the last one ever grows.
       */}
      {segments.map((seg, i) =>
        seg.kind === 'tools' ? (
          <ToolActivity
            key={`seg-${i}`}
            tools={seg.tools}
            // A prior turn still marked in_progress after a later message
            // exists should not keep pulsing "Using SHELL" forever.
            demoteLive={demoteLive}
          />
        ) : (
          <MessageTextSegment
            key={`seg-${i}`}
            text={seg.text}
            role={m.role}
            suppressImagePaths={suppressImagePaths}
            showCaret={!!m.streaming && seg === last}
          />
        )
      )}

      {/*
       * Nothing to type into yet: the turn is open but the newest thing in
       * it is a tool call, or it has produced nothing at all. The caret
       * gets its own bubble so the turn still shows it is live.
       */}
      {m.streaming && (!last || last.kind !== 'text') ? (
        <div className="bubble streaming-caret" />
      ) : null}

      {/*
       * The glance layer, attached to the turn that spawned the work
       * rather than to a global strip: scrolling back to a turn brings its
       * agents with it, and there is nothing to dismiss. Renders nothing
       * when a message spawned no agents, which is most of them.
       */}
      {m.toolCalls?.length ? (
        <AgentDots tools={m.toolCalls} demoteLive={demoteLive} />
      ) : null}

      {failed && m.error ? (
        <div className="msg-send-error" title={m.error}>
          {m.error}
        </div>
      ) : null}
    </div>
  )
})

export function MessageList({ messages, onRetry, canRetry }: Props) {
  return (
    <div className="chat-inner">
      {messages.map((m, idx) => (
        <MessageRow
          key={m.id}
          message={m}
          demoteLive={idx < messages.length - 1 && !m.streaming}
          showRetry={shouldShowRetry(messages, idx, canRetry) && !!onRetry}
          onRetry={onRetry}
        />
      ))}
    </div>
  )
}
