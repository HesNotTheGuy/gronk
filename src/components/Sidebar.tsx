import { useEffect, useMemo, useState } from 'react'
import type {
  AppSurface,
  ProjectContext,
  SessionInfo,
  SessionSearchHit
} from '../../shared/types'
import { MenuButton } from './MenuButton'
import type { MenuOption } from './MenuButton'
import { SessionRow } from './SessionRow'
import { folderName, isChatSession, pathsEqual } from '../../shared/path'

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
  onRemoveProject: (cwd: string) => void
  onPinProject: (cwd: string, pinned: boolean) => void
  /** Opens the Plugins & Skills panel without a detour through Settings. */
  onOpenPlugins: () => void
  onNewProjectSession: () => void
  onOpenArchived: () => void
  onOpenSettings: () => void
  onLogout: () => void
  onSignIn: () => void
}

/** Enough to hop between what you actually work in; the rest live in Build. */
const SWITCHER_LIMIT = 8

/** Rails are a hop list, not an archive: the browse homes hold the full set. */
const LIST_LIMIT = 40

const COLLAPSE_KEY = 'gronk.sidebar.collapse.v2'

/**
 * Project rail actions. "Remove from list" only forgets the recent entry. It
 * never deletes the folder on disk. The wording must stay that careful.
 */
function projectOptions(pinned: boolean): MenuOption[] {
  return [
    { id: 'reveal', label: 'Show in folder', description: 'Open it in your file manager' },
    {
      id: 'pin',
      label: pinned ? 'Unpin' : 'Pin to top',
      description: pinned ? 'Return to normal recent order' : 'Keep this project at the top'
    },
    {
      id: 'remove',
      label: 'Remove from list',
      description: 'Forget this recent entry. Does not delete files.'
    }
  ]
}

/**
 * revealLocalPath already accepts a project directory: its containment check
 * allows every recent project cwd as a root, and a path equal to its root counts
 * as inside. Nothing in the main process had to change for this.
 */
function revealProject(cwd: string): void {
  // Failure means the folder moved or went away, and the rail has nowhere to
  // say so, so the file manager simply not opening is the whole message.
  void window.gronk.revealLocalPath(cwd).catch(() => undefined)
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
 * It stays put whether you are browsing or inside a conversation, so choosing
 * Build shows your projects immediately rather than after you have already
 * picked one. The browse homes still hold the richer view (activity, sessions
 * per project); the rail is the hop list, capped by SWITCHER_LIMIT / LIST_LIMIT,
 * and says how many rows it is hiding when it cuts.
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
  onOpenProject,
  onOpenChat,
  onSelectSession,
  onRenameSession,
  onArchiveSession,
  onExportSession,
  onDeleteSession,
  onRemoveProject,
  onPinProject,
  onOpenPlugins,
  onNewProjectSession,
  onOpenArchived,
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

  /** Only the open project's sessions. The all-projects view is ProjectHome's job */
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
   * cut says how much it is hiding. A header that disagrees with its own body
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
   * had already chosen one, the moment you no longer needed it. Worse, getting
   * back to the list meant leaving the project entirely, which is what the
   * "Switch workspace / All" buttons existed to undo. Keeping the list on screen
   * removes the round trip and both buttons with it.
   */
  const showChatRail = surface === 'chat' && !searching
  const showProjectRails = surface === 'project' && !searching

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
                      const name = p.name || folderName(p.cwd)
                      // Same shape as a session row: the card still opens the
                      // project, and the menu is its sibling rather than a
                      // control nested inside a button, which is not allowed.
                      return (
                        <div key={p.cwd} className="project-item-row">
                          <button
                            type="button"
                            className={`project-card ${active ? 'active' : ''}`}
                            disabled={!authenticated}
                            title={p.cwd}
                            onClick={() => onOpenProject(p.cwd)}
                          >
                            <div className="name">
                              {p.pinned ? <span className="pin-mark" title="Pinned">·</span> : null}
                              {name}
                            </div>
                            <div className="path">{p.cwd}</div>
                          </button>
                          <MenuButton
                            label="Project actions"
                            title={`Actions for ${name}`}
                            trigger="icon"
                            placement="down"
                            options={projectOptions(!!p.pinned)}
                            onSelect={(id) => {
                              if (id === 'reveal') revealProject(p.cwd)
                              if (id === 'pin') onPinProject(p.cwd, !p.pinned)
                              if (id === 'remove') onRemoveProject(p.cwd)
                            }}
                            disabled={!authenticated}
                          />
                        </div>
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
        {/* Stays hidden until there is something archived: archiving is meant to be quiet */}
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
        {authenticated ? (
          <button type="button" className="btn btn-ghost btn-block" onClick={onLogout}>
            Sign out
          </button>
        ) : null}
        <div className="version-tag">v{__APP_VERSION__}</div>
      </div>
    </aside>
  )
}
