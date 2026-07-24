/**
 * Pure path helpers shared by Electron main and the renderer.
 * No Node `path` dependency so the web bundle can import this file.
 */

/** Slash-normalize and strip trailing slashes. Does not resolve relative segments. */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '')
}

/**
 * Compare two filesystem paths for equality after normalize.
 * Defaults to case-insensitive when either path looks like Windows (drive or UNC).
 */
export function pathsEqual(
  a: string,
  b: string,
  opts?: { ignoreCase?: boolean }
): boolean {
  const na = normalizePath(a)
  const nb = normalizePath(b)
  const winLike =
    /^[a-zA-Z]:\//.test(na) ||
    /^[a-zA-Z]:\//.test(nb) ||
    na.startsWith('//') ||
    nb.startsWith('//')
  const ignore = opts?.ignoreCase ?? winLike
  return ignore ? na.toLowerCase() === nb.toLowerCase() : na === nb
}

/** Last path segment (folder/file name). */
export function folderName(cwd: string): string {
  const parts = normalizePath(cwd).split('/').filter(Boolean)
  return parts[parts.length - 1] || cwd
}

/**
 * True if `cwd` is Grocky's app-level chat sandbox (not a user coding folder).
 * 1) Exact match to known chat root when provided
 * 2) Path ends with `/chat-workspace` (Grocky's fixed sandbox under userData)
 * 3) Path contains `/grocky/chat-workspace` (app userData layout)
 */
export function isChatWorkspace(
  cwd: string,
  chatRoot: string | null | undefined
): boolean {
  if (!cwd) return false
  if (chatRoot && pathsEqual(cwd, chatRoot)) return true
  const n = normalizePath(cwd).toLowerCase()
  if (n.endsWith('/chat-workspace') || n === 'chat-workspace') return true
  if (n.includes('/grocky/chat-workspace')) return true
  return false
}

/**
 * Classify a stored session for Chat vs Workspace lists.
 * App chat is always app-local (chat-workspace). Path is authoritative for that
 * sandbox so a wrong/missing `surface` field cannot leak chats into Workspace.
 */
export function isChatSession(
  session: { cwd: string; surface?: 'chat' | 'project' },
  chatRoot?: string | null
): boolean {
  // Sandbox path always means Chat — never Workspace
  if (isChatWorkspace(session.cwd, chatRoot)) return true
  if (session.surface === 'chat') return true
  return false
}

/** Workspace-only session filter (inverse of isChatSession). */
export function isWorkspaceSession(
  session: { cwd: string; surface?: 'chat' | 'project' },
  chatRoot?: string | null
): boolean {
  return !isChatSession(session, chatRoot)
}
