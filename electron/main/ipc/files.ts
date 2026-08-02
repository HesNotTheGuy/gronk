/**
 * Filesystem-facing IPC: native pickers, project file listing, and reading or
 * revealing local images. Every path the renderer supplies is re-validated here
 * or in ./images.ts — none of these handlers trust a path as given.
 */

import { dialog, ipcMain } from 'electron'
import fs from 'node:fs'
import { agentManager } from '../agent-manager'
import { listProjectFiles } from '../fs-utils'
import { assertTrustedSender, isPathInside } from '../ipc-guard'
import { normalizeCwd } from '../store'
import { readLocalImageSafe, revealLocalPathSafe } from './images'
import { assertOptionalString, assertString } from './validate'
import type { IpcContext } from './context'

/**
 * realpath, falling back to the input when the path does not exist yet.
 *
 * Deliberately a second copy of the helper in ./images.ts, which keeps its own
 * private. Worth hoisting into ipc-guard.ts once a third caller wants it; until
 * then a shared export would be indirection around three lines whose entire
 * contract is that they never throw.
 */
function realpathOrSelf(target: string): string {
  try {
    return fs.realpathSync(target)
  } catch {
    return target
  }
}

/**
 * FIX-13: may the renderer list files under `root`? `activeCwd` is the open
 * agent project, or null when no session is running.
 *
 * isPathInside rather than a hand-rolled `startsWith(activeCwd + '/')`, because
 * the separator is a backslash on Windows: the hand-rolled form could not match
 * a single subdirectory there, and comparison on that platform also has to fold
 * case. The trailing separator isPathInside appends is what stops
 * `/home/me/project-secrets` from counting as inside `/home/me/project`.
 */
export function isListProjectFilesAllowed(root: string, activeCwd: string | null): boolean {
  // Skipping the check with no session open is a deliberate decision, not an
  // oversight. The app browses the filesystem before any project exists: the
  // folder picker and the drop-to-open flow both list a directory the user has
  // just chosen, at a moment when there is no agent cwd to confine them to.
  // Refusing here would break opening a project at all.
  //
  // What bounds it. The handler is still behind assertTrustedSender, so only
  // Gronk's own renderer frame reaches this at all. The window closes the
  // instant a session starts, since every later call is measured against that
  // project. And listProjectFiles returns names and paths only, never file
  // contents; reading bytes goes through the jail in agent/fs-bridge.ts, which
  // refuses outright when there is no root. Narrowing this is a product
  // decision about the open flow rather than a one-line change here, so the
  // behaviour is pinned by a test in tests/ipc-files.test.ts and any future
  // change to it has to show up in that diff.
  if (!activeCwd) return true

  const nActive = normalizeCwd(activeCwd)

  // Canonicalise the renderer's path before comparing, the way ./images.ts
  // canonicalises a candidate image. A lexical test cannot see through a
  // symlink, so `<project>/link-to-elsewhere` read as contained while pointing
  // anywhere on disk. A path that does not exist yet is left alone by
  // realpathOrSelf and so is still compared lexically, which is what keeps a
  // directory the user is about to create listable.
  const target = realpathOrSelf(normalizeCwd(root))

  // Both forms of the root are tried because the project itself can sit behind
  // a link: the macOS temp dir is /var/folders/... which really lives under
  // /private, and the same goes for any home directory reached through one. A
  // resolved target could never match that unresolved root, so paths genuinely
  // inside the open project were being refused.
  //
  // This only makes the comparison correct, it does not widen it. Everything
  // the old string prefix accepted with no symlink involved is still accepted,
  // and a target that resolves out of the project is now refused where before
  // it passed.
  if (isPathInside(nActive, target)) return true
  return isPathInside(realpathOrSelf(nActive), target)
}

export function registerFilesIpc(ctx: IpcContext): void {
  ipcMain.handle('gronk:select-folder', async (e) => {
    assertTrustedSender(e)
    const result = await dialog.showOpenDialog(ctx.getMainWindow()!, {
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    return result.filePaths[0]
  })

  ipcMain.handle(
    'gronk:select-file',
    async (
      e,
      options?: { filters?: { name: string; extensions: string[] }[]; title?: string }
    ) => {
      assertTrustedSender(e)
      const result = await dialog.showOpenDialog(ctx.getMainWindow()!, {
        title: options?.title || 'Select file',
        properties: ['openFile'],
        filters: options?.filters
      })
      if (result.canceled || !result.filePaths[0]) return null
      return result.filePaths[0]
    }
  )

  ipcMain.handle(
    'gronk:list-project-files',
    (e, cwd: string, query?: string, limit?: number) => {
      assertTrustedSender(e)
      const root = assertString(cwd, 'cwd')
      if (!isListProjectFilesAllowed(root, agentManager.getCwd())) {
        throw new Error('listProjectFiles restricted to the open project')
      }
      const q = assertOptionalString(query, 'query')
      const lim =
        typeof limit === 'number' && Number.isFinite(limit)
          ? Math.min(Math.max(1, Math.floor(limit)), 100)
          : 40
      return listProjectFiles(root, q, lim)
    }
  )

  ipcMain.handle('gronk:read-local-image', async (e, filePath: string) => {
    assertTrustedSender(e)
    return readLocalImageSafe(assertString(filePath, 'filePath'))
  })

  ipcMain.handle('gronk:reveal-local-path', async (e, filePath: string) => {
    assertTrustedSender(e)
    return revealLocalPathSafe(assertString(filePath, 'filePath'))
  })
}
