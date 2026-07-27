import type { AuthStatus, LoginMethod } from '../../shared/types'

interface Props {
  auth: AuthStatus | null
  busy: boolean
  deviceHint?: string | null
  message?: string | null
  grokFound: boolean
  onLogin: (method: LoginMethod) => void
  onRefresh: () => void
  onOpenSettings: () => void
  onInstallCli: () => void
}

export function AuthGate({
  auth,
  busy,
  deviceHint,
  message,
  grokFound,
  onLogin,
  onRefresh,
  onOpenSettings,
  onInstallCli
}: Props) {
  const checking = !auth || auth.state === 'checking'

  return (
    <div className="auth-gate">
      <div className="auth-card">
        <div className="auth-kicker">Sign in · required to open projects</div>
        <h2>
          Sign in with <span>your</span> Grok account
        </h2>
        <p className="auth-copy">
          This app does not ship with anyone else&apos;s login. Credentials are never baked into Gronk
          or copied between installs. Sign-in goes through the official Grok CLI on{' '}
          <strong>this</strong> computer, for <strong>this</strong> OS user — so if you are signed in
          here, that does not sign anyone else in on their machine.
        </p>

        <ul className="auth-bullets">
          <li>Browser login opens xAI OAuth (recommended)</li>
          <li>Device code works when a browser can&apos;t open here</li>
          <li>Tokens stay in the local CLI store — not in Gronk settings</li>
          <li>Sign out clears credentials on this machine only</li>
        </ul>

        {!grokFound ? (
          <div className="auth-warn">
            Grok CLI not found on this machine.
            <div className="auth-warn-actions">
              <button type="button" className="btn btn-primary btn-sm" onClick={onInstallCli}>
                Install Grok CLI
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={onOpenSettings}>
                Set path…
              </button>
            </div>
          </div>
        ) : null}

        {message ? <div className="auth-msg">{message}</div> : null}
        {deviceHint ? (
          <pre className="auth-device" aria-live="polite">
            {deviceHint}
          </pre>
        ) : null}

        <div className="auth-status-row">
          <span className={`auth-dot ${auth?.authenticated ? 'ok' : checking ? 'wait' : 'bad'}`} />
          <span>
            {checking
              ? 'Checking CLI credentials…'
              : auth?.authenticated
                ? auth.accountLabel || 'Signed in'
                : auth?.message || 'Not signed in'}
          </span>
        </div>

        <div className="auth-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !grokFound}
            onClick={() => onLogin('oauth')}
          >
            {busy ? 'Waiting for browser…' : 'Sign in with browser'}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy || !grokFound}
            onClick={() => onLogin('device')}
          >
            Device code login
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy}
            onClick={onRefresh}
          >
            Re-check status
          </button>
        </div>

        <p className="auth-footnote">
          Advanced: you may set <code>XAI_API_KEY</code> in <em>your</em> environment. Gronk never
          saves or shows that key, and it only applies to processes on this machine.
        </p>
      </div>
    </div>
  )
}
