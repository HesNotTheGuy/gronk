import type { ActivityCalendarState } from '../hooks/useActivityCalendar'
import { ActivityCalendar } from './ActivityCalendar'

interface Props {
  authenticated: boolean
  authLabel?: string
  grokFound: boolean
  model?: string
  /** Parent-owned calendar so Home unmount does not drop the grid. */
  activityCalendar: ActivityCalendarState
  /** Local day currently filtering the sidebar, if any. */
  selectedActivityDay?: string | null
  onSelectActivityDay?: (dayKey: string) => void
  onOpenChat: () => void
  onOpenProjects: () => void
  onSignIn: () => void
  onSettings: () => void
}

/**
 * Landing pad. Chat and Build are the two surfaces; this screen does not
 * also list folders or sessions. Those catalogs live on Chat and Build.
 */
export function HomeView({
  authenticated,
  authLabel,
  grokFound,
  model,
  activityCalendar,
  selectedActivityDay = null,
  onSelectActivityDay,
  onOpenChat,
  onOpenProjects,
  onSignIn,
  onSettings
}: Props) {
  return (
    <div className="home-view browse-home">
      <div className="browse-hero">
        <p className="home-kicker">Home</p>
        <h1>
          Grok on your <span>desktop</span>
        </h1>
        <p className="home-copy">
          <strong>Chat</strong> is a conversation. It has no project folder, so it never reads or
          edits your files. <strong>Build</strong> points Grok at a folder on your computer, where
          it can read, edit and run what is inside. Your folders and sessions live there.
        </p>

        <div className="home-actions">
          <button type="button" className="btn btn-primary" onClick={onOpenChat}>
            Chat
          </button>
          <button type="button" className="btn btn-secondary" onClick={onOpenProjects}>
            Build
          </button>
          {!authenticated ? (
            <button type="button" className="btn btn-ghost" onClick={onSignIn}>
              Sign in
            </button>
          ) : null}
          {!grokFound ? (
            <button type="button" className="btn btn-ghost" onClick={onSettings}>
              Set up CLI
            </button>
          ) : null}
        </div>

        <div className="home-meta">
          <span>
            Account <strong>{authenticated ? authLabel || 'Signed in' : 'Not signed in'}</strong>
          </span>
          <span>
            CLI <strong>{grokFound ? 'Ready' : 'Missing'}</strong>
          </span>
          <span>
            Model <strong>{model || 'default'}</strong>
          </span>
        </div>
      </div>

      <section className="home-feed">
        <div className="home-feed-block">
          <ActivityCalendar
            state={activityCalendar}
            selectedDay={selectedActivityDay}
            onSelectDay={onSelectActivityDay}
          />
        </div>
      </section>
    </div>
  )
}
