import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
import type { ImageRef } from '../lib/image-refs'

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; dataUrl: string; resolvedPath: string }
  | { status: 'error'; message: string }

/** One image in a grid that could not be read, as the grid needs to list it. */
export interface FailedImage {
  path: string
  label: string
  message: string
}

/**
 * Set by ThumbnailGrid, absent everywhere else, and it changes two things.
 *
 * A LocalImage inside a grid draws itself as a small square tile rather than a
 * full width card, and it stops drawing its own failure. Fifty `![name](path)`
 * in one reply meant up to fifty bordered boxes each with its own "Image not
 * found" line under it, so the images that were MISSING took more vertical
 * space than the ones that worked. The grid collects them and prints one line.
 *
 * A context rather than a prop because the tiles are created by react-markdown
 * from the model's own markdown, so nothing in between is ours to pass through.
 */
interface ImageGroup {
  report: (failure: FailedImage) => void
  clear: (path: string) => void
}

const ImageGroupContext = createContext<ImageGroup | null>(null)

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
  const group = useContext(ImageGroupContext)
  const thumb = group !== null

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

  // Tell the grid, if there is one, so it can summarise. The clear on the way
  // out matters during streaming: a message is re-rendered as it grows, and a
  // path that has left the text must not keep inflating the count.
  useEffect(() => {
    if (!group) return undefined
    if (state.status !== 'error') {
      group.clear(image.path)
      return undefined
    }
    group.report({ path: image.path, label: image.label, message: state.message })
    return () => group.clear(image.path)
  }, [group, image.path, image.label, state])

  const openExternal = () => {
    if (state.status === 'ready') {
      void window.gronk.revealLocalPath?.(state.resolvedPath)
    }
  }

  if (state.status === 'loading') {
    return (
      <div
        className={`local-image loading ${thumb ? 'thumb' : ''} ${compact ? 'compact' : ''}`}
        title={image.label}
      >
        <div className="local-image-skeleton" />
        <span className="local-image-caption muted">{image.label}</span>
      </div>
    )
  }

  if (state.status === 'error') {
    // In a grid the group prints one line for all of them, so a tile that
    // failed simply is not there.
    if (thumb) return null
    // Standalone missing refs used to be full cards; a compact one-liner keeps
    // a restored catalogue of dead paths from owning the chat viewport.
    return (
      <div
        className={`local-image error compact-error ${compact ? 'compact' : ''}`}
        title={state.message}
      >
        <span className="local-image-fallback">{image.label}</span>
        <span className="local-image-caption muted">{state.message}</span>
      </div>
    )
  }

  return (
    <>
      <figure className={`local-image ready ${thumb ? 'thumb' : ''} ${compact ? 'compact' : ''}`}>
        <button
          type="button"
          className="local-image-btn"
          onClick={() => setLightbox(true)}
          title={thumb ? image.label : 'Click to enlarge'}
        >
          <img src={state.dataUrl} alt={image.caption || image.label} className="local-image-img" />
        </button>
        {thumb ? (
          // The Open button in the caption is a third of what made each card
          // 265px tall. On a tile it hangs over the picture on hover instead,
          // where it costs no height at all.
          <button
            type="button"
            className="btn-mini local-image-thumb-reveal"
            onClick={openExternal}
            title="Show in folder"
          >
            Open
          </button>
        ) : null}
        <figcaption className="local-image-caption">
          <span className="local-image-label" title={state.resolvedPath}>
            {image.label}
          </span>
          {image.caption && !thumb ? (
            <span className="local-image-prompt" title={image.caption}>
              {image.caption}
            </span>
          ) : null}
          {thumb ? null : (
            <button
              type="button"
              className="btn-mini local-image-reveal"
              onClick={openExternal}
              title="Show in folder"
            >
              Open
            </button>
          )}
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

/**
 * Many images from one message, as a grid of tiles with one shared failure line.
 *
 * Everything inside renders as a thumbnail: see ImageGroupContext above for why
 * that is a context and not a prop. Clicking a tile still opens the same
 * lightbox, which is where an image in a catalogue actually gets looked at.
 */
export function ThumbnailGrid({ children }: { children?: ReactNode }) {
  const [failures, setFailures] = useState<FailedImage[]>([])
  const [expanded, setExpanded] = useState(false)

  /*
   * Both of these return the PREVIOUS array when nothing has changed, which is
   * how React knows to stop. Every tile calls clear() the moment it loads, so a
   * new array each time would be a re-render per image, per render, forever.
   */
  const report = useCallback((failure: FailedImage) => {
    setFailures((prev) => {
      const at = prev.findIndex((f) => f.path === failure.path)
      if (at < 0) return [...prev, failure]
      if (prev[at].message === failure.message && prev[at].label === failure.label) return prev
      const next = prev.slice()
      next[at] = failure
      return next
    })
  }, [])

  const clear = useCallback((path: string) => {
    setFailures((prev) =>
      prev.some((f) => f.path === path) ? prev.filter((f) => f.path !== path) : prev
    )
  }, [])

  const group = useMemo<ImageGroup>(() => ({ report, clear }), [report, clear])

  // "Not found" is the usual reason and worth saying, but it is not the only
  // one the reader can hit: too large, or outside the allowed image roots.
  const allMissing = failures.every((f) => /not found/i.test(f.message))
  const summary =
    `${failures.length} ${failures.length === 1 ? 'image' : 'images'} ` +
    (allMissing ? 'could not be found' : 'could not be loaded')

  return (
    <ImageGroupContext.Provider value={group}>
      <div className="md-image-grid">{children}</div>
      {failures.length ? (
        <div className="md-image-failures">
          <button
            type="button"
            className="md-image-failures-toggle"
            onClick={() => setExpanded((open) => !open)}
            aria-expanded={expanded}
          >
            <span className="md-image-failures-caret" aria-hidden>
              {expanded ? '▾' : '▸'}
            </span>
            {summary}
          </button>
          {expanded ? (
            <ul className="md-image-failure-list">
              {failures.map((failure) => (
                <li key={failure.path} className="md-image-failure">
                  <span className="md-image-failure-name" title={failure.path}>
                    {failure.label}
                  </span>
                  <span className="md-image-failure-why">{failure.message}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </ImageGroupContext.Provider>
  )
}

/**
 * Hard cap on inline previews. Free-text path scans (even when gated to image
 * tools) and multi-image generators can still hand over more refs than a chat
 * row should mount: each LocalImage is a gronk:read-local-image round trip and
 * a base64 data: URL up to 20 MB. The gate in extractImageRefsFromTool is not
 * enough on its own — this bound is independent of how the list was built.
 */
export const MAX_GALLERY_IMAGES = 8

/** Horizontal strip of generated images (tool turn or message). */
export function ImageGallery({
  images,
  compact
}: {
  images: ImageRef[]
  compact?: boolean
}) {
  if (!images.length) return null
  const shown = images.slice(0, MAX_GALLERY_IMAGES)
  const extra = images.length - shown.length
  return (
    <div className={`image-gallery ${compact ? 'compact' : ''}`}>
      {shown.map((img) => (
        <LocalImage key={img.path} image={img} compact={compact} />
      ))}
      {extra > 0 ? (
        <div
          className="image-gallery-more"
          title={`${images.length} images total; only the first ${MAX_GALLERY_IMAGES} are shown`}
        >
          +{extra} more
        </div>
      ) : null}
    </div>
  )
}
