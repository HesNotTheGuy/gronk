import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assertFileDialogOptions,
  assertOneOf,
  assertOptionalAttachments,
  assertOnlyKeys,
  assertPlainObject,
  assertRequestId,
  assertSettingsPatch
} from '../electron/main/ipc/validate'

/**
 * Objects arriving over IPC, narrowed rather than asserted.
 *
 * A TypeScript parameter type is erased at build time, so a handler annotated
 * `(e, options?: SendPromptOptions)` receives whatever the frame sent. These
 * validators are what turns the annotation into a fact, and the cases below are
 * the values that pass a `typeof x === 'object'` test: an array, a null, and an
 * object carrying a prototype somebody chose.
 */

test('an array is not an object, whatever typeof says', () => {
  assert.throws(() => assertPlainObject([], 'options'), /expected an object/)
  assert.throws(() => assertPlainObject([1, 2], 'options'), /expected an object/)
})

test('null is not an object either', () => {
  assert.throws(() => assertPlainObject(null, 'options'), /expected an object/)
})

test('AN OBJECT CARRYING A CHOSEN PROTOTYPE IS REFUSED', () => {
  const shaped = Object.create({ inherited: 'from the prototype' }) as Record<string, unknown>
  shaped.model = 'grok-4'
  assert.throws(() => assertPlainObject(shaped, 'options'), /expected a plain object/)
})

test('a null-prototype object is accepted, having no prototype to inherit from', () => {
  const bare = Object.create(null) as Record<string, unknown>
  bare.model = 'grok-4'
  assert.deepEqual(assertPlainObject(bare, 'options').model, 'grok-4')
})

test('a key nobody declared is refused rather than dropped', () => {
  assert.throws(() => assertOnlyKeys({ known: 1, other: 2 }, 'options', ['known']), /unknown field other/)
  assert.deepEqual(assertOnlyKeys({ known: 1 }, 'options', ['known', 'spare']), { known: 1 })
})

// ── Settings ────────────────────────────────────────────────────────────────

test('A SETTINGS PATCH IS BUILT FROM DECLARED FIELDS, not forwarded', () => {
  const patch = assertSettingsPatch({ theme: 'dark', alwaysApprove: true })
  assert.deepEqual(patch, { theme: 'dark', alwaysApprove: true })
})

test('an unknown settings field is refused', () => {
  assert.throws(() => assertSettingsPatch({ theme: 'dark', sneaky: 'x' }), /unknown field sneaky/)
})

test('an array passes a bare typeof check and is refused here', () => {
  assert.throws(() => assertSettingsPatch([]), /expected an object/)
})

test('THE MODEL IS CHECKED, because it becomes a command-line argument', () => {
  assert.deepEqual(assertSettingsPatch({ model: 'grok-4-fast' }), { model: 'grok-4-fast' })
  // A leading dash would be read as a flag by the CLI rather than as a name.
  assert.throws(() => assertSettingsPatch({ model: '--permission-mode' }), /model/)
  assert.throws(() => assertSettingsPatch({ model: 'grok 4' }), /model/)
  assert.throws(() => assertSettingsPatch({ model: 'grok\n--flag' }), /model/)
  assert.throws(() => assertSettingsPatch({ model: 42 }), /model/)
})

test('an empty model clears the override rather than failing', () => {
  assert.deepEqual(assertSettingsPatch({ model: '' }), { model: '' })
})

test('the permission mode must be one the app knows', () => {
  assert.deepEqual(assertSettingsPatch({ permissionMode: 'default' }), { permissionMode: 'default' })
  assert.throws(() => assertSettingsPatch({ permissionMode: 'whatever' }), /permissionMode/)
})

test('the theme must be one of three', () => {
  assert.throws(() => assertSettingsPatch({ theme: 'neon' }), /theme/)
})

test('the YOLO flags must be booleans, and mean nothing more here', () => {
  assert.throws(() => assertSettingsPatch({ alwaysApprove: 'yes' }), /alwaysApprove/)
  assert.throws(() => assertSettingsPatch({ alwaysApproveAck: 1 }), /alwaysApproveAck/)
  // The rule about what they mean together lives in the store, which folds them
  // against the persisted acknowledgement. Re-deriving it here would put that
  // decision in two places.
  assert.deepEqual(assertSettingsPatch({ alwaysApprove: true, alwaysApproveAck: true }), {
    alwaysApprove: true,
    alwaysApproveAck: true
  })
})

test('a preview command may contain spaces but not a newline', () => {
  assert.deepEqual(assertSettingsPatch({ previewCommand: 'npm run dev -- --port 1234' }), {
    previewCommand: 'npm run dev -- --port 1234'
  })
  assert.throws(() => assertSettingsPatch({ previewCommand: 'npm run dev\nrm -rf x' }), /previewCommand/)
})

// ── Attachments ─────────────────────────────────────────────────────────────

test('ATTACHMENTS MUST BE AN ARRAY OF ATTACHMENTS, not merely present', () => {
  assert.deepEqual(assertOptionalAttachments(undefined, 'attachments'), [])
  assert.throws(() => assertOptionalAttachments('nope', 'attachments'), /expected an array/)
  assert.throws(() => assertOptionalAttachments({ 0: 'x' }, 'attachments'), /expected an array/)
  assert.throws(() => assertOptionalAttachments([null], 'attachments'), /expected an object/)
  assert.throws(() => assertOptionalAttachments([{ kind: 'image' }], 'attachments'), /id/)
  assert.throws(
    () => assertOptionalAttachments([{ id: 'a', kind: 'other', name: 'x' }], 'attachments'),
    /kind/
  )
})

test('an attachment is rebuilt from declared fields only', () => {
  const out = assertOptionalAttachments(
    [{ id: 'a1', kind: 'image', name: 'paste.png', data: 'AAAA', mimeType: 'image/png' }],
    'attachments'
  )
  assert.deepEqual(out, [
    { id: 'a1', kind: 'image', name: 'paste.png', data: 'AAAA', mimeType: 'image/png' }
  ])
})

test('an undeclared field on an attachment is refused', () => {
  assert.throws(
    () => assertOptionalAttachments([{ id: 'a1', kind: 'file', name: 'x', extra: 1 }], 'attachments'),
    /unknown field extra/
  )
})

// ── Permission replies ──────────────────────────────────────────────────────

test('a request id is a number or a non-empty string, and nothing else', () => {
  assert.equal(assertRequestId(7, 'requestId'), 7)
  assert.equal(assertRequestId('abc', 'requestId'), 'abc')
  for (const bad of [undefined, null, '', '   ', {}, [], true, Number.NaN, Infinity]) {
    assert.throws(() => assertRequestId(bad, 'requestId'), /requestId/)
  }
})

test('a decision must be one of the four', () => {
  const allowed = ['allow-once', 'allow-always', 'allow-session', 'reject-once'] as const
  assert.equal(assertOneOf('allow-once', 'decision', allowed), 'allow-once')
  for (const bad of ['allow', 'ALLOW-ONCE', undefined, {}, ['allow-once']]) {
    assert.throws(() => assertOneOf(bad, 'decision', allowed), /decision/)
  }
})

// ── File dialog options ─────────────────────────────────────────────────────

test('DIALOG OPTIONS ARE REBUILT, so only two keys can reach Electron', () => {
  assert.deepEqual(assertFileDialogOptions(undefined, 'options'), {})
  assert.deepEqual(assertFileDialogOptions({ title: 'Pick' }, 'options'), { title: 'Pick' })
  // properties is the app's decision, not the caller's.
  assert.throws(
    () => assertFileDialogOptions({ properties: ['openDirectory'] }, 'options'),
    /unknown field properties/
  )
  assert.throws(
    () => assertFileDialogOptions({ defaultPath: '/etc' }, 'options'),
    /unknown field defaultPath/
  )
})

test('filters must be an array of name and extensions', () => {
  assert.deepEqual(
    assertFileDialogOptions({ filters: [{ name: 'Images', extensions: ['png', 'jpg'] }] }, 'options'),
    { filters: [{ name: 'Images', extensions: ['png', 'jpg'] }] }
  )
  assert.throws(() => assertFileDialogOptions({ filters: 'png' }, 'options'), /expected an array/)
  assert.throws(
    () => assertFileDialogOptions({ filters: [{ name: 'x', extensions: 'png' }] }, 'options'),
    /expected an array/
  )
  assert.throws(
    () => assertFileDialogOptions({ filters: [{ name: 'x', extensions: [], extra: 1 }] }, 'options'),
    /unknown field extra/
  )
})
