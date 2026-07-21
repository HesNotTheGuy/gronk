import type { ProjectContext, SessionInfo } from '../../shared/types'

interface Props {
  recentProjects: ProjectContext[]
  sessions: SessionInfo[]
  activeCwd: string | null
  activeSessionId: string | null
  alwaysApprove: boolean
  onOpenProject: (cwd?: string | null) => void
  onToggleAlwaysApprove: () => void
  onNewChat: () => void
}

export function Sidebar({
  recentProjects,
  sessions,
  activeCwd,
  activeSessionId,
  alwaysApprove,
  onOpenProject,
  onToggleAlwaysApprove,
  onNewChat
}: Props) {
  const projectSessions = activeCwd
    ? sessions.filter((s) => s.cwd === activeCwd)
    : sessions.slice(0, 8)

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="brand">
          <div className="brand-mark" aria-hidden>
            G
          </div>
          <div className="brand-text">
            <h1>Grocky</h1>
            <p>Agent desktop</p>
          </div>
        </div>
        <button
          type="button"
          className="btn btn-primary btn-block"
          onClick={() => onOpenProject()}
        >
          Open project
        </button>
      </div>

      <div className="sidebar-section">
        <div className="section-label">Recent</div>
        {recentProjects.length === 0 ? (
          <div className="muted-note">No pads loaded</div>
        ) : (
          recentProjects.map((p) => (
            <button
              key={p.cwd}
              type="button"
              className={`project-card ${p.cwd === activeCwd ? 'active' : ''}`}
              onClick={() => onOpenProject(p.cwd)}
              title={p.cwd}
            >
              <div className="name">{p.name}</div>
              <div className="path">{p.cwd}</div>
            </button>
          ))
        )}
      </div>

      <div className="sidebar-section grow">
        <div className="section-label">Sessions</div>
        {projectSessions.length === 0 ? (
          <div className="muted-note">Telemetry after first prompt</div>
        ) : (
          projectSessions.map((s) => (
            <div
              key={s.id}
              className={`session-item ${s.id === activeSessionId ? 'active' : ''}`}
              title={s.id}
            >
              <div className="name">{s.title || s.id.slice(0, 8)}</div>
              <div className="meta">{new Date(s.updatedAt).toLocaleString()}</div>
            </div>
          ))
        )}
      </div>

      <div className="sidebar-footer">
        {activeCwd ? (
          <button type="button" className="btn btn-secondary btn-block" onClick={onNewChat}>
            New session
          </button>
        ) : null}
        <div className="settings-row">
          <label htmlFor="always-approve">Auto-approve</label>
          <button
            id="always-approve"
            type="button"
            className={`toggle ${alwaysApprove ? 'on' : ''}`}
            aria-pressed={alwaysApprove}
            onClick={onToggleAlwaysApprove}
            title="Passes --always-approve to grok agent (use carefully)"
          />
        </div>
        <div className="version-tag">v0.1 · ACP link</div>
      </div>
    </aside>
  )
}
