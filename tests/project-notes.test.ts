import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NOTE_MAX_CHARS,
  noteFor,
  noteWordCount,
  normalizeNote,
  pendingNoteSave,
  type ProjectNotes
} from '../src/lib/project-notes'

/**
 * One scratchpad per project folder: what is shown, and what gets written.
 *
 * The two things worth pinning are that the lookup is by path rather than by
 * string, and that "nothing to save" is a real answer. Both are the kind of
 * detail a later simplification removes without noticing: `notes[cwd]` looks
 * complete, and saving unconditionally looks harmless.
 */

const NOTES: ProjectNotes = {
  'G:/work/orbital-api': 'ratelimit lives in gateway/limits.ts\ncheck the 429 retry before shipping',
  '/home/dev/flux': 'flux notes'
}

test('a project with a note shows it', () => {
  assert.equal(noteFor(NOTES, '/home/dev/flux'), 'flux notes')
})

test('a project never seen before shows an empty note, not undefined', () => {
  // The textarea takes this value directly. `undefined` would flip it from a
  // controlled component to an uncontrolled one, which React warns about and
  // which loses the note the moment anything else re-renders.
  assert.equal(noteFor(NOTES, '/home/dev/never-opened'), '')
  assert.equal(noteFor({}, '/home/dev/flux'), '')
})

test('notes that have not loaded yet, and no project at all, read as empty', () => {
  assert.equal(noteFor(null, '/home/dev/flux'), '')
  assert.equal(noteFor(undefined, '/home/dev/flux'), '')
  assert.equal(noteFor(NOTES, null), '')
  assert.equal(noteFor(NOTES, undefined), '')
})

test('THE LOOKUP IS BY PATH: separators and case do not hide a note', () => {
  // The store keys are normalized in the main process (path.resolve, forward
  // slashes) while the renderer holds whatever cwd came back over IPC. An exact
  // string match shows an empty scratchpad for a project that has one, and the
  // user then types into it and overwrites what was there.
  assert.equal(noteFor(NOTES, 'G:\\work\\orbital-api'), NOTES['G:/work/orbital-api'])
  assert.equal(noteFor(NOTES, 'g:/WORK/Orbital-API'), NOTES['G:/work/orbital-api'])
  assert.equal(noteFor(NOTES, 'G:/work/orbital-api/'), NOTES['G:/work/orbital-api'])
})

test('a sibling folder sharing a name prefix is a different project', () => {
  assert.equal(noteFor(NOTES, '/home/dev/flux-staging'), '')
})

test('case is NOT folded for a posix path', () => {
  // Same rule as the containment check: two files on Linux really can differ
  // only by case, so folding there would show one project another one's notes.
  assert.equal(noteFor(NOTES, '/home/dev/FLUX'), '')
})

test('saving trims the ends and leaves the middle alone', () => {
  // Blank lines top and bottom are what a text box accumulates by accident.
  // Blank lines inside are how somebody separates two thoughts, and rewriting
  // those is the same corruption FIX-R1 keeps out of message text.
  assert.equal(normalizeNote('  \n\nkeep this\n\nand this\n\n  '), 'keep this\n\nand this')
  assert.equal(normalizeNote('   indented\n    more   '), 'indented\n    more')
})

test('a note that is only whitespace is not a note', () => {
  assert.equal(normalizeNote('   \n\t\n  '), '')
  assert.equal(normalizeNote(''), '')
})

test('typing only whitespace into an empty note saves nothing at all', () => {
  // Opening the tab, tapping space and clicking away must not write. Every
  // write re-serializes the whole store file and rolls the backup forward.
  assert.equal(pendingNoteSave(NOTES, '/home/dev/never-opened', '   \n '), null)
})

test('re-saving what is already stored is not a save', () => {
  assert.equal(pendingNoteSave(NOTES, '/home/dev/flux', 'flux notes'), null)
  // ...including when only the accidental whitespace differs.
  assert.equal(pendingNoteSave(NOTES, '/home/dev/flux', '\n flux notes \n'), null)
})

test('clearing a note IS a save, and reaches the store as an empty string', () => {
  // The difference between "nothing to do" and "forget this" is the whole point
  // of the null: both look like an empty box on screen.
  assert.equal(pendingNoteSave(NOTES, '/home/dev/flux', ''), '')
  assert.equal(pendingNoteSave(NOTES, '/home/dev/flux', '   '), '')
})

test('a first note on an unseen project saves', () => {
  assert.equal(pendingNoteSave(NOTES, '/home/dev/new', ' first ' ), 'first')
  assert.equal(pendingNoteSave({}, '/home/dev/new', 'first'), 'first')
  assert.equal(pendingNoteSave(null, '/home/dev/new', 'first'), 'first')
})

test('an edit saves the normalized text, not the raw draft', () => {
  assert.equal(pendingNoteSave(NOTES, '/home/dev/flux', 'flux notes\nplus one more\n'), 'flux notes\nplus one more')
})

test('with no project open there is nothing to save', () => {
  assert.equal(pendingNoteSave(NOTES, null, 'orphan text'), null)
})

test('the save path matches the lookup path, so an edit lands on the right project', () => {
  // If these two disagreed, a Windows cwd would read one key and write another,
  // and the note would appear to revert on the next load.
  assert.equal(pendingNoteSave(NOTES, 'G:\\work\\orbital-api', NOTES['G:/work/orbital-api']), null)
})

test('the word count is what the rail shows, and whitespace is not a word', () => {
  assert.equal(noteWordCount(''), 0)
  assert.equal(noteWordCount('   \n\t '), 0)
  assert.equal(noteWordCount('one'), 1)
  assert.equal(noteWordCount('  spaced   out \n across lines '), 4)
})

test('the length cap is a number the textarea and the IPC boundary can both use', () => {
  assert.equal(typeof NOTE_MAX_CHARS, 'number')
  assert.ok(NOTE_MAX_CHARS >= 10_000, 'a scratchpad smaller than this is not one')
})
