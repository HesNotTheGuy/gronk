import { useState } from 'react'
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
  const [menuOpen, setMenuOpen] = useState(false)
  /** Second level of the same menu. Keeps format choice out of the top list */
  const [pickingFormat, setPickingFormat] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [titleDraft, setTitleDraft] = useState(session.title || '')
  const title = (session.title || session.id.slice(0, 8)).trim()

  const commitRename = () => {
    const t = titleDraft.trim()
    if (t && t !== session.title) onRename(t)
    setRenaming(false)
  }

  const closeMenu = () => {
    setMenuOpen(false)
    setPickingFormat(false)
  }

  const exportAs = (format: 'md' | 'json') => {
    closeMenu()
    onExport?.(format)
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
          title="Rename, export, archive, or delete"
          onClick={(e) => {
            e.stopPropagation()
            if (menuOpen) closeMenu()
            else setMenuOpen(true)
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
              onClick={closeMenu}
            />
            <div className="session-menu" role="menu">
              {pickingFormat ? (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    className="session-menu-back"
                    onClick={() => setPickingFormat(false)}
                  >
                    <span className="session-menu-ico">‹</span>
                    Export as
                  </button>
                  <button type="button" role="menuitem" onClick={() => exportAs('md')}>
                    <span className="session-menu-ico">↧</span>
                    Markdown
                  </button>
                  <button type="button" role="menuitem" onClick={() => exportAs('json')}>
                    <span className="session-menu-ico">↧</span>
                    JSON
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      closeMenu()
                      setTitleDraft(session.title || title)
                      setRenaming(true)
                    }}
                  >
                    <span className="session-menu-ico">✎</span>
                    Rename
                  </button>
                  {onExport ? (
                    <button
                      type="button"
                      role="menuitem"
                      aria-haspopup="menu"
                      onClick={() => setPickingFormat(true)}
                    >
                      <span className="session-menu-ico">↧</span>
                      Export
                      <span className="session-menu-more" aria-hidden>
                        ›
                      </span>
                    </button>
                  ) : null}
                  {session.archived ? (
                    onUnarchive ? (
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          closeMenu()
                          onUnarchive()
                        }}
                      >
                        <span className="session-menu-ico">↩</span>
                        Restore
                      </button>
                    ) : null
                  ) : onArchive ? (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        closeMenu()
                        onArchive()
                      }}
                    >
                      <span className="session-menu-ico">▤</span>
                      Archive
                    </button>
                  ) : null}
                  <button
                    type="button"
                    role="menuitem"
                    className="danger"
                    onClick={() => {
                      closeMenu()
                      if (confirm('Permanently delete this session?')) onDelete()
                    }}
                  >
                    <span className="session-menu-ico">⌫</span>
                    Delete
                  </button>
                </>
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}
