/**
 * One scratchpad per project folder: what is shown, and what gets saved.
 *
 * The whole decision is a lookup plus a normalize, and both have a wrong answer
 * that is easy to reach. The lookup is by PATH, not by string: the store keys
 * are main-process normalized (`path.resolve` then forward slashes) while the
 * renderer holds whatever `cwd` came back over IPC, so `G:\work\api` and
 * `G:/work/api` are the same project and an exact-match lookup silently shows an
 * empty scratchpad for a project that has one. `pathsEqual` folds case for
 * Windows-looking paths for the same reason `isPathInside` does.
 *
 * The note is the user's own writing, so nothing here rewrites it beyond
 * trimming the ends. Notes are persisted un-redacted, exactly like message text
 * (FIX-R1 in store.ts): redacting somebody's own words corrupts them, and a
 * scratchpad that eats what you typed is worse than no scratchpad.
 *
 * Nothing in this module renders. Notes are shown in a `<textarea>` and never
 * through Markdown, so this text has no path to the markdown pipeline at all.
 */

import { pathsEqual } from '../../shared/path'
import { NOTE_MAX_CHARS, type ProjectNotes } from '../../shared/types'

export { NOTE_MAX_CHARS }
export type { ProjectNotes }

/**
 * The note to show for a project, and `''` for a project with none.
 *
 * `''` for "never seen before", "note was cleared" and "notes have not loaded
 * yet" alike. The textarea renders all three identically and there is nothing a
 * user could do differently about any of them, so they are deliberately not
 * distinguished.
 */
export function noteFor(
  notes: ProjectNotes | null | undefined,
  cwd: string | null | undefined
): string {
  if (!notes || !cwd) return ''
  const direct = notes[cwd]
  if (typeof direct === 'string') return direct
  for (const key of Object.keys(notes)) {
    if (pathsEqual(key, cwd)) return notes[key]
  }
  return ''
}

/**
 * A draft on its way to disk.
 *
 * Ends are trimmed and the middle is untouched: blank lines top and bottom are
 * what a text box accumulates by accident, while blank lines *inside* a note are
 * how someone separates two thoughts. A note that is nothing but whitespace is
 * not a note, and normalizes to `''`, which is how the store is told to forget
 * it.
 */
export function normalizeNote(draft: string): string {
  return draft.trim()
}

/**
 * What to persist for this project, or `null` when there is nothing to do.
 *
 * Opening the tab, clicking into the box and clicking out again must not write
 * to the store: every write re-serializes the whole store file and rolls the
 * backup forward. So a draft that normalizes to what is already stored is not a
 * save. Clearing a note IS a save, and reaches the store as `''`.
 */
export function pendingNoteSave(
  notes: ProjectNotes | null | undefined,
  cwd: string | null | undefined,
  draft: string
): string | null {
  if (!cwd) return null
  const next = normalizeNote(draft)
  return next === noteFor(notes, cwd) ? null : next
}

/**
 * Words in a note, for the tray tab, so the rail says whether a project has
 * anything written down without putting the note itself on screen.
 *
 * A count rather than a preview on purpose: the rail sits above the composer for
 * the whole session and lands in every screenshot taken of it, and a scratchpad
 * is exactly where somebody pastes the thing they did not want on screen.
 */
export function noteWordCount(note: string): number {
  const trimmed = note.trim()
  return trimmed ? trimmed.split(/\s+/).length : 0
}
