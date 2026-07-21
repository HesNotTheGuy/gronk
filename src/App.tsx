import { Composer } from './components/Composer'
import { MessageList } from './components/MessageList'
import { PermissionModal } from './components/PermissionModal'
import { SettingsPanel } from './components/SettingsPanel'
import { Sidebar } from './components/Sidebar'
import { YoloConfirm } from './components/YoloConfirm'
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
      : g.connection === 'starting' || g.connection === 'loading'
        ? 'starting'
        : g.connection === 'error'
          ? 'error'
          : ''

  const statusLabel =
    g.connection === 'ready'
      ? 'ONLINE'
      : g.connection === 'starting'
        ? 'ARMING'
        : g.connection === 'loading'
          ? 'RESTORE'
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
        alwaysApprove={g.yoloActive}
        models={g.models}
        currentModel={g.settings?.model}
        onOpenProject={(cwd) => void g.openProject(cwd)}
        onSelectSession={(s) => void g.selectSession(s)}
        onToggleAlwaysApprove={() => {
          if (g.yoloActive) {
            void g.updateSettings({ alwaysApprove: false })
          } else {
            void g.updateSettings({ alwaysApprove: true })
          }
        }}
        onNewChat={() => void g.newChat()}
        onOpenSettings={() => g.setShowSettings(true)}
        onChangeModel={(id) => void g.changeModel(id)}
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
            {g.settings?.model ? (
              <div className="status-pill model-pill" title="Active model">
                {g.settings.model}
              </div>
            ) : null}
            <div
              className={`status-pill ${statusClass}`}
              title={g.grokPath || 'grok binary not found'}
            >
              <span className="dot" />
              {statusLabel}
            </div>
          </div>
        </header>

        {g.yoloActive ? (
          <div className="yolo-banner">
            BYPASS PERMISSIONS ACTIVE — agent tools auto-approve. Turn off in sidebar when done.
          </div>
        ) : null}

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

        {g.historySource && g.historySource !== 'empty' ? (
          <div className="history-banner">
            Transcript restored ({g.historySource}
            {g.historySource === 'local' ? ' cache' : ''})
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
                    : 'A desktop shell for Grok Build — ACP over stdio. Session restore, model picker, and gated permissions. Zero extra npm deps for this phase.'}
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
                    <strong>{g.yoloActive ? 'YOLO' : 'GATED'}</strong>
                  </span>
                  <span>
                    Model
                    <strong>{g.settings?.model || 'default'}</strong>
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
          busy={g.busy || g.connection === 'loading'}
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

      {g.showYoloConfirm ? (
        <YoloConfirm
          onConfirm={() => void g.confirmYolo()}
          onCancel={g.cancelYolo}
        />
      ) : null}

      <SettingsPanel
        open={g.showSettings}
        settings={g.settings}
        models={g.models}
        grokPath={g.grokPath}
        audit={g.audit}
        onClose={() => g.setShowSettings(false)}
        onChangeModel={(id) => void g.changeModel(id)}
        onToggleYolo={() => {
          if (g.yoloActive) void g.updateSettings({ alwaysApprove: false })
          else void g.updateSettings({ alwaysApprove: true })
        }}
      />
    </div>
  )
}
