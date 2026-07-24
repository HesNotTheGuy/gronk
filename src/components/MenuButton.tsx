import { useEffect, useRef, useState } from 'react'

export interface MenuOption {
  id: string
  label: string
  description?: string
  dangerous?: boolean
}

interface Props {
  /** Short label shown before the value, e.g. "Mode" or "Model" */
  label: string
  /** Currently-selected option id */
  value?: string
  /** Optional display override for the current value */
  valueLabel?: string
  options: MenuOption[]
  onSelect: (id: string) => void
  disabled?: boolean
  title?: string
}

/**
 * Compact "label: value ▾" button that opens a popover list of options.
 * Popover opens upward (it lives in the composer bar at the bottom of the view).
 * Closes on outside-click and Escape.
 */
export function MenuButton({ label, value, valueLabel, options, onSelect, disabled, title }: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
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

  const current = valueLabel || options.find((o) => o.id === value)?.label || value || '—'

  return (
    <div className={`menu-btn-wrap ${open ? 'open' : ''}`} ref={ref}>
      <button
        type="button"
        className="menu-btn"
        disabled={disabled}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="menu-btn-label">{label}</span>
        <span className="menu-btn-value">{current}</span>
        <span className="menu-btn-caret" aria-hidden>
          ▾
        </span>
      </button>
      {open ? (
        <div className="menu-pop" role="listbox" aria-label={label}>
          {options.map((o) => (
            <button
              key={o.id}
              type="button"
              role="option"
              aria-selected={o.id === value}
              className={`menu-pop-item ${o.id === value ? 'active' : ''} ${o.dangerous ? 'danger' : ''}`}
              title={o.description}
              onClick={() => {
                onSelect(o.id)
                setOpen(false)
              }}
            >
              <span className="menu-pop-name">{o.label}</span>
              {o.description ? <span className="menu-pop-desc">{o.description}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
