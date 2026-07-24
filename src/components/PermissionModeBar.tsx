import type { PermissionMode } from '../../shared/types'
import { PERMISSION_MODE_OPTIONS } from '../../shared/types'

interface Props {
  mode: PermissionMode
  disabled?: boolean
  compact?: boolean
  onChange: (mode: PermissionMode) => void
}

export function PermissionModeBar({ mode, disabled, compact, onChange }: Props) {
  return (
    <div
      className={`perm-mode-bar ${compact ? 'compact' : ''}`}
      role="group"
      aria-label="Permission mode"
    >
      {!compact ? <div className="section-label">Mode</div> : null}
      <div className="perm-mode-row">
        {PERMISSION_MODE_OPTIONS.map((opt) => {
          const active = mode === opt.id
          return (
            <button
              key={opt.id}
              type="button"
              className={`perm-mode-btn ${active ? 'active' : ''} ${opt.dangerous ? 'danger' : ''}`}
              disabled={disabled}
              title={opt.description}
              aria-pressed={active}
              onClick={() => onChange(opt.id)}
            >
              {compact ? opt.short : opt.label}
            </button>
          )
        })}
      </div>
      {!compact ? (
        <p className="perm-mode-hint">
          {PERMISSION_MODE_OPTIONS.find((o) => o.id === mode)?.description ||
            'Choose how tools are approved'}
          {mode !== 'default' ? ' · restarts agent when a project is open' : ''}
        </p>
      ) : null}
    </div>
  )
}
