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
  /** When the outside mousedown closed the menu, so the click it becomes is not an action. */
  const closedByOutsideAt = useRef(0)

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
      // The click this mousedown becomes must not land. The old card menu put a
      // full-window backdrop under its popup so a dismissing click hit the shield;
      // this control just closed on mousedown and let the click through, so
      // dismissing a menu by clicking another card SELECTED that card — and in the
      // archived list, opening restores too, so a dismissal un-archived a session.
      // The swallow is armed imperatively because this effect tears down the moment
      // `open` flips false, before the click arrives.
      closedByOutsideAt.current = Date.now()
      const swallow = (click: MouseEvent): void => {
        // A click that arrives much later is a new intention, not the dismissal.
        if (Date.now() - closedByOutsideAt.current > 700) return
        click.stopPropagation()
        click.preventDefault()
      }
      document.addEventListener('click', swallow, { capture: true, once: true })
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setOpen(false)
        // Focus went into the portal; leaving it at the end of document.body
        // strands keyboard users.
        btnRef.current?.focus()
      }
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

  /**
   * Keyboard access. The popup portals to the end of document.body, so without
   * moving focus the items sit after everything else in tab order — reachable in
   * principle, unreachable in practice, and invisible to assistive tech inside an
   * aria-modal dialog (the archived list) that the portal renders outside of.
   * Focus follows the menu in, arrows move it, and every way out puts it back on
   * the trigger.
   */
  useEffect(() => {
    if (!open) return
    const pop = popRef.current
    if (!pop) return
    const items = (): HTMLButtonElement[] =>
      Array.from(pop.querySelectorAll<HTMLButtonElement>('.menu-pop-item'))
    // The one in force, else the first: matches where a native select opens.
    const start = items().find((b) => b.classList.contains('current')) ?? items()[0]
    start?.focus()

    const onKey = (e: KeyboardEvent): void => {
      const list = items()
      const at = list.indexOf(document.activeElement as HTMLButtonElement)
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const delta = e.key === 'ArrowDown' ? 1 : -1
        const next = list[(at + delta + list.length) % list.length]
        next?.focus()
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault()
        ;(e.key === 'Home' ? list[0] : list[list.length - 1])?.focus()
      } else if (e.key === 'Tab') {
        // Tabbing from the end of document.body goes nowhere useful. Close and
        // hand focus back so the next Tab continues from the trigger.
        e.preventDefault()
        setOpen(false)
        btnRef.current?.focus()
      }
    }
    pop.addEventListener('keydown', onKey)
    return () => pop.removeEventListener('keydown', onKey)
  }, [open, pos])

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
                    // Selection moved focus into the portal; put it back where the
                    // keyboard left off.
                    btnRef.current?.focus()
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
