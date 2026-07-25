import { useMemo } from 'react'
import type { ProjectContext, SessionInfo } from '../../shared/types'
import { pathsEqual } from '../../shared/path'
import {
  buildWorkspaceFolderGroups,
  sessionFrequencyLabel,
  sessionHeat
} from '../lib/activity'
import { SessionCard } from './SessionCard'

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
 * Build landing page: every folder, with that folder's sessions and activity
 * nested underneath. This is the only cross-folder view — the sidebar rails
 * stay scoped to the folder currently open, so the two never repeat a list.
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
          Open a folder for the coding agent. Every folder and its sessions live here; once you are
          inside one, the left rail keeps just that folder. Chat stays on the Chat tab.
        </p>
        <div className="home-actions">
          {authenticated ? (
            <button type="button" className="btn btn-primary" onClick={onOpenFolder}>
              Open folder…
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
            No folders yet. Open a folder to start a coding-agent session.
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
                    <span className="browse-count">
                      {g.sessions.length} session{g.sessions.length === 1 ? '' : 's'}
                    </span>
                    <div className="workspace-folder-actions">
                      <button
                        type="button"
                        className="btn-mini"
                        disabled={!authenticated}
                        onClick={() => onOpenProject(g.cwd)}
                      >
                        Open
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
                    </div>
                  </div>
                </div>

                {g.sessions.length === 0 ? (
                  <div className="workspace-folder-empty muted-note">
                    No sessions in this folder yet. Open it and send a prompt.
                  </div>
                ) : (
                  <div className="workspace-folder-sessions">
                    {g.sessions.map((s) => (
                      <div key={s.id} className="activity-session-wrap">
                        <SessionCard
                          session={s}
                          active={s.id === activeSessionId}
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
                          <div className="activity-label">{sessionFrequencyLabel(s)}</div>
                        </div>
                      </div>
                    ))}
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
