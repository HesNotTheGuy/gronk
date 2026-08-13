import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AuthGate } from './components/AuthGate'
import { ChatHome } from './components/ChatHome'
import { CommandPalette, type PaletteAction } from './components/CommandPalette'
import { Composer } from './components/Composer'
import { HomeView } from './components/HomeView'
import { MessageList } from './components/MessageList'
import { OnboardingChecklist } from './components/OnboardingChecklist'
import { PermissionModal } from './components/PermissionModal'
import { ChatSkeleton } from './components/ChatSkeleton'
import { SessionTray } from './components/SessionTray'
import { ProjectHome } from './components/ProjectHome'
import { PluginsPanel } from './components/PluginsPanel'
import { SessionCard } from './components/SessionCard'
import { SettingsPanel } from './components/SettingsPanel'
import { Sidebar } from './components/Sidebar'
import { StatusMenu } from './components/StatusMenu'
import { WhatsNew } from './components/WhatsNew'
import { YoloConfirm } from './components/YoloConfirm'
import { decideWhatsNew } from './lib/whats-new'
import { hasGotGoing } from './lib/explainer'
import { CliInstall } from './components/CliInstall'
import { PaneSplitter } from './components/PaneSplitter'
import { PreviewPane } from './components/PreviewPane'

import { useGronk } from './hooks/useGronk'
import { useActivityCalendar } from './hooks/useActivityCalendar'
import { folderName, isChatSession } from '../shared/path'
import { formatDayLabel } from './lib/calendar'
import type { LoginMethod, SessionInfo } from '../shared/types'

const ONBOARD_HIDE_KEY = 'gronk.onboarding.hide'

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
  /**
   * Dismissed in this run. Separate from the stored version because the record is written
   * asynchronously — without it the panel stays up for a beat after "Got it", which reads as
   * the button not working.
   */
  const [notesDismissed, setNotesDismissed] = useState(false)
  /** Stop explaining the app once they have actually used it. */
  const gotGoing = useMemo(
    () => hasGotGoing([...g.chatSessions, ...g.projectOnlySessions]),
    [g.chatSessions, g.projectOnlySessions]
  )
  const whatsNew = useMemo(() => {
    // Settings not loaded yet: deciding now would treat every launch as a first run and
    // record the current version, so the update after this one would show nothing.
    if (!g.settings) return { notes: [], record: null }
    return decideWhatsNew(__APP_VERSION__, g.settings.seenNotesVersion)
  }, [g.settings])

  /**
   * A first run records where it came in and shows nothing. Someone opening the app for the
   * first time wants the app, not a changelog — but the next update needs something to
   * compare against, so the silent record matters.
   */
  useEffect(() => {
    if (whatsNew.notes.length === 0 && whatsNew.record) void g.markNotesSeen(whatsNew.record)
  }, [whatsNew, g.markNotesSeen])
  /**
   * Lifted above Home so leaving the surface does not wipe the painted grid.
   * Refreshed only when Home becomes visible — getActivityCalendar re-reads up
   * to 50 transcripts, which activity.ts pays on a Home visit, not per turn.
   */
  const activityCalendar = useActivityCalendar()
  /**
   * Transient day filter from the heatmap. Not a SessionNavMode: Recent / By
   * project still apply on top. Cleared explicitly (chip) or by re-clicking the
   * same day. Not persisted — leaving and coming back should not trap you in a
   * day you forgot you picked.
   */
  const [selectedActivityDay, setSelectedActivityDay] = useState<string | null>(null)
  const [showAuthModal, setShowAuthModal] = useState(false)
  const [showPlugins, setShowPlugins] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [hideOnboarding, setHideOnboarding] = useState(() => {
    try {
      return localStorage.getItem(ONBOARD_HIDE_KEY) === '1'
    } catch {
      return false
    }
  })
  const [exportMenuOpen, setExportMenuOpen] = useState(false)
  /** Chat + composer only. Toggle with [ when not typing in a field. */
  const [focusMode, setFocusMode] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '[' || e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t?.closest('input, textarea, select, [contenteditable="true"]')) return
      e.preventDefault()
      setFocusMode((v) => !v)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  /**
   * Viewport coords for the portalled Export menu. The menu cannot live inside
   * .topbar: that header sets backdrop-filter, which makes it the containing
   * block for fixed-position descendants, so the dismiss layer's `inset: 0`
   * would resolve against the header strip instead of the viewport.
   */
  const [exportMenuPos, setExportMenuPos] = useState<{ top: number; right: number } | null>(null)
  const exportBtnRef = useRef<HTMLButtonElement | null>(null)

  /**
   * Preview width as a percentage, persisted so a resize survives a restart.
   * Percent rather than pixels: a fixed pixel split taken on a wide monitor
   * leaves no conversation at all on a narrow one.
   */
  const [previewPercent, setPreviewPercent] = useState<number>(() => {
    const raw = Number(localStorage.getItem('gronk.preview.percent'))
    return Number.isFinite(raw) && raw >= 20 && raw <= 75 ? raw : 44
  })
  useEffect(() => {
    try {
      localStorage.setItem('gronk.preview.percent', String(Math.round(previewPercent)))
    } catch {
      /* private mode, or storage full: the split just does not persist */
    }
  }, [previewPercent])

  const surface = g.surface
  /** Main pane is live conversation (not browse home) */
  const inConversation = !g.browsing && (surface === 'chat' || surface === 'project') && !!g.cwd
  const inChat = inConversation && surface === 'chat'
  const inProject = inConversation && surface === 'project'

  // Soft-refresh the calendar when Home is shown. Not on session catalog churn:
  // every completed turn would otherwise re-read every transcript.
  useEffect(() => {
    if (surface !== 'home') return
    void activityCalendar.refresh()
  }, [surface, activityCalendar.refresh])

  /** Day click on the heatmap: toggle if same day, else set, then show Build rail. */
  const selectActivityDay = (dayKey: string): void => {
    setSelectedActivityDay((prev) => (prev === dayKey ? null : dayKey))
    // Home's sidebar has no session list; Build does. Land there so the filter
    // is something the user can see without an extra hop.
    g.goProjects()
  }

  /**
   * Stable across App re-renders. An inline `(id) => void g.retryPrompt(id)`
   * is a new function every token and busts MessageRow memo for every row.
   */
  const onRetryPrompt = useCallback(
    (id: string) => {
      void g.retryPrompt(id)
    },
    [g.retryPrompt]
  )

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

  // The Export popover belongs to one session. Never reopen it on the next one.
  useEffect(() => {
    setExportMenuOpen(false)
  }, [g.sessionId, surface, g.browsing, blockingModalOpen])

  // Escape closes the menu; resize invalidates the coords it was placed with.
  useEffect(() => {
    if (!exportMenuOpen) return
    const onKey = (e: KeyboardEvent) => {
      // No preventDefault/stopPropagation here. Anything else listening for Escape
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
      ? 'Online'
      : g.connection === 'starting'
        ? 'Starting'
        : g.connection === 'loading'
          ? 'Restoring'
          : g.connection === 'error'
            ? 'Fault'
            : g.connection === 'stopped'
              ? 'Stopped'
              : 'Standby'

  const requireAuth = (fn: () => void) => {
    if (!g.isAuthenticated) {
      setShowAuthModal(true)
      return
    }
    fn()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const paletteActions = useMemo((): PaletteAction[] => {
    return [
      { id: 'home', label: 'Go to Home', hint: 'Surface', run: () => g.goHome() },
      { id: 'chat', label: 'Go to Chat', hint: 'Surface', run: () => g.goChat() },
      { id: 'build', label: 'Go to Build', hint: 'Surface', run: () => g.goProjects() },
      {
        id: 'new-chat',
        label: 'New chat',
        hint: 'Conversation',
        run: () => requireAuth(() => void g.openChat())
      },
      {
        id: 'add-project',
        label: 'Add project',
        hint: 'Build',
        run: () => requireAuth(() => void g.openProject())
      },
      {
        id: 'new-session',
        label: 'New session in current project',
        hint: 'Build',
        run: () => {
          if (g.cwd) void g.newChat()
          else requireAuth(() => void g.openProject())
        }
      },
      { id: 'settings', label: 'Settings', hint: 'Ctrl+,', run: () => g.setShowSettings(true) },
      { id: 'plugins', label: 'Plugins & skills', run: () => setShowPlugins(true) },
      {
        id: 'sign-in',
        label: g.isAuthenticated ? 'Account is signed in' : 'Sign in',
        run: () => setShowAuthModal(true)
      }
    ]
  }, [g, g.cwd, g.isAuthenticated])

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
    <div className={['app', focusMode ? 'focus-mode' : ''].filter(Boolean).join(' ')}>
      <Sidebar
        authLabel={g.auth?.accountLabel}
        authenticated={g.isAuthenticated}
        surface={surface}
        projects={g.recentProjects}
        projectSessions={g.projectOnlySessions}
        chatSessions={g.chatSessions}
        chatWorkspacePath={g.chatWorkspacePath}
        activeCwd={g.cwd}
        activeSessionId={g.sessionId}
        archivedCount={g.archivedSessions.length}
        activityDayFilter={selectedActivityDay}
        activityDayFilterLabel={
          selectedActivityDay ? formatDayLabel(selectedActivityDay) : null
        }
        onClearActivityDayFilter={() => setSelectedActivityDay(null)}
        onGoHome={() => g.goHome()}
        onGoChat={() => g.goChat()}
        onGoProjects={() => g.goProjects()}
        onOpenProject={(cwd) => openProject(cwd)}
        onOpenChat={openChat}
        onSelectSession={(s) => void g.selectSession(s)}
        onRenameSession={(id, t) => void g.renameSession(id, t)}
        onArchiveSession={(id) => void g.archiveSession(id)}
        onExportSession={(id, f) => void g.exportSession(id, f)}
        onDeleteSession={(id) => void g.deleteSession(id)}
        sessionLiveness={g.sessionLiveness}
        onStopSession={(id) => void g.stopSession(id)}
        onRemoveProject={(cwd) => void g.removeRecentProject(cwd)}
        onPinProject={(cwd, pinned) => void g.setRecentProjectPinned(cwd, pinned)}
        onOpenPlugins={() => setShowPlugins(true)}
        onNewProjectSession={() => void g.newChat()}
        onOpenArchived={() => g.setShowArchived(true)}
        onOpenSettings={() => g.setShowSettings(true)}
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
                    ? 'Your projects'
                    : g.projectName || 'Project'}
            </div>
            {/* Titled because the header no longer allows a selection: a long
                project path ellipsizes here and this is the only way left to
                read the whole of it. */}
            <div className="topbar-sub" title={surface === 'project' && !g.browsing ? g.cwd || undefined : undefined}>
              {/*
                One vocabulary everywhere. This line previously said "app-wide"
                while three other screens said "app-level", "general Grok" and
                "in the app" for the same idea, none of which name the thing a
                user actually wants to know: whether it touches their files.
              */}
              {/*
                The Home line explains what Chat and Build are, and it stops once the person
                has completed a turn — see `hasGotGoing`. On their tenth session they were
                still being told what Chat is, in the header, which on Windows is also most of
                the titlebar. Either it worked and they no longer need it, or it did not and a
                permanent line was never going to fix that.
              */}
              {surface === 'home'
                ? gotGoing
                  ? ''
                  : 'Chat is a conversation · Build gives Grok a folder to work in'
                : surface === 'chat' && g.browsing
                  ? 'Conversations with Grok. No project folder.'
                  : surface === 'project' && g.browsing
                    ? 'Pick a project for the coding agent, or resume a session'
                    : surface === 'chat'
                      ? 'A conversation, saved in the app. No project folder.'
                      : g.cwd || ''}
            </div>
          </div>
          <div className="topbar-actions">
            <button
              type="button"
              className={`btn btn-sm btn-ghost ${focusMode ? 'active' : ''}`}
              title="Focus mode: chat + composer only. Toggle with ["
              aria-pressed={focusMode}
              onClick={() => setFocusMode((v) => !v)}
            >
              {focusMode ? 'Exit focus' : 'Focus'}
            </button>
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
            <StatusMenu
              connection={g.connection}
              statusLabel={statusLabel}
              statusClass={statusClass}
              accountLabel={g.auth?.accountLabel}
              authenticated={g.isAuthenticated}
              /* Same reading as the composer's picker: this menu is only shown inside a
                 conversation, so it has to name that conversation's model rather than
                 what the next session would start with. */
              model={g.sessionModel ?? g.settings?.model}
              models={g.models}
              grokPath={g.grokPath}
              showModel={inConversation}
              onSignIn={() => setShowAuthModal(true)}
              onOpenSettings={() => g.setShowSettings(true)}
              /* Through changeModel, not a bare settings write. Writing the setting alone
                 left the running session on the old model while every picker claimed the
                 new one — the choice looked applied and nothing had happened. */
              onChangeModel={(id) => void g.changeModel(id, g.sessionModel)}
            />
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
            BYPASS PERMISSIONS ACTIVE. Agent tools auto-approve. Switch mode or turn off YOLO.
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
                deletes an unreadable file. An empty session list with no
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
                  Could not open the folder ({g.exportNotice.revealError}). The path above
                  is where the file went.
                </span>
              ) : null}
              {g.exportNotice.copyError ? (
                <span className="export-banner-warn">
                  Could not copy ({g.exportNotice.copyError}). Select the path above instead.
                </span>
              ) : null}
            </div>
            <div className="export-banner-actions">
              {/* Copy is primary because it always works. Reveal only succeeds for
                  paths inside the app's allowed roots, and the save dialog defaults
                  to Documents, which is outside them, so it stays a ghost. */}
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
          <>
            {!hideOnboarding ? (
              <OnboardingChecklist
                grokFound={!!g.grokPath || !!g.health?.grokFound}
                authenticated={g.isAuthenticated}
                hasProject={g.recentProjects.length > 0}
                onInstallCli={() => g.setShowCliInstall(true)}
                onSignIn={() => setShowAuthModal(true)}
                onOpenProject={() => openProject()}
                onDismiss={() => {
                  try {
                    localStorage.setItem(ONBOARD_HIDE_KEY, '1')
                  } catch {
                    /* ignore */
                  }
                  setHideOnboarding(true)
                }}
              />
            ) : null}
            <HomeView
              projects={g.recentProjects}
              sessions={g.projectOnlySessions}
              authenticated={g.isAuthenticated}
              authLabel={g.auth?.accountLabel}
              grokFound={!!g.grokPath || !!g.health?.grokFound}
              model={g.settings?.model}
              activityCalendar={activityCalendar}
              selectedActivityDay={selectedActivityDay}
              onSelectActivityDay={selectActivityDay}
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
          </>
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
              {g.hydrating && g.messages.length === 0 ? (
                <ChatSkeleton
                  label={
                    inChat ? 'Opening chat…' : 'Opening project and loading session…'
                  }
                />
              ) : g.messages.length === 0 ? (
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
                        ? 'General conversation with Grok, on the same account as the CLI.'
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
                <>
                  {g.hydrating ? (
                    <div className="hydrating-banner" role="status">
                      Connecting agent…
                    </div>
                  ) : null}
                  <MessageList
                    messages={g.messages}
                    canRetry={g.connection === 'ready' && !g.busy}
                    onRetry={onRetryPrompt}
                  />
                </>
              )}
            </div>

            {/*
              Plan, agents and usage share one thin rail above the composer.
              Stacking three full panels stole the chat; tabs expand one body.
            */}
            {inConversation ? (
              <SessionTray
                showPlan={inProject}
                sessionId={g.sessionId}
                plan={
                  g.activePlan && g.sessionId && g.activePlan.sessionId === g.sessionId
                    ? g.activePlan
                    : null
                }
                messages={g.messages}
                usage={g.usage}
                auth={g.auth}
                showChanges={inProject}
                notesCwd={inProject ? g.cwd : null}
                notes={g.projectNotes}
                onSaveNote={(cwd, note) => void g.setProjectNote(cwd, note)}
              />
            ) : null}

            <Composer
              connection={g.connection}
              hydrating={g.hydrating}
              draft={g.draft}
              draftKey={g.draftKey}
              onDraftChange={g.setDraft}
              onDraftSent={g.clearDraft}
              onQueue={g.enqueue}
              queued={g.queued}
              queueHeld={g.queueHeld}
              onRemoveQueued={g.removeQueued}
              busy={g.busy || g.connection === 'loading'}
              cwd={inChat ? null : g.cwd}
              models={g.models}
              /* The live session's own model and mode, falling back to the settings
                 default when nothing is running — at which point the default really is
                 what the next session will use. Reading settings while a session was up
                 described the next session, not the one on screen. */
              currentModel={g.sessionModel ?? g.settings?.model}
              onChangeModel={(id) => void g.changeModel(id, g.sessionModel)}
              permissionMode={g.sessionPermissionMode ?? g.permissionMode}
              onChangeMode={(m) => void g.changePermissionMode(m, g.sessionPermissionMode)}
              showMode={inProject}
              onSend={(t, atts) => void g.sendPrompt(t, atts)}
              onCancel={() => void g.cancel()}
              onOpenFolder={(path) => openProject(path)}
            />
          </div>
          {g.previewRunning && inProject ? (
            <>
              <PaneSplitter percent={previewPercent} onChange={setPreviewPercent} />
              <PreviewPane
                url={g.previewUrl}
                error={g.previewError}
                widthPercent={previewPercent}
                poppedOut={g.previewPoppedOut}
                onPopOut={() => void g.popOutPreview()}
                onDock={() => void g.dockPreview()}
                onStop={() => void g.stopPreview()}
              />
            </>
          ) : null}
          </div>
        )}
      </main>

      {showAuthModal ? (
        <div className="auth-overlay" role="dialog" aria-modal="true">
          <AuthGate
            auth={g.auth}
            busy={g.authBusy}
            pendingLogin={g.pendingLogin}
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

      <CommandPalette
        open={paletteOpen}
        actions={paletteActions}
        onClose={() => setPaletteOpen(false)}
      />

      {g.permission ? (
        <PermissionModal
          request={g.permission}
          onRespond={(d) => void g.respondPermission(d)}
        />
      ) : null}

      {g.showYoloConfirm ? (
        <YoloConfirm onConfirm={() => void g.confirmYolo()} onCancel={g.cancelYolo} />
      ) : null}

      {/* What changed since the version last run here. `decideWhatsNew` is what decides
          whether that is anything at all — a fresh install, a downgrade and an unreleased
          build all show nothing, for different reasons. */}
      <WhatsNew
        notes={notesDismissed ? [] : whatsNew.notes}
        onDismiss={() => {
          setNotesDismissed(true)
          if (whatsNew.record) void g.markNotesSeen(whatsNew.record)
        }}
      />

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
              back. Opening it restores it too.
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
        skills={g.skills}
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
