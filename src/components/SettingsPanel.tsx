import type { AppSettings, ModelInfo, PermissionAuditEntry } from '../../shared/types'

interface Props {
  open: boolean
  settings: AppSettings | null
  models: ModelInfo[]
  grokPath: string | null
  audit: PermissionAuditEntry[]
  onClose: () => void
  onChangeModel: (id: string) => void
  onToggleYolo: () => void
}

export function SettingsPanel({
  open,
  settings,
  models,
  grokPath,
  audit,
  onClose,
  onChangeModel,
  onToggleYolo
}: Props) {
  if (!open) return null

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Settings</h3>

        <div className="settings-block">
          <div className="section-label">Model</div>
          <select
            className="model-select"
            value={settings?.model || models.find((m) => m.isDefault)?.id || ''}
            onChange={(e) => onChangeModel(e.target.value)}
          >
            {models.length === 0 ? (
              <option value="">No models discovered</option>
            ) : (
              models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name || m.id}
                  {m.isDefault ? ' (default)' : ''}
                </option>
              ))
            )}
          </select>
          <p className="settings-hint">
            Changing model restarts the agent for the current project (no new npm packages —
            uses <code>grok models</code>).
          </p>
        </div>

        <div className="settings-block">
          <div className="section-label">Agent binary</div>
          <code className="path-code">{grokPath || 'not found'}</code>
        </div>

        <div className="settings-block">
          <div className="settings-row">
            <label htmlFor="settings-yolo">Bypass permissions (YOLO)</label>
            <button
              id="settings-yolo"
              type="button"
              className={`toggle ${settings?.alwaysApprove ? 'on' : ''}`}
              aria-pressed={!!settings?.alwaysApprove}
              onClick={onToggleYolo}
            />
          </div>
          <p className="settings-hint warn-text">
            Dangerous. Requires explicit confirmation. Prefer leaving this off.
          </p>
        </div>

        <div className="settings-block">
          <div className="section-label">Permission audit (local)</div>
          {audit.length === 0 ? (
            <div className="muted-note">No decisions recorded yet</div>
          ) : (
            <div className="audit-list">
              {audit.slice(0, 12).map((a) => (
                <div key={a.id} className="audit-row">
                  <span className={`audit-decision ${a.decision}`}>{a.decision}</span>
                  <span className="audit-title">{a.title}</span>
                  <span className="audit-time">
                    {new Date(a.at).toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="modal-actions">
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
