/**
 * Stored user state IPC: app settings, recent projects, the chat sandbox path,
 * the permission audit log and the activity calendar.
 */

import { ipcMain } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { clampCalendarDays, getActivityCalendar } from '../activity'
import { invalidateCliVersionCache } from '../cli-version'
import { chatWorkspacePath } from '../data-dir'
import { assertTrustedSender } from '../ipc-guard'
import {
  addRecentProject,
  getPermissionAudit,
  getProjectNotes,
  getRecentProjects,
  getSettings,
  removeRecentProject,
  setProjectNote,
  setRecentProjectPinned,
  setSettings
} from '../store'
import { assertNoteText, assertString } from './validate'
import type { AppSettings } from '../../../shared/types'

export function registerSettingsIpc(): void {
  ipcMain.handle('gronk:get-settings', (e) => {
    assertTrustedSender(e)
    return getSettings()
  })

  ipcMain.handle('gronk:set-settings', (e, partial: Partial<AppSettings>) => {
    assertTrustedSender(e)
    if (!partial || typeof partial !== 'object') throw new Error('Invalid settings')
    // A different binary is a different CLI, so its cached version is now a
    // claim about a file the app no longer runs.
    if ('grokBinary' in partial) invalidateCliVersionCache()
    return setSettings(partial)
  })

  ipcMain.handle('gronk:get-recent-projects', (e) => {
    assertTrustedSender(e)
    return getRecentProjects()
  })

  ipcMain.handle('gronk:add-recent-project', (e, cwd: string) => {
    assertTrustedSender(e)
    return addRecentProject(assertString(cwd, 'cwd'))
  })

  ipcMain.handle('gronk:remove-recent-project', (e, cwd: string) => {
    assertTrustedSender(e)
    return removeRecentProject(assertString(cwd, 'cwd'))
  })

  ipcMain.handle('gronk:set-recent-project-pinned', (e, cwd: string, pinned: unknown) => {
    assertTrustedSender(e)
    if (typeof pinned !== 'boolean') throw new Error('pinned must be a boolean')
    return setRecentProjectPinned(assertString(cwd, 'cwd'), pinned)
  })

  ipcMain.handle('gronk:get-project-notes', (e) => {
    assertTrustedSender(e)
    return getProjectNotes()
  })

  ipcMain.handle('gronk:set-project-note', (e, cwd: string, note: unknown) => {
    assertTrustedSender(e)
    // cwd first: it is the key, and a bad one would file the note under garbage.
    // The note itself is the user's own text and is stored verbatim (FIX-R1).
    const dir = assertString(cwd, 'cwd')
    return setProjectNote(dir, assertNoteText(note, 'note'))
  })

  ipcMain.handle('gronk:get-chat-workspace', (e) => {
    assertTrustedSender(e)
    // Must come from data-dir: a relocated data directory has to take the chat
    // sandbox with it, or the agent keeps writing into the old location.
    const dir = chatWorkspacePath()
    fs.mkdirSync(dir, { recursive: true })
    const readme = path.join(dir, 'README.txt')
    if (!fs.existsSync(readme)) {
      fs.writeFileSync(
        readme,
        [
          'Gronk Chat workspace',
          '',
          'This folder is a local sandbox for general Grok chat sessions.',
          'It is not one of your coding projects. Conversations here are',
          'backed by the Grok CLI (same account as `grok login`), not the website.',
          ''
        ].join('\n'),
        'utf8'
      )
    }
    return dir
  })

  ipcMain.handle('gronk:get-permission-audit', (e) => {
    assertTrustedSender(e)
    return getPermissionAudit()
  })

  ipcMain.handle('gronk:get-activity-calendar', (e, days?: unknown) => {
    assertTrustedSender(e)
    // Clamped rather than rejected: `days` only sizes a read-only window over the
    // user's own store, so a nonsense value is a caller bug, not an attack, and
    // failing the Home panel over it would be the worse outcome. The clamp is
    // what stops "1e9 days" from building a billion-element array.
    return getActivityCalendar(clampCalendarDays(days))
  })
}
