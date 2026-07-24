import type { ToolCallInfo } from '../../shared/types'
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

/** Simple line diff when old/new text present (no deps). */
export function simpleDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText.replace(/\r\n/g, '\n').split('\n')
  const b = newText.replace(/\r\n/g, '\n').split('\n')
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
  if (a.length > max || b.length > max) {
    lines.push({ type: 'hunk', text: '…diff truncated for display' })
  }
  return lines.slice(0, 500)
}

function extractDiff(input: Record<string, unknown> | null): DiffLine[] | undefined {
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
    return unified.split('\n').map((line) => {
      if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@'))
        return { type: 'hunk' as const, text: line }
      if (line.startsWith('+')) return { type: 'add' as const, text: line.slice(1) }
      if (line.startsWith('-')) return { type: 'del' as const, text: line.slice(1) }
      return { type: 'ctx' as const, text: line.startsWith(' ') ? line.slice(1) : line }
    })
  }

  if (oldText !== undefined && newText !== undefined && oldText !== newText) {
    return simpleDiff(oldText, newText)
  }
  return undefined
}

export function formatTool(tool: ToolCallInfo): FormattedTool {
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

  const diffLines = extractDiff(input)

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
