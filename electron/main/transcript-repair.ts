/**
 * Making a transcript small enough to read back, without losing anything.
 *
 * Two independent things grew without bound in `gronk-store.json`, and the file
 * is read and `JSON.parse`d synchronously on the main process by every store
 * operation, so its size is felt as the whole window freezing.
 *
 * 1. Replayed tool calls were appended rather than dropped, so every reopen of a
 *    session copied its entire tool-call history onto a fresh message. The
 *    duplicates are byte-identical and share a `toolCallId`.
 * 2. Every image attachment was persisted twice in full base64: once as `data`
 *    and again as `previewUrl`, which is a `data:` URL of the same bytes.
 *
 * The routing bug is fixed at its source in `agent/session-update.ts`. What is
 * here is the other half: keeping new writes small, and repairing what the old
 * behaviour already wrote.
 *
 * Nothing here touches `text`, `thought` or `parts`. Those are the user's own
 * conversation, they are a small fraction of the file, and rewriting them has
 * corrupted transcripts on reload before (FIX-R1 in store.ts).
 *
 * The pure decisions take an injected writer so the whole repair can be tested
 * without a disk.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { ChatMessage, PromptAttachment, ToolCallInfo } from '../../shared/types'
import { IMAGE_EXT_SET } from './ipc-guard'
import { ATTACHMENT_DIR, dataDir } from './data-dir'

/**
 * Where parked attachment bytes live, under the data directory.
 *
 * Defined in `data-dir` with the rest of the directory's layout, because moving
 * the data folder has to carry this and that module cannot import this one.
 * Re-exported so callers can keep taking it from the module that writes it.
 */
export { ATTACHMENT_DIR }

/**
 * Written beside the parked bytes to say this folder is one this app made.
 *
 * The data directory can be pointed anywhere, so the folder's name is not
 * evidence of anything on its own. Anything that deletes from it needs to know
 * the difference between this app's folder and a stranger's that happens to be
 * called the same thing, and the moment the folder is created is the only one
 * where that is known for certain.
 */
export const OWNERSHIP_MARKER = '.gronk-attachments'

/**
 * Drop repeated tool calls, keeping the FIRST message each one appeared in.
 *
 * Collapsing by `toolCallId` across the whole transcript rather than within a
 * message, because that is the shape the leak has: a reopen copies a whole
 * history onto one new message, so the duplicates are spread across messages and
 * a per-message pass sees nothing wrong.
 *
 * Earliest wins so a call stays attached to the turn that actually made it. A
 * later copy is the echo, and the echo is what should go.
 *
 * This is a de-duplication and never a truncation. Every distinct `toolCallId`
 * survives; a transcript with a thousand real calls keeps a thousand. A call
 * with no usable id is kept exactly where it is, because two of those cannot be
 * proven to be the same call.
 */
export function dedupeToolCalls(messages: ChatMessage[]): ChatMessage[] {
  const seen = new Set<string>()
  return messages.map((message) => {
    if (!message.toolCalls?.length) return message
    const kept: ToolCallInfo[] = []
    for (const call of message.toolCalls) {
      const id = typeof call?.toolCallId === 'string' ? call.toolCallId : ''
      if (!id) {
        kept.push(call)
        continue
      }
      if (seen.has(id)) continue
      seen.add(id)
      kept.push(call)
    }
    if (kept.length === message.toolCalls.length) return message
    return { ...message, toolCalls: kept }
  })
}

/** File extension for a parked image, or null when the type is not one we serve. */
export function imageExtension(mimeType: string | undefined, name: string | undefined): string | null {
  const fromName = name ? path.extname(name).toLowerCase() : ''
  if (IMAGE_EXT_SET.has(fromName)) return fromName
  switch ((mimeType || '').toLowerCase()) {
    case 'image/jpeg':
    case 'image/jpg':
      return '.jpg'
    case 'image/png':
      return '.png'
    case 'image/gif':
      return '.gif'
    case 'image/webp':
      return '.webp'
    case 'image/bmp':
      return '.bmp'
    case 'image/svg+xml':
      return '.svg'
    default:
      return null
  }
}

/**
 * The base64 payload of an attachment, from either field.
 *
 * `data` is the raw payload and `previewUrl` is a `data:` URL of the same bytes.
 * Both are read because a transcript on disk may carry either or both, and the
 * point is to end up with neither.
 */
export function attachmentBase64(attachment: PromptAttachment): string {
  if (typeof attachment.data === 'string' && attachment.data) return attachment.data
  const url = attachment.previewUrl
  if (typeof url === 'string') {
    const match = /^data:[^;]*;base64,(.+)$/.exec(url)
    if (match) return match[1]
  }
  return ''
}

/** Content-addressed name, so the same image pasted twice is stored once. */
export function attachmentFileName(base64: string, ext: string): string {
  const digest = crypto.createHash('sha256').update(base64).digest('hex').slice(0, 32)
  return `${digest}${ext}`
}

/** Exactly what `attachmentFileName` produces: 32 hex characters and an image extension. */
const PARKED_NAME = /^[0-9a-f]{32}(\.[a-z0-9+]+)$/

/**
 * Could this app have written a file of this name?
 *
 * The attachments folder sits under a data directory the user can point
 * anywhere, so the folder existing says nothing about who filled it. Anything
 * that reads out of it, or deletes from it, needs a fact about the file rather
 * than about the folder, and the name is the only one available: this is the
 * shape `attachmentFileName` produces and a hash nobody types by hand.
 *
 * Resemblance rather than proof, and used only to NARROW. It is never grounds
 * for reaching outside a directory that is already allowed.
 */
export function isParkedAttachmentName(name: string): boolean {
  const match = PARKED_NAME.exec(name)
  return match !== null && IMAGE_EXT_SET.has(match[1])
}

/** Writes the bytes somewhere durable and returns the path, or null on failure. */
export type AttachmentParker = (attachment: PromptAttachment) => string | null

/**
 * An attachment as it should sit on disk: metadata only.
 *
 * The bytes are removed ONLY once they are somewhere else. An image attachment
 * never carries a `path` when it is created (see `fileToAttachment` in the
 * composer: dropped, pasted and picked images are all base64 with no path), so
 * "strip whatever already has a path" would strip nothing at all and fix
 * nothing. The bytes are parked first, and if parking fails the attachment is
 * returned untouched. A heavy transcript is a much smaller problem than an
 * image that no longer exists anywhere.
 */
export function slimAttachment(
  attachment: PromptAttachment,
  park: AttachmentParker
): PromptAttachment {
  if (!attachment || attachment.kind !== 'image') return attachment
  if (!attachment.data && !attachment.previewUrl) return attachment

  const existing = typeof attachment.path === 'string' && attachment.path ? attachment.path : null
  const parked = existing ?? park(attachment)
  if (!parked) return attachment

  return {
    id: attachment.id,
    kind: attachment.kind,
    name: attachment.name,
    path: parked,
    ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {})
  }
}

/** Same, for every attachment on every message. Messages without any are untouched. */
export function slimAttachments(messages: ChatMessage[], park: AttachmentParker): ChatMessage[] {
  return messages.map((message) => {
    if (!message.attachments?.length) return message
    const next = message.attachments.map((a) => slimAttachment(a, park))
    const changed = next.some((a, i) => a !== message.attachments![i])
    return changed ? { ...message, attachments: next } : message
  })
}

/**
 * Both repairs, in the order that matters: de-duplicate first so parking never
 * runs twice for the same bytes.
 *
 * Idempotent by construction. A second pass finds no repeated ids and no
 * attachment still carrying bytes, so it returns the same messages and the
 * message count cannot change: both halves are `map`, never `filter`.
 */
export function repairTranscript(messages: ChatMessage[], park: AttachmentParker): ChatMessage[] {
  return slimAttachments(dedupeToolCalls(messages), park)
}

/**
 * Park image bytes under the data directory and hand back the path.
 *
 * `userData` is already one of the roots `isAllowedImagePath` accepts, so a file
 * written here is readable by the existing local-image IPC and no jail is
 * widened to make attachments render. The name is the content hash, so writing
 * the same image twice is one file and re-running the repair rewrites nothing.
 *
 * Returns null rather than throwing: every caller treats that as "keep the bytes
 * where they are".
 */
export function parkAttachmentBytes(attachment: PromptAttachment): string | null {
  const base64 = attachmentBase64(attachment)
  if (!base64) return null
  const ext = imageExtension(attachment.mimeType, attachment.name)
  if (!ext) return null

  try {
    const dir = path.join(dataDir(), ATTACHMENT_DIR)
    const file = path.join(dir, attachmentFileName(base64, ext))
    if (fs.existsSync(file)) {
      // Same bytes, so there is nothing to write. The timestamp is still moved
      // forward, because it is what the collector reads to decide a file is old
      // enough that no save can be about to reference it. Attaching an image
      // somebody else already attached is a new reference to an old file, and
      // leaving the original time on it makes the newest reference look like
      // the oldest. Best effort: a clock that cannot be set is a file the
      // collector may take, and it will be re-parked from bytes still in the
      // message rather than lost.
      try {
        const now = new Date()
        fs.utimesSync(file, now, now)
      } catch {
        /* the reference stands whether or not the time could be refreshed */
      }
      return file
    }
    fs.mkdirSync(dir, { recursive: true })
    // Claim the folder before putting anything in it. Best effort: failing to
    // write a marker must never cost the user an image, and a folder without one
    // is simply never collected from.
    try {
      const marker = path.join(dir, OWNERSHIP_MARKER)
      if (!fs.existsSync(marker)) fs.writeFileSync(marker, '')
    } catch {
      /* the bytes matter, the marker does not */
    }
    fs.writeFileSync(file, Buffer.from(base64, 'base64'))
    return file
  } catch {
    return null
  }
}
