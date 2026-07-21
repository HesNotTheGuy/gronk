import type { ModelInfo, ProjectContext, SessionInfo } from '../../shared/types'

interface Props {
  recentProjects: ProjectContext[]
  sessions: SessionInfo[]
  activeCwd: string | null
  activeSessionId: string | null
  alwaysApprove: boolean
  models: ModelInfo[]
  currentModel?: string
  onOpenProject: (cwd?: string | null) => void
  onSelectSession: (session: SessionInfo) => void
  onToggleAlwaysApprove: () => void
  onNewChat: () => void
  onOpenSettings: () => void
  onChangeModel: (id: string) => void
}

function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '')
}

export function Sidebar({
  recentProjects,
  sessions,
  activeCwd,
  activeSessionId,
  alwaysApprove,
  models,
  currentModel,
  onOpenProject,
  onSelectSession,
  onToggleAlwaysApprove,
  onNewChat,
  onOpenSettings,
  onChangeModel
}: Props) {
  const projectSessions = activeCwd
    ? sessions.filter((s) => norm(s.cwd) === norm(activeCwd))
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
        <div className="section-label">Model</div>
        <select
          className="model-select sidebar-select"
          value={currentModel || models.find((m) => m.isDefault)?.id || ''}
          onChange={(e) => onChangeModel(e.target.value)}
          title="Restart agent when changed"
        >
          {models.length === 0 ? (
            <option value="">Discovering…</option>
          ) : (
            models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name || m.id}
              </option>
            ))
          )}
        </select>
      </div>

      <div className="sidebar-section">
        <div className="section-label">Recent</div>
        {recentProjects.length === 0 ? (
          <div className="muted-note">No pads loaded</div>
        ) : (
          recentProjects.map((p) => (
            <button
              key={norm(p.cwd)}
              type="button"
              className={`project-card ${activeCwd && norm(p.cwd) === norm(activeCwd) ? 'active' : ''}`}
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
          <div className="muted-note">After first prompt</div>
        ) : (
          projectSessions.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`session-item ${s.id === activeSessionId ? 'active' : ''}`}
              title={s.id}
              onClick={() => onSelectSession(s)}
            >
              <div className="name">{s.title || s.id.slice(0, 8)}</div>
              <div className="meta">{new Date(s.updatedAt).toLocaleString()}</div>
            </button>
          ))
        )}
      </div>

      <div className="sidebar-footer">
        {activeCwd ? (
          <button type="button" className="btn btn-secondary btn-block" onClick={onNewChat}>
            New session
          </button>
        ) : null}
        <button type="button" className="btn btn-ghost btn-block" onClick={onOpenSettings}>
          Settings
        </button>
        <div className="settings-row">
          <label htmlFor="always-approve">Bypass perms</label>
          <button
            id="always-approve"
            type="button"
            className={`toggle ${alwaysApprove ? 'on' : ''}`}
            aria-pressed={alwaysApprove}
            onClick={onToggleAlwaysApprove}
            title="Requires confirmation. Passes --always-approve to grok agent."
          />
        </div>
        <div className="version-tag">v0.1.1 · phase A</div>
      </div>
    </aside>
  )
}
