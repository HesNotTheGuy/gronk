import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Every class a component asks for must exist in the stylesheet.
 *
 * The activity heatmap shipped in v0.1.0 with no CSS whatsoever: the component
 * rendered 376 correctly-classed day cells and every one of them collapsed to
 * zero height, so a headline feature was an invisible blank space in the
 * released app. Nothing caught it. The unit tests asserted the data
 * (toWeekColumns, intensityLevel) and passed, because the bug was not in the
 * data — it was that `.calendar-grid` and friends had no rules at all.
 *
 * This is deliberately a coarse check: it proves a selector exists, not that the
 * styling is correct. That is still enough to catch a whole component being
 * added without its stylesheet, which is the failure that actually happened.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Tokens that are knowingly unstyled, each of which has to stay harmless.
 *
 * Keep this list short and justified. A growing allowlist means the check is
 * being worked around rather than the CSS being written.
 */
const KNOWN_UNSTYLED = new Map([
  // Sits alongside `browse-card project-browse-card`, both of which are styled.
  // A spare hook for targeting later; carries no layout of its own.
  ['activity-card', 'unused hook on an otherwise styled card'],
  // Wraps a literal chevron glyph. Inline text renders correctly with no rule.
  ['plan-chevron', 'wraps a text glyph that needs no styling'],
  // Grouping div around .tool-diff-path and .diff-pre, both of which are styled,
  // as are .diff-line (6 variants) and .diff-mark. The diff renders from those.
  ['tool-diff', 'wrapper whose children carry all the styling'],
  // Sits alongside .modal-actions, which supplies the layout.
  ['details-actions', 'spare hook on an otherwise styled modal footer'],
  // AgentFleet's `+N` overflow marker is `agent-chip more`, and .agent-chip
  // supplies all of its styling. `more` has never had a rule of its own: it
  // passed this check only because the deleted `.tool-chip.more` mentioned the
  // token, and that compound selector never matched an .agent-chip. So this
  // entry records a modifier that was already inert rather than one that just
  // became so. Giving it a rule, or dropping it from AgentFleet, is a decision
  // for whoever owns that component.
  ['more', 'inert modifier on an otherwise styled .agent-chip']
])

/**
 * Does the stylesheet define a rule for this exact class?
 *
 * A plain substring test is wrong in both directions that matter: `.level-1`
 * would be satisfied by `.level-10`, and `.calendar-grid` by a typo'd
 * `.calendar-gridX`. The lookahead requires the next character to end the
 * identifier, so only a real match counts.
 */
function hasRule(css: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\.${escaped}(?![-\\w])`).test(css)
}

function tsxFiles(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) tsxFiles(full, found)
    else if (entry.name.endsWith('.tsx')) found.push(full)
  }
  return found
}

test('every static className in a component has a rule in styles.css', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src/styles.css'), 'utf8')
  const owners = new Map<string, string>()

  for (const file of tsxFiles(path.join(ROOT, 'src'))) {
    const source = fs.readFileSync(file, 'utf8')
    // Static values only. A value containing `${` is composed at runtime, so its
    // pieces cannot be read reliably from source and are skipped.
    for (const match of source.matchAll(/className=\{?[`"']([^`"'$]*?)[`"']/g)) {
      for (const token of match[1].split(/\s+/).filter(Boolean)) {
        if (!owners.has(token)) owners.set(token, path.relative(ROOT, file).replace(/\\/g, '/'))
      }
    }
  }

  // The harness proved the scan works; if it ever finds nothing, it has broken.
  assert.ok(owners.size > 100, `expected to find many class tokens, found ${owners.size}`)

  const missing = [...owners]
    .filter(([token]) => !KNOWN_UNSTYLED.has(token))
    .filter(([token]) => !hasRule(css, token))
    .map(([token, file]) => `  .${token}  (${file})`)

  assert.deepEqual(
    missing,
    [],
    `class names with no rule in src/styles.css:\n${missing.join('\n')}\n\n` +
      'Either add the CSS, or add the token to KNOWN_UNSTYLED with a reason.'
  )
})

test('the unstyled allowlist has no stale entries', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src/styles.css'), 'utf8')
  const nowStyled = [...KNOWN_UNSTYLED.keys()].filter((token) => hasRule(css, token))
  assert.deepEqual(
    nowStyled,
    [],
    `these are styled now and should leave KNOWN_UNSTYLED: ${nowStyled.join(', ')}`
  )
})
