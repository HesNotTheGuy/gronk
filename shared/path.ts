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

/**
 * Folder names that mean "this directory is mirrored to somebody's servers".
 *
 * Prefix rather than exact match, because every provider decorates the folder
 * with the account: "OneDrive - Contoso", "Dropbox (Personal)", and on modern
 * macOS "OneDrive-Personal" under ~/Library/CloudStorage.
 */
const CLOUD_SYNC_FOLDERS: ReadonlyArray<readonly [prefix: string, service: string]> = [
  ['onedrive', 'OneDrive'],
  ['dropbox', 'Dropbox'],
  ['google drive', 'Google Drive'],
  ['googledrive', 'Google Drive'],
  ['my drive', 'Google Drive'],
  ['icloud drive', 'iCloud Drive'],
  ['com~apple~clouddocs', 'iCloud Drive'],
  ['mobile documents', 'iCloud Drive'],
  ['box sync', 'Box'],
  ['nextcloud', 'Nextcloud'],
  ['owncloud', 'ownCloud'],
  ['pcloud', 'pCloud'],
  ['tresorit', 'Tresorit'],
  ['proton drive', 'Proton Drive'],
  ['protondrive', 'Proton Drive'],
  ['creative cloud files', 'Adobe Creative Cloud'],
  ['yandexdisk', 'Yandex Disk'],
  ['sync.com', 'Sync.com']
]

/**
 * A sync root at the top of a user's home: "Dropbox", "OneDrive - Contoso",
 * "Dropbox (Personal)".
 *
 * A space is required before the account name. Allowing a hyphen here would
 * make "dropbox-clone" and "onedrive-backup-tool" match, which are ordinary
 * project folders.
 */
function isSyncRootSegment(segment: string, prefix: string): boolean {
  return segment === prefix || segment.startsWith(prefix + ' ')
}

/**
 * A provider directory inside ~/Library/CloudStorage, where macOS uses
 * "OneDrive-Personal" and "GoogleDrive-sam@example.com".
 *
 * The hyphen is safe here in a way it is not elsewhere: the parent directory has
 * already established that everything under it is synced.
 */
function isCloudStorageChild(segment: string, prefix: string): boolean {
  return isSyncRootSegment(segment, prefix) || segment.startsWith(prefix + '-')
}

/**
 * Which cloud service syncs this directory, if any. Null when it looks local.
 *
 * Gronk's data directory is relocatable, and transcripts are stored as readable
 * text. Moving them into a synced folder therefore uploads every conversation to
 * a third party, which is a decision worth making on purpose rather than by
 * accident. This only informs a warning: it never blocks a move, because
 * plenty of people sync deliberately and this cannot tell the difference.
 *
 * Name-based, so it is a heuristic. A renamed sync root is missed and a folder
 * that merely happens to be called "Dropbox" is a false positive. Being wrong
 * costs one dismissable notice in either direction.
 */
export function cloudSyncServiceFor(dir: string): string | null {
  if (!dir) return null
  const segments = normalizePath(dir)
    .split('/')
    .filter(Boolean)
    .map((s) => s.toLowerCase())

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]
    // macOS puts every provider under ~/Library/CloudStorage/<Provider>-<account>,
    // so the parent alone is proof even when the provider is one not listed here.
    if (segment === 'cloudstorage') {
      const child = segments[i + 1]
      const known = child && CLOUD_SYNC_FOLDERS.find(([prefix]) => isCloudStorageChild(child, prefix))
      return known ? known[1] : 'a cloud-synced folder'
    }
    const match = CLOUD_SYNC_FOLDERS.find(([prefix]) => isSyncRootSegment(segment, prefix))
    if (match) return match[1]
  }
  return null
}

/** Last path segment (folder/file name). */
export function folderName(cwd: string): string {
  const parts = normalizePath(cwd).split('/').filter(Boolean)
  return parts[parts.length - 1] || cwd
}

/**
 * True if `cwd` is Gronk's app-level chat sandbox (not a user coding folder).
 * 1) Exact match to known chat root when provided
 * 2) Path ends with `/chat-workspace` (Gronk's fixed sandbox under userData)
 * 3) Path contains `/gronk/chat-workspace` (app userData layout)
 */
export function isChatWorkspace(
  cwd: string,
  chatRoot: string | null | undefined
): boolean {
  if (!cwd) return false
  if (chatRoot && pathsEqual(cwd, chatRoot)) return true
  const n = normalizePath(cwd).toLowerCase()
  if (n.endsWith('/chat-workspace') || n === 'chat-workspace') return true
  if (n.includes('/gronk/chat-workspace')) return true
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
