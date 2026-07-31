import { useEffect, useRef, useState } from 'react'

interface Props {
  url: string | null
  error: string | null
  /** Width as a percentage of the row, driven by the splitter. */
  widthPercent: number
  /** Showing in its own window, so the pane is only a placeholder. */
  poppedOut: boolean
  onPopOut: () => void
  onDock: () => void
  onStop: () => void
}

/**
 * Preview pane. The actual page is a main-process WebContentsView floating over
 * `.preview-surface`; this component reserves the space, syncs the view's bounds
 * to that div, and provides a URL bar, reload, pop-out and stop.
 *
 * Popped out, the view is destroyed and recreated in a BrowserWindow rather than
 * shown in both: two live views on one URL would both hold the dev server's
 * socket and run its scripts twice.
 */
export function PreviewPane({
  url,
  error,
  widthPercent,
  poppedOut,
  onPopOut,
  onDock,
  onStop
}: Props) {
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
    <div className="preview-pane" style={{ flexBasis: `${widthPercent}%` }}>
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
        <button
          type="button"
          className="btn-mini"
          onClick={poppedOut ? onDock : onPopOut}
          title={poppedOut ? 'Put the preview back in this pane' : 'Open the preview in its own window'}
        >
          {poppedOut ? 'Dock' : 'Pop out'}
        </button>
        <button type="button" className="btn-mini danger" onClick={onStop} title="Stop preview">
          ■
        </button>
      </div>
      <div className="preview-surface" ref={surfaceRef}>
        {/* Detached: the native view lives in another window, so this space
            would otherwise be an unexplained black rectangle. */}
        {poppedOut ? (
          <div className="preview-placeholder">
            <span>Showing in its own window.</span>
            <button type="button" className="btn btn-secondary btn-sm" onClick={onDock}>
              Dock it back
            </button>
          </div>
        ) : !url ? (
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
