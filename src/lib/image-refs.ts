import type { ToolCallInfo } from '../../shared/types'

export interface ImageRef {
  /** Absolute path preferred; relative session path (e.g. images/1.jpg) also accepted */
  path: string
  /** Display label: basename or short relative path */
  label: string
  /** Optional caption (e.g. generation prompt snippet) */
  caption?: string
}

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|bmp|svg)$/i
const ABS_WIN = /^[a-zA-Z]:[\\/]/
const ABS_UNIX = /^\/(?!\/)/
const ABS_UNC = /^\\\\/

/** True for paths that look like local image files (absolute or relative). */
export function looksLikeImagePath(s: string): boolean {
  const t = s.trim().replace(/^["'`]+|["'`]+$/g, '')
  if (!t || t.length > 800) return false
  if (t.startsWith('http://') || t.startsWith('https://') || t.startsWith('data:')) return false
  if (!IMAGE_EXT.test(t.split(/[?#]/)[0])) return false
  // Reject shell-ish noise
  if (/[\n\r\t<>|*?]/.test(t)) return false
  return true
}

export function isAbsoluteLocalPath(s: string): boolean {
  return ABS_WIN.test(s) || ABS_UNIX.test(s) || ABS_UNC.test(s)
}

function basename(p: string): string {
  const norm = p.replace(/\\/g, '/')
  const parts = norm.split('/')
  return parts[parts.length - 1] || p
}

function shortLabel(p: string): string {
  const norm = p.replace(/\\/g, '/')
  // Prefer Grok-style short path: images/1.jpg
  const m = norm.match(/(?:^|\/)(images\/[^/]+\.(?:jpe?g|png|gif|webp|bmp|svg))$/i)
  if (m) return m[1]
  return basename(p)
}

function pushUnique(out: ImageRef[], ref: ImageRef): void {
  const key = ref.path.replace(/\\/g, '/').toLowerCase()
  if (out.some((r) => r.path.replace(/\\/g, '/').toLowerCase() === key)) return
  out.push(ref)
}

/** Flatten nested ACP tool content into plain text chunks. */
export function flattenToolContent(content: unknown, depth = 0): string[] {
  if (content == null || depth > 8) return []
  if (typeof content === 'string') return content ? [content] : []
  if (Array.isArray(content)) {
    return content.flatMap((c) => flattenToolContent(c, depth + 1))
  }
  if (typeof content === 'object') {
    const o = content as Record<string, unknown>
    const chunks: string[] = []
    if (typeof o.text === 'string') chunks.push(o.text)
    if (typeof o.path === 'string') chunks.push(o.path)
    if (typeof o.filename === 'string' && typeof o.path === 'string') {
      // already covered by path; skip
    } else if (typeof o.filename === 'string' && looksLikeImagePath(o.filename)) {
      chunks.push(o.filename)
    }
    if (o.content !== undefined) chunks.push(...flattenToolContent(o.content, depth + 1))
    if (o.result !== undefined) chunks.push(...flattenToolContent(o.result, depth + 1))
    if (o.output !== undefined) chunks.push(...flattenToolContent(o.output, depth + 1))
    // Structured image-gen payload
    if (typeof o.path === 'string' && looksLikeImagePath(o.path)) {
      chunks.push(JSON.stringify(o))
    }
    return chunks
  }
  return []
}

function tryParseImageJson(text: string): ImageRef | null {
  const t = text.trim()
  if (!t.startsWith('{') || !t.includes('path')) return null
  try {
    const obj = JSON.parse(t) as Record<string, unknown>
    const p = typeof obj.path === 'string' ? obj.path : null
    if (!p || !looksLikeImagePath(p)) return null
    const filename = typeof obj.filename === 'string' ? obj.filename : shortLabel(p)
    const sessionFolder =
      typeof obj.session_folder === 'string' ? obj.session_folder.replace(/\\/g, '/') : null
    const label =
      sessionFolder && filename
        ? `${sessionFolder}/${filename}`.replace(/\/+/g, '/')
        : shortLabel(p)
    return { path: p, label }
  } catch {
    return null
  }
}

/**
 * Tools whose *purpose* is to produce images. Free-text path scanning is only
 * safe for these: a shell/list tool that merely *mentions* an image path in its
 * output is not producing one, and treating every hit as a preview is how a
 * directory listing of build/icons filled the screen with BMPs.
 *
 * Structured JSON results (tryParseImageJson) are accepted from any tool —
 * that is how image_gen / image_edit report their files, and a false positive
 * on a path-shaped JSON object from another tool is far rarer than free-text
 * absolute paths in command output.
 */
const IMAGE_PRODUCER =
  /image_gen|image_edit|imagine|image_to_video|reference_to_video/

export function isImageProducingTool(tool: Pick<ToolCallInfo, 'kind' | 'title'>): boolean {
  const kind = (tool.kind || '').toLowerCase()
  const title = (tool.title || '').toLowerCase()
  // ACP may label the kind "IMAGE" once the client has classified it.
  if (kind === 'image') return true
  return IMAGE_PRODUCER.test(kind) || IMAGE_PRODUCER.test(title)
}

export interface ExtractImagePathsOptions {
  /**
   * When false, only structured JSON payloads are accepted — no free-text scan
   * of absolute paths, session-relative `images/…`, or markdown links.
   * Defaults to true for callers that pass already-trusted text (e.g. assistant
   * markdown). Tool extraction sets this from isImageProducingTool.
   */
  freeText?: boolean
}

/** Pull image file paths out of free text (tool payload, assistant markdown). */
export function extractImagePathsFromText(
  text: string,
  opts: ExtractImagePathsOptions = {}
): ImageRef[] {
  if (!text) return []
  const freeText = opts.freeText !== false
  const out: ImageRef[] = []

  // Full JSON payloads (image_gen / image_edit tool results)
  const jsonRef = tryParseImageJson(text)
  if (jsonRef) {
    pushUnique(out, jsonRef)
    return out
  }

  if (!freeText) return out

  // Markdown images/links: ![alt](path) or [label](path)
  const mdLink = /!?\[([^\]]*)\]\(([^)\s]+)\)/g
  let m: RegExpExecArray | null
  while ((m = mdLink.exec(text)) !== null) {
    const href = m[2].trim()
    if (looksLikeImagePath(href)) {
      pushUnique(out, { path: href, label: m[1]?.trim() || shortLabel(href) })
    }
  }

  // Absolute Windows / Unix paths ending in image extension
  const absRe =
    /(?:[a-zA-Z]:[\\/][^\s"'`<>|*?\n\r]+\.(?:jpe?g|png|gif|webp|bmp|svg)|\/[^\s"'`<>|*?\n\r]+\.(?:jpe?g|png|gif|webp|bmp|svg))/gi
  while ((m = absRe.exec(text)) !== null) {
    const p = m[0].replace(/[.,;:)+\]}'"]+$/, '')
    if (looksLikeImagePath(p)) {
      pushUnique(out, { path: p, label: shortLabel(p) })
    }
  }

  // Relative session paths: images/1.jpg, images\2.png
  const relRe = /(?:^|[\s("'`])((?:images[\\/])[^\s"'`<>|*?\n\r]+\.(?:jpe?g|png|gif|webp|bmp|svg))/gi
  while ((m = relRe.exec(text)) !== null) {
    const p = m[1].replace(/[.,;:)+\]}'"]+$/, '')
    if (looksLikeImagePath(p)) {
      pushUnique(out, { path: p, label: shortLabel(p) })
    }
  }

  return out
}

function captionFromInput(rawInput: unknown): string | undefined {
  if (!rawInput) return undefined
  let obj: Record<string, unknown> | null = null
  if (typeof rawInput === 'string') {
    try {
      obj = JSON.parse(rawInput) as Record<string, unknown>
    } catch {
      return rawInput.slice(0, 120)
    }
  } else if (typeof rawInput === 'object' && !Array.isArray(rawInput)) {
    obj = rawInput as Record<string, unknown>
  }
  if (!obj) return undefined
  const prompt = obj.prompt
  if (typeof prompt === 'string' && prompt.trim()) {
    const p = prompt.trim().replace(/\s+/g, ' ')
    return p.length > 140 ? p.slice(0, 137) + '…' : p
  }
  return undefined
}

/** Extract generated/edited image paths from a tool call. */
export function extractImageRefsFromTool(tool: ToolCallInfo): ImageRef[] {
  const out: ImageRef[] = []
  const caption = captionFromInput(tool.rawInput)
  // Free-text path scanning only for tools that produce images. Structured
  // JSON results stay unconditional — see isImageProducingTool.
  const freeText = isImageProducingTool(tool)

  for (const chunk of flattenToolContent(tool.content)) {
    for (const ref of extractImagePathsFromText(chunk, { freeText })) {
      pushUnique(out, { ...ref, caption: caption || ref.caption })
    }
  }

  // rawInput may also reference output path on some agents
  if (tool.rawInput !== undefined) {
    for (const chunk of flattenToolContent(tool.rawInput)) {
      // Don't treat prompt text with accidental paths; only absolute or images/
      for (const ref of extractImagePathsFromText(chunk, { freeText })) {
        if (isAbsoluteLocalPath(ref.path) || /^images[\\/]/i.test(ref.path)) {
          pushUnique(out, { ...ref, caption: caption || ref.caption })
        }
      }
    }
  }

  return out
}

/** Collect unique image refs across several tools (e.g. one turn). */
export function extractImageRefsFromTools(tools: ToolCallInfo[]): ImageRef[] {
  const out: ImageRef[] = []
  for (const t of tools) {
    for (const ref of extractImageRefsFromTool(t)) {
      pushUnique(out, ref)
    }
  }
  return out
}
