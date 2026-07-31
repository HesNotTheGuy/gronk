import { useEffect, useRef, useState } from 'react'
import { MenuButton } from './MenuButton'
import type { MenuOption } from './MenuButton'
import type { SessionInfo } from '../../shared/types'

interface Props {
  session: SessionInfo
  active: boolean
  authenticated: boolean
  /** Secondary line under the title — date, or project name in search results. */
  meta: string
  /** Optional third line, used for a search snippet. */
  detail?: string | null
  onSelect: () => void
  onRename: (title: string) => void
  onArchive: () => void
  onExport: (format: 'md' | 'json') => void
  onDelete: () => void
}

const OPTIONS: MenuOption[] = [
  { id: 'rename', label: 'Rename' },
  { id: 'archive', label: 'Archive', description: 'Hide it without deleting' },
  { id: 'export-md', label: 'Export as Markdown' },
  { id: 'export-json', label: 'Export as JSON' },
  { id: 'delete', label: 'Delete', description: 'Permanent', dangerous: true }
]

/**
 * A session in the sidebar, with the actions that used to live only in the
 * browse views.
 *
 * The rail became the primary navigator, which moved people away from the one
 * place Rename / Archive / Export / Delete were reachable. The row cannot simply
 * be a button any more — a menu control cannot nest inside one — so the click
 * target and the menu are siblings.
 *
 * Delete asks first. Archive does not: it is reversible, and a confirm on every
 * tidy-up trains people to dismiss dialogs without reading them.
 */
export function SessionRow({
  session,
  active,
  authenticated,
  meta,
  detail,
  onSelect,
  onRename,
  onArchive,
  onExport,
  onDelete
}: Props) {
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState('')
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const title = (session.title || session.id.slice(0, 8)).trim()

  useEffect(() => {
    if (renaming) inputRef.current?.select()
  }, [renaming])

  const commitRename = (): void => {
    const next = draft.trim()
    setRenaming(false)
    // An unchanged or emptied title is a cancel, not a rename to "".
    if (next && next !== title) onRename(next)
  }

  const choose = (id: string): void => {
    if (id === 'rename') {
      setDraft(title)
      setRenaming(true)
    } else if (id === 'archive') onArchive()
    else if (id === 'export-md') onExport('md')
    else if (id === 'export-json') onExport('json')
    else if (id === 'delete') setConfirmingDelete(true)
  }

  if (renaming) {
    return (
      <div className={`session-item-row ${active ? 'active' : ''}`}>
        <input
          ref={inputRef}
          className="session-rename-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename()
            if (e.key === 'Escape') setRenaming(false)
          }}
          aria-label={`Rename ${title}`}
        />
      </div>
    )
  }

  if (confirmingDelete) {
    return (
      <div className="session-item-row confirming">
        <div className="session-confirm-text">Delete “{title}”?</div>
        <div className="session-confirm-actions">
          <button type="button" className="btn-mini" onClick={() => setConfirmingDelete(false)}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-mini danger"
            onClick={() => {
              setConfirmingDelete(false)
              onDelete()
            }}
          >
            Delete
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className={`session-item-row ${active ? 'active' : ''}`}>
      <button
        type="button"
        className="session-item"
        disabled={!authenticated}
        title={title}
        onClick={onSelect}
      >
        <div className="name">{title}</div>
        <div className="meta">{meta}</div>
        {detail ? <div className="search-snippet">{detail}</div> : null}
      </button>
      <MenuButton
        label="Session actions"
        title={`Actions for ${title}`}
        trigger="icon"
        placement="down"
        options={OPTIONS}
        onSelect={choose}
        disabled={!authenticated}
      />
    </div>
  )
}
