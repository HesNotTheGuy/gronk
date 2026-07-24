import { useEffect, useState } from 'react'
import { AuthGate } from './components/AuthGate'
import { ChatHome } from './components/ChatHome'
import { Composer } from './components/Composer'
import { HomeView } from './components/HomeView'
import { MessageList } from './components/MessageList'
import { PermissionModal } from './components/PermissionModal'
import { PermissionModeBar } from './components/PermissionModeBar'
import { AgentFleetStrip } from './components/AgentFleet'
import { PlanPanel } from './components/PlanPanel'
import { ProjectHome } from './components/ProjectHome'
import { SettingsPanel } from './components/SettingsPanel'
import { Sidebar } from './components/Sidebar'
import { YoloConfirm } from './components/YoloConfirm'
import { useGrocky } from './hooks/useGrocky'
import type { LoginMethod } from '../shared/types'

const PROJECT_HINTS = [
  'Map the architecture and main entry points',
  'Find the roughest edges and fix the top three',
  'Run the tests. If anything fails, make it green'
]

const CHAT_HINTS = [
  'Explain something I am curious about',
  'Help me think through a decision',
  'What is interesting in the world today?'
]

export function App() {
  const g = useGrocky()
  const [showAuthModal, setShowAuthModal] = useState(false)

  const surface = g.surface
  /** Main pane is live conversation (not browse home) */
  const inConversation = !g.browsing && (surface === 'chat' || surface === 'project') && !!g.cwd
  const inChat = inConversation && surface === 'chat'
  const inProject = inConversation && surface === 'project'

  useEffect(() => {
    if (g.auth && !g.auth.authenticated) {
      setShowAuthModal(true)
    }
  }, [g.auth?.authenticated, g.auth?.state])

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

  const requireAuth = (fn: () => void) => {
    if (!g.isAuthenticated) {
      setShowAuthModal(true)
      return
    }
    fn()
  }

  const openProject = (cwd?: string | null) => {
    requireAuth(() => void g.openProject(cwd))
  }

  const openChat = () => {
    requireAuth(() => void g.openChat())
  }

  const handleLogin = async (method: LoginMethod) => {
    const result = await g.login(method)
    if (result?.ok) setShowAuthModal(false)
  }

  const hints = inChat ? CHAT_HINTS : PROJECT_HINTS

  return (
    <div className="app">
      <Sidebar
        alwaysApprove={g.yoloActive}
        models={g.models}
        currentModel={g.settings?.model}
        authLabel={g.auth?.accountLabel}
        authenticated={g.isAuthenticated}
        permissionMode={g.permissionMode}
        surface={surface}
        inConversation={inConversation}
        projects={g.recentProjects}
        projectSessions={g.projectOnlySessions}
        chatSessions={g.chatSessions}
        activeCwd={g.cwd}
        activeSessionId={g.sessionId}
        onGoHome={() => g.goHome()}
        onGoChat={() => g.goChat()}
        onGoProjects={() => g.goProjects()}
        onOpenProject={(cwd) => openProject(cwd)}
        onOpenChat={openChat}
        onSelectSession={(s) => void g.selectSession(s)}
        onNewProjectSession={() => void g.newChat()}
        onToggleAlwaysApprove={() => {
          if (g.yoloActive) {
            void g.updateSettings({ alwaysApprove: false, permissionMode: 'default' })
          } else {
            void g.updateSettings({ alwaysApprove: true })
          }
        }}
        onChangePermissionMode={(mode) => void g.changePermissionMode(mode)}
        onOpenSettings={() => g.setShowSettings(true)}
        onChangeModel={(id) => void g.changeModel(id)}
        onLogout={() => void g.logout()}
        onSignIn={() => setShowAuthModal(true)}
      />

      <main className="main">
        <header className="topbar">
          <div className="topbar-left">
            <div className="topbar-kicker">
              {surface === 'home' ? 'Home' : surface === 'chat' ? 'Chat' : 'Build'}
            </div>
            <div className="topbar-title">
              {surface === 'home'
                ? 'Grocky'
                : surface === 'chat'
                  ? g.browsing
                    ? 'Your chats'
                    : 'Chat with Grok'
                  : g.browsing
                    ? 'Folders & sessions'
                    : g.projectName || 'Folder'}
            </div>
            <div className="topbar-sub">
              {surface === 'home'
                ? 'Chat is app-wide · Build is Grok working in a folder on your computer'
                : surface === 'chat' && g.browsing
                  ? 'App-level chats — no project folder required'
                  : surface === 'project' && g.browsing
                    ? 'Open a folder for the coding agent, or resume a session'
                    : surface === 'chat'
                      ? 'General conversation · saved in the app'
                      : g.cwd || ''}
            </div>
          </div>
          <div className="topbar-actions">
            {inConversation ? (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => (surface === 'chat' ? g.goChat() : g.goProjects())}
              >
                ← Back
              </button>
            ) : null}
            {g.isAuthenticated && g.auth?.accountLabel ? (
              <div className="status-pill auth-pill" title="Signed-in account (CLI)">
                {g.auth.accountLabel}
              </div>
            ) : (
              <button
                type="button"
                className="status-pill"
                onClick={() => setShowAuthModal(true)}
              >
                Sign in
              </button>
            )}
            {inConversation && g.settings?.model ? (
              <div className="status-pill model-pill" title="Active model">
                {g.settings.model}
              </div>
            ) : null}
            {inConversation ? (
              <div
                className={`status-pill ${statusClass}`}
                title={g.grokPath || 'grok binary not found'}
              >
                <span className="dot" />
                {statusLabel}
              </div>
            ) : null}
          </div>
        </header>

        {inProject ? (
          <div className="mode-toolbar">
            <PermissionModeBar
              mode={g.permissionMode}
              compact
              disabled={!g.isAuthenticated}
              onChange={(mode) => void g.changePermissionMode(mode)}
            />
          </div>
        ) : null}

        {g.yoloActive && inProject ? (
          <div className="yolo-banner">
            BYPASS PERMISSIONS ACTIVE — agent tools auto-approve. Switch mode or turn off YOLO.
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

        {g.historySource && g.historySource !== 'empty' && inConversation ? (
          <div className="history-banner">
            Transcript restored ({g.historySource}
            {g.historySource === 'local' ? ' cache' : ''})
          </div>
        ) : null}

        {surface === 'home' ? (
          <HomeView
            projects={g.recentProjects}
            sessions={g.projectOnlySessions}
            authenticated={g.isAuthenticated}
            authLabel={g.auth?.accountLabel}
            grokFound={!!g.grokPath || !!g.health?.grokFound}
            model={g.settings?.model}
            onOpenChat={() => g.goChat()}
            onOpenProjects={() => g.goProjects()}
            onOpenProject={(cwd) => openProject(cwd)}
            onSelectSession={(s) => void g.selectSession(s)}
            onRenameSession={(id, t) => void g.renameSession(id, t)}
            onArchiveSession={(id) => void g.archiveSession(id)}
            onDeleteSession={(id) => void g.deleteSession(id)}
            onSignIn={() => setShowAuthModal(true)}
            onSettings={() => g.setShowSettings(true)}
          />
        ) : surface === 'chat' && g.browsing ? (
          <ChatHome
            sessions={g.chatSessions}
            activeSessionId={g.sessionId}
            authenticated={g.isAuthenticated}
            onNewChat={openChat}
            onSelectSession={(s) => void g.selectSession(s)}
            onRename={(id, t) => void g.renameSession(id, t)}
            onArchive={(id) => void g.archiveSession(id)}
            onDelete={(id) => void g.deleteSession(id)}
            onSignIn={() => setShowAuthModal(true)}
          />
        ) : surface === 'project' && g.browsing ? (
          <ProjectHome
            projects={g.recentProjects}
            sessions={g.projectOnlySessions}
            activeCwd={g.cwd}
            activeSessionId={g.sessionId}
            authenticated={g.isAuthenticated}
            onOpenFolder={() => openProject()}
            onOpenProject={(cwd) => openProject(cwd)}
            onSelectSession={(s) => void g.selectSession(s)}
            onRename={(id, t) => void g.renameSession(id, t)}
            onArchive={(id) => void g.archiveSession(id)}
            onDelete={(id) => void g.deleteSession(id)}
            onSignIn={() => setShowAuthModal(true)}
          />
        ) : (
          <div className="chat-workspace">
            <div className="chat" ref={g.scrollRef}>
              {g.messages.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-frame">
                    <p className="empty-kicker">
                      {inChat ? 'Chat · Grok CLI' : 'Project agent · ACP'}
                    </p>
                    <h2>
                      {inChat ? (
                        <>
                          What&apos;s on your <span>mind?</span>
                        </>
                      ) : (
                        <>
                          What should we <span>build?</span>
                        </>
                      )}
                    </h2>
                    <p className="empty-copy">
                      {inChat
                        ? 'General conversation with Grok — same account as the CLI.'
                        : 'Stream prompts to the local Grok agent. Tools and permissions stay under your control.'}
                    </p>
                    <div className="hints">
                      {hints.map((h) => (
                        <button
                          key={h}
                          type="button"
                          className="hint"
                          disabled={g.connection !== 'ready'}
                          onClick={() => void g.sendPrompt(h)}
                        >
                          {h}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <MessageList
                  messages={g.messages}
                  canRetry={g.connection === 'ready' && !g.busy}
                  onRetry={(id) => void g.retryPrompt(id)}
                />
              )}
            </div>

            {inProject ? (
              <PlanPanel
                plan={
                  g.activePlan && g.sessionId && g.activePlan.sessionId === g.sessionId
                    ? g.activePlan
                    : null
                }
                collapsed={g.planCollapsed}
                onToggle={() => g.setPlanCollapsed(!g.planCollapsed)}
              />
            ) : null}

            {inConversation ? <AgentFleetStrip messages={g.messages} /> : null}

            <Composer
              disabled={g.connection !== 'ready'}
              busy={g.busy || g.connection === 'loading'}
              cwd={inChat ? null : g.cwd}
              onSend={(t, atts) => void g.sendPrompt(t, atts)}
              onCancel={() => void g.cancel()}
              onOpenFolder={(path) => openProject(path)}
            />
          </div>
        )}
      </main>

      {showAuthModal ? (
        <div className="auth-overlay" role="dialog" aria-modal="true">
          <AuthGate
            auth={g.auth}
            busy={g.authBusy}
            deviceHint={g.deviceHint}
            message={g.authMessage}
            grokFound={!!g.grokPath || !!g.health?.grokFound}
            onLogin={(m) => void handleLogin(m)}
            onRefresh={() => void g.refreshAuth()}
            onOpenSettings={() => {
              setShowAuthModal(false)
              g.setShowSettings(true)
            }}
          />
          {g.isAuthenticated ? (
            <button
              type="button"
              className="btn btn-primary auth-dismiss"
              onClick={() => setShowAuthModal(false)}
            >
              Continue to app
            </button>
          ) : null}
        </div>
      ) : null}

      {g.permission ? (
        <PermissionModal
          request={g.permission}
          onRespond={(d) => void g.respondPermission(d)}
        />
      ) : null}

      {g.showYoloConfirm ? (
        <YoloConfirm onConfirm={() => void g.confirmYolo()} onCancel={g.cancelYolo} />
      ) : null}

      <SettingsPanel
        open={g.showSettings}
        settings={g.settings}
        models={g.models}
        grokPath={g.grokPath}
        audit={g.audit}
        health={g.health}
        auth={g.auth}
        authBusy={g.authBusy}
        onClose={() => g.setShowSettings(false)}
        onChangeModel={(id) => void g.changeModel(id)}
        onToggleYolo={() => {
          if (g.yoloActive) void g.updateSettings({ alwaysApprove: false })
          else void g.updateSettings({ alwaysApprove: true })
        }}
        onChangeTheme={(theme) => void g.updateSettings({ theme })}
        onPickBinary={() => void g.pickBinary()}
        onClearBinary={() => void g.clearBinary()}
        onRefreshHealth={() => void g.refreshHealth()}
        onLogin={(m) => void g.login(m)}
        onLogout={() => void g.logout()}
        onChangePermissionMode={(mode) => void g.changePermissionMode(mode)}
      />
    </div>
  )
}
