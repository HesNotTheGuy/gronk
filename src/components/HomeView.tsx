import { useMemo } from 'react'
import type { ProjectContext, SessionInfo } from '../../shared/types'
import { folderName } from '../../shared/path'
import {
  buildProjectActivity,
  sessionFrequencyLabel,
  sessionHeat
} from '../lib/activity'
import type { ActivityCalendarState } from '../hooks/useActivityCalendar'
import { ActivityCalendar } from './ActivityCalendar'
import { SessionCard } from './SessionCard'

interface Props {
  projects: ProjectContext[]
  /** Non-chat project sessions for the home feed */
  sessions: SessionInfo[]
  authenticated: boolean
  authLabel?: string
  grokFound: boolean
  model?: string
  /** Parent-owned calendar so Home unmount does not drop the grid. */
  activityCalendar: ActivityCalendarState
  /** Local day currently filtering the sidebar, if any. */
  selectedActivityDay?: string | null
  onSelectActivityDay?: (dayKey: string) => void
  onOpenChat: () => void
  onOpenProjects: () => void
  onOpenProject: (cwd: string) => void
  onSelectSession: (s: SessionInfo) => void
  onRenameSession: (id: string, title: string) => void
  onArchiveSession: (id: string) => void
  onDeleteSession: (id: string) => void
  onSignIn: () => void
  onSettings: () => void
}

export function HomeView({
  projects,
  sessions,
  authenticated,
  authLabel,
  grokFound,
  model,
  activityCalendar,
  selectedActivityDay = null,
  onSelectActivityDay,
  onOpenChat,
  onOpenProjects,
  onOpenProject,
  onSelectSession,
  onRenameSession,
  onArchiveSession,
  onDeleteSession,
  onSignIn,
  onSettings
}: Props) {
  const projectActivity = useMemo(
    () => buildProjectActivity(projects, sessions),
    [projects, sessions]
  )

  const recentSessions = useMemo(
    () =>
      [...sessions]
        .filter((s) => !s.archived)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 12),
    [sessions]
  )

  return (
    <div className="home-view browse-home">
      <div className="browse-hero">
        <p className="home-kicker">Home</p>
        <h1>
          Grok on your <span>desktop</span>
        </h1>
        <p className="home-copy">
          <strong>Chat</strong> is a conversation. Ask things, work through ideas, paste images. It
          has no project folder, so it never reads or edits your files. <strong>Build</strong> points
          Grok at a folder on your computer, where it can read, edit and run what is inside.
          Frequency shows how much you&apos;ve been using each item.
        </p>

        <div className="home-actions">
          <button type="button" className="btn btn-primary" onClick={onOpenChat}>
            Chat
          </button>
          <button type="button" className="btn btn-secondary" onClick={onOpenProjects}>
            Build
          </button>
          {!authenticated ? (
            <button type="button" className="btn btn-ghost" onClick={onSignIn}>
              Sign in
            </button>
          ) : null}
          {!grokFound ? (
            <button type="button" className="btn btn-ghost" onClick={onSettings}>
              Set up CLI
            </button>
          ) : null}
        </div>

        <div className="home-meta">
          <span>
            Account <strong>{authenticated ? authLabel || 'Signed in' : 'Not signed in'}</strong>
          </span>
          <span>
            CLI <strong>{grokFound ? 'Ready' : 'Missing'}</strong>
          </span>
          <span>
            Model <strong>{model || 'default'}</strong>
          </span>
        </div>
      </div>

      {/* Single scrollable feed: one panel so sections never overlay each other */}
      <section className="home-feed">
        <div className="home-feed-block">
          <ActivityCalendar
            state={activityCalendar}
            selectedDay={selectedActivityDay}
            onSelectDay={onSelectActivityDay}
          />
        </div>

        <div className="home-feed-block">
          <div className="browse-panel-head">
            <div className="section-label">Folders</div>
            <button type="button" className="btn-mini" onClick={onOpenProjects}>
              Build
            </button>
          </div>
          {projectActivity.length === 0 ? (
            <div className="browse-empty">
              No folders yet. Open a folder from Build to start the coding agent.
            </div>
          ) : (
            <div className="browse-grid">
              {projectActivity.map((a) => (
                <button
                  key={a.project.cwd}
                  type="button"
                  className="browse-card project-browse-card activity-card"
                  disabled={!authenticated}
                  onClick={() => onOpenProject(a.project.cwd)}
                  title={a.project.cwd}
                >
                  <div className="browse-card-title">{a.project.name}</div>
                  <div className="browse-card-sub">{a.project.cwd}</div>
                  <div className="activity-row">
                    <div className="activity-bar" aria-hidden>
                      <div
                        className="activity-fill"
                        style={{ width: `${Math.round(a.heat * 100)}%` }}
                      />
                    </div>
                    <div className="activity-label">{a.frequencyLabel}</div>
                  </div>
                  <div className="activity-stats">
                    <span>
                      {a.sessionCount} session{a.sessionCount === 1 ? '' : 's'}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="home-feed-block">
          <div className="browse-panel-head">
            <div className="section-label">Build sessions</div>
            <button type="button" className="btn-mini" onClick={onOpenProjects}>
              Build
            </button>
          </div>
          {recentSessions.length === 0 ? (
            <div className="browse-empty">
              No Build sessions yet. They appear after you use the coding agent in a folder.
            </div>
          ) : (
            <div className="browse-grid">
              {recentSessions.map((s) => (
                <div key={s.id} className="activity-session-wrap">
                  <SessionCard
                    session={s}
                    subtitle={folderName(s.cwd)}
                    onSelect={() => onSelectSession(s)}
                    onRename={(t) => onRenameSession(s.id, t)}
                    onArchive={() => onArchiveSession(s.id)}
                    onDelete={() => onDeleteSession(s.id)}
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
        </div>
      </section>
    </div>
  )
}
