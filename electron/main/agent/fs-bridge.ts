/**
 * Filesystem guards for the ACP `fs/read_text_file` and `fs/write_text_file`
 * client requests.
 *
 * No Electron import: this is the boundary that decides which paths the agent
 * may reach on the user's machine, so it is the part of the manager most worth
 * having under test.
 */

import fs from 'node:fs'
import path from 'node:path'

/** Read the size before the bytes, so a huge file cannot be slurped into memory. */
export const MAX_FS_READ_BYTES = 4 * 1024 * 1024 // 4 MB

/**
 * Resolve `filePath` inside the project root, or refuse.
 *
 * Realpath-aware in both directions: the root is resolved first so a symlinked
 * project folder still matches, and the deepest existing ancestor of the target
 * is resolved so a symlink pointing out of the tree cannot be followed. A file
 * that does not exist yet is allowed as long as its existing ancestor is inside
 * — that is the create-a-new-file case.
 *
 * Returns null when there is no project root at all: refusing is the only safe
 * default, since "no root" would otherwise mean "any path".
 */
export function resolveInsideJail(root: string | null, filePath: string): string | null {
  if (!root) return null
  let realRoot: string
  try {
    realRoot = fs.realpathSync(path.resolve(root))
  } catch {
    return null
  }
  const resolved = path.resolve(realRoot, filePath)
  let probe = resolved
  while (!fs.existsSync(probe) && path.dirname(probe) !== probe) {
    probe = path.dirname(probe)
  }
  let realProbe: string
  try {
    realProbe = fs.realpathSync(probe)
  } catch {
    return null
  }
  const real = realProbe + resolved.slice(probe.length)
  if (real === realRoot || real.startsWith(realRoot + path.sep)) return real
  return null
}

/**
 * Apply ACP's optional `line` / `limit` window to file content.
 *
 * `line` is 1-based in the protocol. Neither argument present means the whole
 * file, so the split is skipped rather than round-tripped through join.
 */
export function sliceLines(content: string, line?: number, limit?: number): string {
  if (line === undefined && limit === undefined) return content
  const lines = content.split(/\r?\n/)
  const start = Math.max(0, (line ?? 1) - 1)
  const end = limit !== undefined ? start + limit : lines.length
  return lines.slice(start, end).join('\n')
}
