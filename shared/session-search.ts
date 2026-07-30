/**
 * Finding a conversation again.
 *
 * Session titles are generated from the first prompt, so title-only matching is
 * really "search the opening message" — which is exactly the case where you
 * already remember enough to scroll. The thing worth finding is a detail buried
 * mid-conversation, so this searches message text too and reports WHERE it hit.
 *
 * Pure and Electron-free: the main process reads the store and hands the text in.
 */

import type { ChatMessage, SessionInfo, SessionSearchHit } from './types'

const SNIPPET_RADIUS = 48
const MAX_SNIPPET = 140

/**
 * Split on whitespace and require EVERY term, so a second word narrows rather
 * than widens. Quoted phrases are not supported: two words that must both
 * appear covers the realistic case, and a half-working quote syntax is worse
 * than none.
 */
export function parseQuery(raw: string): string[] {
  return raw
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

function containsAll(haystack: string, terms: string[]): boolean {
  const lower = haystack.toLowerCase()
  return terms.every((t) => lower.includes(t))
}

/**
 * A window of text around the first term, with the boundaries nudged to spaces
 * so a snippet does not start or end mid-word.
 */
export function buildSnippet(text: string, terms: string[]): string | null {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) return null

  const lower = flat.toLowerCase()
  let at = -1
  for (const term of terms) {
    const i = lower.indexOf(term)
    if (i >= 0 && (at < 0 || i < at)) at = i
  }
  if (at < 0) return null

  let start = Math.max(0, at - SNIPPET_RADIUS)
  let end = Math.min(flat.length, at + MAX_SNIPPET - SNIPPET_RADIUS)
  if (start > 0) {
    const space = flat.indexOf(' ', start)
    if (space >= 0 && space < at) start = space + 1
  }
  if (end < flat.length) {
    const space = flat.lastIndexOf(' ', end)
    if (space > at) end = space
  }

  const body = flat.slice(start, end).trim()
  return `${start > 0 ? '…' : ''}${body}${end < flat.length ? '…' : ''}`
}

/**
 * Score one session against a query, or null when it does not match.
 *
 * A title hit outranks any number of body hits: the title is what the user named
 * the thing, or what they opened it with, so it is the stronger signal of "this
 * is the one I meant". Body hits then rank by how often the terms appear, and
 * `updatedAt` breaks ties in the caller so recent work surfaces first.
 */
export function scoreSession(
  session: SessionInfo,
  messages: readonly ChatMessage[],
  terms: string[]
): SessionSearchHit | null {
  if (terms.length === 0) return null

  const inTitle = containsAll(session.title || '', terms)

  let messageMatches = 0
  let snippet: string | null = null
  for (const message of messages) {
    // Thoughts are searched too: reasoning often names the file or symbol that
    // the visible answer only alludes to.
    const body = `${message.text || ''}\n${message.thought || ''}`
    if (!containsAll(body, terms)) continue
    messageMatches++
    if (!snippet) snippet = buildSnippet(body, terms)
  }

  if (!inTitle && messageMatches === 0) return null

  return {
    sessionId: session.id,
    inTitle,
    messageMatches,
    snippet,
    score: (inTitle ? 1000 : 0) + Math.min(messageMatches, 50)
  }
}

/** Newest first within equal scores, so ranking never looks arbitrary. */
export function rankHits(
  hits: readonly SessionSearchHit[],
  sessions: readonly SessionInfo[]
): SessionSearchHit[] {
  const updatedAt = new Map(sessions.map((s) => [s.id, s.updatedAt]))
  return [...hits].sort(
    (a, b) => b.score - a.score || (updatedAt.get(b.sessionId) ?? 0) - (updatedAt.get(a.sessionId) ?? 0)
  )
}
