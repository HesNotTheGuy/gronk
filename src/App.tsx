import { Composer } from './components/Composer'
import { MessageList } from './components/MessageList'
import { PermissionModal } from './components/PermissionModal'
import { Sidebar } from './components/Sidebar'
import { useGrocky } from './hooks/useGrocky'

const HINTS = [
  'Map the architecture and main entry points',
  'Find the roughest edges and fix the top three',
  'Run the tests. If anything fails, make it green'
]

export function App() {
  const g = useGrocky()

  const statusClass =
    g.connection === 'ready'
      ? 'ready'
      : g.connection === 'starting'
        ? 'starting'
        : g.connection === 'error'
          ? 'error'
          : ''

  const statusLabel =
    g.connection === 'ready'
      ? 'ONLINE'
      : g.connection === 'starting'
        ? 'ARMING'
        : g.connection === 'error'
          ? 'FAULT'
          : g.connection === 'stopped'
            ? 'STOPPED'
            : 'STANDBY'

  return (
    <div className="app">
      <div className="grain" aria-hidden />
      <div className="scanline" aria-hidden />

      <Sidebar
        recentProjects={g.recentProjects}
        sessions={g.sessions}
        activeCwd={g.cwd}
        activeSessionId={g.sessionId}
        alwaysApprove={!!g.settings?.alwaysApprove}
        onOpenProject={(cwd) => void g.openProject(cwd)}
        onToggleAlwaysApprove={() => {
          void g.updateSettings({ alwaysApprove: !g.settings?.alwaysApprove })
        }}
        onNewChat={() => void g.openProject(g.cwd)}
      />

      <main className="main">
        <header className="topbar">
          <div className="topbar-left">
            <div className="topbar-kicker">Mission · Grok Build</div>
            <div className="topbar-title">
              {g.projectName || 'No payload selected'}
            </div>
            <div className="topbar-sub">
              {g.cwd || 'Select a project directory to initialize the agent'}
            </div>
          </div>
          <div className="topbar-actions">
            <div
              className={`status-pill ${statusClass}`}
              title={g.grokPath || 'grok binary not found'}
            >
              <span className="dot" />
              {statusLabel}
            </div>
          </div>
        </header>

        {g.error ? (
          <div className="error-banner">
            <span style={{ flex: 1 }}>{g.error}</span>
            <button
              type="button"
              className="btn btn-ghost"
              style={{ padding: '4px 8px' }}
              onClick={() => g.setError(null)}
            >
              Dismiss
            </button>
          </div>
        ) : null}

        <div className="chat" ref={g.scrollRef}>
          {g.messages.length === 0 ? (
            <div className="empty-state">
              <div className="empty-frame">
                <p className="empty-kicker">
                  {g.cwd ? 'Channel open' : 'Grocky · Desktop agent'}
                </p>
                <h2>
                  {g.cwd ? (
                    <>
                      What should we <span>build?</span>
                    </>
                  ) : (
                    <>
                      Build at the <span>speed of thought</span>
                    </>
                  )}
                </h2>
                <p className="empty-copy">
                  {g.cwd
                    ? 'Stream prompts to the local Grok agent. Tool calls land live. You stay on the auth gate for anything that matters.'
                    : 'A desktop shell for Grok Build — ACP over stdio, mission-control UI. Same agent. Less terminal cosplay.'}
                </p>

                {g.cwd ? (
                  <div className="hints">
                    {HINTS.map((h) => (
                      <button
                        key={h}
                        type="button"
                        className="hint"
                        onClick={() => void g.sendPrompt(h)}
                      >
                        {h}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="empty-actions">
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => void g.openProject()}
                    >
                      Open project
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => void g.openProject()}
                    >
                      Launch sequence
                    </button>
                  </div>
                )}

                <div className="telemetry-strip">
                  <span>
                    Link
                    <strong>{g.grokPath ? 'CLI' : '—'}</strong>
                  </span>
                  <span>
                    Transport
                    <strong>ACP / stdio</strong>
                  </span>
                  <span>
                    Mode
                    <strong>{g.settings?.alwaysApprove ? 'YOLO' : 'GATED'}</strong>
                  </span>
                  <span>
                    Session
                    <strong>{g.sessionId ? g.sessionId.slice(0, 8) : 'NONE'}</strong>
                  </span>
                </div>
              </div>
            </div>
          ) : (
            <MessageList messages={g.messages} />
          )}
        </div>

        <Composer
          disabled={g.connection !== 'ready'}
          busy={g.busy}
          onSend={(t) => void g.sendPrompt(t)}
          onCancel={() => void g.cancel()}
        />
      </main>

      {g.permission ? (
        <PermissionModal
          request={g.permission}
          onRespond={(d) => void g.respondPermission(d)}
        />
      ) : null}
    </div>
  )
}
