import { useEffect, useMemo, useState } from 'react'
import type { AppSurface, ProjectContext, SessionInfo } from '../../shared/types'
import { folderName, pathsEqual } from '../../shared/path'

interface Props {
  alwaysApprove: boolean
  authLabel?: string
  authenticated: boolean
  surface: AppSurface
  /** true when main pane is the conversation (not a browse home) */
  inConversation: boolean
  /** Recent projects (coding agent) */
  projects: ProjectContext[]
  /** Project-bound agent sessions (excludes app chat) */
  projectSessions: SessionInfo[]
  /** App-level chat sessions (not tied to a project) */
  chatSessions: SessionInfo[]
  activeCwd: string | null
  activeSessionId: string | null
  /** Archived sessions across both surfaces — entry point is hidden at 0 */
  archivedCount: number
  onGoHome: () => void
  onGoChat: () => void
  onGoProjects: () => void
  onOpenProject: (cwd?: string | null) => void
  onOpenChat: () => void
  onSelectSession: (s: SessionInfo) => void
  onNewProjectSession: () => void
  onOpenArchived: () => void
  onToggleAlwaysApprove: () => void
  onOpenSettings: () => void
  onLogout: () => void
  onSignIn: () => void
}

function sessionTitle(s: SessionInfo): string {
  return (s.title || s.id.slice(0, 8)).trim()
}

/** Enough to hop between what you actually work in; the rest live in Build. */
const SWITCHER_LIMIT = 8

/** Rails are a hop list, not an archive — the browse homes hold the full set. */
const LIST_LIMIT = 40

const COLLAPSE_KEY = 'gronk.sidebar.collapse.v2'

function loadCollapse(): { folders: boolean; sessions: boolean; chats: boolean } {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY)
    if (!raw) return { folders: true, sessions: true, chats: true }
    const p = JSON.parse(raw) as {
      folders?: boolean
      sessions?: boolean
      chats?: boolean
    }
    return {
      folders: p.folders !== false,
      sessions: p.sessions !== false,
      chats: p.chats !== false
    }
  } catch {
    return { folders: true, sessions: true, chats: true }
  }
}

/**
 * Left rail — the navigator for whichever surface you are on.
 *
 * It stays put whether you are browsing or inside a conversation, so choosing
 * Build shows your projects immediately rather than after you have already
 * picked one. The browse homes still hold the richer view (activity, sessions
 * per project); the rail is the hop list, capped by SWITCHER_LIMIT / LIST_LIMIT,
 * and says how many rows it is hiding when it cuts.
 */
export function Sidebar({
  alwaysApprove,
  authLabel,
  authenticated,
  surface,
  inConversation,
  projects,
  projectSessions,
  chatSessions,
  activeCwd,
  activeSessionId,
  archivedCount,
  onGoHome,
  onGoChat,
  onGoProjects,
  onOpenProject,
  onOpenChat,
  onSelectSession,
  onNewProjectSession,
  onOpenArchived,
  onToggleAlwaysApprove,
  onOpenSettings,
  onLogout,
  onSignIn
}: Props) {
  const [open, setOpen] = useState(loadCollapse)

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify(open))
    } catch {
      /* ignore */
    }
  }, [open])

  const toggle = (key: 'folders' | 'sessions' | 'chats') => {
    setOpen((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  /** Only the open project's sessions — the all-projects view is ProjectHome's job */
  const folderSessionsAll = useMemo(() => {
    if (!activeCwd) return []
    return projectSessions
      .filter((s) => pathsEqual(s.cwd, activeCwd))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }, [activeCwd, projectSessions])

  const folderSessions = useMemo(
    () => folderSessionsAll.slice(0, LIST_LIMIT),
    [folderSessionsAll]
  )

  const folderSwitcher = useMemo(() => projects.slice(0, SWITCHER_LIMIT), [projects])

  const chatListAll = useMemo(
    () => [...chatSessions].sort((a, b) => b.updatedAt - a.updatedAt),
    [chatSessions]
  )

  const chatList = useMemo(() => chatListAll.slice(0, LIST_LIMIT), [chatListAll])

  /**
   * Every rail count describes the rows actually rendered, and any list that got
   * cut says how much it is hiding — a header that disagrees with its own body
   * is worse than no count at all.
   */
  const hiddenChats = chatListAll.length - chatList.length
  const hiddenFolders = projects.length - folderSwitcher.length
  const hiddenFolderSessions = folderSessionsAll.length - folderSessions.length

  /**
   * The rails follow the SURFACE, not whether a conversation is open.
   *
   * They used to be hidden while browsing, so picking Build gave you a browse
   * screen with an empty rail, and the list of projects only appeared after you
   * had already chosen one — the moment you no longer needed it. Worse, getting
   * back to the list meant leaving the project entirely, which is what the
   * "Switch workspace / All" buttons existed to undo. Keeping the list on screen
   * removes the round trip and both buttons with it.
   */
  const showChatRail = surface === 'chat'
  const showProjectRails = surface === 'project'

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="brand">
          <div className="brand-mark" aria-hidden>
            G
          </div>
          <div className="brand-text">
            <h1>Gronk</h1>
            <p>Grok desktop</p>
          </div>
        </div>

        <nav className="nav-stack" aria-label="Main">
          <button
            type="button"
            className={`nav-item ${surface === 'home' ? 'active' : ''}`}
            onClick={onGoHome}
          >
            Home
          </button>
          <button
            type="button"
            className={`nav-item ${surface === 'chat' ? 'active' : ''}`}
            onClick={onGoChat}
            title="App-level chats — no project"
          >
            Chat
          </button>
          <button
            type="button"
            className={`nav-item ${surface === 'project' ? 'active' : ''}`}
            onClick={onGoProjects}
            title="Grok working in a project on your computer"
          >
            Build
          </button>
        </nav>
      </div>

      <div className="sidebar-body">
        {surface === 'home' ? (
          <div className="sidebar-section">
            <div className="muted-note">
              <strong>Chat</strong> is general Grok in the app.
              <br />
              <strong>Build</strong> is Grok working in a project on your computer.
            </div>
          </div>
        ) : null}

        {/* ---- Chat: the list is here whether or not a chat is open ---- */}
        {showChatRail ? (
          <div className={`sidebar-rail ${open.chats ? 'open' : 'collapsed'}`}>
            <button
              type="button"
              className="sidebar-rail-head"
              onClick={() => toggle('chats')}
              aria-expanded={open.chats}
              title={open.chats ? 'Minimize chats' : 'Expand chats'}
            >
              <span className="sidebar-rail-chevron" aria-hidden>
                {open.chats ? '▾' : '▸'}
              </span>
              <span className="sidebar-rail-title">Chats</span>
              <span className="sidebar-rail-count">{chatList.length || ''}</span>
            </button>
            {open.chats ? (
              <div className="sidebar-rail-body">
                <div className="sidebar-rail-toolbar">
                  <div className="sidebar-rail-sub">Saved in the app · no project</div>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm btn-block sidebar-rail-action"
                    disabled={!authenticated}
                    onClick={onOpenChat}
                  >
                    New chat
                  </button>
                </div>
                {chatList.length === 0 ? (
                  <div className="muted-note">No chats yet</div>
                ) : (
                  chatList.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      className={`session-item ${s.id === activeSessionId ? 'active' : ''}`}
                      disabled={!authenticated}
                      title={sessionTitle(s)}
                      onClick={() => onSelectSession(s)}
                    >
                      <div className="name">{sessionTitle(s)}</div>
                      <div className="meta">{new Date(s.updatedAt).toLocaleDateString()}</div>
                    </button>
                  ))
                )}
                {hiddenChats > 0 ? (
                  <button
                    type="button"
                    className="sidebar-rail-more"
                    onClick={onGoChat}
                    title="Open the full chat list"
                  >
                    +{hiddenChats} older · See all
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {/* ---- Build: projects, and the sessions inside the open one ---- */}
        {showProjectRails ? (
          <>
            <div className={`sidebar-rail ${open.folders ? 'open' : 'collapsed'}`}>
              <button
                type="button"
                className="sidebar-rail-head"
                onClick={() => toggle('folders')}
                aria-expanded={open.folders}
                title={open.folders ? 'Minimize projects' : 'Expand projects'}
              >
                <span className="sidebar-rail-chevron" aria-hidden>
                  {open.folders ? '▾' : '▸'}
                </span>
                <span className="sidebar-rail-title">Projects</span>
                <span className="sidebar-rail-count">{folderSwitcher.length || ''}</span>
              </button>
              {open.folders ? (
                <div className="sidebar-rail-body">
                  {/* One action, not two. "Open…" and "All" were a pair of large
                      buttons for adding a project and for returning to a list
                      that is now permanently on screen. Adding is the only one
                      of those the list cannot do itself. */}
                  <div className="sidebar-rail-toolbar">
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm btn-block sidebar-rail-action"
                      disabled={!authenticated}
                      onClick={() => onOpenProject()}
                      title="Pick a folder on your computer to work in"
                    >
                      + Add project
                    </button>
                  </div>
                  {folderSwitcher.length === 0 ? (
                    <div className="muted-note">No projects yet</div>
                  ) : (
                    folderSwitcher.map((p) => {
                      const active = !!activeCwd && pathsEqual(p.cwd, activeCwd)
                      return (
                        <button
                          key={p.cwd}
                          type="button"
                          className={`project-card ${active ? 'active' : ''}`}
                          disabled={!authenticated}
                          title={p.cwd}
                          onClick={() => onOpenProject(p.cwd)}
                        >
                          <div className="name">{p.name || folderName(p.cwd)}</div>
                          <div className="path">{p.cwd}</div>
                        </button>
                      )
                    })
                  )}
                  {hiddenFolders > 0 ? (
                    <button
                      type="button"
                      className="sidebar-rail-more"
                      onClick={onGoProjects}
                      title="All projects, with their sessions and activity"
                    >
                      +{hiddenFolders} more · See all
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>

            {/* Only once a project is open. With none, this rail was a header, a
                disabled button and a line telling you to go do the thing the
                rail above it already offers. */}
            {activeCwd ? (
            <div className={`sidebar-rail ${open.sessions ? 'open' : 'collapsed'}`}>
              <button
                type="button"
                className="sidebar-rail-head"
                onClick={() => toggle('sessions')}
                aria-expanded={open.sessions}
                title={open.sessions ? 'Minimize sessions' : 'Expand sessions'}
              >
                <span className="sidebar-rail-chevron" aria-hidden>
                  {open.sessions ? '▾' : '▸'}
                </span>
                <span className="sidebar-rail-title">Sessions</span>
                <span className="sidebar-rail-count">{folderSessions.length || ''}</span>
              </button>
              {open.sessions ? (
                <div className="sidebar-rail-body">
                  <div className="sidebar-rail-toolbar">
                    <div className="sidebar-rail-sub">
                      {activeCwd ? folderName(activeCwd) : 'No project open'}
                    </div>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm btn-block sidebar-rail-action"
                      disabled={!authenticated || !activeCwd}
                      onClick={onNewProjectSession}
                      title={
                        activeCwd
                          ? 'Start a fresh agent session in this project'
                          : 'Add a project first'
                      }
                    >
                      New session
                    </button>
                  </div>
                  {folderSessions.length === 0 ? (
                    <div className="muted-note">
                      {activeCwd ? 'No sessions in this project yet' : 'Add a project first'}
                    </div>
                  ) : (
                    folderSessions.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        className={`session-item ${s.id === activeSessionId ? 'active' : ''}`}
                        disabled={!authenticated}
                        title={sessionTitle(s)}
                        onClick={() => onSelectSession(s)}
                      >
                        <div className="name">{sessionTitle(s)}</div>
                        <div className="meta">
                          {new Date(s.updatedAt).toLocaleDateString()}
                        </div>
                      </button>
                    ))
                  )}
                  {hiddenFolderSessions > 0 ? (
                    <button
                      type="button"
                      className="sidebar-rail-more"
                      onClick={onGoProjects}
                      title="Open the full session list for every folder"
                    >
                      +{hiddenFolderSessions} older · See all
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
            ) : null}
          </>
        ) : null}
      </div>

      <div className="sidebar-footer">
        <div className={`account-chip ${authenticated ? 'ok' : 'bad'}`}>
          {authenticated ? authLabel || 'Signed in' : 'Not signed in'}
        </div>
        {!authenticated ? (
          <button type="button" className="btn btn-primary btn-block" onClick={onSignIn}>
            Sign in
          </button>
        ) : null}
        {/* Stays hidden until there is something archived — archiving is meant to be quiet */}
        {archivedCount > 0 ? (
          <button
            type="button"
            className="btn btn-ghost btn-block"
            onClick={onOpenArchived}
            title="View and restore archived sessions"
          >
            Archived
            <span className="archived-entry-count">{archivedCount}</span>
          </button>
        ) : null}
        <button type="button" className="btn btn-ghost btn-block" onClick={onOpenSettings}>
          Settings
        </button>
        {authenticated ? (
          <button type="button" className="btn btn-ghost btn-block" onClick={onLogout}>
            Sign out
          </button>
        ) : null}
        {surface === 'project' && inConversation ? (
          <div className="settings-row">
            <label htmlFor="always-approve">YOLO</label>
            <button
              id="always-approve"
              type="button"
              className={`toggle ${alwaysApprove ? 'on' : ''}`}
              aria-pressed={!!alwaysApprove}
              onClick={onToggleAlwaysApprove}
              disabled={!authenticated}
              title="Bypass all permissions for coding agent"
            />
          </div>
        ) : null}
        <div className="version-tag">v{__APP_VERSION__}</div>
      </div>
    </aside>
  )
}
