import type { PermissionRequest, ToolCallInfo } from '../../shared/types'
import {
  extractImageRefsFromTool,
  flattenToolContent,
  type ImageRef
} from './image-refs'
import { parseRawInput, pickString } from './tool-payload'

export interface FormattedTool {
  kindLabel: string
  summary: string
  body: string
  diffLines?: DiffLine[]
  path?: string
  /** Generated/edited image files to show inline in chat */
  images?: ImageRef[]
}

export interface DiffLine {
  type: 'add' | 'del' | 'ctx' | 'hunk'
  text: string
}

/**
 * Gutter mark for a diff row. Shared so the tool card and the permission modal
 * cannot drift — the approval screen and the after-the-fact view showing the
 * same edit with different symbols would be its own small trust problem.
 * Uses U+2212 MINUS, not a hyphen, so it aligns with '+' in a mono column.
 */
export function diffMark(type: DiffLine['type']): string {
  if (type === 'add') return '+'
  if (type === 'del') return '−'
  if (type === 'hunk') return '@@'
  return ' '
}

function kindLabel(kind?: string, title?: string, hasImages?: boolean): string {
  const k = (kind || title || 'tool').toLowerCase()
  if (/image_gen|image_edit|imagine|image_to_video|reference_to_video/.test(k) || hasImages) {
    return 'IMAGE'
  }
  if (/spawn_subagent|subagent/.test(k)) return 'AGENT'
  if (/workflow/.test(k)) return 'FLOW'
  if (/monitor|scheduler/.test(k)) return 'TASK'
  if (/edit|write|patch|apply|str_replace|search_replace/.test(k)) return 'EDIT'
  if (/read|cat|open|file_read|view/.test(k)) return 'READ'
  if (/bash|shell|exec|command|terminal|run/.test(k)) return 'SHELL'
  if (/search|grep|glob|find|rg/.test(k)) return 'SEARCH'
  if (/web|fetch|http|browse/.test(k)) return 'NET'
  if (/list|ls|dir|tree/.test(k)) return 'LIST'
  return (kind || 'TOOL').slice(0, 8).toUpperCase()
}

export interface FormatOptions {
  /**
   * Cap on the characters read from each side before diffing. Left undefined by
   * ToolCard — a completed call already ran, so its payload is whatever it was.
   * The permission surface sets it because the request is agent-supplied and
   * unbounded: splitting a multi-megabyte string into lines and painting them
   * would stall the renderer at the exact moment the user needs to answer.
   */
  maxDiffSourceChars?: number
}

/** Simple line diff when old/new text present (no deps). */
export function simpleDiff(
  oldText: string,
  newText: string,
  maxSourceChars?: number
): DiffLine[] {
  const cap = maxSourceChars && maxSourceChars > 0 ? maxSourceChars : 0
  const clipped = cap > 0 && (oldText.length > cap || newText.length > cap)
  const a = (cap > 0 ? oldText.slice(0, cap) : oldText).replace(/\r\n/g, '\n').split('\n')
  const b = (cap > 0 ? newText.slice(0, cap) : newText).replace(/\r\n/g, '\n').split('\n')
  // LCS on capped sizes for UI
  const max = 400
  const aa = a.length > max ? a.slice(0, max) : a
  const bb = b.length > max ? b.slice(0, max) : b
  const n = aa.length
  const m = bb.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = aa[i] === bb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const lines: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (aa[i] === bb[j]) {
      lines.push({ type: 'ctx', text: aa[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push({ type: 'del', text: aa[i] })
      i++
    } else {
      lines.push({ type: 'add', text: bb[j] })
      j++
    }
  }
  while (i < n) {
    lines.push({ type: 'del', text: aa[i++] })
  }
  while (j < m) {
    lines.push({ type: 'add', text: bb[j++] })
  }
  if (a.length > max || b.length > max || clipped) {
    lines.push({ type: 'hunk', text: '…diff truncated for display' })
  }
  return lines.slice(0, 500)
}

function extractDiff(
  input: Record<string, unknown> | null,
  opts: FormatOptions
): DiffLine[] | undefined {
  if (!input) return undefined
  const oldText =
    pickString(input, ['old_string', 'oldString', 'oldText', 'before', 'original']) ||
    (typeof input.old === 'string' ? input.old : undefined)
  const newText =
    pickString(input, ['new_string', 'newString', 'newText', 'after', 'replacement', 'content']) ||
    (typeof input.new === 'string' ? input.new : undefined)

  // Unified diff already in payload
  const unified =
    pickString(input, ['diff', 'patch', 'unifiedDiff']) ||
    (typeof input.contents === 'string' && input.contents.includes('@@')
      ? input.contents
      : undefined)
  if (unified && (unified.includes('\n+') || unified.includes('\n-') || unified.includes('@@'))) {
    const cap = opts.maxDiffSourceChars
    const clipped = cap !== undefined && cap > 0 && unified.length > cap
    const source = clipped ? unified.slice(0, cap) : unified
    const lines: DiffLine[] = source.split('\n').map((line) => {
      if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@'))
        return { type: 'hunk' as const, text: line }
      if (line.startsWith('+')) return { type: 'add' as const, text: line.slice(1) }
      if (line.startsWith('-')) return { type: 'del' as const, text: line.slice(1) }
      return { type: 'ctx' as const, text: line.startsWith(' ') ? line.slice(1) : line }
    })
    if (clipped) lines.push({ type: 'hunk', text: '…diff truncated for display' })
    return lines
  }

  if (oldText !== undefined && newText !== undefined && oldText !== newText) {
    return simpleDiff(oldText, newText, opts.maxDiffSourceChars)
  }
  return undefined
}

export function formatTool(tool: ToolCallInfo, opts: FormatOptions = {}): FormattedTool {
  const input = parseRawInput(tool.rawInput)

  const images = extractImageRefsFromTool(tool)
  const hasImages = images.length > 0

  const path =
    pickString(input, ['path', 'file', 'file_path', 'filePath', 'filename', 'target']) ||
    images[0]?.path ||
    undefined

  const command = pickString(input, ['command', 'cmd', 'shell', 'script'])
  const pattern = pickString(input, ['pattern', 'query', 'grep', 'regex'])
  const prompt = pickString(input, ['prompt'])

  const label = kindLabel(tool.kind, tool.title, hasImages)
  let summary = tool.title
  if (hasImages) {
    summary =
      images.map((i) => i.label).join(', ') ||
      (prompt ? prompt.slice(0, 80) : 'Generated image')
  } else if (path) summary = path
  else if (command) summary = command.slice(0, 120)
  else if (pattern) summary = pattern.slice(0, 80)
  else if (prompt) summary = prompt.slice(0, 80)

  const diffLines = extractDiff(input, opts)

  const parts: string[] = []
  if (tool.rawInput !== undefined && !diffLines && !hasImages) {
    parts.push(
      typeof tool.rawInput === 'string'
        ? tool.rawInput
        : JSON.stringify(tool.rawInput, null, 2)
    )
  } else if (hasImages && prompt) {
    parts.push(`Prompt: ${prompt}`)
  }

  if (tool.content !== undefined && !hasImages) {
    // Prefer flattened text for nested ACP content blocks
    const flat = flattenToolContent(tool.content)
    if (flat.length === 1) {
      parts.push(flat[0])
    } else if (flat.length > 1) {
      parts.push(flat.join('\n\n---\n\n'))
    } else {
      parts.push(
        typeof tool.content === 'string'
          ? tool.content
          : JSON.stringify(tool.content, null, 2)
      )
    }
  }
  if (tool.error) parts.push(`Error: ${tool.error}`)

  return {
    kindLabel: label,
    summary,
    body: parts.join('\n\n---\n\n') || (diffLines || hasImages ? '' : 'No payload'),
    diffLines,
    path,
    images: hasImages ? images : undefined
  }
}

// ── Permission requests ────────────────────────────────────────────
//
// The approval prompt is the one screen where the user's answer is binding, and
// its entire payload is written by the agent. Everything below turns that
// payload into something readable — a diff, a command, the fields that matter —
// without letting it decide how tall the modal gets or what the reader sees
// first. The raw payload stays reachable in the modal; this is a lens on it,
// not a replacement for it.

/** Display caps for the approval screen. Deliberately small: the buttons matter more. */
export const PERMISSION_LIMITS = {
  /** Characters read from each side before diffing. */
  diffSourceChars: 60000,
  /** Rendered diff rows. `.diff-pre` scrolls; this bounds the DOM node count. */
  diffLines: 200,
  /** Per rendered line — one unbroken megabyte-long line wraps into a wall of text. */
  lineChars: 300,
  subjectChars: 2000,
  factValueChars: 200,
  factLabelChars: 40,
  facts: 8,
  rawChars: 20000
} as const

/**
 * C0/C1 controls, zero-width joiners, bidi overrides and stray surrogates.
 * Bidi overrides are the reason this exists: they can make a path or a diff line
 * read as something other than what will be written (Trojan Source), and an
 * approval screen is exactly where that pays off for an attacker.
 */
function isUnsafeChar(code: number, preserveLayout: boolean): boolean {
  if (preserveLayout && (code === 0x09 || code === 0x0a)) return false
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0xd800 && code <= 0xdfff) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x2028 && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  )
}

/**
 * Agent text rendered as inert characters, bounded to `max`.
 * `preserveLayout` keeps tabs, newlines and indentation (code, commands, raw
 * payloads); without it the value is collapsed to a single line for a label row.
 */
export function inertText(value: unknown, max: number, preserveLayout = false): string {
  if (typeof value !== 'string' || !value || max <= 0) return ''
  // Slice before scanning: the loop below is per-codepoint over unbounded input.
  const over = value.length > max
  let out = ''
  for (const ch of over ? value.slice(0, max) : value) {
    out += isUnsafeChar(ch.codePointAt(0) || 0, preserveLayout) ? ' ' : ch
  }
  const shaped = preserveLayout ? out : out.replace(/\s+/g, ' ').trim()
  return over ? `${shaped}…` : shaped
}

export interface BoundedDiff {
  lines: DiffLine[]
  truncated: boolean
  added: number
  removed: number
}

/** Clip a computed diff to something a modal can hold, and count the real damage. */
export function boundDiffLines(
  lines: DiffLine[],
  maxLines: number = PERMISSION_LIMITS.diffLines,
  maxChars: number = PERMISSION_LIMITS.lineChars
): BoundedDiff {
  let added = 0
  let removed = 0
  let clippedLine = false
  for (const line of lines) {
    if (line.type === 'add') added++
    else if (line.type === 'del') removed++
    if (line.text.length > maxChars) clippedLine = true
  }
  const kept: DiffLine[] = lines.slice(0, maxLines).map((line) => ({
    type: line.type,
    text: inertText(line.text, maxChars, true)
  }))
  const truncated = lines.length > maxLines || clippedLine
  if (lines.length > maxLines) {
    kept.push({ type: 'hunk', text: `…${lines.length - maxLines} more lines not shown` })
  } else if (clippedLine) {
    kept.push({ type: 'hunk', text: '…long lines clipped for display' })
  }
  return { lines: kept, truncated, added, removed }
}

export interface PermissionFact {
  label: string
  value: string
}

export interface FormattedPermission {
  /** EDIT / SHELL / READ / NET / … derived from the structured kind only. */
  kindLabel: string
  /** What the request acts on: 'Command', 'URL', 'File', 'Pattern', 'Prompt'. */
  subjectLabel: string
  subject: string
  /** File path for an edit, shown above the diff. */
  path?: string
  diffLines?: DiffLine[]
  diffTruncated: boolean
  added: number
  removed: number
  /** Remaining scalar fields, so a non-edit request is not a JSON dump either. */
  facts: PermissionFact[]
  raw: string
  rawTruncated: boolean
}

const SUBJECT_GROUPS: Array<{ label: string; keys: string[] }> = [
  { label: 'Command', keys: ['command', 'cmd', 'shell', 'script'] },
  { label: 'URL', keys: ['url', 'uri', 'href', 'endpoint'] },
  { label: 'File', keys: ['path', 'file_path', 'filePath', 'file', 'filename', 'target'] },
  { label: 'Pattern', keys: ['pattern', 'query', 'regex', 'grep'] },
  { label: 'Prompt', keys: ['prompt', 'instructions'] }
]

const PREFERRED_SUBJECT: Record<string, string> = {
  SHELL: 'Command',
  NET: 'URL',
  EDIT: 'File',
  READ: 'File',
  LIST: 'File',
  SEARCH: 'Pattern',
  AGENT: 'Prompt'
}

/** Keys the diff already renders — repeating them as facts is noise, not detail. */
const DIFF_KEYS = [
  'old_string',
  'oldString',
  'oldText',
  'before',
  'original',
  'old',
  'new_string',
  'newString',
  'newText',
  'after',
  'replacement',
  'content',
  'contents',
  'text',
  'new',
  'diff',
  'patch',
  'unifiedDiff'
]

const OLD_TEXT_KEYS = ['old_string', 'oldString', 'oldText', 'before', 'original', 'old']
const NEW_TEXT_KEYS = [
  'new_string',
  'newString',
  'newText',
  'after',
  'replacement',
  'content',
  'contents',
  'text',
  'new'
]

/** Like pickString, but an empty string is an answer here: it means "nothing on this side". */
function pickAnyString(
  input: Record<string, unknown> | null,
  keys: string[]
): string | undefined {
  if (!input) return undefined
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string') return value
  }
  return undefined
}

/** Whole-file create or delete: there is no other side, so every line is one colour. */
function oneSidedDiff(text: string, type: 'add' | 'del', cap: number): DiffLine[] {
  const clipped = text.length > cap
  const lines: DiffLine[] = (clipped ? text.slice(0, cap) : text)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => ({ type, text: line }))
  if (clipped) lines.push({ type: 'hunk', text: '…diff truncated for display' })
  return lines
}

/**
 * Creating a file sends `new_string` with an empty (or absent) `old_string`, and
 * `extractDiff` skips it because there is nothing to compare against. That is
 * the case where a preview matters most — the user is approving the entire
 * contents — so the permission view renders it as an all-additions diff.
 */
function wholeFileDiff(input: Record<string, unknown> | null): DiffLine[] | undefined {
  const before = pickAnyString(input, OLD_TEXT_KEYS)
  const after = pickAnyString(input, NEW_TEXT_KEYS)
  if (before === after) return undefined
  const cap = PERMISSION_LIMITS.diffSourceChars
  if (!before && after) return oneSidedDiff(after, 'add', cap)
  if (before && !after) return oneSidedDiff(before, 'del', cap)
  return undefined
}

function pickSubject(
  label: string,
  input: Record<string, unknown> | null
): { label: string; key: string; value: string } | null {
  if (!input) return null
  const preferred = PREFERRED_SUBJECT[label]
  const groups = preferred
    ? [
        ...SUBJECT_GROUPS.filter((g) => g.label === preferred),
        ...SUBJECT_GROUPS.filter((g) => g.label !== preferred)
      ]
    : SUBJECT_GROUPS
  for (const group of groups) {
    for (const key of group.keys) {
      const raw = input[key]
      if (typeof raw !== 'string' || !raw.trim()) continue
      const value = inertText(raw, PERMISSION_LIMITS.subjectChars, true)
      if (value) return { label: group.label, key, value }
    }
  }
  return null
}

function factValue(value: unknown): string {
  if (typeof value === 'string') return inertText(value, PERMISSION_LIMITS.factValueChars)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return inertText(JSON.stringify(value), PERMISSION_LIMITS.factValueChars)
  } catch {
    return '[unserialisable]'
  }
}

function factsFrom(input: Record<string, unknown> | null, skip: Set<string>): PermissionFact[] {
  if (!input) return []
  const out: PermissionFact[] = []
  for (const key of Object.keys(input)) {
    if (out.length >= PERMISSION_LIMITS.facts) break
    if (skip.has(key)) continue
    const value = input[key]
    if (value === null || value === undefined || value === '') continue
    const shown = factValue(value)
    if (!shown) continue
    out.push({ label: inertText(key, PERMISSION_LIMITS.factLabelChars) || 'field', value: shown })
  }
  return out
}

function rawPayload(rawInput: unknown): { text: string; truncated: boolean } {
  if (rawInput === undefined || rawInput === null) return { text: '', truncated: false }
  let serialised: string
  try {
    serialised = typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput, null, 2)
  } catch {
    // Circular or otherwise unserialisable: say so rather than showing nothing.
    serialised = '[payload could not be serialised — deny unless you know what this is]'
  }
  return {
    text: inertText(serialised, PERMISSION_LIMITS.rawChars, true),
    truncated: serialised.length > PERMISSION_LIMITS.rawChars
  }
}

function emptyPermission(raw: { text: string; truncated: boolean }): FormattedPermission {
  return {
    kindLabel: 'TOOL',
    subjectLabel: '',
    subject: '',
    diffTruncated: false,
    added: 0,
    removed: 0,
    facts: [],
    raw: raw.text,
    rawTruncated: raw.truncated
  }
}

/**
 * A permission request as the modal should read it.
 *
 * Never throws: a formatting failure here would leave the user unable to answer
 * a prompt that is already blocking the agent, so it degrades to the raw
 * payload instead.
 */
export function formatPermission(
  request: Pick<PermissionRequest, 'title' | 'kind' | 'rawInput'>
): FormattedPermission {
  const raw = rawPayload(request?.rawInput)
  try {
    const input = parseRawInput(request?.rawInput)
    // Badge comes from the structured kind alone. `title` is agent-written prose
    // and must not be able to make a write announce itself as a read.
    const label = kindLabel(request?.kind, undefined, false)

    const fmt = formatTool(
      {
        toolCallId: '',
        title: '',
        kind: request?.kind,
        rawInput: request?.rawInput,
        status: 'pending'
      },
      { maxDiffSourceChars: PERMISSION_LIMITS.diffSourceChars }
    )

    const computed = fmt.diffLines?.length
      ? fmt.diffLines
      : label === 'EDIT'
        ? wholeFileDiff(input)
        : undefined
    const diff = computed?.length ? boundDiffLines(computed) : null
    const path = fmt.path ? inertText(fmt.path, PERMISSION_LIMITS.subjectChars) : undefined

    let subject = pickSubject(label, input)
    // With a diff on screen the path is already the caption above it.
    if (diff && subject?.label === 'File') subject = null
    if (!subject && !input && typeof request?.rawInput === 'string' && request.rawInput.trim()) {
      // Payload is a bare string, not JSON — that string is the whole request.
      subject = {
        label: PREFERRED_SUBJECT[label] || 'Payload',
        key: '',
        value: inertText(request.rawInput, PERMISSION_LIMITS.subjectChars, true)
      }
    }

    const skip = new Set<string>(DIFF_KEYS)
    if (subject) skip.add(subject.key)
    if (diff) {
      // The path is the caption above the diff; listing it again is noise.
      for (const group of SUBJECT_GROUPS) {
        if (group.label !== 'File') continue
        for (const key of group.keys) skip.add(key)
      }
    }

    return {
      kindLabel: label,
      subjectLabel: subject?.label || '',
      subject: subject?.value || '',
      path,
      diffLines: diff?.lines,
      diffTruncated: diff?.truncated || false,
      added: diff?.added || 0,
      removed: diff?.removed || 0,
      facts: factsFrom(input, skip),
      raw: raw.text,
      rawTruncated: raw.truncated
    }
  } catch {
    return emptyPermission(raw)
  }
}
