import { useEffect, useMemo, useState } from 'react'
import type {
  AppSurface,
  ModelInfo,
  PermissionMode,
  ProjectContext,
  SessionInfo
} from '../../shared/types'
import { folderName, pathsEqual } from '../../shared/path'

interface Props {
  alwaysApprove: boolean
  models: ModelInfo[]
  currentModel?: string
  authLabel?: string
  authenticated: boolean
  permissionMode: PermissionMode
  surface: AppSurface
  /** true when main pane is the conversation (not a browse home) */
  inConversation: boolean
  /** Recent folder workspaces (coding agent) */
  projects: ProjectContext[]
  /** Folder-bound agent sessions (excludes app chat) */
  projectSessions: SessionInfo[]
  /** App-level chat sessions (not tied to a user folder) */
  chatSessions: SessionInfo[]
  activeCwd: string | null
  activeSessionId: string | null
  onGoHome: () => void
  onGoChat: () => void
  onGoProjects: () => void
  onOpenProject: (cwd?: string | null) => void
  onOpenChat: () => void
  onSelectSession: (s: SessionInfo) => void
  onNewProjectSession: () => void
  onToggleAlwaysApprove: () => void
  onChangePermissionMode: (mode: PermissionMode) => void
  onOpenSettings: () => void
  onChangeModel: (id: string) => void
  onLogout: () => void
  onSignIn: () => void
}

function sessionTitle(s: SessionInfo): string {
  return (s.title || s.id.slice(0, 8)).trim()
}

const COLLAPSE_KEY = 'grocky.sidebar.collapse.v2'

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
 * Left rail:
 * - Home: model + account only (browse in main)
 * - Chat: app-bound chat list (no folder pick)
 * - Workspace: folders + sessions for coding agent in a file tree
 */
export function Sidebar({
  alwaysApprove,
  models,
  currentModel,
  authLabel,
  authenticated,
  permissionMode,
  surface,
  inConversation,
  projects,
  projectSessions,
  chatSessions,
  activeCwd,
  activeSessionId,
  onGoHome,
  onGoChat,
  onGoProjects,
  onOpenProject,
  onOpenChat,
  onSelectSession,
  onNewProjectSession,
  onToggleAlwaysApprove,
  onChangePermissionMode,
  onOpenSettings,
  onChangeModel,
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

  const workspaceSessions = useMemo(() => {
    if (activeCwd && surface === 'project') {
      const mine = projectSessions
        .filter((s) => pathsEqual(s.cwd, activeCwd))
        .sort((a, b) => b.updatedAt - a.updatedAt)
      if (mine.length) return mine.slice(0, 40)
    }
    return [...projectSessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 40)
  }, [surface, activeCwd, projectSessions])

  const chatList = useMemo(
    () => [...chatSessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 40),
    [chatSessions]
  )

  const showChatRail = surface === 'chat'
  const showWorkspaceRails = surface === 'project'

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="brand">
          <div className="brand-mark" aria-hidden>
            G
          </div>
          <div className="brand-text">
            <h1>Grocky</h1>
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
            title="App-level chats — no project folder"
          >
            Chat
          </button>
          <button
            type="button"
            className={`nav-item ${surface === 'project' ? 'active' : ''}`}
            onClick={onGoProjects}
            title="Grok working in a folder on your computer"
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
              <strong>Build</strong> is Grok working in a folder on your computer.
            </div>
          </div>
        ) : null}

        {/* ---- Chat surface: only chats (app-bound) ---- */}
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
                  <div className="sidebar-rail-sub">Saved in the app · no folder</div>
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
              </div>
            ) : null}
          </div>
        ) : null}

        {/* ---- Workspace surface: folders + sessions ---- */}
        {showWorkspaceRails ? (
          <>
            <div className={`sidebar-rail ${open.folders ? 'open' : 'collapsed'}`}>
              <button
                type="button"
                className="sidebar-rail-head"
                onClick={() => toggle('folders')}
                aria-expanded={open.folders}
                title={open.folders ? 'Minimize folders' : 'Expand folders'}
              >
                <span className="sidebar-rail-chevron" aria-hidden>
                  {open.folders ? '▾' : '▸'}
                </span>
                <span className="sidebar-rail-title">Folders</span>
                <span className="sidebar-rail-count">{projects.length || ''}</span>
              </button>
              {open.folders ? (
                <div className="sidebar-rail-body">
                  <div className="sidebar-rail-toolbar">
                    <div className="sidebar-rail-sub">Coding agent root</div>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm btn-block sidebar-rail-action"
                      disabled={!authenticated}
                      onClick={() => onOpenProject()}
                      title="Pick a folder in Explorer"
                    >
                      Open folder…
                    </button>
                  </div>
                  {projects.length === 0 ? (
                    <div className="muted-note">No folders yet</div>
                  ) : (
                    projects.map((p) => {
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
                </div>
              ) : null}
            </div>

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
                <span className="sidebar-rail-count">{workspaceSessions.length || ''}</span>
              </button>
              {open.sessions ? (
                <div className="sidebar-rail-body">
                  <div className="sidebar-rail-toolbar">
                    <div className="sidebar-rail-sub">
                      {activeCwd ? folderName(activeCwd) : 'All folders'}
                    </div>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm btn-block sidebar-rail-action"
                      disabled={!authenticated || !activeCwd}
                      onClick={onNewProjectSession}
                      title={
                        activeCwd
                          ? 'Start a fresh agent session in this folder'
                          : 'Open a folder first'
                      }
                    >
                      New session
                    </button>
                  </div>
                  {workspaceSessions.length === 0 ? (
                    <div className="muted-note">No sessions yet</div>
                  ) : (
                    workspaceSessions.map((s) => {
                      const active = s.id === activeSessionId
                      const showFolder = !activeCwd || !pathsEqual(s.cwd, activeCwd)
                      return (
                        <button
                          key={s.id}
                          type="button"
                          className={`session-item ${active ? 'active' : ''}`}
                          disabled={!authenticated}
                          title={sessionTitle(s)}
                          onClick={() => onSelectSession(s)}
                        >
                          <div className="name">{sessionTitle(s)}</div>
                          <div className="meta">
                            {showFolder ? `${folderName(s.cwd)} · ` : ''}
                            {new Date(s.updatedAt).toLocaleDateString()}
                          </div>
                        </button>
                      )
                    })
                  )}
                </div>
              ) : null}
            </div>
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
        <div className="version-tag">v0.2.0</div>
      </div>
    </aside>
  )
}
