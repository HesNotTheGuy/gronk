import fs from 'node:fs'
import path from 'node:path'
import type { FileEntry } from '../../shared/types'

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'release',
  '.next',
  '.cache',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  '.turbo',
  '.idea',
  '.vscode'
])

/**
 * Shallow project walk for @-file mentions. Caps depth + count for UI speed.
 */
export function listProjectFiles(
  cwd: string,
  query?: string,
  limit = 40
): FileEntry[] {
  const root = path.resolve(cwd)
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return []

  const q = (query || '').trim().toLowerCase().replace(/\\/g, '/')
  const out: FileEntry[] = []
  const maxDepth = 4

  function walk(dir: string, depth: number): void {
    if (out.length >= limit * 3) return // oversample then filter/sort
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const ent of entries) {
      if (out.length >= limit * 3) break
      const name = ent.name
      if (name.startsWith('.') && name !== '.env.example') {
        if (name !== '.gitignore' && name !== '.env') continue
      }
      if (ent.isDirectory() && SKIP_DIRS.has(name)) continue

      const full = path.join(dir, name)
      const rel = path.relative(root, full).replace(/\\/g, '/')
      const isDir = ent.isDirectory()

      out.push({
        path: full,
        name,
        relative: rel,
        isDir
      })

      if (isDir && depth < maxDepth) {
        walk(full, depth + 1)
      }
    }
  }

  walk(root, 0)

  let filtered = out
  if (q) {
    filtered = out.filter(
      (f) =>
        f.relative.toLowerCase().includes(q) ||
        f.name.toLowerCase().includes(q)
    )
  }

  // Prefer files over dirs; shorter paths first; then alpha
  filtered.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? 1 : -1
    const ad = a.relative.split('/').length
    const bd = b.relative.split('/').length
    if (ad !== bd) return ad - bd
    return a.relative.localeCompare(b.relative)
  })

  return filtered.slice(0, limit)
}

export function exportTranscriptMarkdown(
  title: string,
  messages: Array<{ role: string; text: string; thought?: string }>
): string {
  // "Written with Grok" is one of the two phrasings xAI's brand guidelines ask
  // for on generated material that is published or distributed. An export is
  // meant to leave the machine, which is what makes it the place the request
  // applies — not the store, not the clipboard, not the UI.
  //
  // Above the transcript rather than at the end: the guidelines ask for legible
  // and noticeable, and a footer on a long export is neither.
  //
  // The same menu also exports raw JSON. That carries no attribution and should
  // not: a machine-readable dump of stored fields is not a document being read
  // by a person, and inventing a field for it would change a shape nothing
  // currently parses, for a line nobody sees.
  const lines: string[] = [
    `# ${title}`,
    '',
    `Written with Grok · exported ${new Date().toISOString()}`,
    ''
  ]
  for (const m of messages) {
    const role = m.role === 'user' ? 'Operator' : m.role === 'assistant' ? 'Grok' : 'System'
    lines.push(`## ${role}`, '')
    if (m.thought) {
      lines.push('> Thinking', '>')
      for (const t of m.thought.split('\n')) lines.push(`> ${t}`)
      lines.push('')
    }
    lines.push(m.text || '_(empty)_', '')
  }
  return lines.join('\n')
}
