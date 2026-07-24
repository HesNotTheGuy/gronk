import type { SessionInfo } from '../../shared/types'
import { sessionFrequencyLabel, sessionHeat } from '../lib/activity'
import { SessionCard } from './SessionCard'

interface Props {
  sessions: SessionInfo[]
  activeSessionId: string | null
  authenticated: boolean
  onNewChat: () => void
  onSelectSession: (s: SessionInfo) => void
  onRename: (id: string, title: string) => void
  onArchive: (id: string) => void
  onDelete: (id: string) => void
  onSignIn: () => void
}

export function ChatHome({
  sessions,
  activeSessionId,
  authenticated,
  onNewChat,
  onSelectSession,
  onRename,
  onArchive,
  onDelete,
  onSignIn
}: Props) {
  return (
    <div className="browse-home">
      <div className="browse-hero">
        <p className="home-kicker">Chat</p>
        <h1>
          Talk with <span>Grok</span>
        </h1>
        <p className="home-copy">
          App-level chats with Grok — no project folder. History stays in Grocky; same account as the
          CLI, not a website wrap.
        </p>
        <div className="home-actions">
          {authenticated ? (
            <button type="button" className="btn btn-primary" onClick={onNewChat}>
              New chat
            </button>
          ) : (
            <button type="button" className="btn btn-primary" onClick={onSignIn}>
              Sign in to chat
            </button>
          )}
        </div>
      </div>

      <div className="browse-panel">
        <div className="browse-panel-head">
          <div className="section-label">Previous chats</div>
          <span className="browse-count">{sessions.length}</span>
        </div>
        {sessions.length === 0 ? (
          <div className="browse-empty">
            No chats yet. Start one — it will show up here to resume later.
          </div>
        ) : (
          <div className="browse-grid">
            {sessions.map((s) => (
              <div key={s.id} className="activity-session-wrap">
                <SessionCard
                  session={s}
                  active={s.id === activeSessionId}
                  onSelect={() => onSelectSession(s)}
                  onRename={(t) => onRename(s.id, t)}
                  onArchive={() => onArchive(s.id)}
                  onDelete={() => onDelete(s.id)}
                />
                <div className="activity-row under-card">
                  <div className="activity-bar" aria-hidden>
                    <div
                      className="activity-fill"
                      style={{ width: `${Math.round(sessionHeat(s) * 100)}%` }}
                    />
                  </div>
                  <div className="activity-label">{sessionFrequencyLabel(s)}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
