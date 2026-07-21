import type { ChatMessage } from '../../shared/types'
import { Markdown } from './Markdown'
import { ToolCard } from './ToolCard'

export function MessageList({ messages }: { messages: ChatMessage[] }) {
  return (
    <div className="chat-inner">
      {messages.map((m) => (
        <div key={m.id} className={`message ${m.role}`}>
          <div className="message-role">
            {m.role === 'user' ? 'Operator' : m.role === 'assistant' ? 'Grok' : 'System'}
          </div>

          {m.thought ? (
            <div className="thought">
              <span style={{ color: 'var(--ink-4)', marginRight: 8 }}>THINK</span>
              {m.thought}
            </div>
          ) : null}

          {m.toolCalls && m.toolCalls.length > 0 ? (
            <div className="tool-list">
              {m.toolCalls.map((t) => (
                <ToolCard key={t.toolCallId} tool={t} />
              ))}
            </div>
          ) : null}

          {(m.text || m.streaming) && (
            <div className={`bubble ${m.streaming && !m.text ? 'streaming-caret' : ''}`}>
              {m.role === 'assistant' ? (
                <Markdown text={m.text || (m.streaming ? '' : '')} />
              ) : (
                m.text
              )}
              {m.streaming && m.text ? <span className="streaming-caret" /> : null}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
