import { useEffect, useRef, useState, type KeyboardEvent } from 'react'

interface Props {
  disabled: boolean
  busy: boolean
  onSend: (text: string) => void
  onCancel: () => void
}

export function Composer({ disabled, busy, onSend, onCancel }: Props) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [text])

  const submit = () => {
    if (!text.trim() || disabled) return
    onSend(text)
    setText('')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div className="composer-wrap">
      <div className="composer">
        <textarea
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            disabled
              ? 'Initialize a project to open the uplink…'
              : 'Transmit to Grok  ·  Enter to send  ·  Shift+Enter newline'
          }
          disabled={disabled}
          rows={2}
        />
        <div className="composer-bar">
          <span className={`composer-hint ${busy ? 'busy' : ''}`}>
            {busy ? 'Agent executing' : 'ACP · grok agent stdio'}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            {busy ? (
              <button type="button" className="btn btn-danger" onClick={onCancel}>
                Abort
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-primary"
              disabled={disabled || !text.trim() || busy}
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
