import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AuthGate } from './components/AuthGate'
import { ChatHome } from './components/ChatHome'
import { Composer } from './components/Composer'
import { HomeView } from './components/HomeView'
import { MessageList } from './components/MessageList'
import { PermissionModal } from './components/PermissionModal'
import { AgentFleetStrip } from './components/AgentFleet'
import { PlanPanel } from './components/PlanPanel'
import { ProjectHome } from './components/ProjectHome'
import { PluginsPanel } from './components/PluginsPanel'
import { SessionCard } from './components/SessionCard'
import { SettingsPanel } from './components/SettingsPanel'
import { Sidebar } from './components/Sidebar'
import { YoloConfirm } from './components/YoloConfirm'
import { CliInstall } from './components/CliInstall'
import { PreviewPane } from './components/PreviewPane'
import { UsageMeter } from './components/UsageMeter'
import { useGronk } from './hooks/useGronk'
import { folderName, isChatSession } from '../shared/path'
import type { LoginMethod, SessionInfo } from '../shared/types'

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
  const g = useGronk()
  const [showAuthModal, setShowAuthModal] = useState(false)
  const [showPlugins, setShowPlugins] = useState(false)
  const [exportMenuOpen, setExportMenuOpen] = useState(false)
  /**
   * Viewport coords for the portalled Export menu. The menu cannot live inside
   * .topbar: that header sets backdrop-filter, which makes it the containing
   * block for fixed-position descendants, so the dismiss layer's `inset: 0`
   * would resolve against the header strip instead of the viewport.
   */
  const [exportMenuPos, setExportMenuPos] = useState<{ top: number; right: number } | null>(null)
  const exportBtnRef = useRef<HTMLButtonElement | null>(null)

  const surface = g.surface
  /** Main pane is live conversation (not browse home) */
  const inConversation = !g.browsing && (surface === 'chat' || surface === 'project') && !!g.cwd
  const inChat = inConversation && surface === 'chat'
  const inProject = inConversation && surface === 'project'

  /**
   * The Export menu portals out of .app, so it would otherwise float above a
   * modal and its Escape handler would compete with the modal's. Closing it
   * when a modal takes over keeps Escape unambiguous.
   */
  const blockingModalOpen =
    showAuthModal ||
    showPlugins ||
    !!g.permission ||
    g.showYoloConfirm ||
    g.showArchived ||
    g.showSettings ||
    g.showCliInstall

  useEffect(() => {
    if (g.auth && !g.auth.authenticated) {
      setShowAuthModal(true)
    }
  }, [g.auth?.authenticated, g.auth?.state])

  // The Export popover belongs to one session — never reopen it on the next one
  useEffect(() => {
    setExportMenuOpen(false)
  }, [g.sessionId, surface, g.browsing, blockingModalOpen])

  // Escape closes the menu; resize invalidates the coords it was placed with.
  useEffect(() => {
    if (!exportMenuOpen) return
    const onKey = (e: KeyboardEvent) => {
      // No preventDefault/stopPropagation — anything else listening for Escape
      // (modals, the composer) must still see the same keystroke.
      if (e.key === 'Escape') setExportMenuOpen(false)
    }
    const onReflow = () => setExportMenuOpen(false)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onReflow)
    return () => {
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onReflow)
    }
  }, [exportMenuOpen])

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

  const exportCurrent = (format: 'md' | 'json') => {
    setExportMenuOpen(false)
    if (g.sessionId) void g.exportSession(g.sessionId, format)
  }

  const toggleExportMenu = () => {
    if (exportMenuOpen) {
      setExportMenuOpen(false)
      return
    }
    const r = exportBtnRef.current?.getBoundingClientRect()
    if (!r) return
    // Right-anchored so the menu hangs under the button, never off-screen
    setExportMenuPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) })
    setExportMenuOpen(true)
  }

  /** Opening an archived session is how you say "I want this back". */
  const openArchived = async (s: SessionInfo) => {
    await g.unarchiveSession(s.id)
    g.setShowArchived(false)
    await g.selectSession(s)
  }

  const hints = inChat ? CHAT_HINTS : PROJECT_HINTS

  return (
    <div className="app">
      <Sidebar
        alwaysApprove={g.yoloActive}
        authLabel={g.auth?.accountLabel}
        authenticated={g.isAuthenticated}
        surface={surface}
        inConversation={inConversation}
        browsing={g.browsing}
        projects={g.recentProjects}
        projectSessions={g.projectOnlySessions}
        chatSessions={g.chatSessions}
        activeCwd={g.cwd}
        activeSessionId={g.sessionId}
        archivedCount={g.archivedSessions.length}
        onGoHome={() => g.goHome()}
        onGoChat={() => g.goChat()}
        onGoProjects={() => g.goProjects()}
        onOpenProject={(cwd) => openProject(cwd)}
        onOpenChat={openChat}
        onSelectSession={(s) => void g.selectSession(s)}
        onNewProjectSession={() => void g.newChat()}
        onOpenArchived={() => g.setShowArchived(true)}
        onToggleAlwaysApprove={() => {
          if (g.yoloActive) {
            void g.updateSettings({ alwaysApprove: false, permissionMode: 'default' })
          } else {
            void g.updateSettings({ alwaysApprove: true })
          }
        }}
        onOpenSettings={() => g.setShowSettings(true)}
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
                ? 'Gronk'
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
            {inProject ? (
              <button
                type="button"
                className={`btn btn-sm preview-toggle ${g.previewRunning ? 'btn-danger' : 'btn-ghost'}`}
                onClick={() => g.togglePreview()}
                title={g.previewRunning ? 'Stop the dev server + preview' : 'Run the dev server + open preview'}
              >
                {g.previewRunning ? '■ Preview' : '▶ Preview'}
              </button>
            ) : null}
            {inConversation && g.sessionId ? (
              <>
                <button
                  ref={exportBtnRef}
                  type="button"
                  className="btn btn-ghost btn-sm"
                  aria-haspopup="menu"
                  aria-expanded={exportMenuOpen}
                  onClick={toggleExportMenu}
                  title="Save this transcript to a file"
                >
                  Export
                </button>
                {exportMenuOpen && exportMenuPos
                  ? createPortal(
                      <>
                        <button
                          type="button"
                          className="session-menu-backdrop"
                          aria-label="Close export menu"
                          onClick={() => setExportMenuOpen(false)}
                        />
                        <div
                          className="session-menu session-menu-floating"
                          role="menu"
                          style={{ top: exportMenuPos.top, right: exportMenuPos.right }}
                        >
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => exportCurrent('md')}
                          >
                            <span className="session-menu-ico">↧</span>
                            Markdown
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => exportCurrent('json')}
                          >
                            <span className="session-menu-ico">↧</span>
                            JSON
                          </button>
                        </div>
                      </>,
                      document.body
                    )
                  : null}
              </>
            ) : null}
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

        {/*
          Not gated on `inProject`. yoloActive is a global setting, so hiding
          the banner on Chat meant bypass could be on, and passed to the agent,
          with nothing on screen saying so. A safety indicator that is only
          sometimes shown is worse than none, because its absence reads as safe.
        */}
        {g.yoloActive ? (
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

        {g.storeHealth ? (
          <div className="export-banner store-health-banner" role="alert">
            <div className="export-banner-text">
              <span className="export-banner-label">
                {g.storeHealth.source === 'backup'
                  ? 'Sessions restored from backup'
                  : 'Saved sessions could not be read'}
              </span>
              {/*
                Say which file, so the user can rescue it by hand. The store never
                deletes an unreadable file — an empty session list with no
                explanation is exactly what a wiped install looks like, and that
                ambiguity is the whole reason this banner exists.
              */}
              <span className="export-banner-path">
                {g.storeHealth.message ||
                  'The transcript store on disk was unreadable. Nothing has been deleted.'}
              </span>
              {g.storeHealth.corruptPath ? (
                <code className="path-code">{g.storeHealth.corruptPath}</code>
              ) : null}
            </div>
            <div className="btn-row export-banner-actions">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => g.dismissStoreHealth()}
              >
                Dismiss
              </button>
            </div>
          </div>
        ) : null}

        {g.exportNotice ? (
          <div className="export-banner">
            <div className="export-banner-text">
              <span className="export-banner-label">
                Transcript saved as {g.exportNotice.format === 'json' ? 'JSON' : 'Markdown'}
              </span>
              <code className="path-code export-banner-path">{g.exportNotice.path}</code>
              {g.exportNotice.revealError ? (
                <span className="export-banner-warn">
                  Could not open the folder ({g.exportNotice.revealError}) — the path above
                  is where the file went.
                </span>
              ) : null}
              {g.exportNotice.copyError ? (
                <span className="export-banner-warn">
                  Could not copy ({g.exportNotice.copyError}) — select the path above instead.
                </span>
              ) : null}
            </div>
            <div className="export-banner-actions">
              {/* Copy is primary because it always works. Reveal only succeeds for
                  paths inside the app's allowed roots, and the save dialog defaults
                  to Documents, which is outside them — so it stays a ghost. */}
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => void g.copyExportPath()}
              >
                {g.exportNotice.copied ? 'Copied' : 'Copy path'}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => void g.revealExport()}
                title="Open the containing folder"
              >
                Show in folder
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => g.dismissExport()}
              >
                Dismiss
              </button>
            </div>
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
            onNewSession={(cwd) =>
              requireAuth(() => void g.openProject(cwd, { forceNew: true }))
            }
            onSelectSession={(s) => void g.selectSession(s)}
            onRename={(id, t) => void g.renameSession(id, t)}
            onArchive={(id) => void g.archiveSession(id)}
            onExport={(id, format) => void g.exportSession(id, format)}
            onDelete={(id) => void g.deleteSession(id)}
            onSignIn={() => setShowAuthModal(true)}
          />
        ) : (
          <div className="conv-row">
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

            {/* Directly above the composer: in view whenever the user is about to
                spend more, and it renders nothing until a turn has completed, so
                it never greets an empty session. */}
            {inConversation ? <UsageMeter usage={g.usage} /> : null}

            <Composer
              disabled={g.connection !== 'ready'}
              busy={g.busy || g.connection === 'loading'}
              cwd={inChat ? null : g.cwd}
              models={g.models}
              currentModel={g.settings?.model}
              onChangeModel={(id) => void g.changeModel(id)}
              permissionMode={g.permissionMode}
              onChangeMode={(m) => void g.changePermissionMode(m)}
              showMode={inProject}
              onSend={(t, atts) => void g.sendPrompt(t, atts)}
              onCancel={() => void g.cancel()}
              onOpenFolder={(path) => openProject(path)}
            />
          </div>
          {g.previewRunning && inProject ? (
            <PreviewPane
              url={g.previewUrl}
              error={g.previewError}
              onStop={() => void g.stopPreview()}
            />
          ) : null}
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
            onInstallCli={() => {
              g.setCliInstallResult(null)
              g.setShowCliInstall(true)
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

      {g.showArchived ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Archived sessions">
          <div className="modal archived-modal">
            <div className="settings-modal-head">
              <h3>Archived</h3>
              <button
                type="button"
                className="btn-mini settings-close"
                onClick={() => g.setShowArchived(false)}
              >
                Close
              </button>
            </div>
            <p>
              Archived sessions are kept out of the Chat and Build lists. Restore one to put it
              back — opening it restores it too.
            </p>
            {g.archivedSessions.length === 0 ? (
              <div className="browse-empty">Nothing archived.</div>
            ) : (
              <div className="archived-list">
                {g.archivedSessions.map((s) => (
                  <SessionCard
                    key={s.id}
                    session={s}
                    subtitle={
                      isChatSession(s, g.chatWorkspacePath) ? 'Chat' : folderName(s.cwd)
                    }
                    onSelect={() => void openArchived(s)}
                    onRename={(t) => void g.renameSession(s.id, t)}
                    onUnarchive={() => void g.unarchiveSession(s.id)}
                    onExport={(format) => void g.exportSession(s.id, format)}
                    onDelete={() => void g.deleteSession(s.id)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      ) : null}

      <CliInstall
        open={g.showCliInstall}
        platform={window.gronk.platform}
        installing={g.cliInstalling}
        result={g.cliInstallResult}
        onInstall={() => void g.installCli()}
        onClose={() => {
          g.setShowCliInstall(false)
          g.setCliInstallResult(null)
        }}
      />

      <SettingsPanel
        open={g.showSettings}
        settings={g.settings}
        models={g.models}
        grokPath={g.grokPath}
        audit={g.audit}
        health={g.health}
        auth={g.auth}
        authBusy={g.authBusy}
        dataLocation={g.dataLocation}
        dataBusy={g.dataBusy}
        dataError={g.dataError}
        dataNotice={g.dataNotice}
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
        onChooseDataDir={() => g.chooseDataDir()}
        onMoveDataDir={(target) => void g.moveDataDir(target)}
        onResetDataDir={() => void g.resetDataDir()}
        onChangePermissionMode={(mode) => void g.changePermissionMode(mode)}
        onOpenPlugins={() => setShowPlugins(true)}
      />

      <PluginsPanel
        open={showPlugins}
        installed={g.installedPlugins}
        available={g.availablePlugins}
        marketplaces={g.marketplaces}
        mcpServers={g.mcpServers}
        loading={g.pluginsLoading}
        error={g.pluginsError}
        busyName={g.pluginBusy}
        onClose={() => setShowPlugins(false)}
        onRefresh={() => void g.refreshPlugins()}
        onLoadCatalog={() => void g.loadPluginCatalog()}
        onInstall={(source, trust) => void g.installPlugin(source, trust)}
        onEnable={(name) => void g.enablePlugin(name)}
        onDisable={(name) => void g.disablePlugin(name)}
        onUninstall={(name) => void g.uninstallPlugin(name)}
        onAddMcp={(input) => void g.addMcpServer(input)}
        onRemoveMcp={(name) => void g.removeMcpServer(name)}
      />
    </div>
  )
}
