import { useEffect, useRef, useState } from 'react'
import type { ConnectionState, ModelInfo } from '../../shared/types'

interface Props {
  connection: ConnectionState
  statusLabel: string
  statusClass: string
  accountLabel?: string
  authenticated: boolean
  model?: string
  models?: ModelInfo[]
  grokPath?: string | null
  /** Show model picker when conversation is live */
  showModel: boolean
  onSignIn: () => void
  onOpenSettings: () => void
  onChangeModel?: (id: string) => void
}

/**
 * One chip for connection + account + model. Replaces three topbar pills that
 * competed with Preview/Export and duplicated the sidebar account chip.
 */
export function StatusMenu({
  connection,
  statusLabel,
  statusClass,
  accountLabel,
  authenticated,
  model,
  models,
  grokPath,
  showModel,
  onSignIn,
  onOpenSettings,
  onChangeModel
}: Props) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const chipLabel = (() => {
    if (!authenticated) return 'Sign in'
    if (showModel && model) {
      const short = model.length > 14 ? `${model.slice(0, 12)}…` : model
      return `${statusLabel} · ${short}`
    }
    return statusLabel
  })()

  return (
    <div className="status-menu" ref={rootRef}>
      <button
        type="button"
        className={`status-pill status-menu-trigger ${statusClass} ${open ? 'open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={grokPath || 'Connection and account'}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="dot" aria-hidden />
        {chipLabel}
      </button>
      {open ? (
        <div className="status-menu-panel" role="menu">
          <div className="status-menu-section">
            <div className="status-menu-label">Connection</div>
            <div className="status-menu-row">
              <span className={`dot inline ${statusClass}`} />
              <span>{statusLabel}</span>
              <span className="status-menu-muted">{connection}</span>
            </div>
            {grokPath ? (
              <div className="status-menu-path" title={grokPath}>
                {grokPath}
              </div>
            ) : (
              <div className="status-menu-muted">Grok CLI not found</div>
            )}
          </div>

          <div className="status-menu-section">
            <div className="status-menu-label">Account</div>
            {authenticated ? (
              <div className="status-menu-row">
                <span>{accountLabel || 'Signed in'}</span>
              </div>
            ) : (
              <button
                type="button"
                className="btn btn-primary btn-sm btn-block"
                role="menuitem"
                onClick={() => {
                  setOpen(false)
                  onSignIn()
                }}
              >
                Sign in
              </button>
            )}
          </div>

          {showModel ? (
            <div className="status-menu-section">
              <div className="status-menu-label">Model</div>
              {models && models.length > 0 && onChangeModel ? (
                <div className="status-menu-models" role="group" aria-label="Model">
                  {models.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={m.id === model}
                      className={`status-menu-model ${m.id === model ? 'active' : ''}`}
                      onClick={() => {
                        onChangeModel(m.id)
                        setOpen(false)
                      }}
                    >
                      {m.name || m.id}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="status-menu-row">{model || 'Default'}</div>
              )}
            </div>
          ) : null}

          <div className="status-menu-section">
            <button
              type="button"
              className="btn btn-ghost btn-sm btn-block"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                onOpenSettings()
              }}
            >
              Settings
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
