import { useEffect, useState } from 'react'
import type {
  AppSettings,
  AuthStatus,
  CliVersionInfo,
  DataLocation,
  HealthStatus,
  LoginMethod,
  ModelInfo,
  PermissionAuditEntry,
  PermissionMode
} from '../../shared/types'
import { cloudSyncServiceFor } from '@shared/path'
import { PermissionModeBar } from './PermissionModeBar'

/**
 * Colour for the CLI-version row.
 *
 * `unknown` stays neutral on purpose: we have no evidence the CLI is wrong, only
 * that we could not read its version, and a red row for that is the cry-wolf the
 * whole check exists to avoid. Only a real minor/major drift, the kind that can
 * rename the JSON keys Gronk reads, earns the alarm colour.
 */
function cliVersionTone(info: CliVersionInfo | null): string {
  if (!info || info.status === 'unknown') return ''
  return info.status === 'ok' ? 'ok' : 'bad'
}

/** Store size, so the user can see what a move would actually carry. */
function formatBytes(bytes?: number): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

const ISSUES_URL = 'https://github.com/HesNotTheGuy/gronk/issues/new'

/**
 * Prefilled report skeleton. Deliberately carries only the OS: no paths, no
 * account label, no transcript. Anything more would put the user's data in a
 * public issue before they had a chance to read it.
 */
function issueTemplate(platform?: string): string {
  return [
    '### What happened',
    '',
    '',
    '### What you expected',
    '',
    '',
    '### Steps to reproduce',
    '1. ',
    '2. ',
    '',
    '---',
    `Platform: ${platform || 'unknown'}`
  ].join('\n')
}

interface Props {
  open: boolean
  settings: AppSettings | null
  models: ModelInfo[]
  grokPath: string | null
  audit: PermissionAuditEntry[]
  health: HealthStatus | null
  auth: AuthStatus | null
  authBusy: boolean
  dataLocation: DataLocation | null
  dataBusy: boolean
  dataError: string | null
  dataNotice: string | null
  onClose: () => void
  onChangeModel: (id: string) => void
  onToggleYolo: () => void
  onChangeTheme: (theme: AppSettings['theme']) => void
  onPickBinary: () => void
  onClearBinary: () => void
  onRefreshHealth: () => void
  onLogin: (method: LoginMethod) => void
  onLogout: () => void
  /** Opens the directory picker; resolves to null when the user cancels. */
  onChooseDataDir: () => Promise<string | null>
  onMoveDataDir: (target: string) => void
  onResetDataDir: () => void
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
  dataLocation,
  dataBusy,
  dataError,
  dataNotice,
  onClose,
  onChangeModel,
  onToggleYolo,
  onChangeTheme,
  onPickBinary,
  onClearBinary,
  onRefreshHealth,
  onLogin,
  onLogout,
  onChooseDataDir,
  onMoveDataDir,
  onResetDataDir,
  onChangePermissionMode,
  onOpenPlugins
}: Props) {
  /**
   * What "follow grok" resolves to right now, named so the choice is not a blind one.
   * Absent when the model list could not be read, in which case the option still works
   * — it means "send no model", which does not depend on knowing the answer.
   */
  const defaultModelName = models.find((m) => m.isDefault)?.name
  /** Chosen destination awaiting confirmation. A move is never one click. */
  const [pendingTarget, setPendingTarget] = useState<string | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)
  const [cliVersion, setCliVersion] = useState<CliVersionInfo | null>(null)

  // Closing the panel must not leave a confirmation armed for the next open.
  // Only setState here, never a prop, so this cannot re-fire on prop identity.
  useEffect(() => {
    if (!open) {
      setPendingTarget(null)
      setConfirmReset(false)
    }
  }, [open])

  // Probed straight from the panel rather than threaded through app state: the
  // version is only ever shown here, and the main-process probe is cached and
  // single-flighted, so re-reading it on each open costs nothing. Opening the
  // panel is also the natural moment to refresh it.
  useEffect(() => {
    let cancelled = false
    if (open) {
      void window.gronk.getCliVersion().then(
        (info) => {
          if (!cancelled) setCliVersion(info)
        },
        () => {
          // A failed probe must not blank out the rest of Settings.
          if (!cancelled) setCliVersion(null)
        }
      )
    }
    return () => {
      cancelled = true
    }
  }, [open])

  if (!open) return null

  const mode: PermissionMode =
    settings?.permissionMode ||
    (settings?.alwaysApprove ? 'bypassPermissions' : 'default')

  const pickTarget = async () => {
    const target = await onChooseDataDir()
    if (target) setPendingTarget(target)
  }

  /**
   * Warn, never block. Transcripts are stored as readable text, so relocating
   * them into a synced folder hands every conversation to that provider. Plenty
   * of people sync on purpose and this cannot tell the difference, so it informs
   * the decision rather than overriding it.
   */
  const pendingCloudService = pendingTarget ? cloudSyncServiceFor(pendingTarget) : null

  const confirmMove = () => {
    const target = pendingTarget
    setPendingTarget(null)
    if (target) onMoveDataDir(target)
  }

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
            Your login is local to this OS user on this machine. Gronk never stores tokens or API
            keys in app settings, and never ships shared credentials. Sign-in uses the Grok CLI (
            <code>~/.grok/auth.json</code> or env <code>XAI_API_KEY</code>) so other people&apos;s
            installs stay signed out until they authenticate themselves.
          </p>
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={authBusy || !health?.grokFound}
              onClick={() => onLogin('oauth')}
            >
              {authBusy
                ? 'Waiting…'
                : auth?.authenticated
                  ? 'Sign in again'
                  : 'Browser sign-in'}
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={authBusy || !health?.grokFound}
              onClick={() => onLogin('device')}
            >
              Device code
            </button>
            {auth?.authenticated ? (
              <button
                type="button"
                className="btn btn-danger btn-sm"
                disabled={authBusy}
                onClick={onLogout}
              >
                {authBusy ? 'Working…' : 'Sign out'}
              </button>
            ) : null}
          </div>
        </div>

        <div className="settings-block">
          <div className="section-label">Health</div>
          <div className="health-grid">
            <div className={`health-row ${health?.grokFound ? 'ok' : 'bad'}`}>
              <span>Grok CLI</span>
              <strong>{health?.grokFound ? 'Found' : 'Missing'}</strong>
            </div>
            <div
              className={`health-row ${cliVersionTone(cliVersion)}`}
              title={
                cliVersion
                  ? `Gronk's plugin and MCP output parsing was verified against ${cliVersion.verifiedAgainst}`
                  : undefined
              }
            >
              <span>CLI version</span>
              <strong>
                {cliVersion?.current || '—'}
                {cliVersion?.current && cliVersion.channel ? ` · ${cliVersion.channel}` : ''}
              </strong>
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
                : 'CLI found. Sign in above before opening projects.'
              : 'Install Grok CLI or set a custom binary path below.'}
          </p>
          {/*
            Only shown once the CLI is actually present and its version differs
            by more than a patch. A patch bump classifies as `ok` and prints
            nothing. The CLI self-updates through those constantly, and nagging
            about them would train the user to skip the message that matters.
            The consequence is spelled out rather than the version diff, because
            an empty plugin list is what the user will actually see.
          */}
          {health?.grokFound && cliVersion && cliVersion.status !== 'ok' && cliVersion.message ? (
            <p className="settings-hint warn-text">{cliVersion.message}</p>
          ) : null}
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
          <div className="section-label">Model for new sessions</div>
          {/*
            `settings?.model ?? ''` and nothing else. This used to fall back to the
            model grok reports as its default, so a pinned install and an unpinned one
            looked identical here — the one screen that could have said which it was.
            Empty is a real, distinct state: no model is stored and none is sent.
          */}
          {/* `model-select` is a shared style class — the theme dropdown above wears it
              too — so the label is also what identifies this control. */}
          <select
            className="model-select"
            aria-label="Model for new sessions"
            value={settings?.model ?? ''}
            onChange={(e) => onChangeModel(e.target.value)}
            disabled={!auth?.authenticated}
          >
            <option value="">
              {defaultModelName ? `Follow grok (${defaultModelName})` : 'Follow grok'}
            </option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name || m.id}
              </option>
            ))}
          </select>
          <p className="settings-hint">
            {settings?.model
              ? 'New sessions are pinned to this model. Grok releasing a newer one will not change it until you choose Follow grok.'
              : 'New sessions use whatever grok defaults to, so a newer model arrives on its own.'}{' '}
            Switching model inside a conversation changes that conversation only.
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
            Override if Gronk cannot find <code>grok</code> on PATH or in ~/.grok/bin.
          </p>
        </div>

        <div className="settings-block">
          <div className="section-label">Data location</div>
          <div className="health-grid">
            <div className={`health-row ${dataLocation?.isDefault ? 'ok' : ''}`}>
              <span>Folder</span>
              <strong>
                {dataLocation ? (dataLocation.isDefault ? 'Default' : 'Custom') : '—'}
              </strong>
            </div>
            <div className="health-row ok">
              <span>Transcripts</span>
              <strong>{formatBytes(dataLocation?.storeBytes)}</strong>
            </div>
          </div>
          {/* A path is user data, not markup: plain text inside a code box. */}
          <code className="path-code data-path">
            {dataLocation?.dataDir || 'Reading…'}
          </code>
          <p className="settings-hint">
            Your transcripts and the Chat sandbox live here. Moving them copies everything to
            the new folder, verifies it, and only then removes the old copy.
          </p>
          {dataNotice ? <p className="settings-hint data-ok">{dataNotice}</p> : null}
          {dataError ? <p className="settings-hint warn-text">{dataError}</p> : null}
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={dataBusy}
              onClick={() => void pickTarget()}
            >
              {dataBusy ? 'Working…' : 'Move…'}
            </button>
            {dataLocation && !dataLocation.isDefault ? (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={dataBusy}
                onClick={() => setConfirmReset(true)}
              >
                Reset to default
              </button>
            ) : null}
          </div>
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
              your machine with your permissions, outside Gronk&apos;s file protections.
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

        <div className="settings-block">
          <div className="section-label">Help</div>
          {/*
            A plain external link, not an IPC call: the window-open handler already
            routes target=_blank through openExternalSafely, which allows only
            http/https/mailto. Prefilling the body from `platform` alone keeps the
            report useful without volunteering paths, account labels or transcripts.
            The user can see and edit everything before submitting on GitHub.
          */}
          <a
            className="btn btn-secondary btn-sm"
            href={`${ISSUES_URL}?body=${encodeURIComponent(issueTemplate(health?.platform))}`}
            target="_blank"
            rel="noreferrer"
          >
            Report an issue
          </a>
          <p className="settings-hint">
            Opens the Gronk issue tracker in your browser. Nothing is sent automatically. You
            write and submit the report yourself.
          </p>
        </div>

        <div className="modal-actions">
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Close
          </button>
        </div>

        {pendingTarget ? (
          <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Confirm data move">
            <div className="modal data-move-modal">
              <h3>Move Gronk&apos;s data?</h3>
              <dl className="data-move-paths">
                <dt>From</dt>
                <dd>
                  <code className="path-code data-path">{dataLocation?.dataDir || '—'}</code>
                </dd>
                <dt>To</dt>
                <dd>
                  <code className="path-code data-path">{pendingTarget}</code>
                </dd>
              </dl>
              <p className="settings-hint">
                Your transcripts and the Chat sandbox are copied to the new folder and verified
                there. Only then are they removed from the old one. Nothing is deleted before
                the copy checks out.
              </p>
              {pendingCloudService ? (
                <p className="settings-hint warn-text">
                  <strong>{pendingCloudService} syncs this folder to the internet.</strong>{' '}
                  Transcripts are stored as readable text, so every conversation, including
                  anything you have pasted into one, would be uploaded and kept by that service.
                  Pick a folder outside it unless that is what you want.
                </p>
              ) : null}
              <p className="settings-hint warn-text">
                The app must not have a running agent. Stop the current Chat or Build session
                first, or the move is refused.
              </p>
              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setPendingTarget(null)}
                >
                  Cancel
                </button>
                <button type="button" className="btn btn-primary" onClick={confirmMove}>
                  Move data
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {confirmReset ? (
          <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Confirm reset to default">
            <div className="modal data-move-modal">
              <h3>Move data back to the default folder?</h3>
              <dl className="data-move-paths">
                <dt>From</dt>
                <dd>
                  <code className="path-code data-path">{dataLocation?.dataDir || '—'}</code>
                </dd>
                <dt>To</dt>
                <dd>
                  <code className="path-code data-path">{dataLocation?.defaultDir || '—'}</code>
                </dd>
              </dl>
              <p className="settings-hint">
                Same operation in reverse: copied to the default folder, verified, and only then
                removed from the current one.
              </p>
              <p className="settings-hint warn-text">
                The app must not have a running agent. Stop the current Chat or Build session
                first, or the move is refused.
              </p>
              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setConfirmReset(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    setConfirmReset(false)
                    onResetDataDir()
                  }}
                >
                  Move data
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
