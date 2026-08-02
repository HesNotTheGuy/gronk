import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ImageRef } from '../lib/image-refs'

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; dataUrl: string; resolvedPath: string }
  | { status: 'error'; message: string }

/**
 * Loads a local filesystem image via main-process IPC (renderer cannot read disk)
 * and renders it inline. Used for Grok Imagine outputs (images/1.jpg, …).
 */
export function LocalImage({
  image,
  compact
}: {
  image: ImageRef
  /** Smaller thumb when embedded in tool chips */
  compact?: boolean
}) {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [lightbox, setLightbox] = useState(false)

  /**
   * Escape closes it, and the page behind stops scrolling while it is open.
   *
   * The key handler used to sit on the overlay div as onKeyDown. That div has no
   * tabIndex and nothing ever focused it, so it never received a keystroke and
   * the branch was unreachable: clicking the backdrop worked, and the one key
   * anybody actually reaches for did nothing. A document listener has no such
   * requirement.
   */
  useEffect(() => {
    if (!lightbox) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setLightbox(false)
    }
    document.addEventListener('keydown', onKey)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previousOverflow
    }
  }, [lightbox])

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    void (async () => {
      try {
        const res = await window.gronk.readLocalImage(image.path)
        if (cancelled) return
        if (!res?.dataUrl) {
          setState({ status: 'error', message: res?.error || 'Image not found' })
          return
        }
        setState({
          status: 'ready',
          dataUrl: res.dataUrl,
          resolvedPath: res.path || image.path
        })
      } catch (err) {
        if (cancelled) return
        setState({
          status: 'error',
          message: err instanceof Error ? err.message : String(err)
        })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [image.path])

  const openExternal = () => {
    if (state.status === 'ready') {
      void window.gronk.revealLocalPath?.(state.resolvedPath)
    }
  }

  if (state.status === 'loading') {
    return (
      <div className={`local-image loading ${compact ? 'compact' : ''}`} title={image.label}>
        <div className="local-image-skeleton" />
        <span className="local-image-caption muted">{image.label}</span>
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className={`local-image error ${compact ? 'compact' : ''}`} title={state.message}>
        <span className="local-image-fallback">{image.label}</span>
        <span className="local-image-caption muted">{state.message}</span>
      </div>
    )
  }

  return (
    <>
      <figure className={`local-image ready ${compact ? 'compact' : ''}`}>
        <button
          type="button"
          className="local-image-btn"
          onClick={() => setLightbox(true)}
          title="Click to enlarge"
        >
          <img src={state.dataUrl} alt={image.caption || image.label} className="local-image-img" />
        </button>
        <figcaption className="local-image-caption">
          <span className="local-image-label" title={state.resolvedPath}>
            {image.label}
          </span>
          {image.caption ? (
            <span className="local-image-prompt" title={image.caption}>
              {image.caption}
            </span>
          ) : null}
          <button
            type="button"
            className="btn-mini local-image-reveal"
            onClick={openExternal}
            title="Show in folder"
          >
            Open
          </button>
        </figcaption>
      </figure>
      {lightbox
        ? createPortal(
            <div
              className="local-image-lightbox"
              role="dialog"
              aria-modal="true"
              aria-label={image.label}
              onClick={() => setLightbox(false)}
            >
              <div className="local-image-lightbox-frame" onClick={(e) => e.stopPropagation()}>
                <img
                  src={state.dataUrl}
                  alt={image.caption || image.label}
                  className="local-image-lightbox-img"
                />
                <button
                  type="button"
                  className="local-image-lightbox-close"
                  onClick={() => setLightbox(false)}
                >
                  Close
                </button>
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  )
}

/** Horizontal strip of generated images (tool turn or message). */
export function ImageGallery({
  images,
  compact
}: {
  images: ImageRef[]
  compact?: boolean
}) {
  if (!images.length) return null
  return (
    <div className={`image-gallery ${compact ? 'compact' : ''}`}>
      {images.map((img) => (
        <LocalImage key={img.path} image={img} compact={compact} />
      ))}
    </div>
  )
}
