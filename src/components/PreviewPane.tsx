import { useEffect, useRef, useState } from 'react'

interface Props {
  url: string | null
  error: string | null
  onStop: () => void
}

/**
 * Preview pane. The actual page is a main-process WebContentsView floating over
 * `.preview-surface`; this component reserves the space, syncs the view's bounds
 * to that div, and provides a URL bar + reload + stop.
 */
export function PreviewPane({ url, error, onStop }: Props) {
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const [addr, setAddr] = useState(url || '')

  useEffect(() => {
    if (url) setAddr(url)
  }, [url])

  // Keep the native view aligned to the surface div (resize / layout shifts / scroll).
  useEffect(() => {
    const el = surfaceRef.current
    if (!el) return
    let raf = 0
    const sync = (): void => {
      const r = el.getBoundingClientRect()
      window.gronk.previewSetBounds({ x: r.left, y: r.top, width: r.width, height: r.height })
    }
    const schedule = (): void => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(sync)
    }
    sync()
    const ro = new ResizeObserver(schedule)
    ro.observe(el)
    window.addEventListener('resize', schedule)
    // Catch layout shifts ResizeObserver misses (sidebar toggles, banners appearing).
    const iv = window.setInterval(sync, 400)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', schedule)
      cancelAnimationFrame(raf)
      window.clearInterval(iv)
    }
  }, [])

  return (
    <div className="preview-pane">
      <div className="preview-bar">
        <span className="preview-dot" aria-hidden />
        <input
          className="preview-url"
          value={addr}
          spellCheck={false}
          onChange={(e) => setAddr(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && addr.trim()) void window.gronk.previewSetUrl(addr.trim())
          }}
          placeholder="http://localhost:5173"
        />
        <button
          type="button"
          className="btn-mini"
          onClick={() => void window.gronk.previewReload()}
          title="Reload"
        >
          ⟳
        </button>
        <button type="button" className="btn-mini danger" onClick={onStop} title="Stop preview">
          ■
        </button>
      </div>
      <div className="preview-surface" ref={surfaceRef}>
        {!url ? (
          <div className="preview-placeholder">
            {error ? (
              <span className="preview-error">{error}</span>
            ) : (
              <>
                <span className="cli-spinner" aria-hidden />
                <span>Starting dev server… waiting for a localhost URL</span>
              </>
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}
