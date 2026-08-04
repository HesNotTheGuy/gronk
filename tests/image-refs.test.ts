/**
 * Tool-card image previews come from extractImageRefsFromTool. Two rules:
 *
 * 1. Structured JSON (image_gen / image_edit style) always surfaces, whatever
 *    the tool title is — that is the real result payload.
 * 2. Free-text absolute / images/… path scanning is only for tools that
 *    produce images. A shell or list tool that merely mentions a path in its
 *    output must not become a gallery.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { ToolCallInfo } from '../shared/types'
import {
  extractImagePathsFromText,
  extractImageRefsFromTool,
  isImageProducingTool
} from '../src/lib/image-refs'

function tool(partial: Partial<ToolCallInfo> & Pick<ToolCallInfo, 'title'>): ToolCallInfo {
  return {
    toolCallId: partial.toolCallId || 't1',
    title: partial.title,
    kind: partial.kind,
    status: partial.status || 'completed',
    rawInput: partial.rawInput,
    content: partial.content,
    error: partial.error
  }
}

test('isImageProducingTool matches image generators by title or kind', () => {
  assert.equal(isImageProducingTool({ title: 'image_gen' }), true)
  assert.equal(isImageProducingTool({ title: 'image_edit' }), true)
  assert.equal(isImageProducingTool({ title: 'Shell', kind: 'image_gen' }), true)
  assert.equal(isImageProducingTool({ title: 'something', kind: 'IMAGE' }), true)
  assert.equal(isImageProducingTool({ title: 'imagine' }), true)
  assert.equal(isImageProducingTool({ title: 'bash' }), false)
  assert.equal(isImageProducingTool({ title: 'Shell', kind: 'SHELL' }), false)
  assert.equal(isImageProducingTool({ title: 'list_dir' }), false)
  // A title that merely contains the word "image" is not a producer.
  assert.equal(isImageProducingTool({ title: 'read image_refs.ts' }), false)
})

test('structured JSON image results surface even on a non-image tool title', () => {
  const payload = JSON.stringify({
    path: 'C:\\Users\\sam\\.grok\\sessions\\x\\images\\1.jpg',
    filename: '1.jpg',
    session_folder: 'images'
  })
  const refs = extractImageRefsFromTool(
    tool({
      title: 'unknown_tool',
      kind: 'OTHER',
      content: payload
    })
  )
  assert.equal(refs.length, 1)
  assert.match(refs[0].path, /1\.jpg$/i)
})

test('free-text absolute paths on a shell tool do not become previews', () => {
  const output = [
    'wrote build/icon.png',
    'C:\\Users\\sam\\project\\build\\icon.png',
    'C:\\Users\\sam\\project\\installer\\splash.bmp',
    '/home/sam/project/docs/logo.png'
  ].join('\n')
  const refs = extractImageRefsFromTool(
    tool({
      title: 'bash',
      kind: 'SHELL',
      content: output
    })
  )
  assert.deepEqual(refs, [])
})

test('free-text absolute paths on an image_gen tool still surface', () => {
  const refs = extractImageRefsFromTool(
    tool({
      title: 'image_gen',
      content: 'Saved to C:\\Users\\sam\\.grok\\sessions\\x\\images\\2.png'
    })
  )
  assert.equal(refs.length, 1)
  assert.match(refs[0].path, /2\.png$/i)
})

test('extractImagePathsFromText freeText:false keeps only JSON payloads', () => {
  const abs = 'C:\\Users\\sam\\project\\build\\icon.png'
  assert.equal(extractImagePathsFromText(abs, { freeText: false }).length, 0)
  assert.equal(extractImagePathsFromText(abs, { freeText: true }).length, 1)

  const json = JSON.stringify({ path: abs, filename: 'icon.png' })
  const structured = extractImagePathsFromText(json, { freeText: false })
  assert.equal(structured.length, 1)
  assert.equal(structured[0].path, abs)
})

test('a list-style tool that dumps many image paths yields no refs', () => {
  const paths = Array.from({ length: 40 }, (_, i) => `C:\\assets\\tile-${i}.bmp`).join('\n')
  const refs = extractImageRefsFromTool(
    tool({
      title: 'run_terminal_command',
      kind: 'shell',
      content: paths
    })
  )
  assert.equal(refs.length, 0)
})
