/**
 * Security primitives for the main process: which senders may call IPC, which
 * URLs may be opened or navigated to, and whether a resolved path stays inside
 * an allowed root.
 *
 * Pure by design — no Electron or app-lifecycle imports — so every rule here is
 * covered by `npm test`. `index.ts` wires them to the real handlers.
 * These are the boundary between the renderer and the OS: do not relax a check
 * here without a test that proves the hole stays closed.
 */

import path from 'node:path'
import { normalizePath } from '../../shared/path'

export const ALLOWED_EXTERNAL_SCHEMES = new Set(['https:', 'http:', 'mailto:'])

/** Only these may be handed to shell.openExternal. Anything else is dropped. */
export function isAllowedExternalUrl(target: string): boolean {
  try {
    return ALLOWED_EXTERNAL_SCHEMES.has(new URL(target).protocol)
  } catch {
    return false
  }
}

export function isLocalDevHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1'
  )
}

/**
 * True when `target` is Gronk's own renderer.
 * Dev serves it over http from the Vite server; packaged builds load file://.
 * `devRendererUrl` is `process.env.ELECTRON_RENDERER_URL` — passed in rather
 * than read here so tests can exercise both modes.
 */
export function isAppUrl(target: string, devRendererUrl?: string): boolean {
  try {
    const u = new URL(target)
    if (devRendererUrl) {
      return (u.protocol === 'http:' || u.protocol === 'https:') && isLocalDevHost(u.hostname)
    }
    return u.protocol === 'file:'
  } catch {
    return false
  }
}

/** Structural stand-in for Electron.IpcMainInvokeEvent — keeps this module Electron-free. */
export interface IpcSenderLike {
  senderFrame?: { url?: string } | null
}

/**
 * Reject IPC that did not come from Gronk's own renderer frame. Without this a
 * compromised or injected frame could call every privileged handler.
 * Must stay on EVERY ipcMain handler.
 */
export function assertTrustedSender(
  e: IpcSenderLike,
  devRendererUrl = process.env.ELECTRON_RENDERER_URL
): void {
  const url = e?.senderFrame?.url ?? ''
  let ok = false
  try {
    if (devRendererUrl) {
      const u = new URL(url)
      ok = (u.protocol === 'http:' || u.protocol === 'https:') && isLocalDevHost(u.hostname)
    } else {
      ok = url.startsWith('file://')
    }
  } catch {
    ok = false
  }
  if (!ok) throw new Error(`Rejected IPC from untrusted sender: ${url || '(empty)'}`)
}

/**
 * Containment check for the fs jail. Callers must pass REALPATHS — this is a
 * lexical test and cannot see through a symlink on its own.
 * The trailing separator matters: without it `/data/private` would count as
 * inside `/data/priv`.
 */
export function isPathInside(root: string, target: string): boolean {
  const nRoot = path.resolve(root)
  const nTarget = path.resolve(target)
  if (process.platform === 'win32') {
    const r = nRoot.toLowerCase()
    const t = nTarget.toLowerCase()
    return t === r || t.startsWith(r + '\\')
  }
  return nTarget === nRoot || nTarget.startsWith(nRoot + path.sep)
}

export const IMAGE_EXT_SET = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'])

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024 // 20 MB

export function mimeForImageExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.png':
      return 'image/png'
    case '.gif':
      return 'image/gif'
    case '.webp':
      return 'image/webp'
    case '.bmp':
      return 'image/bmp'
    case '.svg':
      return 'image/svg+xml'
    default:
      return 'application/octet-stream'
  }
}

/** Encode a cwd the same way the Grok CLI does for its session storage folders. */
export function encodeSessionCwdKey(cwd: string): string {
  return encodeURIComponent(normalizePath(cwd))
}
