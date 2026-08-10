import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { __freshUserData } from './stubs/electron'
import {
  attachmentBase64,
  attachmentFileName,
  dedupeToolCalls,
  imageExtension,
  repairTranscript,
  slimAttachment,
  slimAttachments,
  parkAttachmentBytes,
  ATTACHMENT_DIR
} from '../electron/main/transcript-repair'
import {
  getTranscript,
  listSessions,
  repairStoreOnStartup,
  saveTranscript,
  upsertSession
} from '../electron/main/store'
import type { ChatMessage, PromptAttachment, ToolCallInfo } from '../shared/types'

/**
 * Making a 118 MB store small without losing a message.
 *
 * Two leaks, one repair. What every test here is really guarding is the word
 * "without": a transcript is somebody's conversation, and the cheapest way to
 * make this file small would also be the way to destroy it.
 */

let userData = ''
beforeEach(() => {
  userData = __freshUserData()
})

function storeFile(): string {
  return path.join(userData, 'gronk-store.json')
}

function call(id: string, title = 'Read'): ToolCallInfo {
  return { toolCallId: id, title, status: 'completed', content: 'x'.repeat(64) }
}

function msg(id: string, toolCalls?: ToolCallInfo[], attachments?: PromptAttachment[]): ChatMessage {
  return {
    id,
    role: 'assistant',
    text: `turn ${id}`,
    createdAt: 1,
    ...(toolCalls ? { toolCalls } : {}),
    ...(attachments ? { attachments } : {})
  }
}

/** A 1x1 PNG, so the parked bytes are a real image rather than random noise. */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

function image(id: string, data = PNG_B64): PromptAttachment {
  return {
    id,
    kind: 'image',
    name: 'paste.png',
    data,
    mimeType: 'image/png',
    previewUrl: `data:image/png;base64,${data}`
  }
}

// ── Leak 1: duplicated tool calls ───────────────────────────────────

test('THE DUPLICATE: the same call across several messages collapses to one', () => {
  // The shape the leak actually has. Reopening copied a whole history onto a
  // fresh message, so the duplicates sit in DIFFERENT messages and a
  // per-message pass would find nothing wrong.
  const messages = [
    msg('m1', [call('t1'), call('t2')]),
    msg('m2', [call('t1'), call('t2'), call('t3')]),
    msg('m3', [call('t1'), call('t2'), call('t3')])
  ]
  const repaired = dedupeToolCalls(messages)

  assert.equal(repaired.length, 3, 'no message may be removed')
  assert.deepEqual(repaired.map((m) => m.toolCalls?.map((c) => c.toolCallId)), [
    ['t1', 't2'],
    ['t3'],
    []
  ])
})

test('EVERY DISTINCT CALL SURVIVES: this is a de-duplication, not a cap', () => {
  // A thousand real calls is a thousand real calls. A ceiling would have been
  // the wrong fix and would silently eat history.
  const many = Array.from({ length: 1000 }, (_, i) => call(`t${i}`))
  const messages = [msg('m1', many), msg('m2', many), msg('m3', many)]
  const repaired = dedupeToolCalls(messages)

  const ids = repaired.flatMap((m) => m.toolCalls?.map((c) => c.toolCallId) ?? [])
  assert.equal(ids.length, 1000)
  assert.equal(new Set(ids).size, 1000)
  assert.equal(repaired[0].toolCalls?.length, 1000, 'the earliest message keeps them')
})

test('the earliest occurrence is the one kept, so a call stays with its own turn', () => {
  const first = { ...call('t1'), title: 'the real call' }
  const echo = { ...call('t1'), title: 'the echo' }
  const repaired = dedupeToolCalls([msg('m1', [first]), msg('m2', [echo])])
  assert.equal(repaired[0].toolCalls?.[0].title, 'the real call')
  assert.deepEqual(repaired[1].toolCalls, [])
})

test('a call with no id is left exactly where it is', () => {
  // Two of these cannot be shown to be the same call, so removing one would be
  // a guess about the user's history.
  const anonymous = { title: 'no id', status: 'completed' } as ToolCallInfo
  const repaired = dedupeToolCalls([msg('m1', [anonymous]), msg('m2', [anonymous])])
  assert.equal(repaired[0].toolCalls?.length, 1)
  assert.equal(repaired[1].toolCalls?.length, 1)
})

test('a transcript with nothing to remove is returned untouched', () => {
  const messages = [msg('m1', [call('t1')]), msg('m2', [call('t2')])]
  const repaired = dedupeToolCalls(messages)
  assert.equal(repaired[0], messages[0], 'an unchanged message must not be rebuilt')
  assert.equal(repaired[1], messages[1])
})

// ── Leak 2: attachments held twice in base64 ────────────────────────

test('both copies of the bytes are read, and neither survives', () => {
  // `data` is the payload and `previewUrl` is a data: URL of the same bytes, so
  // an image was persisted twice.
  assert.equal(attachmentBase64(image('a')), PNG_B64)
  assert.equal(attachmentBase64({ ...image('a'), data: undefined }), PNG_B64)
  assert.equal(attachmentBase64({ id: 'a', kind: 'image', name: 'x.png' }), '')

  const slim = slimAttachment(image('a'), () => 'C:/data/attachments/a.png')
  assert.equal(slim.data, undefined)
  assert.equal(slim.previewUrl, undefined)
})

test('the metadata that lets the UI find the image again is kept', () => {
  const slim = slimAttachment(image('a'), () => 'C:/data/attachments/a.png')
  assert.deepEqual(slim, {
    id: 'a',
    kind: 'image',
    name: 'paste.png',
    path: 'C:/data/attachments/a.png',
    mimeType: 'image/png'
  })
})

test('AN IMAGE IS NEVER DESTROYED: bytes stay if they could not be parked', () => {
  // The whole reason parking exists. An image attachment is created with no
  // path (dropped, pasted and picked images are all base64), so if the write
  // fails there is nowhere else for those bytes to be.
  const kept = slimAttachment(image('a'), () => null)
  assert.equal(kept.data, PNG_B64)
  assert.equal(kept.previewUrl, `data:image/png;base64,${PNG_B64}`)
})

test('a file attachment and an already-parked image are left alone', () => {
  const file: PromptAttachment = { id: 'f', kind: 'file', name: 'notes.md', path: 'C:/x/notes.md' }
  assert.equal(slimAttachment(file, () => 'unused'), file)

  let parked = 0
  const already: PromptAttachment = {
    id: 'i',
    kind: 'image',
    name: 'a.png',
    path: 'C:/x/a.png',
    data: PNG_B64
  }
  const slim = slimAttachment(already, () => {
    parked++
    return 'C:/other.png'
  })
  assert.equal(parked, 0, 'an image already on disk must not be written again')
  assert.equal(slim.path, 'C:/x/a.png')
  assert.equal(slim.data, undefined)
})

test('the same image parks once, however many times it appears', () => {
  // Content addressed, so a picture pasted into three turns is one file.
  const a = attachmentFileName(PNG_B64, '.png')
  assert.equal(attachmentFileName(PNG_B64, '.png'), a)
  assert.notEqual(attachmentFileName(`${PNG_B64}x`, '.png'), a)
  assert.match(a, /^[0-9a-f]{32}\.png$/)
})

test('an image type we cannot serve is not parked at all', () => {
  assert.equal(imageExtension('image/png', 'x'), '.png')
  assert.equal(imageExtension('image/jpeg', 'x'), '.jpg')
  assert.equal(imageExtension(undefined, 'photo.WEBP'), '.webp')
  assert.equal(imageExtension('application/pdf', 'doc.pdf'), null)
  assert.equal(imageExtension(undefined, undefined), null)
})

test('parking writes the real bytes under the data directory', () => {
  const parked = parkAttachmentBytes(image('a'))
  assert.ok(parked, 'nothing was written')
  assert.equal(path.dirname(parked), path.join(userData, ATTACHMENT_DIR))
  assert.deepEqual(fs.readFileSync(parked), Buffer.from(PNG_B64, 'base64'))

  // Second call is the same path and does not rewrite.
  const again = parkAttachmentBytes(image('b'))
  assert.equal(again, parked, 'the same bytes produced a second file')
})

// ── Both together, and idempotence ──────────────────────────────────

test('the repair changes no message count and can run twice', () => {
  const messages = [
    msg('m1', [call('t1')], [image('a')]),
    msg('m2', [call('t1'), call('t2')], [image('b')])
  ]
  const once = repairTranscript(messages, () => 'C:/data/attachments/a.png')
  const twice = repairTranscript(once, () => 'C:/data/attachments/a.png')

  assert.equal(once.length, messages.length)
  assert.equal(twice.length, messages.length)
  assert.deepEqual(twice, once, 'a second pass must be a no-op')
  assert.deepEqual(
    once.flatMap((m) => m.toolCalls?.map((c) => c.toolCallId) ?? []),
    ['t1', 't2']
  )
})

test('text, thought and parts are not touched', () => {
  // They are the user's own conversation, they are a small fraction of the
  // file, and rewriting them has corrupted transcripts on reload before.
  const rich: ChatMessage = {
    id: 'm1',
    role: 'assistant',
    text: 'the whole answer',
    thought: 'the whole reasoning',
    parts: [{ kind: 'text', text: 'the whole answer' }],
    createdAt: 1,
    toolCalls: [call('t1'), call('t1')],
    attachments: [image('a')]
  }
  const [repaired] = repairTranscript([rich], () => 'C:/data/attachments/a.png')
  assert.equal(repaired.text, rich.text)
  assert.equal(repaired.thought, rich.thought)
  assert.deepEqual(repaired.parts, rich.parts)
})

test('slimAttachments leaves a message with no attachments identical', () => {
  const messages = [msg('m1', [call('t1')])]
  assert.equal(slimAttachments(messages, () => 'x')[0], messages[0])
})

// ── Through the real store, on disk ─────────────────────────────────

/** A store file in the old shape, written straight to disk as v1 would have. */
function writeLegacyStore(transcripts: Record<string, ChatMessage[]>): void {
  fs.mkdirSync(userData, { recursive: true })
  fs.writeFileSync(
    storeFile(),
    JSON.stringify({
      version: 1,
      settings: {},
      recentProjects: [],
      sessions: Object.keys(transcripts).map((id) => ({
        id,
        cwd: 'C:/work/app',
        createdAt: 1,
        updatedAt: 1
      })),
      transcripts,
      permissionAudit: []
    }),
    'utf8'
  )
}

test('MIGRATION: a v1 store on disk is repaired at startup', () => {
  const duplicated = Array.from({ length: 6 }, (_, i) =>
    msg(`m${i}`, [call('t1'), call('t2'), call('t3')], i === 0 ? [image('a')] : undefined)
  )
  writeLegacyStore({ s1: duplicated })
  const before = fs.statSync(storeFile()).size

  // The repair used to happen inside every read, which made a read cost a full
  // write of the file being repaired. It is a startup step now, so this names it
  // rather than relying on a read to trigger it.
  repairStoreOnStartup()
  const restored = getTranscript('s1')

  assert.equal(restored.length, 6, 'the conversation lost a message')
  assert.deepEqual(
    restored.flatMap((m) => m.toolCalls?.map((c) => c.toolCallId) ?? []),
    ['t1', 't2', 't3'],
    'every distinct call must survive and every duplicate must go'
  )
  assert.equal(restored[0].attachments?.[0].data, undefined, 'attachment bytes survived the repair')
  assert.ok(restored[0].attachments?.[0].path, 'the image was not parked anywhere')

  // Persisted rather than redone: the file on disk is now smaller and stamped,
  // and its size was the whole problem.
  const after = fs.statSync(storeFile()).size
  assert.ok(after < before, `expected the file to shrink, ${before} -> ${after}`)
  assert.equal(JSON.parse(fs.readFileSync(storeFile(), 'utf8')).version, 2)
})

test('a second startup neither re-runs the repair nor strips anything twice', () => {
  writeLegacyStore({ s1: [msg('m1', [call('t1'), call('t1')], [image('a')])] })
  repairStoreOnStartup()
  getTranscript('s1')
  const afterFirst = fs.readFileSync(storeFile(), 'utf8')

  // Already at this version, so a second startup has nothing to do.
  repairStoreOnStartup()
  const second = getTranscript('s1')
  assert.equal(fs.readFileSync(storeFile(), 'utf8'), afterFirst, 'the store was rewritten again')
  assert.equal(second.length, 1)
  assert.equal(second[0].toolCalls?.length, 1)
  assert.ok(second[0].attachments?.[0].path)
  assert.equal(second[0].attachments?.[0].data, undefined)
})

test('sessions and their message counts are unchanged by the repair', () => {
  writeLegacyStore({
    s1: Array.from({ length: 4 }, (_, i) => msg(`a${i}`, [call('t1')])),
    s2: Array.from({ length: 7 }, (_, i) => msg(`b${i}`, [call('t2')]))
  })
  assert.equal(listSessions().length, 2)
  assert.equal(getTranscript('s1').length, 4)
  assert.equal(getTranscript('s2').length, 7)
})

test('a new save parks its attachments instead of writing base64 again', () => {
  upsertSession({ id: 's1', cwd: 'C:/work/app', createdAt: 1, updatedAt: 1 })
  saveTranscript('s1', [msg('m1', undefined, [image('a')])])

  const onDisk = JSON.parse(fs.readFileSync(storeFile(), 'utf8'))
  const attachment = onDisk.transcripts.s1[0].attachments[0]
  assert.equal(attachment.data, undefined)
  assert.equal(attachment.previewUrl, undefined)
  assert.ok(attachment.path, 'the image was not parked')
  assert.equal(attachment.name, 'paste.png')
  assert.equal(fs.readFileSync(storeFile(), 'utf8').includes(PNG_B64), false)
})
