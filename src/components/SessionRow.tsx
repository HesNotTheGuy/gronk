import { useEffect, useRef, useState } from 'react'
import { MenuButton } from './MenuButton'
import type { MenuOption } from './MenuButton'
import { isChatSession } from '../../shared/path'
import type { SessionInfo, SessionLiveness } from '../../shared/types'

interface Props {
  session: SessionInfo
  active: boolean
  authenticated: boolean
  /** Secondary line under the title: date, or project name in search results. */
  meta: string
  /** Optional third line, used for a search snippet. */
  detail?: string | null
  /**
   * Sandbox root, so a chat session is not offered a project folder it does not
   * have. Optional: `session.surface` already answers this for anything written
   * by a current build, and the path check covers the older entries.
   */
  chatWorkspacePath?: string | null
  /**
   * What this session's agent is doing, or absent when it is not running.
   *
   * Three answers rather than a boolean, because "busy" and "waiting for you"
   * look identical from outside and only one of them needs a person.
   */
  liveness?: SessionLiveness | null
  onSelect: () => void
  onRename: (title: string) => void
  onArchive: () => void
  onExport: (format: 'md' | 'json') => void
  onDelete: () => void
  /** Stop this session's agent without opening it. */
  onStop?: () => void
}

/** The word under the title, and the label the dot answers to. */
const LIVENESS_LABEL: Record<SessionLiveness, string> = {
  working: 'Working',
  blocked: 'Needs you',
  idle: 'Running'
}

const COMMON_OPTIONS: MenuOption[] = [
  { id: 'rename', label: 'Rename' },
  { id: 'archive', label: 'Archive', description: 'Hide it without deleting' },
  { id: 'export-md', label: 'Export as Markdown' },
  { id: 'export-json', label: 'Export as JSON' }
]

/**
 * "project folder", never "session folder".
 *
 * A session owns no directory. Every transcript lives inside the one store file,
 * so a menu item named after the session would promise a folder that does not
 * exist, and whoever went looking for their messages in it would find a project
 * checkout instead. What this reveals is the cwd the agent runs in, and that is
 * what it says.
 */
const REVEAL_OPTION: MenuOption = {
  id: 'reveal',
  label: 'Show project folder',
  description: 'The folder this session runs in'
}

/**
 * Stopping is offered only when there is a live agent to stop, and it sits above
 * Delete so the destructive item stays last.
 */
const STOP_OPTION: MenuOption = {
  id: 'stop',
  label: 'Stop session',
  description: 'End the agent, keep the transcript'
}

const DELETE_OPTION: MenuOption = {
  id: 'delete',
  label: 'Delete',
  description: 'Permanent',
  dangerous: true
}

/**
 * Reveal sits second from last in both lists rather than first, so every item
 * that was already there keeps the position people reach for.
 */
const PROJECT_OPTIONS: MenuOption[] = [...COMMON_OPTIONS, REVEAL_OPTION, DELETE_OPTION]
const CHAT_OPTIONS: MenuOption[] = [...COMMON_OPTIONS, DELETE_OPTION]

/**
 * A session in the sidebar, with the actions that used to live only in the
 * browse views.
 *
 * The rail became the primary navigator, which moved people away from the one
 * place Rename / Archive / Export / Delete were reachable. The row cannot simply
 * be a button any more, because a menu control cannot nest inside one. The
 * click target and the menu are siblings instead.
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
  chatWorkspacePath,
  liveness,
  onSelect,
  onRename,
  onArchive,
  onExport,
  onDelete,
  onStop
}: Props) {
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState('')
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const title = (session.title || session.id.slice(0, 8)).trim()

  /**
   * A chat runs in the app's own sandbox, which is app plumbing rather than
   * anywhere the user put files. Offering to reveal it would send someone into
   * an internal directory looking for work they did not do there, so the item is
   * absent instead of disabled: there is nothing to enable.
   */
  const hasProjectFolder = !!session.cwd && !isChatSession(session, chatWorkspacePath)

  const base = hasProjectFolder ? PROJECT_OPTIONS : CHAT_OPTIONS
  // Absent rather than disabled: a session that is not running has nothing to
  // stop, and a permanently greyed item reads as something broken.
  const menuOptions =
    liveness && onStop ? [...base.slice(0, -1), STOP_OPTION, base[base.length - 1]] : base

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
    else if (id === 'reveal') {
      // Nothing to report on failure and nowhere to report it: a row has no
      // notice surface, and the only way this fails is a folder that has since
      // been moved or removed, which the file manager not opening already says.
      void window.gronk.revealLocalPath(session.cwd).catch(() => undefined)
    } else if (id === 'stop') onStop?.()
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
        // Title carries destination: opening this row sets agent cwd to session.cwd.
        title={session.cwd ? `${title}\n${meta}\n${session.cwd}` : `${title}\n${meta}`}
        onClick={onSelect}
      >
        <div className="name">
          {/* Inside the existing name line rather than beside the row, so a
              running session changes no geometry and the other rows do not
              move when one starts. */}
          {liveness ? (
            <span
              className={`session-live session-live-${liveness}`}
              title={LIVENESS_LABEL[liveness]}
              aria-label={LIVENESS_LABEL[liveness]}
              role="img"
            />
          ) : null}
          {title}
        </div>
        <div className="meta">{meta}</div>
        {detail ? <div className="search-snippet">{detail}</div> : null}
      </button>
      <MenuButton
        label="Session actions"
        title={`Actions for ${title}`}
        trigger="icon"
        placement="down"
        options={menuOptions}
        onSelect={choose}
        disabled={!authenticated}
      />
    </div>
  )
}
