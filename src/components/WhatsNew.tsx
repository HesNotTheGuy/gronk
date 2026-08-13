import { fixedLines } from '../lib/whats-new'
import type { ReleaseNote } from '../../shared/release-notes'

interface Props {
  notes: ReleaseNote[]
  onDismiss: () => void
}

/**
 * What changed since the version you were last running.
 *
 * Shown once per version and never again — dismissing records the version, and that record
 * survives an update, because a panel that comes back on every release reads as broken
 * rather than merely redundant.
 *
 * It says nothing about how any of it works. The audience is somebody who used the app
 * yesterday and wants to know what moved, not somebody reading a changelog.
 */
export function WhatsNew({ notes, onDismiss }: Props) {
  if (notes.length === 0) return null

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="What's new">
      <div className="modal whats-new">
        <div className="whats-new-head">
          <h2>What&apos;s new</h2>
          <span className="whats-new-version">
            {notes.length === 1 ? notes[0].version : `${notes[notes.length - 1].version}–${notes[0].version}`}
          </span>
        </div>

        <div className="whats-new-body">
          {notes.map((note) => (
            <section key={note.version} className="whats-new-release">
              {notes.length > 1 ? (
                <div className="whats-new-release-version">{note.version}</div>
              ) : null}

              {note.changed.length > 0 ? (
                <>
                  <h3>Changed</h3>
                  <ul>
                    {note.changed.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </>
              ) : null}

              {fixedLines(note).length > 0 ? (
                <>
                  <h3>Fixed</h3>
                  <ul>
                    {fixedLines(note).map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </>
              ) : null}
            </section>
          ))}
        </div>

        <div className="whats-new-actions">
          <button type="button" className="btn btn-primary" onClick={onDismiss}>
            Got it
          </button>
        </div>
      </div>
    </div>
  )
}
