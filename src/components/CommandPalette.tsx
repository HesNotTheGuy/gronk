import { useEffect, useMemo, useRef, useState } from 'react'

export interface PaletteAction {
  id: string
  label: string
  hint?: string
  group?: string
  run: () => void
}

interface Props {
  open: boolean
  actions: PaletteAction[]
  onClose: () => void
}

/**
 * Keyboard-first jump list. Keeps chrome dense without teaching every shortcut
 * on the topbar. Opened with Ctrl/Cmd+K from App.
 */
export function CommandPalette({ open, actions, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return actions
    return actions.filter(
      (a) =>
        a.label.toLowerCase().includes(q) ||
        (a.hint && a.hint.toLowerCase().includes(q)) ||
        (a.group && a.group.toLowerCase().includes(q))
    )
  }, [actions, query])

  useEffect(() => {
    if (!open) {
      setQuery('')
      setIndex(0)
      return
    }
    setIndex(0)
    const t = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [open])

  useEffect(() => {
    if (index >= filtered.length) setIndex(Math.max(0, filtered.length - 1))
  }, [filtered.length, index])

  if (!open) return null

  const run = (action: PaletteAction) => {
    onClose()
    action.run()
  }

  return (
    <div className="modal-backdrop palette-backdrop" role="dialog" aria-modal="true" aria-label="Command palette">
      <button type="button" className="session-menu-backdrop" aria-label="Close palette" onClick={onClose} />
      <div className="palette-panel">
        <input
          ref={inputRef}
          className="palette-input"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setIndex(0)
          }}
          placeholder="Jump to…"
          aria-label="Filter commands"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              onClose()
              return
            }
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setIndex((i) => Math.min(i + 1, Math.max(0, filtered.length - 1)))
              return
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault()
              setIndex((i) => Math.max(i - 1, 0))
              return
            }
            if (e.key === 'Enter') {
              e.preventDefault()
              const a = filtered[index]
              if (a) run(a)
            }
          }}
        />
        <div className="palette-list" role="listbox">
          {filtered.length === 0 ? (
            <div className="palette-empty">No matches</div>
          ) : (
            filtered.map((a, i) => (
              <button
                key={a.id}
                type="button"
                role="option"
                aria-selected={i === index}
                className={`palette-item ${i === index ? 'active' : ''}`}
                onMouseEnter={() => setIndex(i)}
                onClick={() => run(a)}
              >
                <span className="palette-item-label">{a.label}</span>
                {a.hint ? <span className="palette-item-hint">{a.hint}</span> : null}
              </button>
            ))
          )}
        </div>
        <div className="palette-footer">
          <span>↑↓ move</span>
          <span>↵ run</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  )
}
