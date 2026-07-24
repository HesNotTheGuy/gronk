import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

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
 * The popover is rendered in a portal on document.body with fixed positioning so
 * it is never clipped by the composer's overflow; it opens upward from the button.
 * Closes on outside-click, Escape, and window resize.
 */
export function MenuButton({ label, value, valueLabel, options, onSelect, disabled, title }: Props) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; bottom: number; maxHeight: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const popRef = useRef<HTMLDivElement | null>(null)

  const place = (): void => {
    const r = btnRef.current?.getBoundingClientRect()
    if (!r) return
    setPos({
      left: r.left,
      bottom: window.innerHeight - r.top + 6, // sit just above the button, grow upward
      maxHeight: Math.max(140, r.top - 16) // never taller than the space above the button
    })
  }

  const toggle = (): void => {
    if (!open) place()
    setOpen((v) => !v)
  }

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      const t = e.target as Node
      if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onReflow = (): void => setOpen(false)
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onReflow)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onReflow)
    }
  }, [open])

  const current = valueLabel || options.find((o) => o.id === value)?.label || value || '—'

  return (
    <div className="menu-btn-wrap">
      <button
        ref={btnRef}
        type="button"
        className={`menu-btn ${open ? 'active' : ''}`}
        disabled={disabled}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={toggle}
      >
        <span className="menu-btn-label">{label}</span>
        <span className="menu-btn-value">{current}</span>
        <span className="menu-btn-caret" aria-hidden>
          ▾
        </span>
      </button>
      {open && pos
        ? createPortal(
            <div
              ref={popRef}
              className="menu-pop"
              role="listbox"
              aria-label={label}
              style={{ position: 'fixed', left: pos.left, bottom: pos.bottom, maxHeight: pos.maxHeight }}
            >
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
            </div>,
            document.body
          )
        : null}
    </div>
  )
}
