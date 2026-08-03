/**
 * Placeholder for the conversation pane while a project/session is hydrating.
 * Keeps layout stable and gives the main process time to boot without looking frozen.
 */
export function ChatSkeleton({ label }: { label?: string }) {
  return (
    <div className="chat-skeleton" aria-busy="true" aria-live="polite">
      <p className="chat-skeleton-label">{label || 'Opening session…'}</p>
      <div className="chat-skeleton-stack">
        <div className="chat-skeleton-row user">
          <div className="chat-skeleton-bubble short" />
        </div>
        <div className="chat-skeleton-row assistant">
          <div className="chat-skeleton-bubble long" />
          <div className="chat-skeleton-bubble med" />
        </div>
        <div className="chat-skeleton-row user">
          <div className="chat-skeleton-bubble med" />
        </div>
        <div className="chat-skeleton-row assistant">
          <div className="chat-skeleton-bubble long" />
          <div className="chat-skeleton-bubble short" />
          <div className="chat-skeleton-tool" />
        </div>
      </div>
    </div>
  )
}
