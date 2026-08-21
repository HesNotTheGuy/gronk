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
  /**
   * `labelled` is the composer's "Mode: Default ▾". `icon` is a bare glyph for a
   * dense row, where a label would not fit and the options name themselves.
   */
  trigger?: 'labelled' | 'icon'
  /** Composer menus open upward; a row near the top of a list must open down. */
  placement?: 'up' | 'down'
  /**
   * Glyph for the icon trigger.
   *
   * Vertical (U+22EE), not horizontal. The horizontal '⋯' sat to the right of a title
   * that truncates with `text-overflow: ellipsis`, and the two are the same three dots
   * at row size — so a hovered row with a clipped title showed what read as two menu
   * buttons (#67's sighting: one "inside the row's background", the title's own
   * ellipsis, and one outside it, this control fading in on hover). A vertical glyph
   * cannot be produced by text truncation, so if two ever appear again it is a real
   * duplicate control and worth reporting.
   */
  glyph?: string
}

/**
 * Compact "label: value ▾" button that opens a popover list of options.
 * The popover is rendered in a portal on document.body with fixed positioning so
 * it is never clipped by the composer's overflow; it opens upward from the button.
 * Closes on outside-click, Escape, and window resize.
 */
export function MenuButton({
  label,
  value,
  valueLabel,
  options,
  onSelect,
  disabled,
  title,
  trigger = 'labelled',
  placement = 'up',
  glyph = '⋮'
}: Props) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{
    left: number
    bottom?: number
    top?: number
    maxHeight: number
  } | null>(null)
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const popRef = useRef<HTMLDivElement | null>(null)

  const place = (): void => {
    const r = btnRef.current?.getBoundingClientRect()
    if (!r) return
    if (placement === 'down') {
      // Right-aligned to the trigger so a menu on a narrow row cannot run off
      // the edge, and capped to the space actually below it.
      setPos({
        left: Math.max(8, r.right - 200),
        top: r.bottom + 6,
        maxHeight: Math.max(140, window.innerHeight - r.bottom - 16)
      })
    } else {
      setPos({
        left: r.left,
        bottom: window.innerHeight - r.top + 6, // sit just above the button, grow upward
        maxHeight: Math.max(140, r.top - 16) // never taller than the space above the button
      })
    }
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
        className={`menu-btn ${trigger === 'icon' ? 'icon' : ''} ${open ? 'active' : ''}`}
        disabled={disabled}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={(e) => {
          // Defensive only. SessionRow keeps this control as a sibling of the
          // select <button>, and the open menu is portalled (outside-click already
          // ignores popRef). No menu click can reach onSelect in today's layout.
          // Kept so a future wrap under a clickable parent does not start bubbling.
          e.stopPropagation()
          toggle()
        }}
      >
        {trigger === 'icon' ? (
          <span className="menu-btn-glyph" aria-hidden>
            {glyph}
          </span>
        ) : (
          <>
            <span className="menu-btn-label">{label}</span>
            <span className="menu-btn-value">{current}</span>
            <span className="menu-btn-caret" aria-hidden>
              ▾
            </span>
          </>
        )}
      </button>
      {open && pos
        ? createPortal(
            <div
              ref={popRef}
              className="menu-pop"
              role="listbox"
              aria-label={label}
              style={{
                position: 'fixed',
                left: pos.left,
                ...(pos.top !== undefined ? { top: pos.top } : { bottom: pos.bottom }),
                maxHeight: pos.maxHeight
              }}
            >
              {options.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  role="option"
                  aria-selected={o.id === value}
                  /* The one already in force is not a choice. Selecting it used to be
                     accepted and acted on, and for the model picker acting on it meant
                     restarting the agent — so choosing what you already had replaced the
                     conversation with an empty session. Closing the menu is the whole of
                     what a click on it should do. */
                  aria-disabled={o.id === value}
                  className={`menu-pop-item ${o.id === value ? 'active current' : ''} ${o.dangerous ? 'danger' : ''}`}
                  title={o.id === value ? `Already using ${o.label}` : o.description}
                  onClick={() => {
                    if (o.id !== value) onSelect(o.id)
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
