import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PERMISSION_LIMITS,
  boundDiffLines,
  formatPermission,
  formatTool,
  inertText,
  shortenForDisplay,
  simpleDiff,
  type DiffLine
} from '../src/lib/tool-format'
import type { PermissionRequest, ToolCallInfo } from '../shared/types'

function tool(partial: Partial<ToolCallInfo>): ToolCallInfo {
  return {
    toolCallId: 't1',
    title: 'tool',
    status: 'completed',
    ...partial
  }
}

function request(partial: Partial<PermissionRequest>): PermissionRequest {
  return {
    requestId: 1,
    sessionId: 's1',
    toolCallId: 't1',
    title: 'tool',
    ...partial
  }
}

function texts(lines: DiffLine[] | undefined, type: DiffLine['type']): string[] {
  return (lines || []).filter((l) => l.type === type).map((l) => l.text)
}

// ── formatTool: diff computation (what ToolCard renders after the fact) ──

test('an edit produces add / del / ctx lines', () => {
  const fmt = formatTool(
    tool({
      kind: 'edit',
      rawInput: {
        path: 'src/app.ts',
        old_string: 'const a = 1\nconst b = 2\nconst c = 3',
        new_string: 'const a = 1\nconst b = 22\nconst c = 3'
      }
    })
  )
  assert.equal(fmt.kindLabel, 'EDIT')
  assert.equal(fmt.path, 'src/app.ts')
  assert.deepEqual(texts(fmt.diffLines, 'del'), ['const b = 2'])
  assert.deepEqual(texts(fmt.diffLines, 'add'), ['const b = 22'])
  assert.deepEqual(texts(fmt.diffLines, 'ctx'), ['const a = 1', 'const c = 3'])
})

test('identical old and new strings produce no diff at all', () => {
  const fmt = formatTool(
    tool({ kind: 'edit', rawInput: { path: 'a.ts', old_string: 'same', new_string: 'same' } })
  )
  assert.equal(fmt.diffLines, undefined)
  // Falls back to the payload so the card still shows something.
  assert.match(fmt.body, /old_string/)
})

test('a half-specified edit degrades to the raw payload instead of a diff', () => {
  const onlyNew = formatTool(tool({ kind: 'edit', rawInput: { path: 'a.ts', new_string: 'x' } }))
  assert.equal(onlyNew.diffLines, undefined)
  assert.match(onlyNew.body, /new_string/)

  const onlyOld = formatTool(tool({ kind: 'edit', rawInput: { path: 'a.ts', old_string: 'x' } }))
  assert.equal(onlyOld.diffLines, undefined)

  const neither = formatTool(tool({ kind: 'edit', rawInput: { path: 'a.ts' } }))
  assert.equal(neither.diffLines, undefined)
  assert.equal(neither.summary, 'a.ts')
})

test('a non-edit tool call has no diff lines', () => {
  const shell = formatTool(tool({ kind: 'bash', rawInput: { command: 'npm test' } }))
  assert.equal(shell.kindLabel, 'SHELL')
  assert.equal(shell.diffLines, undefined)
  assert.equal(shell.summary, 'npm test')
})

// ── shortenForDisplay (chat briefs; never hardcodes a real username) ──

test('shortenForDisplay replaces Windows and POSIX home prefixes with ~', () => {
  // Deep under home collapses to ~ + last three segments
  assert.equal(
    shortenForDisplay('C:/Users/sam/OneDrive/Documents/VibeCoding/Grocky'),
    '~/Documents/VibeCoding/Grocky'
  )
  assert.equal(shortenForDisplay('C:\\Users\\x\\proj\\file.ts'), '~/proj/file.ts')
  assert.equal(shortenForDisplay('/Users/sam/code/app/src/main.ts'), '~/app/src/main.ts')
  assert.equal(shortenForDisplay('/home/dev/work/repo'), '~/work/repo')
})

test('shortenForDisplay shortens home paths inside shell commands', () => {
  const cmd =
    'git -C "C:/Users/sam/OneDrive/Documents/VibeCoding/Grocky" tag -a v0.1.8'
  const out = shortenForDisplay(cmd)
  assert.ok(!/Users[/\\]sam/i.test(out), out)
  assert.ok(out.includes('git'), out)
  assert.ok(out.includes('~'), out)
})

test('formatTool summary shortens paths but keeps raw path for callers', () => {
  const fmt = formatTool(
    tool({
      kind: 'read',
      rawInput: { path: 'C:/Users/sam/proj/package.json' }
    })
  )
  assert.equal(fmt.path, 'C:/Users/sam/proj/package.json')
  assert.equal(fmt.summary, '~/proj/package.json')
  assert.ok(!fmt.summary.includes('Users'), fmt.summary)
})

test('a huge edit is bounded and says so', () => {
  const fmt = formatTool(
    tool({
      kind: 'edit',
      rawInput: {
        path: 'big.txt',
        old_string: 'line 0',
        new_string: Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n')
      }
    })
  )
  const lines = fmt.diffLines || []
  assert.ok(lines.length <= 500, `expected <= 500 lines, got ${lines.length}`)
  assert.ok(lines.some((l) => l.type === 'hunk' && /truncated/.test(l.text)))
})

test('a unified diff already in the payload is parsed, not re-diffed', () => {
  const fmt = formatTool(
    tool({
      kind: 'patch',
      rawInput: { path: 'a.ts', diff: '@@ -1,2 +1,2 @@\n ctx\n-gone\n+here' }
    })
  )
  assert.deepEqual(texts(fmt.diffLines, 'del'), ['gone'])
  assert.deepEqual(texts(fmt.diffLines, 'add'), ['here'])
  assert.deepEqual(texts(fmt.diffLines, 'ctx'), ['ctx'])
})

// ── simpleDiff source cap (opt-in, so ToolCard is unaffected) ────────

test('simpleDiff without a cap is unchanged', () => {
  const lines = simpleDiff('a\nb', 'a\nc')
  assert.deepEqual(lines, [
    { type: 'ctx', text: 'a' },
    { type: 'del', text: 'b' },
    { type: 'add', text: 'c' }
  ])
  assert.ok(!lines.some((l) => l.type === 'hunk'))
})

test('simpleDiff with a cap stops reading and flags the truncation', () => {
  const lines = simpleDiff('a\nbbbbbbbbbb', 'a\ncccccccccc', 4)
  assert.ok(lines.some((l) => l.type === 'hunk' && /truncated/.test(l.text)))
  // Only 4 characters of each side were read, so no content line can exceed it.
  for (const line of lines) {
    if (line.type !== 'hunk') assert.ok(line.text.length <= 4)
  }
})

test('a whole-file write is left to the permission view, not shown as a diff here', () => {
  const fmt = formatTool(
    tool({ kind: 'write', rawInput: { path: 'new.ts', old_string: '', new_string: 'a\nb' } })
  )
  assert.equal(fmt.diffLines, undefined)
})

// ── inertText ───────────────────────────────────────────────────────

test('inertText replaces bidi, zero-width and control characters', () => {
  for (const code of [0x00, 0x1f, 0x200b, 0x202e, 0x2066]) {
    assert.equal(inertText(`safe${String.fromCodePoint(code)}name`, 80), 'safe name')
  }
})

test('inertText keeps indentation only when layout is preserved', () => {
  assert.equal(inertText('  if (x) {\n\treturn\n', 80, true), '  if (x) {\n\treturn\n')
  assert.equal(inertText('  if (x) {\n\treturn\n', 80), 'if (x) { return')
})

test('inertText truncates with an ellipsis and rejects non-strings', () => {
  const out = inertText('x'.repeat(50), 10)
  assert.equal(out, `${'x'.repeat(10)}…`)
  assert.equal(inertText(undefined, 10), '')
  assert.equal(inertText({ a: 1 }, 10), '')
  assert.equal(inertText('x', 0), '')
})

// ── boundDiffLines ──────────────────────────────────────────────────

test('boundDiffLines counts the whole diff but renders only a slice', () => {
  const lines: DiffLine[] = Array.from({ length: 300 }, (_, i) => ({
    type: i % 2 === 0 ? 'add' : 'del',
    text: `l${i}`
  }))
  const bounded = boundDiffLines(lines, 10, 100)
  assert.equal(bounded.added, 150)
  assert.equal(bounded.removed, 150)
  assert.equal(bounded.truncated, true)
  assert.equal(bounded.lines.length, 11)
  assert.equal(bounded.lines[10].type, 'hunk')
  assert.match(bounded.lines[10].text, /290 more lines/)
})

test('boundDiffLines clips a single monstrous line', () => {
  const bounded = boundDiffLines([{ type: 'add', text: 'y'.repeat(10000) }], 10, 20)
  assert.equal(bounded.truncated, true)
  assert.equal(bounded.lines[0].text.length, 21) // 20 chars + the ellipsis
  assert.match(bounded.lines[1].text, /long lines clipped/)
})

test('boundDiffLines leaves a small diff alone', () => {
  const bounded = boundDiffLines([{ type: 'add', text: '  indented' }], 10, 20)
  assert.equal(bounded.truncated, false)
  assert.deepEqual(bounded.lines, [{ type: 'add', text: '  indented' }])
})

// ── formatPermission: the approval screen ───────────────────────────

test('a write request shows a diff, a path and a change count', () => {
  const fmt = formatPermission(
    request({
      kind: 'fs/write',
      title: 'Edit file',
      rawInput: {
        path: 'src/app.ts',
        old_string: 'one\ntwo',
        new_string: 'one\nTWO'
      }
    })
  )
  assert.equal(fmt.kindLabel, 'EDIT')
  assert.equal(fmt.path, 'src/app.ts')
  assert.deepEqual(texts(fmt.diffLines, 'add'), ['TWO'])
  assert.deepEqual(texts(fmt.diffLines, 'del'), ['two'])
  assert.equal(fmt.added, 1)
  assert.equal(fmt.removed, 1)
  // The path is the diff caption; neither it nor the raw strings repeat as facts.
  assert.equal(fmt.subject, '')
  assert.deepEqual(fmt.facts, [])
  assert.match(fmt.raw, /old_string/)
})

// Creating a file has no old text to compare against, and it is the case where
// the user is approving the most content at once.
test('creating a file previews the whole content as additions', () => {
  const fmt = formatPermission(
    request({
      kind: 'fs/write',
      rawInput: { path: 'new.ts', old_string: '', new_string: 'export const a = 1\nexport const b = 2' }
    })
  )
  assert.equal(fmt.path, 'new.ts')
  assert.deepEqual(texts(fmt.diffLines, 'add'), ['export const a = 1', 'export const b = 2'])
  assert.equal(fmt.added, 2)
  assert.equal(fmt.removed, 0)
  assert.equal(fmt.diffTruncated, false)

  // Same for a bare `content` payload with no old side at all.
  const created = formatPermission(
    request({ kind: 'fs/write', rawInput: { path: 'new.ts', content: 'hello' } })
  )
  assert.deepEqual(texts(created.diffLines, 'add'), ['hello'])
})

test('emptying a file previews the removal', () => {
  const fmt = formatPermission(
    request({ kind: 'fs/write', rawInput: { path: 'gone.ts', old_string: 'a\nb', new_string: '' } })
  )
  assert.deepEqual(texts(fmt.diffLines, 'del'), ['a', 'b'])
  assert.equal(fmt.removed, 2)
})

test('a shell request shows the command verbatim, not a JSON blob', () => {
  const fmt = formatPermission(
    request({
      kind: 'execute',
      rawInput: { command: 'rm -rf ./build && npm ci', cwd: '/repo', timeout: 30 }
    })
  )
  assert.equal(fmt.kindLabel, 'SHELL')
  assert.equal(fmt.subjectLabel, 'Command')
  assert.equal(fmt.subject, 'rm -rf ./build && npm ci')
  assert.equal(fmt.diffLines, undefined)
  assert.deepEqual(fmt.facts, [
    { label: 'cwd', value: '/repo' },
    { label: 'timeout', value: '30' }
  ])
})

test('read and fetch requests lead with the file and the URL', () => {
  const read = formatPermission(
    request({ kind: 'fs/read', rawInput: { path: '/etc/hosts', limit: 100 } })
  )
  assert.equal(read.kindLabel, 'READ')
  assert.equal(read.subjectLabel, 'File')
  assert.equal(read.subject, '/etc/hosts')
  assert.deepEqual(read.facts, [{ label: 'limit', value: '100' }])

  const net = formatPermission(
    request({ kind: 'fetch', rawInput: { url: 'https://example.com/x', method: 'POST' } })
  )
  assert.equal(net.kindLabel, 'NET')
  assert.equal(net.subjectLabel, 'URL')
  assert.equal(net.subject, 'https://example.com/x')
  assert.deepEqual(net.facts, [{ label: 'method', value: 'POST' }])
})

// The agent writes `title`. If it could steer the badge, a write could announce
// itself as a read on the one screen where that matters.
test('the agent title cannot relabel the request', () => {
  const fmt = formatPermission(
    request({
      kind: 'fs/write',
      title: 'read a file (safe)',
      rawInput: { path: 'a.ts', old_string: 'a', new_string: 'b' }
    })
  )
  assert.equal(fmt.kindLabel, 'EDIT')

  const unkinded = formatPermission(request({ title: 'read a file', rawInput: { path: 'a.ts' } }))
  assert.equal(unkinded.kindLabel, 'TOOL')
})

test('a monstrous edit cannot outgrow the modal', () => {
  const fmt = formatPermission(
    request({
      kind: 'fs/write',
      rawInput: {
        path: 'big.txt',
        old_string: '',
        new_string: Array.from({ length: 20000 }, (_, i) => `line ${i} ${'x'.repeat(600)}`).join(
          '\n'
        )
      }
    })
  )
  assert.equal(fmt.diffTruncated, true)
  assert.ok(fmt.diffLines!.length <= PERMISSION_LIMITS.diffLines + 1)
  for (const line of fmt.diffLines!) {
    assert.ok(
      line.text.length <= PERMISSION_LIMITS.lineChars + 1,
      `line of ${line.text.length} chars escaped the cap`
    )
  }
  assert.equal(fmt.rawTruncated, true)
  assert.ok(fmt.raw.length <= PERMISSION_LIMITS.rawChars + 1)
})

test('a single unbroken megabyte line is clipped too', () => {
  const fmt = formatPermission(
    request({
      kind: 'fs/write',
      rawInput: { path: 'a.txt', old_string: '', new_string: 'z'.repeat(1_000_000) }
    })
  )
  assert.equal(fmt.diffTruncated, true)
  assert.ok(fmt.diffLines![0].text.length <= PERMISSION_LIMITS.lineChars + 1)
})

test('bidi and control characters never reach the approval screen', () => {
  const rlo = String.fromCodePoint(0x202e)
  const fmt = formatPermission(
    request({
      kind: 'fs/write',
      rawInput: {
        path: `src/${rlo}gnp.exe`,
        note: `hi${rlo}there`,
        old_string: 'a',
        new_string: `drop${rlo}Table`
      }
    })
  )
  assert.ok(!fmt.path!.includes(rlo))
  assert.ok(!fmt.diffLines!.some((l) => l.text.includes(rlo)))
  assert.ok(!fmt.facts.some((f) => f.value.includes(rlo)))
  assert.ok(!fmt.raw.includes(rlo))
})

test('a non-JSON string payload is the request', () => {
  const fmt = formatPermission(request({ kind: 'execute', rawInput: 'ls -la' }))
  assert.equal(fmt.raw, 'ls -la')
  assert.equal(fmt.subjectLabel, 'Command')
  assert.equal(fmt.subject, 'ls -la')
  assert.deepEqual(fmt.facts, [])
  assert.equal(fmt.diffLines, undefined)

  const unkinded = formatPermission(request({ rawInput: 'do a thing' }))
  assert.equal(unkinded.subjectLabel, 'Payload')
  assert.equal(unkinded.subject, 'do a thing')
})

test('a request with no payload yields an empty, still-renderable view', () => {
  const fmt = formatPermission(request({ kind: 'other' }))
  assert.equal(fmt.raw, '')
  assert.equal(fmt.rawTruncated, false)
  assert.equal(fmt.subject, '')
  assert.deepEqual(fmt.facts, [])
  assert.equal(fmt.diffLines, undefined)
})

// A modal that throws is a modal with no Deny button, which is worse than an
// ugly one — the agent stays blocked and the user cannot answer.
test('an unserialisable payload degrades instead of throwing', () => {
  const circular: Record<string, unknown> = { path: 'a.ts' }
  circular.self = circular
  const fmt = formatPermission(request({ kind: 'fs/write', rawInput: circular }))
  assert.equal(typeof fmt.raw, 'string')
  assert.match(fmt.raw, /could not be serialised/)
  assert.equal(fmt.diffLines, undefined)
})

test('formatPermission tolerates a malformed request object', () => {
  const bogus = undefined as unknown as PermissionRequest
  const fmt = formatPermission(bogus)
  assert.equal(fmt.kindLabel, 'TOOL')
  assert.equal(fmt.raw, '')
})

test('nested payload values are summarised rather than dumped', () => {
  const fmt = formatPermission(
    request({
      kind: 'other',
      rawInput: { headers: { auth: 'x' }, retries: 3, dryRun: false, empty: '' }
    })
  )
  assert.deepEqual(fmt.facts, [
    { label: 'headers', value: '{"auth":"x"}' },
    { label: 'retries', value: '3' },
    { label: 'dryRun', value: 'false' }
  ])
})

test('the fact list is capped so the buttons stay on screen', () => {
  const input: Record<string, unknown> = {}
  for (let i = 0; i < 50; i++) input[`k${i}`] = `v${i}`
  const fmt = formatPermission(request({ kind: 'other', rawInput: input }))
  assert.equal(fmt.facts.length, PERMISSION_LIMITS.facts)
  for (const fact of fmt.facts) {
    assert.ok(fact.value.length <= PERMISSION_LIMITS.factValueChars + 1)
  }
})
