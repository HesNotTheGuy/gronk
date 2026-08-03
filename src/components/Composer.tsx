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
  FileEntry,
  ModelInfo,
  PermissionMode,
  PromptAttachment
} from '../../shared/types'
import { PERMISSION_MODE_OPTIONS } from '../../shared/types'
import { MenuButton } from './MenuButton'

interface Props {
  disabled: boolean
  busy: boolean
  cwd: string | null
  onSend: (text: string, attachments: PromptAttachment[]) => void
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
  disabled,
  busy,
  cwd,
  onSend,
  onCancel,
  onOpenFolder,
  models,
  currentModel,
  onChangeModel,
  permissionMode,
  onChangeMode,
  showMode
}: Props) {
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<PromptAttachment[]>([])
  const [mentionOpen, setMentionOpen] = useState(false)
  const [mentionQuery, setMentionQuery] = useState('')
  const [mentionItems, setMentionItems] = useState<FileEntry[]>([])
  const [mentionIndex, setMentionIndex] = useState(0)
  const [dragOver, setDragOver] = useState(false)
  const ref = useRef<HTMLTextAreaElement | null>(null)
  const mentionStart = useRef<number | null>(null)

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

  const submit = () => {
    if ((!text.trim() && attachments.length === 0) || disabled) return
    onSend(text, attachments)
    setText('')
    setAttachments([])
    setMentionOpen(false)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
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
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
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
        {attachments.length > 0 ? (
          <div className="attach-row">
            {attachments.map((a) => (
              <div key={a.id} className={`attach-chip ${a.kind}`}>
                {a.kind === 'image' && a.previewUrl ? (
                  <img src={a.previewUrl} alt="" className="attach-thumb" />
                ) : null}
                <span className="attach-name" title={a.path || a.name}>
                  {a.name}
                </span>
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
          onChange={(e) => {
            setText(e.target.value)
            detectMention(e.target.value, e.target.selectionStart ?? e.target.value.length)
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onClick={(e) => {
            const t = e.currentTarget
            detectMention(t.value, t.selectionStart ?? t.value.length)
          }}
          placeholder={
            disabled
              ? 'Sign in and open Chat or a Project…'
              : cwd
                ? 'Message the project agent  ·  @ files  ·  paste images  ·  Enter send'
                : 'Message Grok  ·  paste images  ·  Enter send'
          }
          disabled={disabled}
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
                disabled={disabled}
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
                disabled={disabled}
                title="Switch model (restarts the agent)"
              />
            ) : null}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={disabled}
              onClick={() => void pickFiles()}
              title="Attach file"
            >
              Attach
            </button>
            <span className={`composer-hint ${busy ? 'busy' : ''}`}>
              {busy ? 'Agent executing' : 'ACP'}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {busy ? (
              <button type="button" className="btn btn-danger" onClick={onCancel}>
                Abort
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-primary"
              disabled={disabled || busy || (!text.trim() && attachments.length === 0)}
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
