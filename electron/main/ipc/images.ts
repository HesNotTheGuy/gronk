/**
 * Resolving and reading local images the agent referred to by name, plus the
 * reveal-in-folder path check.
 *
 * The agent hands back bare filenames and relative paths, so resolution has to
 * probe several roots — which is exactly why every result is re-checked against
 * the allow-list below before any bytes leave the main process.
 */

import { app, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { agentManager } from '../agent-manager'
import { chatWorkspacePath, getDataLocation } from '../data-dir'
import {
  encodeSessionCwdKey,
  IMAGE_EXT_SET,
  isPathInside,
  MAX_IMAGE_BYTES,
  mimeForImageExt
} from '../ipc-guard'
import { getRecentProjects, normalizeCwd } from '../store'
import { isConsentedExportPath } from './exported-paths'

function grokSessionsRoot(): string {
  return path.join(app.getPath('home'), '.grok', 'sessions')
}

function resolveImageCandidates(filePath: string): string[] {
  const trimmed = filePath.trim().replace(/^["'`]+|["'`]+$/g, '')
  if (!trimmed) return []

  const candidates: string[] = []
  const isAbs = path.isAbsolute(trimmed)

  if (isAbs) {
    candidates.push(path.normalize(trimmed))
  } else {
    const rel = trimmed.replace(/^\.[\\/]/, '')
    const cwd = agentManager.getCwd()
    const sessionId = agentManager.getSessionId()

    if (cwd) {
      candidates.push(path.resolve(cwd, rel))
      // Grok Imagine saves under ~/.grok/sessions/<encoded-cwd>/<sessionId>/images/N.jpg
      const enc = encodeSessionCwdKey(normalizeCwd(cwd))
      const sessionBase = path.join(grokSessionsRoot(), enc)
      if (sessionId) {
        candidates.push(path.join(sessionBase, sessionId, rel))
      }
      // Fall back: newest session folder under this cwd that has the file
      try {
        if (fs.existsSync(sessionBase)) {
          const dirs = fs
            .readdirSync(sessionBase, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name)
          for (const d of dirs) {
            candidates.push(path.join(sessionBase, d, rel))
          }
        }
      } catch {
        /* ignore */
      }
    }

    // Also try chat workspace encoding (common when surface is chat).
    // The CLI keys its session folders by cwd, so images generated before a data
    // move still sit under the OLD chat-workspace key. Probing the previous keys
    // too is what keeps a relocation from orphaning a user's existing images.
    try {
      const location = getDataLocation()
      const seenKeys = new Set<string>()
      for (const root of [
        location.chatWorkspacePath,
        ...(location.previousChatWorkspaces || [])
      ]) {
        if (!root) continue
        const encChat = encodeSessionCwdKey(normalizeCwd(root))
        if (seenKeys.has(encChat)) continue
        seenKeys.add(encChat)
        const chatSessions = path.join(grokSessionsRoot(), encChat)
        if (!fs.existsSync(chatSessions)) continue
        for (const d of fs.readdirSync(chatSessions, { withFileTypes: true })) {
          if (d.isDirectory()) candidates.push(path.join(chatSessions, d.name, rel))
        }
      }
    } catch {
      /* ignore */
    }
  }

  return candidates
}

function isAllowedImagePath(resolved: string): boolean {
  // chatWorkspacePath() follows a relocated data dir; userData stays because the
  // pointer file and any pre-move leftovers still live there.
  const roots: string[] = [grokSessionsRoot(), chatWorkspacePath(), app.getPath('userData')]
  const cwd = agentManager.getCwd()
  if (cwd) roots.push(path.resolve(cwd))
  // Recent projects: allow images under any recently opened project cwd
  try {
    for (const p of getRecentProjects()) {
      if (p?.cwd) roots.push(path.resolve(p.cwd))
    }
  } catch {
    /* ignore */
  }

  for (const root of roots) {
    try {
      if (isPathInside(root, resolved)) return true
    } catch {
      /* ignore */
    }
  }
  return false
}

export function readLocalImageSafe(filePath: string): {
  dataUrl?: string
  path?: string
  mimeType?: string
  error?: string
} {
  try {
    const candidates = resolveImageCandidates(filePath)
    let found: string | null = null
    for (const c of candidates) {
      try {
        if (fs.existsSync(c) && fs.statSync(c).isFile()) {
          found = c
          break
        }
      } catch {
        /* try next */
      }
    }
    if (!found) {
      return { error: `Image not found: ${filePath}` }
    }

    // realpath to defeat symlink escapes outside allowed roots
    let real: string
    try {
      real = fs.realpathSync(found)
    } catch {
      real = path.resolve(found)
    }

    const ext = path.extname(real).toLowerCase()
    if (!IMAGE_EXT_SET.has(ext)) {
      return { error: `Not an image file (${ext || 'no extension'})` }
    }
    if (!isAllowedImagePath(real)) {
      return { error: 'Path outside allowed image roots' }
    }

    const stat = fs.statSync(real)
    if (stat.size > MAX_IMAGE_BYTES) {
      return { error: `Image too large (${stat.size} bytes)` }
    }

    const buf = fs.readFileSync(real)
    const mime = mimeForImageExt(ext)
    const dataUrl = `data:${mime};base64,${buf.toString('base64')}`
    return { dataUrl, path: real, mimeType: mime }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

export function revealLocalPathSafe(filePath: string): { ok: boolean; error?: string } {
  try {
    const candidates = resolveImageCandidates(filePath)
    let found: string | null = null
    for (const c of candidates) {
      try {
        if (fs.existsSync(c)) {
          found = c
          break
        }
      } catch {
        /* next */
      }
    }
    if (!found) return { ok: false, error: 'Path not found' }

    let real: string
    try {
      real = fs.realpathSync(found)
    } catch {
      real = path.resolve(found)
    }
    // Two independent grounds to reveal: the path sits under an allowed root, or
    // the user personally chose it in this session's export save dialog. The
    // second is per-path consent, so it does not widen the roots for anything else.
    if (!isAllowedImagePath(real) && !isConsentedExportPath(real)) {
      return { ok: false, error: 'Path outside allowed roots' }
    }
    shell.showItemInFolder(real)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
