import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The open session highlights in the sidebar.
 *
 * Reported as two symptoms with one felt cause, "the sidebar does not know which
 * session I am in": a new session was slow to appear, and the session that was
 * open did not render as selected while the project row above it did.
 *
 * The second one was not an identity bug. `s.id === activeSessionId` was correct
 * the whole time and the ids matched. `SessionRow` renders
 * `session-item-row active`, the row was renamed from `session-row` in 0392e8e,
 * and the rename left the old block behind: the only `.active` background in the
 * stylesheet was `.session-row.active`, on a class no component had emitted
 * since. The class was applied to an element with no rule to match it.
 *
 * `tests/css-coverage.test.ts` could not see this, twice over. It skips any
 * className containing `${`, which is every state modifier in the app. And even
 * read, `active` as a bare token would have been satisfied by `.session-row
 * .active` elsewhere in the file: a modifier is only real when it is compounded
 * with a class the same element actually carries.
 *
 * This is deliberately narrow. The same scan over every component finds eleven
 * more state modifiers with no rule by any route, which is a real finding and
 * its own piece of work; adjudicating them here would mean either fixing eleven
 * unrelated things or allowlisting eleven unverified ones.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROW = fs.readFileSync(path.join(ROOT, 'src/components/SessionRow.tsx'), 'utf8')

/**
 * Comments stripped first, the same way tests/setup-shell.test.ts does it, so
 * prose explaining why a selector was removed is never mistaken for the selector
 * still being there. Written before the removal test existed, and immediately
 * needed by it: the note left in place of the deleted block names the class.
 */
const CSS = fs
  .readFileSync(path.join(ROOT, 'src/styles.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')

/** The base class and the state modifier SessionRow actually emits together. */
function activeRowClasses(): { base: string; modifier: string } {
  const m = ROW.match(/className=\{`([\w-]+) \$\{\s*active \? '([\w-]+)' : ''\s*\}`\}/)
  assert.ok(
    m,
    'SessionRow no longer renders `<base> ${active ? <modifier> : ""}`. If the shape ' +
      'changed, update this test rather than deleting it: the bug it pins is a class ' +
      'applied with no rule behind it, which is invisible in every other way.'
  )
  return { base: m[1], modifier: m[2] }
}

test('the class SessionRow emits for the open session has a rule behind it', () => {
  const { base, modifier } = activeRowClasses()

  // Compounded, not merely present. A bare `.active` anywhere else in the file
  // is what made this look styled while rendering nothing.
  const compound = new RegExp(`\\.${base}\\.${modifier}(?![-\\w])`)
  assert.match(
    CSS,
    compound,
    `SessionRow renders "${base} ${modifier}" but src/styles.css has no ` +
      `.${base}.${modifier} rule, so the open session is styled exactly like every ` +
      'other row.'
  )
})

test('the rule carries a visible background, not just any declaration', () => {
  // An empty or purely structural rule would satisfy the selector check and
  // still leave the row looking unselected, which is the symptom.
  const { base, modifier } = activeRowClasses()
  const block = CSS.match(
    new RegExp(`\\.${base}\\.${modifier}(?![-\\w])[^{]*\\{([^}]*)\\}`)
  )
  assert.ok(block, 'no rule block found')
  assert.match(
    block[1],
    /background/,
    'the active row rule sets no background, so nothing distinguishes the open session'
  )
})

test('the renamed-away selector is gone, so it cannot be mistaken for the styling', () => {
  // `.session-row` outlived the rename and looked like the row's stylesheet for
  // long enough to send this bug report somewhere else entirely. Nothing emits
  // it; if it comes back, so does the decoy.
  assert.ok(
    !/\.session-row(?![-\w])/.test(CSS),
    'the .session-row block is back in styles.css. No component renders that class, ' +
      'so its rules are unreachable and it reads as the styling for a row it cannot match.'
  )
})

test('no component renders the old class name', () => {
  // The other half: if something starts emitting `session-row` again, the rule
  // above should come back with it rather than the class going unstyled.
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.name.endsWith('.tsx')) files.push(full)
    }
  }
  walk(path.join(ROOT, 'src'))

  const emitters = files.filter((f) =>
    /className=[^\n]*\bsession-row\b/.test(fs.readFileSync(f, 'utf8'))
  )
  assert.deepEqual(
    emitters.map((f) => path.relative(ROOT, f).replace(/\\/g, '/')),
    [],
    'a component renders `session-row`, which has no rules'
  )
})
