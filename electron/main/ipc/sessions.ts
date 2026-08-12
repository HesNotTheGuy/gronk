/**
 * Session and transcript IPC: listing, restoring, persisting, renaming,
 * archiving, deleting and exporting conversations.
 */

import { app, dialog, ipcMain } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { agentManager } from '../agent-manager'
import { scheduleAttachmentSweep } from '../attachment-gc'
import { getAuthStatus } from '../auth'
import { exportTranscriptMarkdown } from '../fs-utils'
import { assertTrustedSender } from '../ipc-guard'
import {
  archiveSession,
  deleteSession,
  getTranscript,
  listSessions,
  listSessionsWithTranscripts,
  renameSession,
  saveTranscript
} from '../store'
import { parseQuery, rankHits, scoreSession } from '../../../shared/session-search'
import { rememberExportedPath } from './exported-paths'
import { assertOptionalString, assertString } from './validate'
import type { IpcContext } from './context'
import type { ChatMessage } from '../../../shared/types'

export function registerSessionsIpc(ctx: IpcContext): void {
  ipcMain.handle('gronk:list-sessions', (e) => {
    assertTrustedSender(e)
    return listSessions()
  })

  ipcMain.handle('gronk:load-session', async (e, sessionId: unknown, requestId?: unknown) => {
    assertTrustedSender(e)
    const auth = await getAuthStatus()
    if (!auth.authenticated) {
      throw new Error(
        auth.message ||
          'Sign in required before restoring a session. Use your own Grok account.'
      )
    }
    const id = assertString(sessionId, 'sessionId')
    // Validated like any other renderer argument: it is echoed back on this load's
    // history events, so it reaches the renderer's own filtering decisions.
    const request = assertOptionalString(requestId, 'requestId')
    const sessions = listSessions()
    const match = sessions.find((s) => s.id === id)
    return agentManager.loadSession(id, match?.cwd, request)
  })

  ipcMain.handle('gronk:get-transcript', (e, sessionId: string) => {
    assertTrustedSender(e)
    return getTranscript(assertString(sessionId, 'sessionId'))
  })

  /**
   * Full-text search across every session's transcript.
   *
   * Runs in the main process because the renderer has no store access, and
   * shipping every transcript over IPC to filter them there would be both slow
   * and pointless. Reads are already capped at 200 messages per session by
   * saveTranscript, so the worst case is bounded by session count.
   */
  ipcMain.handle('gronk:search-sessions', (e, query: string) => {
    assertTrustedSender(e)
    const terms = parseQuery(assertString(query, 'query'))
    if (terms.length === 0) return []

    // One store read for everything. Archived sessions are excluded because the
    // sidebar builds its row lookup from the active lists, so an archived hit was
    // counted in the results header and then silently dropped when it could not
    // be rendered. Archived work is reachable from its own view.
    const entries = listSessionsWithTranscripts()
    const hits = []
    for (const { session, messages } of entries) {
      // A session whose transcript was never persisted still matches on title.
      const hit = scoreSession(session, messages, terms)
      if (hit) hits.push(hit)
    }
    return rankHits(hits, entries.map((e) => e.session))
  })

  ipcMain.handle(
    'gronk:save-transcript',
    (e, sessionId: string, messages: ChatMessage[]) => {
      assertTrustedSender(e)
      if (!Array.isArray(messages)) throw new Error('Invalid messages')
      saveTranscript(assertString(sessionId, 'sessionId'), messages)
    }
  )

  ipcMain.handle('gronk:delete-session', (e, sessionId: string) => {
    assertTrustedSender(e)
    const sessions = deleteSession(assertString(sessionId, 'sessionId'))
    // After the store is written, never before: the sweep reads the file to
    // work out what is still referenced. Not awaited, so a slow disk cannot
    // hold up the reply and a failed sweep cannot fail the delete.
    //
    // This will usually NOT collect what was just deleted. `writeStore` rolls
    // the previous copy into the backup first, so immediately after a delete
    // the backup is the copy that still has the session, and a picture stays
    // while anything can still restore it. This call collects the generation
    // before; the sweep on launch collects the rest.
    void scheduleAttachmentSweep()
    return sessions
  })

  ipcMain.handle('gronk:rename-session', (e, sessionId: string, title: string) => {
    assertTrustedSender(e)
    return renameSession(assertString(sessionId, 'sessionId'), assertString(title, 'title'))
  })

  ipcMain.handle(
    'gronk:archive-session',
    (e, sessionId: string, archived?: boolean) => {
      assertTrustedSender(e)
      return archiveSession(assertString(sessionId, 'sessionId'), archived !== false)
    }
  )

  ipcMain.handle(
    'gronk:export-transcript',
    async (e, sessionId: string, format: 'md' | 'json' = 'md') => {
      assertTrustedSender(e)
      const id = assertString(sessionId, 'sessionId')
      if (format !== 'md' && format !== 'json') throw new Error('Invalid format')
      const sessions = listSessions()
      const sessionInfo = sessions.find((s) => s.id === id)
      const messages = getTranscript(id)
      // Discriminated so the renderer can tell "nothing to export" from "user
      // cancelled the dialog". A bare null meant both, so an empty transcript
      // looked exactly like a dead menu item — no dialog, no message.
      if (!messages.length) return { ok: false as const, reason: 'empty' as const }

      const base = (sessionInfo?.title || id.slice(0, 8)).replace(/[<>:"/\\|?*]/g, '_')
      const defaultPath = path.join(
        app.getPath('documents'),
        `gronk-${base}.${format === 'json' ? 'json' : 'md'}`
      )

      const result = await dialog.showSaveDialog(ctx.getMainWindow()!, {
        title: 'Export transcript',
        defaultPath,
        filters:
          format === 'json'
            ? [{ name: 'JSON', extensions: ['json'] }]
            : [{ name: 'Markdown', extensions: ['md'] }]
      })
      if (result.canceled || !result.filePath) {
        return { ok: false as const, reason: 'cancelled' as const }
      }

      if (format === 'json') {
        fs.writeFileSync(
          result.filePath,
          JSON.stringify({ session: sessionInfo, messages }, null, 2),
          'utf8'
        )
      } else {
        const md = exportTranscriptMarkdown(sessionInfo?.title || id, messages)
        fs.writeFileSync(result.filePath, md, 'utf8')
      }
      // The user chose this path in a native save dialog, so revealing it is
      // consented by construction. Recording it here is what lets the reveal
      // handler open it WITHOUT widening the allowed roots for every other path.
      rememberExportedPath(result.filePath)
      return { ok: true as const, path: result.filePath }
    }
  )
}
