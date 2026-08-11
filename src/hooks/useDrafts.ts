import { useCallback, useEffect, useState } from 'react'
import type { PromptAttachment } from '../../shared/types'

/**
 * What is typed but not sent, kept per conversation.
 *
 * The composer used to own its own text, which belongs to the component rather
 * than to a session, and that failed in both directions. Leaving the conversation
 * view unmounts the composer, so going Home threw a written message away with no
 * warning. A session switch does NOT unmount it, so the same message was still in
 * the box when another conversation opened, one Enter away from the wrong agent.
 *
 * Held in memory only. A draft does not survive quitting the app, and saying so is
 * better than half-persisting it: putting user text in the store brings the
 * transcript's own rules with it (never redacted, never truncated) and attachments
 * bring the collector's, so that is its own change rather than a detail of this one.
 */

export interface Draft {
  text: string
  attachments: PromptAttachment[]
}

export const EMPTY_DRAFT: Draft = { text: '', attachments: [] }

const isEmpty = (draft: Draft): boolean => !draft.text && draft.attachments.length === 0

export function useDrafts(sessionId: string | null) {
  const [saved, setSaved] = useState<Record<string, Draft>>({})
  /**
   * The draft with no session to file it under.
   *
   * Typing is allowed while a project or chat is still booting, and the id only
   * exists once the agent answers. Its own state rather than a reserved key in
   * `saved`, because every reserved key is a string a session id could one day be.
   */
  const [unnamed, setUnnamed] = useState<Draft | null>(null)

  // Falls back to the unnamed draft for the render between the id arriving and the
  // effect below filing it. Without that one render the composer would swap its box
  // over to an empty draft and never look again — the message gone at the exact
  // moment the session became real.
  const draft = (sessionId ? saved[sessionId] ?? unnamed : unnamed) ?? EMPTY_DRAFT

  useEffect(() => {
    if (!sessionId || !unnamed) return
    // Filed under the session that turned up, and only if that session has nothing
    // already — an unnamed draft belongs to one conversation, not to every new one.
    setSaved((prev) => (prev[sessionId] ? prev : { ...prev, [sessionId]: unnamed }))
    setUnnamed(null)
  }, [sessionId, unnamed])

  /**
   * `forSession` files the draft under a conversation other than the current one.
   *
   * The composer hands back what it holds a beat after typing stops, and a switch can
   * happen inside that beat — so the text arriving may belong to the conversation just
   * left, not the one now on screen. Without saying which, switching within a moment of
   * typing threw the text away, which is the bug this hook exists to fix arriving in a
   * narrower window.
   */
  const setDraft = useCallback(
    (next: Draft, forSession?: string | null) => {
      const target = forSession === undefined ? sessionId : forSession
      if (!target) {
        setUnnamed(isEmpty(next) ? null : next)
        return
      }
      setSaved((prev) => {
        if (isEmpty(next)) {
          if (!(target in prev)) return prev
          const { [target]: _empty, ...rest } = prev
          return rest
        }
        const held = prev[target]
        if (held && held.text === next.text && held.attachments === next.attachments) return prev
        return { ...prev, [target]: next }
      })
    },
    [sessionId]
  )

  /** The message went. Nothing is left to restore, under either name. */
  const clearDraft = useCallback(() => {
    setUnnamed(null)
    if (!sessionId) return
    setSaved((prev) => {
      if (!(sessionId in prev)) return prev
      const { [sessionId]: _sent, ...rest } = prev
      return rest
    })
  }, [sessionId])

  /** A conversation nobody can open again has nothing to restore into. */
  const forgetDraft = useCallback((id: string) => {
    setSaved((prev) => {
      if (!(id in prev)) return prev
      const { [id]: _gone, ...rest } = prev
      return rest
    })
  }, [])

  return { draft, draftKey: sessionId ?? '', setDraft, clearDraft, forgetDraft }
}
