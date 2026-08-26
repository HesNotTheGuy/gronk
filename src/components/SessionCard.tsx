import { useState } from 'react'
import { MenuButton } from './MenuButton'
import type { MenuOption } from './MenuButton'
import type { SessionInfo } from '../../shared/types'

interface Props {
  session: SessionInfo
  active?: boolean
  /** Optional subtitle under title (e.g. project name) */
  subtitle?: string
  onSelect: () => void
  onRename: (title: string) => void
  /** Omit to hide Archive (e.g. the archived list itself) */
  onArchive?: () => void
  /** Shown instead of Archive once the session is archived */
  onUnarchive?: () => void
  /** Omit to hide Export. The backend writes .md or .json via a save dialog */
  onExport?: (format: 'md' | 'json') => void
  onDelete: () => void
}

/**
 * A session in the browse views (Chat home, project cards, the archived list).
 *
 * The menu must stay the shared `MenuButton` — a second menu implementation here is
 * invisible to anything auditing menus. Export is flat items, matching the sidebar.
 * Delete confirms in the card: `window.confirm` blocks the whole app and must not
 * return.
 */
export function SessionCard({
  session,
  active,
  subtitle,
  onSelect,
  onRename,
  onArchive,
  onUnarchive,
  onExport,
  onDelete
}: Props) {
  const [renaming, setRenaming] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [titleDraft, setTitleDraft] = useState(session.title || '')
  const title = (session.title || session.id.slice(0, 8)).trim()

  const commitRename = () => {
    const t = titleDraft.trim()
    if (t && t !== session.title) onRename(t)
    setRenaming(false)
  }

  const menuOptions: MenuOption[] = [
    { id: 'rename', label: 'Rename' },
    ...(onExport
      ? [
          { id: 'export-md', label: 'Export as Markdown' },
          { id: 'export-json', label: 'Export as JSON' }
        ]
      : []),
    ...(session.archived
      ? onUnarchive
        ? [{ id: 'restore', label: 'Restore', description: 'Back into the main list' }]
        : []
      : onArchive
        ? [{ id: 'archive', label: 'Archive', description: 'Hide it without deleting' }]
        : []),
    { id: 'delete', label: 'Delete', description: 'Permanent', dangerous: true }
  ]

  const choose = (id: string): void => {
    if (id === 'rename') {
      setTitleDraft(session.title || title)
      setRenaming(true)
    } else if (id === 'export-md') onExport?.('md')
    else if (id === 'export-json') onExport?.('json')
    else if (id === 'restore') onUnarchive?.()
    else if (id === 'archive') onArchive?.()
    else if (id === 'delete') setConfirmingDelete(true)
  }

  if (confirmingDelete) {
    return (
      <div className={`browse-card session-card confirming ${active ? 'active' : ''}`}>
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
    <div className={`browse-card session-card ${active ? 'active' : ''}`}>
      {renaming ? (
        <input
          className="browse-rename"
          value={titleDraft}
          autoFocus
          /* onInput, not onChange: identical in a real browser, but jsdom never
             synthesizes onChange from a dispatched input event, so onChange is
             untestable here. */
          onInput={(e) => setTitleDraft((e.target as HTMLInputElement).value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename()
            if (e.key === 'Escape') setRenaming(false)
          }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <button type="button" className="browse-card-main" onClick={onSelect} title={title}>
          <div className="browse-card-title">{title}</div>
          {subtitle ? <div className="browse-card-sub">{subtitle}</div> : null}
          <div className="browse-card-meta">
            {new Date(session.updatedAt).toLocaleString()}
          </div>
        </button>
      )}

      <MenuButton
        label="Session actions"
        title={`Actions for ${title}`}
        trigger="icon"
        placement="down"
        options={menuOptions}
        onSelect={choose}
      />
    </div>
  )
}
