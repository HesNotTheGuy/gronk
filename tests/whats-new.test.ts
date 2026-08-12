import test from 'node:test'
import assert from 'node:assert/strict'
import { compareVersions, decideWhatsNew, fixedLines, SECURITY_LINE } from '../src/lib/whats-new'
import { RELEASE_NOTES, type ReleaseNote } from '../shared/release-notes'

/**
 * Whether to show what changed, and what.
 *
 * Every case here is a launch that is tedious to stage by hand — a fresh install, a skipped
 * version, a downgrade, an unreleased build — which is why the decision is a function rather
 * than something living inside the component.
 */

const CATALOG: ReleaseNote[] = [
  { version: '0.5.0', changed: ['new thing'], fixed: [] },
  { version: '0.4.1', changed: [], fixed: ['a repair'] },
  { version: '0.4.0', changed: ['big thing'], fixed: ['old repair'] }
]

test('A FRESH INSTALL IS TOLD NOTHING, BUT ITS VERSION IS RECORDED', async () => {
  // Somebody opening the app for the first time wants the app, not a changelog. The record
  // still matters: without it the NEXT update has nothing to compare against and would also
  // show nothing.
  const d = decideWhatsNew('0.4.1', undefined, CATALOG)
  assert.deepEqual(d.notes, [])
  assert.equal(d.record, '0.4.1')
})

test('AN UPDATE SHOWS EVERY VERSION SINCE THE ONE LAST RUN', async () => {
  // Skipping releases is normal, so this is a range and not a single entry.
  const d = decideWhatsNew('0.5.0', '0.4.0', CATALOG)
  assert.deepEqual(
    d.notes.map((n) => n.version),
    ['0.5.0', '0.4.1'],
    'newest first, and the version already seen is not repeated'
  )
  assert.equal(d.record, '0.5.0')
})

test('THE SAME VERSION IS NEVER SHOWN TWICE', async () => {
  const d = decideWhatsNew('0.4.1', '0.4.1', CATALOG)
  assert.deepEqual(d.notes, [])
  assert.equal(d.record, null, 'nothing to write, so nothing is written')
})

test('A DOWNGRADE SHOWS NOTHING AND RECORDS NOTHING', async () => {
  // Running an older build than the one last seen is not an occasion for a panel, and
  // recording it would make the next launch of the newer build re-announce itself.
  const d = decideWhatsNew('0.4.0', '0.5.0', CATALOG)
  assert.deepEqual(d.notes, [])
  assert.equal(d.record, null)
})

test('A BUILD WITH NO NOTES SHOWS NOTHING AND IS STILL RECORDED', async () => {
  // An unreleased build, which is also what the screenshot fixtures run as. Recording it
  // stops the decision being reconsidered on every launch.
  // Seen the newest release in the catalog, running something above it — so the range is
  // genuinely empty. (With an older `seen` this would correctly show the releases between.)
  const d = decideWhatsNew('0.9.9', '0.5.0', CATALOG)
  assert.deepEqual(d.notes, [])
  assert.equal(d.record, '0.9.9')
})

test('NO VERSION AT ALL DECIDES NOTHING', async () => {
  // The version is a build-time define; under `node --test` it can be absent, and guessing
  // would record a wrong baseline.
  assert.deepEqual(decideWhatsNew('', undefined, CATALOG), { notes: [], record: null })
})

test('VERSIONS SORT NUMERICALLY, NOT AS TEXT', async () => {
  assert.ok(compareVersions('0.10.0', '0.9.0') > 0, 'string comparison would call 0.10 older')
  assert.ok(compareVersions('1.0.0', '0.99.99') > 0)
  assert.equal(compareVersions('0.4.1', '0.4.1'), 0)
  assert.ok(compareVersions('0.4.2-rc1', '0.4.1') > 0, 'a build label is not a version bump')
})

// ── The security rule ───────────────────────────────────────────────────────

test('A SECURITY RELEASE SAYS ONE LINE AND NOTHING ELSE ABOUT IT', async () => {
  // The people at risk from a detailed security note are the ones who have not updated yet.
  // The panel may say an update matters; it may not say why.
  const note: ReleaseNote = { version: '0.4.2', changed: [], fixed: [], security: true }
  assert.deepEqual(fixedLines(note), [SECURITY_LINE])
  assert.match(SECURITY_LINE, /^Security and stability improvements\.$/)
})

test('THE SHIPPED NOTES DESCRIBE NO SECURITY FIX', async () => {
  // A guard on the content, not the mechanism: this is the file a future release edits, and
  // the failure mode is somebody writing a helpful sentence about what a fix prevented.
  const words = /\b(exploit|vulnerab|attacker|injection|escape|sandbox|traversal|CVE|privilege|malicious|bypass)\w*/i
  for (const note of RELEASE_NOTES) {
    for (const line of [...note.changed, ...note.fixed]) {
      assert.doesNotMatch(
        line,
        words,
        `${note.version} describes something security-shaped: "${line}". Set security: true and say nothing more.`
      )
    }
  }
})

test('THE SHIPPED NOTES READ AS PLAIN ENGLISH', async () => {
  // No file names, no internal terms, no issue numbers — the audience does not know how the
  // app is built.
  for (const note of RELEASE_NOTES) {
    for (const line of [...note.changed, ...note.fixed]) {
      assert.doesNotMatch(line, /\.tsx?\b|\bipc\b|#\d+|\bACP\b|electron\/|src\//i, `internal detail in ${note.version}: "${line}"`)
      assert.ok(line.length > 20, `too terse to be useful in ${note.version}: "${line}"`)
      assert.ok(line.length < 320, `too long for a panel in ${note.version}: "${line}"`)
    }
  }
})

test('EVERY SHIPPED VERSION HAS SOMETHING TO SAY', async () => {
  for (const note of RELEASE_NOTES) {
    assert.ok(
      note.changed.length + fixedLines(note).length > 0,
      `${note.version} has an entry with no content, which would show an empty panel`
    )
  }
})

// ── The panel itself ────────────────────────────────────────────────────────

test('THE PANEL PRINTS WHAT CHANGED AND CLOSES ON DISMISS', async () => {
  const { createElement } = await import('react')
  const { flush, mount } = await import('./helpers/render')
  const { WhatsNew } = await import('../src/components/WhatsNew')

  let dismissed = 0
  const view = await mount(
    createElement(WhatsNew, {
      notes: [{ version: '0.4.1', changed: ['a visible change'], fixed: ['a repair'] }],
      onDismiss: () => (dismissed += 1)
    } as never)
  )
  await flush()
  try {
    const text = (view.text() || '').replace(/\s+/g, ' ')
    assert.match(text, /a visible change/)
    assert.match(text, /a repair/)
    assert.match(text, /0\.4\.1/, 'the version it is about is not shown')

    const got = view.queryAll('button').find((b) => /got it/i.test(b.textContent ?? ''))
    assert.ok(got, 'no way to dismiss it')
    await view.click(got)
    assert.equal(dismissed, 1)
  } finally {
    view.unmount()
  }
})

test('WITH NOTHING TO SAY THE PANEL DOES NOT EXIST', async () => {
  // Not "renders empty": a modal backdrop with nothing in it would still block the app.
  const { createElement } = await import('react')
  const { flush, mount } = await import('./helpers/render')
  const { WhatsNew } = await import('../src/components/WhatsNew')

  const view = await mount(createElement(WhatsNew, { notes: [], onDismiss: () => {} } as never))
  await flush()
  try {
    assert.equal(view.query('.modal-backdrop'), null, 'an empty panel still covers the app')
  } finally {
    view.unmount()
  }
})
