import type {
  AppSettings,
  AuthStatus,
  HealthStatus,
  LoginMethod,
  ModelInfo,
  PermissionAuditEntry,
  PermissionMode
} from '../../shared/types'
import { PermissionModeBar } from './PermissionModeBar'

interface Props {
  open: boolean
  settings: AppSettings | null
  models: ModelInfo[]
  grokPath: string | null
  audit: PermissionAuditEntry[]
  health: HealthStatus | null
  auth: AuthStatus | null
  authBusy: boolean
  onClose: () => void
  onChangeModel: (id: string) => void
  onToggleYolo: () => void
  onChangeTheme: (theme: AppSettings['theme']) => void
  onPickBinary: () => void
  onClearBinary: () => void
  onRefreshHealth: () => void
  onLogin: (method: LoginMethod) => void
  onLogout: () => void
  onChangePermissionMode?: (mode: PermissionMode) => void
  onOpenPlugins?: () => void
}

export function SettingsPanel({
  open,
  settings,
  models,
  grokPath,
  audit,
  health,
  auth,
  authBusy,
  onClose,
  onChangeModel,
  onToggleYolo,
  onChangeTheme,
  onPickBinary,
  onClearBinary,
  onRefreshHealth,
  onLogin,
  onLogout,
  onChangePermissionMode,
  onOpenPlugins
}: Props) {
  if (!open) return null

  const mode: PermissionMode =
    settings?.permissionMode ||
    (settings?.alwaysApprove ? 'bypassPermissions' : 'default')

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div
        className="modal settings-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-modal-head">
          <h3>Settings</h3>
          <button
            type="button"
            className="btn-mini settings-close"
            onClick={onClose}
            title="Close settings"
            aria-label="Close settings"
          >
            Close
          </button>
        </div>

        <div className="settings-block">
          <div className="section-label">Account</div>
          <div className="health-grid">
            <div className={`health-row ${auth?.authenticated ? 'ok' : 'bad'}`}>
              <span>Status</span>
              <strong>{auth?.authenticated ? 'Signed in' : 'Signed out'}</strong>
            </div>
            <div className={`health-row ${auth?.authenticated ? 'ok' : ''}`}>
              <span>Via</span>
              <strong>
                {auth?.method === 'api_key_env'
                  ? 'API key (env)'
                  : auth?.method === 'session'
                    ? 'CLI session'
                    : auth?.accountLabel || '—'}
              </strong>
            </div>
            {auth?.accountLabel ? (
              <div className="health-row ok">
                <span>Label</span>
                <strong>{auth.accountLabel}</strong>
              </div>
            ) : null}
          </div>
          <p className="settings-hint">
            Your login is local to this OS user on this machine. Grocky never stores tokens or API
            keys in app settings, and never ships shared credentials. Sign-in uses the Grok CLI (
            <code>~/.grok/auth.json</code> or env <code>XAI_API_KEY</code>) so other people&apos;s
            installs stay signed out until they authenticate themselves.
          </p>
          <div className="btn-row">
            {auth?.authenticated ? (
              <button
                type="button"
                className="btn btn-danger btn-sm"
                disabled={authBusy}
                onClick={onLogout}
              >
                {authBusy ? 'Working…' : 'Sign out'}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={authBusy || !health?.grokFound}
                  onClick={() => onLogin('oauth')}
                >
                  {authBusy ? 'Waiting…' : 'Browser sign-in'}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={authBusy || !health?.grokFound}
                  onClick={() => onLogin('device')}
                >
                  Device code
                </button>
              </>
            )}
          </div>
        </div>

        <div className="settings-block">
          <div className="section-label">Health</div>
          <div className="health-grid">
            <div className={`health-row ${health?.grokFound ? 'ok' : 'bad'}`}>
              <span>Grok CLI</span>
              <strong>{health?.grokFound ? 'Found' : 'Missing'}</strong>
            </div>
            <div className={`health-row ${auth?.authenticated ? 'ok' : 'bad'}`}>
              <span>Auth</span>
              <strong>{auth?.authenticated ? 'OK' : 'Required'}</strong>
            </div>
            <div className="health-row ok">
              <span>Platform</span>
              <strong>{health?.platform || '—'}</strong>
            </div>
          </div>
          <p className="settings-hint">
            {health?.grokFound
              ? auth?.authenticated
                ? 'CLI and credentials look ready.'
                : 'CLI found — sign in above before opening projects.'
              : 'Install Grok CLI or set a custom binary path below.'}
          </p>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onRefreshHealth}>
            Re-check
          </button>
        </div>

        {onChangePermissionMode ? (
          <div className="settings-block">
            <PermissionModeBar
              mode={mode}
              disabled={!auth?.authenticated}
              onChange={onChangePermissionMode}
            />
          </div>
        ) : null}

        <div className="settings-block">
          <div className="section-label">Theme</div>
          <select
            className="model-select"
            value={settings?.theme || 'dark'}
            onChange={(e) => onChangeTheme(e.target.value as AppSettings['theme'])}
          >
            <option value="dark">Dark (void)</option>
            <option value="light">Light</option>
            <option value="system">System</option>
          </select>
        </div>

        <div className="settings-block">
          <div className="section-label">Model</div>
          <select
            className="model-select"
            value={settings?.model || models.find((m) => m.isDefault)?.id || ''}
            onChange={(e) => onChangeModel(e.target.value)}
            disabled={!auth?.authenticated}
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
            Changing model restarts the agent for the current project (uses{' '}
            <code>grok models</code>).
          </p>
        </div>

        <div className="settings-block">
          <div className="section-label">Agent binary</div>
          <code className="path-code">
            {settings?.grokBinary || grokPath || 'not found'}
          </code>
          <div className="btn-row">
            <button type="button" className="btn btn-secondary btn-sm" onClick={onPickBinary}>
              Browse…
            </button>
            {settings?.grokBinary ? (
              <button type="button" className="btn btn-ghost btn-sm" onClick={onClearBinary}>
                Use auto-detect
              </button>
            ) : null}
          </div>
          <p className="settings-hint">
            Override if Grocky cannot find <code>grok</code> on PATH or in ~/.grok/bin.
          </p>
        </div>

        {onOpenPlugins ? (
          <div className="settings-block">
            <div className="section-label">Plugins &amp; Skills</div>
            <div className="btn-row">
              <button type="button" className="btn btn-secondary btn-sm" onClick={onOpenPlugins}>
                Manage plugins…
              </button>
            </div>
            <p className="settings-hint">
              Browse marketplaces, install skills, and configure MCP servers. Plugin code runs on
              your machine with your permissions — outside Grocky&apos;s file protections.
            </p>
          </div>
        ) : null}

        <div className="settings-block">
          <div className="settings-row">
            <label htmlFor="settings-yolo">Bypass permissions (YOLO)</label>
            <button
              id="settings-yolo"
              type="button"
              className={`toggle ${settings?.alwaysApprove ? 'on' : ''}`}
              aria-pressed={!!settings?.alwaysApprove}
              onClick={onToggleYolo}
              disabled={!auth?.authenticated}
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
                  <span className="audit-time">{new Date(a.at).toLocaleString()}</span>
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
