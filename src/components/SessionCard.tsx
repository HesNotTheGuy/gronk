import { useState } from 'react'
import type { SessionInfo } from '../../shared/types'

interface Props {
  session: SessionInfo
  active?: boolean
  /** Optional subtitle under title (e.g. project name) */
  subtitle?: string
  onSelect: () => void
  onRename: (title: string) => void
  onArchive: () => void
  onDelete: () => void
}

export function SessionCard({
  session,
  active,
  subtitle,
  onSelect,
  onRename,
  onArchive,
  onDelete
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [titleDraft, setTitleDraft] = useState(session.title || '')
  const title = (session.title || session.id.slice(0, 8)).trim()

  const commitRename = () => {
    const t = titleDraft.trim()
    if (t && t !== session.title) onRename(t)
    setRenaming(false)
  }

  return (
    <div className={`browse-card session-card ${active ? 'active' : ''}`}>
      {renaming ? (
        <input
          className="browse-rename"
          value={titleDraft}
          autoFocus
          onChange={(e) => setTitleDraft(e.target.value)}
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

      <div className="browse-card-menu-wrap">
        <button
          type="button"
          className="session-menu-btn"
          aria-label="Session actions"
          aria-expanded={menuOpen}
          title="Rename, archive, or delete"
          onClick={(e) => {
            e.stopPropagation()
            setMenuOpen((v) => !v)
          }}
        >
          ⋯
        </button>
        {menuOpen ? (
          <>
            <button
              type="button"
              className="session-menu-backdrop"
              aria-label="Close menu"
              onClick={() => setMenuOpen(false)}
            />
            <div className="session-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false)
                  setTitleDraft(session.title || title)
                  setRenaming(true)
                }}
              >
                <span className="session-menu-ico">✎</span>
                Rename
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false)
                  onArchive()
                }}
              >
                <span className="session-menu-ico">▤</span>
                Archive
              </button>
              <button
                type="button"
                role="menuitem"
                className="danger"
                onClick={() => {
                  setMenuOpen(false)
                  if (confirm('Permanently delete this session?')) onDelete()
                }}
              >
                <span className="session-menu-ico">⌫</span>
                Delete
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}
