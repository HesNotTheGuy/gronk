import { useCallback, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { looksLikeImagePath } from '../lib/image-refs'
import { LocalImage } from './LocalImage'

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

function isHttpUrl(src: string): boolean {
  return /^https?:\/\//i.test(src) || src.startsWith('data:')
}

function LocalOrRemoteImg({
  src,
  alt
}: {
  src?: string
  alt?: string
}) {
  if (!src) return null
  if (isHttpUrl(src)) {
    return <img src={src} alt={alt || ''} className="md-img" />
  }
  if (looksLikeImagePath(src)) {
    return (
      <LocalImage
        image={{
          path: src,
          label: alt?.trim() || src.replace(/\\/g, '/').split('/').pop() || src,
          caption: alt?.trim() || undefined
        }}
      />
    )
  }
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
  if (!text) return null
  const suppress = suppressImagePaths?.length
    ? new Set(suppressImagePaths.map(pathKey))
    : undefined

  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
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
          img({ src, alt }) {
            if (src && isSuppressed(src, suppress)) {
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
            if (href && looksLikeImagePath(href)) {
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
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
