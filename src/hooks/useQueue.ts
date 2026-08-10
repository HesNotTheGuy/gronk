import { useCallback, useRef, useState } from 'react'
import type { PromptAttachment } from '../../shared/types'

/**
 * Messages written while a turn was running, waiting for it to finish.
 *
 * Send was simply disabled for the whole time the agent worked, so a finished
 * message sat in the box against a turn whose end you cannot see coming. Queueing
 * is the same message, held instead of refused.
 *
 * Per conversation, in memory, and it never fires on its own after a restart — a
 * queue that sent prompts the next time the app opened would be alarming. Draining
 * is deliberately the caller's decision rather than this hook's: a turn that was
 * cancelled or that failed must NOT release the next message, because stopping a
 * turn usually means the user wants to say something different.
 */

export interface QueuedMessage {
  id: string
  text: string
  attachments: PromptAttachment[]
}

/**
 * How many one conversation may hold.
 *
 * One pending message is most of the value. A long queue invites lining up eight
 * prompts against a plan that changes after the second, and the person who typed
 * them is not watching by then. The cap is small on purpose, and being refused at
 * the cap is visible rather than silent.
 */
export const QUEUE_LIMIT = 5

export function useQueue(sessionId: string | null) {
  const [queues, setQueues] = useState<Record<string, QueuedMessage[]>>({})
  /**
   * Conversations whose queue must not drain by itself.
   *
   * Stopping a turn, or a turn failing, usually means the user wants to say
   * something different — releasing the next queued message into that is the
   * opposite of what was wanted. The messages stay; they wait for a person.
   */
  const [heldFor, setHeldFor] = useState<Record<string, true>>({})
  const nextId = useRef(0)
  const queued = (sessionId && queues[sessionId]) || []
  const held = !!(sessionId && heldFor[sessionId])

  /** True when the message was taken. False means the cap refused it. */
  const enqueue = useCallback(
    (text: string, attachments: PromptAttachment[]): boolean => {
      if (!sessionId) return false
      if (!text.trim() && attachments.length === 0) return false
      if ((queues[sessionId] ?? []).length >= QUEUE_LIMIT) return false

      const id = `q${(nextId.current += 1)}`
      setQueues((prev) => {
        const held = prev[sessionId] ?? []
        // Checked again inside the updater: React may call it more than once for a
        // single dispatch, and appending twice would send the message twice.
        if (held.length >= QUEUE_LIMIT || held.some((m) => m.id === id)) return prev
        return { ...prev, [sessionId]: [...held, { id, text, attachments }] }
      })
      return true
    },
    [sessionId, queues]
  )

  /** The next message to send, removed as it is handed over. */
  const takeNext = useCallback((): QueuedMessage | null => {
    if (!sessionId) return null
    const next = (queues[sessionId] ?? [])[0]
    if (!next) return null
    setQueues((prev) => {
      const held = prev[sessionId] ?? []
      // Only if it is still the front. Two drains racing must not take two.
      if (held[0]?.id !== next.id) return prev
      const rest = held.slice(1)
      if (rest.length === 0) {
        const { [sessionId]: _drained, ...others } = prev
        return others
      }
      return { ...prev, [sessionId]: rest }
    })
    return next
  }, [sessionId, queues])

  const removeQueued = useCallback(
    (id: string) => {
      if (!sessionId) return
      setQueues((prev) => {
        const held = prev[sessionId] ?? []
        const rest = held.filter((m) => m.id !== id)
        if (rest.length === held.length) return prev
        if (rest.length === 0) {
          const { [sessionId]: _empty, ...others } = prev
          return others
        }
        return { ...prev, [sessionId]: rest }
      })
    },
    [sessionId]
  )

  /**
   * Both take the conversation by name rather than reading the focused one.
   *
   * A turn ends for a session, not for whichever session happens to be on screen,
   * and the event handler that hears about it is registered once — closing over the
   * focused id would hold whatever it was at the time, which is how a stopped turn
   * came to hold nothing at all.
   */
  const holdQueue = useCallback((id: string) => {
    setHeldFor((prev) => (prev[id] ? prev : { ...prev, [id]: true }))
  }, [])

  const releaseQueue = useCallback((id: string) => {
    setHeldFor((prev) => {
      if (!prev[id]) return prev
      const { [id]: _released, ...rest } = prev
      return rest
    })
  }, [])

  /** A conversation nobody can open again has nothing to send into. */
  const forgetQueue = useCallback((id: string) => {
    setQueues((prev) => {
      if (!(id in prev)) return prev
      const { [id]: _gone, ...rest } = prev
      return rest
    })
  }, [])

  return {
    queued,
    queueHeld: held,
    queueFull: queued.length >= QUEUE_LIMIT,
    enqueue,
    takeNext,
    removeQueued,
    holdQueue,
    releaseQueue,
    forgetQueue
  }
}
