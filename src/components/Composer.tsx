import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent
} from 'react'
import type {
  AgentCommand,
  ConnectionState,
  FileEntry,
  ModelInfo,
  PermissionMode,
  PromptAttachment
} from '../../shared/types'
import { PERMISSION_MODE_OPTIONS } from '../../shared/types'
import { MenuButton } from './MenuButton'
import { composerPermissions, composerPlaceholder } from '../lib/composer-state'
import { looksInsideProject } from '../../shared/path'
import type { Draft } from '../hooks/useDrafts'
import { QUEUE_LIMIT, type QueuedMessage } from '../hooks/useQueue'

interface Props {
  connection: ConnectionState
  /** Slash commands the live agent accepts; absent means no completion menu. */
  commands?: AgentCommand[]
  /** A transcript is being restored onto the screen. */
  hydrating: boolean
  busy: boolean
  cwd: string | null
  onSend: (text: string, attachments: PromptAttachment[]) => void
  /** What was typed for this conversation and not sent. */
  draft: Draft
  /**
   * Which conversation `draft` belongs to.
   *
   * The composer is not remounted between sessions, so this is how it knows the
   * text in the box is no longer the text for what is on screen.
   */
  draftKey: string
  /** `forKey` names the conversation the text belongs to, when it is not the current one. */
  onDraftChange: (draft: Draft, forKey?: string | null) => void
  onDraftSent: () => void
  /** Hold this message until the running turn finishes. */
  onQueue: (text: string, attachments: PromptAttachment[]) => void
  /** Messages already waiting for this conversation. */
  queued: QueuedMessage[]
  /** The queue will not go by itself: the last turn was stopped or failed. */
  queueHeld: boolean
  onRemoveQueued: (id: string) => void
  onCancel: () => void
  onOpenFolder?: (path: string) => void
  /** Inline Model picker (popover), both surfaces */
  models?: ModelInfo[]
  currentModel?: string
  onChangeModel?: (id: string) => void
  /** Inline permission-Mode picker (popover), Build surface only */
  permissionMode?: PermissionMode
  onChangeMode?: (mode: PermissionMode) => void
  showMode?: boolean
}

function fileToAttachment(file: File): Promise<PromptAttachment | null> {
  return new Promise((resolve) => {
    if (file.type.startsWith('image/')) {
      const reader = new FileReader()
      reader.onload = () => {
        const result = String(reader.result || '')
        const match = result.match(/^data:([^;]+);base64,(.+)$/)
        if (!match) {
          resolve(null)
          return
        }
        resolve({
          id: crypto.randomUUID(),
          kind: 'image',
          name: file.name || 'paste.png',
          data: match[2],
          mimeType: match[1] || file.type || 'image/png',
          previewUrl: result
        })
      }
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(file)
      return
    }
    // Non-images from OS drop may only give name in browser; path comes via selectFile
    resolve({
      id: crypto.randomUUID(),
      kind: 'file',
      name: file.name,
      path: (file as File & { path?: string }).path
    })
  })
}

export function Composer({
  connection,
  commands,
  hydrating,
  busy,
  cwd,
  onSend,
  draft,
  draftKey,
  onDraftChange,
  onDraftSent,
  onQueue,
  queued,
  queueHeld,
  onRemoveQueued,
  onCancel,
  onOpenFolder,
  models,
  currentModel,
  onChangeModel,
  permissionMode,
  onChangeMode,
  showMode
}: Props) {
  /**
   * A turn is really running, as opposed to a session being read off disk.
   *
   * `busy` is set by both, which is why the hint and the Abort button used to
   * appear during a restore. Restoring wins when both are set: at that moment the
   * app has not yet learned whether a turn is open, and offering Abort for a
   * prompt nobody sent is the worse of the two mistakes.
   */
  const working = busy && !hydrating

  /**
   * What the box holds right now, readable from a render or a cleanup. Declared above
   * the swap because the swap reads it to know what the conversation being left had.
   */
  const pendingDraftRef = useRef<Draft>(draft)
  const [text, setText] = useState(draft.text)
  const [attachments, setAttachments] = useState<PromptAttachment[]>(draft.attachments)

  // Swap the box over when the conversation under it changes. Assigning during
  // the render rather than in an effect is deliberate: an effect would paint one
  // frame of the previous conversation's message in the new conversation's box.
  const shownFor = useRef(draftKey)
  /**
   * What the box held for the conversation being left, waiting to be filed.
   *
   * Captured in the render that swaps and written in an effect below, because a write
   * is a side effect and the swap has to be immediate — an effect-driven swap paints
   * one frame of the previous conversation's message under the new one.
   *
   * Without this, typing and then switching inside the write-back delay lost the text:
   * the swap replaced the box and the pending write was cancelled with it.
   */
  const outgoing = useRef<{ key: string; draft: Draft } | null>(null)
  if (shownFor.current !== draftKey) {
    // A conversation getting its name is not a switch. Typing is allowed before the
    // agent answers, and the id only exists once it does — so the box keeps what it
    // holds and the text is filed under the name that just arrived. Treating it as a
    // switch loaded the new conversation's empty draft over the message someone was
    // part-way through writing, at the moment the session became real.
    const named = shownFor.current === '' && draftKey !== ''
    outgoing.current = { key: named ? draftKey : shownFor.current, draft: pendingDraftRef.current }
    shownFor.current = draftKey
    if (!named) {
      setText(draft.text)
      setAttachments(draft.attachments)
    }
  }
  const [mentionOpen, setMentionOpen] = useState(false)
  const [slashIndex, setSlashIndex] = useState(0)
  /**
   * What is hovering, as far as a dragover event can tell: the spec exposes MIME
   * types but not names or paths until the drop, so this can promise how a payload
   * will be SENT and cannot yet know whether the agent will be allowed to open it.
   */
  const [dragKind, setDragKind] = useState<'image' | 'file' | 'none'>('none')
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [mentionQuery, setMentionQuery] = useState('')
  const [mentionItems, setMentionItems] = useState<FileEntry[]>([])
  const [mentionIndex, setMentionIndex] = useState(0)
  const [dragOver, setDragOver] = useState(false)
  const ref = useRef<HTMLTextAreaElement | null>(null)
  const mentionStart = useRef<number | null>(null)

  // One decision object rather than six `disabled` expressions. Typing is
  // allowed while a session restores; everything that needs the agent is not.
  const perms = composerPermissions({
    connection,
    hydrating,
    busy,
    hasContent: !!text.trim() || attachments.length > 0,
    queueFull: queued.length >= QUEUE_LIMIT
  })

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [text])

  useEffect(() => {
    if (!mentionOpen || !cwd) {
      setMentionItems([])
      return
    }
    let cancelled = false
    const t = setTimeout(() => {
      void window.gronk.listProjectFiles(cwd, mentionQuery, 24).then((items) => {
        if (!cancelled) {
          setMentionItems(items.filter((i) => !i.isDir))
          setMentionIndex(0)
        }
      })
    }, 80)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [mentionOpen, mentionQuery, cwd])

  const addAttachments = useCallback((items: PromptAttachment[]) => {
    setAttachments((prev) => {
      const next = [...prev]
      for (const a of items) {
        if (a.kind === 'file' && a.path && next.some((x) => x.path === a.path)) continue
        next.push(a)
      }
      return next.slice(0, 12)
    })
  }, [])

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }

  const detectMention = (value: string, caret: number) => {
    const before = value.slice(0, caret)
    const at = before.lastIndexOf('@')
    if (at < 0) {
      setMentionOpen(false)
      mentionStart.current = null
      return
    }
    const chBefore = at === 0 ? ' ' : before[at - 1]
    if (chBefore && !/\s/.test(chBefore)) {
      setMentionOpen(false)
      mentionStart.current = null
      return
    }
    const query = before.slice(at + 1)
    if (/\s/.test(query)) {
      setMentionOpen(false)
      mentionStart.current = null
      return
    }
    mentionStart.current = at
    setMentionQuery(query)
    setMentionOpen(!!cwd)
  }

  const insertMention = (entry: FileEntry) => {
    const el = ref.current
    const start = mentionStart.current
    if (start === null || !el) return
    const caret = el.selectionStart ?? text.length
    const before = text.slice(0, start)
    const after = text.slice(caret)
    const insert = entry.relative
    const next = `${before}${insert} ${after}`
    setText(next)
    setMentionOpen(false)
    mentionStart.current = null
    addAttachments([
      {
        id: crypto.randomUUID(),
        kind: 'file',
        name: entry.name,
        path: entry.path
      }
    ])
    requestAnimationFrame(() => {
      const pos = before.length + insert.length + 1
      el.focus()
      el.setSelectionRange(pos, pos)
    })
  }

  /**
   * Hand the draft back, a beat after typing stops.
   *
   * Not on every keystroke: this lifts into the hook that owns the transcript, so
   * a write per character re-renders the whole conversation while someone is trying
   * to type into it. The flush below is what makes the delay safe.
   */
  pendingDraftRef.current = { text, attachments }

  useEffect(() => {
    const leaving = outgoing.current
    if (!leaving) return
    outgoing.current = null
    onDraftChange(leaving.draft, leaving.key)
  }, [draftKey, onDraftChange])

  useEffect(() => {
    // Nothing to say when the box already matches what was handed down. Without
    // this an untouched composer writes its empty draft back on a timer, which is
    // pointless work and, worse, would erase a draft written by anything else.
    if (text === draft.text && attachments === draft.attachments) return
    const t = setTimeout(() => onDraftChange(pendingDraftRef.current), 250)
    return () => clearTimeout(t)
  }, [text, attachments, draft, onDraftChange])

  useEffect(() => {
    // Leaving the conversation view unmounts this component, which is exactly the
    // gesture that used to throw a written message away. Whatever the debounce
    // above has not written yet is written here instead.
    // Leaving the conversation view unmounts this component, which is exactly the
    // gesture that used to throw a written message away. Whatever the debounce
    // above has not written yet is written here instead.
    return () => onDraftChange(pendingDraftRef.current, shownFor.current)
  }, [onDraftChange])

  const submit = () => {
    if (perms.canQueue) {
      // A turn is running. Hold it rather than refuse it, and empty the box so the
      // next thought can be typed — the held message is shown above the composer,
      // so nothing has silently disappeared.
      onQueue(text, attachments)
      onDraftSent()
      setText('')
      setAttachments([])
      setMentionOpen(false)
      return
    }
    if (!perms.canSend) return
    // Ahead of onSend: the draft is gone the moment the message is real. Clearing
    // the box below is what stops the debounce and the unmount flush putting it
    // back — they write whatever is in the box, and by then that is nothing.
    onDraftSent()
    onSend(text, attachments)
    setText('')
    setAttachments([])
    setMentionOpen(false)
  }

  // Open while the draft is a single half-typed command token. A trailing space ends
  // completion (the argument has started), so Enter then sends as normal.
  const slashQuery = /^\/(\S*)$/.exec(text)?.[1] ?? null
  const slashItems =
    slashQuery !== null && !slashDismissed && commands?.length
      ? commands.filter((c) => c.name.toLowerCase().startsWith(slashQuery.toLowerCase()))
      : []
  const slashOpen = slashItems.length > 0
  const slashAt = Math.min(slashIndex, slashItems.length - 1)

  const completeSlash = (name: string): void => {
    setText(`/${name} `)
    setSlashIndex(0)
    ref.current?.focus()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashIndex((i) => (i + 1) % slashItems.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashIndex((i) => (i - 1 + slashItems.length) % slashItems.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        completeSlash(slashItems[slashAt].name)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setSlashDismissed(true)
        return
      }
    }
    if (mentionOpen && mentionItems.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMentionIndex((i) => (i + 1) % mentionItems.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionIndex((i) => (i - 1 + mentionItems.length) % mentionItems.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        insertMention(mentionItems[mentionIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMentionOpen(false)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items
    if (!items) return
    const files: File[] = []
    for (const item of Array.from(items)) {
      if (item.kind === 'file') {
        const f = item.getAsFile()
        if (f) files.push(f)
      }
    }
    if (!files.length) return
    e.preventDefault()
    void Promise.all(files.map(fileToAttachment)).then((atts) => {
      addAttachments(atts.filter(Boolean) as PromptAttachment[])
    })
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    setDragKind('none')
    const files = Array.from(e.dataTransfer.files || [])
    if (!files.length) return

    // Single directory drop → open project (Electron may expose path)
    if (files.length === 1) {
      const f = files[0] as File & { path?: string }
      if (f.path && !f.type && onOpenFolder) {
        // Heuristic: no MIME often means folder on Electron
        void window.gronk
          .listProjectFiles(f.path, '', 1)
          .then((entries) => {
            if (entries.length || f.path) {
              // If path exists as folder, open it
              onOpenFolder(f.path!)
            }
          })
          .catch(() => {
            /* treat as file attach */
          })
      }
    }

    void Promise.all(files.map(fileToAttachment)).then((atts) => {
      const valid = (atts.filter(Boolean) as PromptAttachment[]).filter(
        (a) => a.kind === 'image' || a.path
      )
      addAttachments(valid)
    })
  }

  const pickFiles = async () => {
    const path = await window.gronk.selectFile({ title: 'Attach file' })
    if (!path) return
    const name = path.replace(/\\/g, '/').split('/').pop() || path
    addAttachments([
      {
        id: crypto.randomUUID(),
        kind: 'file',
        name,
        path
      }
    ])
  }

  return (
    <div
      className={`composer-wrap ${dragOver ? 'drag-over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
        const items = Array.from(e.dataTransfer?.items ?? [])
        const files = items.filter((i) => i.kind === 'file')
        if (!files.length) {
          setDragKind('none')
          return
        }
        setDragKind(files.some((i) => i.type.startsWith('image/')) ? 'image' : 'file')
      }}
      onDragLeave={() => {
        setDragOver(false)
        setDragKind('none')
      }}
      onDrop={onDrop}
    >
      {dragOver && dragKind !== 'none' ? (
        <div className={`drop-hint drop-hint-${dragKind}`} role="status">
          {dragKind === 'image'
            ? 'Drop to attach — images are sent to the agent directly.'
            : cwd
              ? 'Drop to attach — the agent is sent the path and opens it itself, so it has to be inside this project.'
              : 'Drop to attach — Chat has no project folder, so the agent cannot open files.'}
        </div>
      ) : null}
      {slashOpen ? (
        <div className="mention-menu" role="listbox" aria-label="Commands">
          {slashItems.map((c, i) => (
            <button
              key={c.name}
              type="button"
              className={`mention-item ${i === slashAt ? 'active' : ''}`}
              title={c.hint ? `/${c.name} ${c.hint}` : `/${c.name}`}
              onMouseDown={(e) => {
                e.preventDefault()
                completeSlash(c.name)
              }}
            >
              <span className="mention-name">/{c.name}</span>
              {c.description ? <span className="mention-path">{c.description}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
      {mentionOpen && mentionItems.length > 0 ? (
        <div className="mention-menu" role="listbox">
          {mentionItems.map((item, i) => (
            <button
              key={item.path}
              type="button"
              className={`mention-item ${i === mentionIndex ? 'active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault()
                insertMention(item)
              }}
            >
              <span className="mention-name">{item.name}</span>
              <span className="mention-path">{item.relative}</span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="composer">
        {queued.length > 0 ? (
          <div className="pending-stack" aria-label="Waiting to send">
            <div className="pending-head">
              <span className="pending-count">
                {queued.length === 1 ? '1 message waiting' : `${queued.length} messages waiting`}
              </span>
              {/* Says what Stop does BEFORE it is pressed. With messages behind the
                  running turn, "abort" stops reading as abort: the obvious guess is
                  that it stops this turn and the next one starts, which is the
                  opposite of what happens. */}
              <span className="pending-what">
                {queueHeld
                  ? 'held — the turn was stopped. Send anything to carry on.'
                  : queued.length === 1
                    ? 'sends when this turn finishes · Stop keeps it waiting'
                    : 'they send in order as turns finish · Stop keeps them waiting'}
              </span>
              {queued.length > 1 ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm pending-clear"
                  onClick={() => queued.forEach((m) => onRemoveQueued(m.id))}
                >
                  Cancel all
                </button>
              ) : null}
            </div>
            {queued.map((m) => (
              <div key={m.id} className={`pending-msg ${queueHeld ? 'held' : ''}`}>
                <span className="pending-body">
                  {m.text || `${m.attachments.length} attachment(s)`}
                </span>
                {m.attachments.length > 0 && m.text ? (
                  <span className="pending-attach">
                    +{m.attachments.length} attached
                  </span>
                ) : null}
                <button
                  type="button"
                  className="pending-cancel"
                  aria-label={`Cancel this message: ${m.text.slice(0, 60)}`}
                  title="Cancel this message"
                  onClick={() => onRemoveQueued(m.id)}
                >
                  Cancel
                </button>
              </div>
            ))}
          </div>
        ) : null}

        {attachments.length > 0 ? (
          <div className="attach-row">
            {attachments.map((a) => (
              <div
                key={a.id}
                className={`attach-chip ${a.kind} ${
                  a.kind === 'file' && a.path && !looksInsideProject(cwd, a.path)
                    ? 'unreachable'
                    : ''
                }`}
              >
                {a.kind === 'image' && a.previewUrl ? (
                  <img src={a.previewUrl} alt="" className="attach-thumb" />
                ) : null}
                <span className="attach-name" title={a.path || a.name}>
                  {a.name}
                </span>
                {/* A file attachment sends the PATH, and the agent's own file access is
                    jailed to the project — so one from outside it produces a turn where
                    the agent is refused and appears to have ignored the attachment.
                    Said here, before the turn is spent. */}
                {a.kind === 'file' && a.path && !looksInsideProject(cwd, a.path) ? (
                  <span
                    className="attach-warn"
                    title={
                      cwd
                        ? 'Outside this project, so the agent will not be allowed to open it. Copy it into the project first.'
                        : 'Chat has no project folder, so the agent cannot open files.'
                    }
                  >
                    can’t be opened
                  </span>
                ) : null}
                <button
                  type="button"
                  className="attach-x"
                  onClick={() => removeAttachment(a.id)}
                  aria-label="Remove attachment"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : null}

        <textarea
          ref={ref}
          value={text}
          /*
            onInput rather than onChange, matching the project-notes box for the
            same reason recorded there: React 19's change plugin does not
            synthesize onChange from a dispatched input event outside a real
            browser, so with onChange the whole draft and queue path had no test
            that could type a character. It fires for exactly the same keystrokes.

            This is not a detail of the tests. Every claim about what happens to
            text someone has typed and not sent — that leaving the conversation
            keeps it, that switching does not carry it to the wrong agent, that a
            queued message is the one that was written — could only be argued from
            reading before this.
          */
          onInput={(e) => {
            setSlashDismissed(false)
            setSlashIndex(0)
            const el = e.currentTarget
            setText(el.value)
            detectMention(el.value, el.selectionStart ?? el.value.length)
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onClick={(e) => {
            const t = e.currentTarget
            detectMention(t.value, t.selectionStart ?? t.value.length)
          }}
          placeholder={composerPlaceholder(perms, { hydrating, cwd })}
          disabled={!perms.canType}
          rows={2}
        />
        <div className="composer-bar">
          <div className="composer-left">
            {showMode && onChangeMode ? (
              <MenuButton
                label="Mode"
                value={permissionMode}
                options={PERMISSION_MODE_OPTIONS.map((o) => ({
                  id: o.id,
                  label: o.label,
                  description: o.description,
                  dangerous: o.dangerous
                }))}
                onSelect={(id) => onChangeMode(id as PermissionMode)}
                disabled={!perms.canChangeAgentSettings}
                title="How the agent's tools are approved"
              />
            ) : null}
            {onChangeModel && models && models.length > 0 ? (
              <MenuButton
                label="Model"
                value={currentModel}
                valueLabel={
                  models.find((m) => m.id === currentModel)?.name ||
                  models.find((m) => m.isDefault)?.name ||
                  currentModel
                }
                options={models.map((m) => ({
                  id: m.id,
                  label: m.name || m.id,
                  description: m.description
                }))}
                onSelect={(id) => onChangeModel(id)}
                disabled={!perms.canChangeAgentSettings}
                title="Switch model (restarts the agent)"
              />
            ) : null}
            <button
              type="button"
              className="btn btn-ghost btn-sm composer-attach"
              disabled={!perms.canAttach}
              onClick={() => void pickFiles()}
              title="Attach a file or image"
              aria-label="Attach a file or image"
            >
              +
            </button>
            {/* Restoring is not executing. `busy` is set both by a real send and
                by opening a session, and this line used to read the same for
                both — so every restore claimed an agent was working, for as long
                as the read took. On a large store that was about a minute. */}
            <span className={`composer-hint ${working ? 'busy' : ''}`}>
              {working ? 'Agent executing' : hydrating ? 'Restoring' : 'ACP'}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {/* Nothing to abort during a restore: `onCancel` cancels a prompt,
                and opening a session has not sent one. */}
            {working ? (
              <button
                type="button"
                className="btn btn-danger"
                onClick={onCancel}
                /* "Abort" is honest about one turn and misleading about a queue: with
                   messages waiting behind, the obvious reading is that stopping frees
                   the next one to start. It does the opposite — the rest are held for a
                   person — so when there is a queue the button says which it stops and
                   the title says what happens to the others. */
                title={
                  queued.length > 0
                    ? `Stop this turn. The ${queued.length} waiting will stay put until you send something.`
                    : 'Stop this turn'
                }
              >
                {queued.length > 0 ? 'Stop this turn' : 'Abort'}
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-primary"
              disabled={!perms.canSend}
              onClick={submit}
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
