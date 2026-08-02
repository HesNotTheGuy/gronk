import { useMemo } from 'react'
import type { ProjectContext, SessionInfo } from '../../shared/types'
import { pathsEqual } from '../../shared/path'
import {
  buildWorkspaceFolderGroups,
  sessionFrequencyLabel,
  sessionHeat
} from '../lib/activity'
import { MenuButton } from './MenuButton'
import type { MenuOption } from './MenuButton'
import { SessionCard } from './SessionCard'

/**
 * One item, for now.
 *
 * "Remove from recents" belongs here too, and nothing can build it yet: the
 * bridge exposes getRecentProjects and addRecentProject and no way to forget
 * one. An item wired to nothing would be a lie, and the obvious substitute is
 * the one thing this must never do, since a menu row next to a project called
 * anything like "Remove" will be read as "delete my folder" by somebody. So it
 * waits for the IPC rather than shipping in a shape that could be misread.
 */
const PROJECT_OPTIONS: MenuOption[] = [
  { id: 'reveal', label: 'Show in folder', description: 'Open it in your file manager' }
]

/**
 * revealLocalPath already accepts a project directory: its containment check
 * allows every recent project cwd as a root, and a path equal to its root counts
 * as inside. Nothing in the main process had to change for this.
 */
function revealProject(cwd: string): void {
  // Failure means the folder moved or went away, and this view has nowhere to
  // say so, so the file manager simply not opening is the whole message.
  void window.gronk.revealLocalPath(cwd).catch(() => undefined)
}

/**
 * Says in words what a border was being asked to say and could not.
 *
 * Nobody selects anything to reach this screen, so an accented outline on the
 * project already open reads as "you picked this" and is wrong about the one
 * thing it is trying to communicate. Running is a state, and a state needs a
 * noun. The header already has this exact shape for its ONLINE readout, so this
 * borrows .status-pill outright rather than teaching a second badge vocabulary.
 */
function OpenPill({ title }: { title: string }) {
  return (
    <span className="status-pill open-pill" title={title}>
      <span className="dot" aria-hidden />
      Open
    </span>
  )
}

interface Props {
  projects: ProjectContext[]
  sessions: SessionInfo[]
  activeCwd: string | null
  activeSessionId: string | null
  authenticated: boolean
  onOpenFolder: () => void
  onOpenProject: (cwd: string) => void
  onNewSession: (cwd: string) => void
  onSelectSession: (s: SessionInfo) => void
  onRename: (id: string, title: string) => void
  onArchive: (id: string) => void
  onExport: (id: string, format: 'md' | 'json') => void
  onDelete: (id: string) => void
  onSignIn: () => void
}

/**
 * Build landing page: every project, with its sessions and activity nested
 * underneath. Richer than the sidebar rail, which is a capped hop list scoped to
 * the project currently open.
 * Chat sessions never appear here (filtered upstream).
 */
export function ProjectHome({
  projects,
  sessions,
  activeCwd,
  activeSessionId,
  authenticated,
  onOpenFolder,
  onOpenProject,
  onNewSession,
  onSelectSession,
  onRename,
  onArchive,
  onExport,
  onDelete,
  onSignIn
}: Props) {
  const groups = useMemo(
    () => buildWorkspaceFolderGroups(projects, sessions),
    [projects, sessions]
  )

  return (
    <div className="browse-home">
      <div className="browse-hero">
        <p className="home-kicker">Build</p>
        <h1>
          Code with the <span>agent</span>
        </h1>
        <p className="home-copy">
          Point the coding agent at a project. Every project and its sessions are listed here and
          in the left rail, which stays put while you work. Chat stays on the Chat tab.
        </p>
        <div className="home-actions">
          {authenticated ? (
            <button type="button" className="btn btn-primary" onClick={onOpenFolder}>
              + Add project
            </button>
          ) : (
            <button type="button" className="btn btn-primary" onClick={onSignIn}>
              Sign in
            </button>
          )}
        </div>
      </div>

      <div className="browse-panel workspace-folder-list">
        {groups.length === 0 ? (
          <div className="browse-empty">
            No projects yet. Add one to start a coding-agent session.
          </div>
        ) : (
          groups.map((g) => {
            const active = !!activeCwd && pathsEqual(g.cwd, activeCwd)
            return (
              <section
                key={g.cwd}
                className={`workspace-folder-block ${active ? 'active' : ''}`}
              >
                <div className="workspace-folder-head">
                  <button
                    type="button"
                    className="workspace-folder-open"
                    disabled={!authenticated}
                    onClick={() => onOpenProject(g.cwd)}
                    title={g.cwd}
                  >
                    <div className="workspace-folder-name">{g.name}</div>
                    <div className="workspace-folder-path">{g.cwd}</div>
                    <div className="activity-row">
                      <div className="activity-bar" aria-hidden>
                        <div
                          className="activity-fill"
                          style={{ width: `${Math.round(g.heat * 100)}%` }}
                        />
                      </div>
                      <div className="activity-label">{g.frequencyLabel}</div>
                    </div>
                  </button>
                  <div className="workspace-folder-meta">
                    <div className="workspace-folder-count-row">
                      <span className="browse-count">
                        {g.sessions.length} session{g.sessions.length === 1 ? '' : 's'}
                      </span>
                      {active ? (
                        <OpenPill title="This is the project you already have open" />
                      ) : null}
                    </div>
                    <div className="workspace-folder-actions">
                      {/* The verb carries the state. "Return" only makes sense
                          about somewhere you already are, so the button says
                          what the border was trying to and says it in a place
                          the user is already reading before they click. */}
                      <button
                        type="button"
                        className="btn-mini"
                        disabled={!authenticated}
                        onClick={() => onOpenProject(g.cwd)}
                        title={
                          active
                            ? 'Go back to this project, which is already open'
                            : 'Open this project'
                        }
                      >
                        {active ? 'Return' : 'Open'}
                      </button>
                      <button
                        type="button"
                        className="btn-mini"
                        disabled={!authenticated}
                        onClick={() => onNewSession(g.cwd)}
                        title="Start a fresh agent session in this folder"
                      >
                        New session
                      </button>
                      {/* Sits beside the two entry points rather than hidden
                          until hover, the way the sidebar row does it: there is
                          already a visible row of controls here to belong to. */}
                      <MenuButton
                        label="Project actions"
                        title={`Actions for ${g.name}`}
                        trigger="icon"
                        placement="down"
                        options={PROJECT_OPTIONS}
                        onSelect={(id) => {
                          if (id === 'reveal') revealProject(g.cwd)
                        }}
                        disabled={!authenticated}
                      />
                    </div>
                  </div>
                </div>

                {g.sessions.length === 0 ? (
                  <div className="workspace-folder-empty muted-note">
                    No sessions in this folder yet. Open it and send a prompt.
                  </div>
                ) : (
                  <div className="workspace-folder-sessions">
                    {g.sessions.map((s) => {
                      const open = s.id === activeSessionId
                      return (
                        <div
                          key={s.id}
                          className={`activity-session-wrap ${open ? 'active' : ''}`}
                        >
                          <SessionCard
                            session={s}
                            active={open}
                            onSelect={() => onSelectSession(s)}
                            onRename={(t) => onRename(s.id, t)}
                            onArchive={() => onArchive(s.id)}
                            onExport={(format) => onExport(s.id, format)}
                            onDelete={() => onDelete(s.id)}
                          />
                          <div className="activity-row under-card">
                            <div className="activity-bar" aria-hidden>
                              <div
                                className="activity-fill"
                                style={{ width: `${Math.round(sessionHeat(s) * 100)}%` }}
                              />
                            </div>
                            {/* The pill joins the frequency label rather than the
                                title, because both are the same kind of claim:
                                a fact about the session, not a thing to click. */}
                            <div className="activity-foot">
                              <div className="activity-label">{sessionFrequencyLabel(s)}</div>
                              {open ? (
                                <OpenPill title="This is the session you already have open" />
                              ) : null}
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </section>
            )
          })
        )}
      </div>
    </div>
  )
}
