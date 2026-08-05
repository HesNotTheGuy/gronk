import { useEffect, useMemo, useState } from 'react'
import type {
  AppSurface,
  ProjectContext,
  SessionInfo,
  SessionSearchHit
} from '../../shared/types'
import { SessionRow } from './SessionRow'
import { folderName, isChatSession } from '../../shared/path'
import { BrandMark } from './BrandMark'
import {
  buildSessionNav,
  sessionNavMeta,
  SESSION_NAV_LIMIT,
  type SessionNavMode
} from '../lib/session-nav'

interface Props {
  authLabel?: string
  authenticated: boolean
  surface: AppSurface
  /** Recent projects (coding agent) */
  projects: ProjectContext[]
  /** Project-bound agent sessions (excludes app chat) */
  projectSessions: SessionInfo[]
  /** App-level chat sessions (not tied to a project) */
  chatSessions: SessionInfo[]
  /** Sandbox root, so a search hit can say whether it came from Chat or a project */
  chatWorkspacePath: string | null
  activeCwd: string | null
  activeSessionId: string | null
  /** Archived sessions across both surfaces. The entry point is hidden at 0 */
  archivedCount: number
  onGoHome: () => void
  onGoChat: () => void
  onGoProjects: () => void
  onOpenProject: (cwd?: string | null) => void
  onOpenChat: () => void
  onSelectSession: (s: SessionInfo) => void
  onRenameSession: (id: string, title: string) => void
  onArchiveSession: (id: string) => void
  onExportSession: (id: string, format: 'md' | 'json') => void
  onDeleteSession: (id: string) => void
  /**
   * Still accepted so App does not fork its props shape; project pin/remove live
   * on the Build browse screen and project menus there, not on this session rail.
   */
  onRemoveProject: (cwd: string) => void
  onPinProject: (cwd: string, pinned: boolean) => void
  /** Opens the Plugins & Skills panel without a detour through Settings. */
  onOpenPlugins: () => void
  onNewProjectSession: () => void
  onOpenArchived: () => void
  onOpenSettings: () => void
  onSignIn: () => void
}

/** Rails are a hop list, not an archive: the browse homes hold the full set. */
const LIST_LIMIT = 40

const COLLAPSE_KEY = 'gronk.sidebar.collapse.v2'
const SESSION_MODE_KEY = 'gronk.sidebar.sessionMode.v1'

function loadSessionMode(): SessionNavMode {
  try {
    const raw = localStorage.getItem(SESSION_MODE_KEY)
    if (raw === 'by-project' || raw === 'recent') return raw
  } catch {
    /* ignore */
  }
  return 'recent'
}

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
 * Left rail: the navigator for whichever surface you are on.
 *
 * On Build, sessions are the primary list (flat by recency by default, or
 * grouped by project). Projects are no longer a drill-down you must walk before
 * the sessions appear — opening a session sets the agent cwd, and every row
 * shows which project that is. Browse homes still hold the full project map.
 */
export function Sidebar({
  authLabel,
  authenticated,
  surface,
  projects,
  projectSessions,
  chatSessions,
  chatWorkspacePath,
  activeCwd,
  activeSessionId,
  archivedCount,
  onGoHome,
  onGoChat,
  onGoProjects,
  onOpenProject: _onOpenProject,
  onOpenChat,
  onSelectSession,
  onRenameSession,
  onArchiveSession,
  onExportSession,
  onDeleteSession,
  onRemoveProject: _onRemoveProject,
  onPinProject: _onPinProject,
  onOpenPlugins,
  onNewProjectSession,
  onOpenArchived,
  onOpenSettings,
  onSignIn
}: Props) {
  const [open, setOpen] = useState(loadCollapse)
  const [sessionMode, setSessionMode] = useState<SessionNavMode>(loadSessionMode)

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify(open))
    } catch {
      /* ignore */
    }
  }, [open])

  useEffect(() => {
    try {
      localStorage.setItem(SESSION_MODE_KEY, sessionMode)
    } catch {
      /* ignore */
    }
  }, [sessionMode])

  const toggle = (key: 'chats') => {
    setOpen((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SessionSearchHit[] | null>(null)
  const searching = query.trim().length > 0

  /**
   * Debounced, and every in-flight result is discarded unless it belongs to the
   * text currently in the box. Without that check a slow scan of an early
   * keystroke can land after a later one and repaint stale results.
   */
  useEffect(() => {
    const term = query.trim()
    if (!term) {
      setHits(null)
      return
    }
    let live = true
    const timer = setTimeout(() => {
      void window.gronk
        .searchSessions(term)
        .then((result) => {
          if (live) setHits(result)
        })
        .catch(() => {
          if (live) setHits([])
        })
    }, 140)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [query])

  /** Search spans both surfaces, so a hit needs its own session object back. */
  const byId = useMemo(() => {
    const map = new Map<string, SessionInfo>()
    for (const s of [...chatSessions, ...projectSessions]) map.set(s.id, s)
    return map
  }, [chatSessions, projectSessions])

  /**
   * Build rail: every project session, not only the open folder. Ordering and
   * grouping live in session-nav.ts so the suite can mutation-check them.
   */
  const projectSessionNav = useMemo(
    () =>
      buildSessionNav({
        sessions: projectSessions,
        projects,
        mode: sessionMode,
        chatWorkspacePath,
        limit: SESSION_NAV_LIMIT
      }),
    [projectSessions, projects, sessionMode, chatWorkspacePath]
  )

  const projectSessionCount = useMemo(() => {
    if (projectSessionNav.mode === 'recent') return projectSessionNav.entries.length
    return projectSessionNav.groups.reduce((n, g) => n + g.entries.length, 0)
  }, [projectSessionNav])

  const chatListAll = useMemo(
    () => [...chatSessions].sort((a, b) => b.updatedAt - a.updatedAt),
    [chatSessions]
  )

  const chatList = useMemo(() => chatListAll.slice(0, LIST_LIMIT), [chatListAll])

  /**
   * Every rail count describes the rows actually rendered, and any list that got
   * cut says how much it is hiding. A header that disagrees with its own body
   * is worse than no count at all.
   */
  const hiddenChats = chatListAll.length - chatList.length

  /**
   * The rails follow the SURFACE, not whether a conversation is open.
   *
   * Build shows sessions immediately (flat recency by default). Chat keeps its
   * own list. Search still spans both and replaces the rails while active.
   */
  const showChatRail = surface === 'chat' && !searching
  const showProjectRails = surface === 'project' && !searching

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="brand">
          <BrandMark />
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
            title="Home"
          >
            Home
          </button>
          <button
            type="button"
            className={`nav-item ${surface === 'chat' ? 'active' : ''}`}
            onClick={onGoChat}
            title="Conversations with Grok. No project folder."
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
        {/* Search spans Chat and Build together: you remember what was said, not
            which surface you said it on. While a query is active the rails give
            way to results, so the two lists are never on screen at once. */}
        {surface !== 'home' ? (
          <div className="sidebar-search">
            <input
              type="search"
              className="sidebar-search-input"
              placeholder="Search all sessions"
              value={query}
              // Not disabled when signed out: a query typed before the session
              // expired could then never be cleared, leaving the results pane
              // stuck over the rails with no way back.
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setQuery('')
              }}
              aria-label="Search every session by title or message text"
            />
          </div>
        ) : null}

        {searching ? (
          <div className="sidebar-rail open">
            <div className="sidebar-rail-head static">
              <span className="sidebar-rail-title">Results</span>
              <span className="sidebar-rail-count">{hits ? hits.length || '' : ''}</span>
            </div>
            <div className="sidebar-rail-body">
              {hits === null ? (
                <div className="muted-note">Searching…</div>
              ) : hits.length === 0 ? (
                <div className="muted-note">Nothing matched “{query.trim()}”</div>
              ) : (
                hits.map((hit) => {
                  const s = byId.get(hit.sessionId)
                  if (!s) return null
                  return (
                    <SessionRow
                      key={hit.sessionId}
                      session={s}
                      active={hit.sessionId === activeSessionId}
                      authenticated={authenticated}
                      chatWorkspacePath={chatWorkspacePath}
                      meta={
                        `${isChatSession(s, chatWorkspacePath) ? 'Chat' : folderName(s.cwd)}` +
                        ` · ${new Date(s.updatedAt).toLocaleDateString()}` +
                        (hit.messageMatches > 0
                          ? ` · ${hit.messageMatches} match${hit.messageMatches === 1 ? '' : 'es'}`
                          : '')
                      }
                      // Only for body hits. Echoing the title back beneath itself
                      // would say nothing.
                      detail={hit.snippet}
                      onSelect={() => {
                        setQuery('')
                        onSelectSession(s)
                      }}
                      onRename={(t) => onRenameSession(s.id, t)}
                      onArchive={() => onArchiveSession(s.id)}
                      onExport={(f) => onExportSession(s.id, f)}
                      onDelete={() => onDeleteSession(s.id)}
                    />
                  )
                })
              )}
            </div>
          </div>
        ) : null}

        {surface === 'home' ? (
          <div className="sidebar-section">
            <div className="muted-note">
              <strong>Chat</strong> is a conversation. No project folder.
              <br />
              <strong>Build</strong> gives Grok a folder on your computer to work in.
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
                    <SessionRow
                      key={s.id}
                      session={s}
                      active={s.id === activeSessionId}
                      authenticated={authenticated}
                      chatWorkspacePath={chatWorkspacePath}
                      meta={new Date(s.updatedAt).toLocaleDateString()}
                      onSelect={() => onSelectSession(s)}
                      onRename={(t) => onRenameSession(s.id, t)}
                      onArchive={() => onArchiveSession(s.id)}
                      onExport={(f) => onExportSession(s.id, f)}
                      onDelete={() => onDeleteSession(s.id)}
                    />
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

        {/*
          Build: the panel is the session list. No rail header, chevron, count,
          Add project, or agent-folder summary — those are furniture around the
          thing the surface exists for. Search (above) + one way to start a
          session + sessions. Mode sits on the same line as New session so it
          does not own a row. Chat still uses rails; it has several sections.
        */}
        {showProjectRails ? (
          <div className="session-nav">
            <div className="session-nav-bar">
              <button
                type="button"
                className="session-nav-new"
                disabled={!authenticated || !activeCwd}
                onClick={onNewProjectSession}
                title={
                  activeCwd
                    ? `Start a fresh agent session in ${folderName(activeCwd)}`
                    : 'Open a session first so the agent has a folder'
                }
              >
                + New session
              </button>
              <div
                className="session-mode-toggle"
                role="group"
                aria-label="How to organise sessions"
              >
                <button
                  type="button"
                  className={`session-mode-btn ${sessionMode === 'recent' ? 'active' : ''}`}
                  aria-pressed={sessionMode === 'recent'}
                  onClick={() => setSessionMode('recent')}
                  title="All sessions, newest first"
                >
                  Recent
                </button>
                <button
                  type="button"
                  className={`session-mode-btn ${sessionMode === 'by-project' ? 'active' : ''}`}
                  aria-pressed={sessionMode === 'by-project'}
                  onClick={() => setSessionMode('by-project')}
                  title="Sessions grouped by project"
                >
                  By project
                </button>
              </div>
            </div>
            {projectSessionCount === 0 ? (
              <div className="muted-note">No sessions yet</div>
            ) : projectSessionNav.mode === 'recent' ? (
              projectSessionNav.entries.map((entry) => {
                const s = entry.session
                return (
                  <SessionRow
                    key={s.id}
                    session={s}
                    active={s.id === activeSessionId}
                    authenticated={authenticated}
                    chatWorkspacePath={chatWorkspacePath}
                    meta={sessionNavMeta(entry)}
                    onSelect={() => onSelectSession(s)}
                    onRename={(t) => onRenameSession(s.id, t)}
                    onArchive={() => onArchiveSession(s.id)}
                    onExport={(f) => onExportSession(s.id, f)}
                    onDelete={() => onDeleteSession(s.id)}
                  />
                )
              })
            ) : (
              projectSessionNav.groups.map((group) => (
                <div key={group.cwd} className="session-nav-group">
                  <div className="session-nav-group-head" title={group.cwd}>
                    {group.projectLabel}
                  </div>
                  {group.entries.map((entry) => {
                    const s = entry.session
                    return (
                      <SessionRow
                        key={s.id}
                        session={s}
                        active={s.id === activeSessionId}
                        authenticated={authenticated}
                        chatWorkspacePath={chatWorkspacePath}
                        meta={sessionNavMeta(entry)}
                        onSelect={() => onSelectSession(s)}
                        onRename={(t) => onRenameSession(s.id, t)}
                        onArchive={() => onArchiveSession(s.id)}
                        onExport={(f) => onExportSession(s.id, f)}
                        onDelete={() => onDeleteSession(s.id)}
                      />
                    )
                  })}
                </div>
              ))
            )}
            {projectSessionNav.hidden > 0 ? (
              <button
                type="button"
                className="sidebar-rail-more"
                onClick={onGoProjects}
                title="All projects and sessions on the Build browse screen"
              >
                +{projectSessionNav.hidden} older · See all
              </button>
            ) : null}
          </div>
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
        <button type="button" className="btn btn-ghost btn-block" onClick={onOpenPlugins}>
          Plugins &amp; skills
        </button>
        <button type="button" className="btn btn-ghost btn-block" onClick={onOpenSettings}>
          Settings
        </button>
        <div className="version-tag" title={`package ${__APP_VERSION__}`}>
          {__APP_BUILD_LABEL__}
        </div>
      </div>
    </aside>
  )
}
