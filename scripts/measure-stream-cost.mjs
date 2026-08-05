/**
 * Cost of one streaming token at ~150 messages.
 *
 * Measures the work the chat path actually does per token:
 *  - remark+gfm parse of assistant markdown (MessageList / Markdown hot path)
 *  - real collectAgentUnitsFromMessages over a 200-message window (SessionTray)
 *
 * Before: every token re-parsed every assistant bubble and re-scanned the tray
 * (plus a setRetained second React pass). After: one growing-segment parse;
 * tray extract skipped when tool activity is unchanged.
 *
 * Run: node --import ./tests/ts-loader.mjs ./scripts/measure-stream-cost.mjs
 */
import { performance } from 'node:perf_hooks'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'

const require = createRequire(import.meta.url)
// Load TS modules the same way the test suite does.
const { collectAgentUnitsFromMessages } = await import(
  pathToFileURL(new URL('../src/lib/agent-activity.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')).href
).catch(async () => {
  // Windows pathToFileURL needs the file URL form.
  const p = require('node:path').resolve('src/lib/agent-activity.ts')
  return import(pathToFileURL(p).href)
})
const { toolActivitySignature } = await import(
  (() => {
    const p = require('node:path').resolve('src/lib/tool-activity-sig.ts')
    return pathToFileURL(p).href
  })()
)
const { nextRetained } = await import(
  (() => {
    const p = require('node:path').resolve('src/lib/agent-retention.ts')
    return pathToFileURL(p).href
  })()
)

const MESSAGE_COUNT = 150
const TOKEN = ' word'
const GROWING_BASE =
  '## Findings\n\nHere is what I found in the codebase:\n\n' +
  '- Path handling is local, not UTC\n' +
  '- The tray retained agents across restores\n' +
  '- Streaming re-parsed every bubble\n\n' +
  '```ts\nfunction localDayKey(ts: number): string {\n  const d = new Date(ts)\n  return d.toISOString()\n}\n```\n\n' +
  'More detail follows as the reply streams.'

const SAMPLE_BUBBLE =
  GROWING_BASE +
  '\n\nAdditional settled context that a finished turn would already have, ' +
  'with **bold**, a [link](https://example.com), and a short list:\n\n' +
  '1. One\n2. Two\n3. Three\n'

function parseMarkdown(text) {
  return unified().use(remarkParse).use(remarkGfm).parse(text)
}

function buildTranscript() {
  const messages = []
  for (let i = 0; i < MESSAGE_COUNT; i++) {
    const isAssistant = i % 2 === 1
    const msg = {
      id: `m${i}`,
      role: isAssistant ? 'assistant' : 'user',
      text: isAssistant ? SAMPLE_BUBBLE : `User question number ${i}`,
      toolCalls:
        isAssistant && i % 10 === 1
          ? [
              {
                toolCallId: `t${i}`,
                title: 'spawn_subagent',
                status: 'completed',
                rawInput: { subagent_type: 'explore', description: 'scan' }
              }
            ]
          : undefined
    }
    messages.push(msg)
  }
  const settled = GROWING_BASE.slice(0, 180)
  const growing = GROWING_BASE.slice(180) + TOKEN.repeat(40)
  messages[messages.length - 1] = {
    id: 'streaming',
    role: 'assistant',
    text: settled + growing,
    streaming: true,
    parts: [
      { kind: 'text', text: settled },
      { kind: 'text', text: growing }
    ]
  }
  return messages
}

function mean(samples) {
  return samples.reduce((a, b) => a + b, 0) / samples.length
}

function measure(label, fn, runs = 25) {
  for (let i = 0; i < 5; i++) fn()
  const samples = []
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    fn()
    samples.push(performance.now() - t0)
  }
  const avg = mean(samples)
  console.log(
    `${label.padEnd(56)} ${avg.toFixed(2)} ms/token  (min ${Math.min(...samples).toFixed(2)}, max ${Math.max(...samples).toFixed(2)})`
  )
  return avg
}

const messages = buildTranscript()
const assistantTexts = messages.filter((m) => m.role === 'assistant').map((m) => m.text)
const lastParts = messages[messages.length - 1].parts
const lastGrowing = lastParts[lastParts.length - 1].text
// Without segment memo, the streaming row re-parses its full concatenated text.
const streamingFullText = messages[messages.length - 1].text

console.log(`Transcript: ${messages.length} messages, ${assistantTexts.length} assistant bubbles`)
console.log(`Streaming full text: ${streamingFullText.length} chars; last segment: ${lastGrowing.length} chars`)
console.log('')

const beforeMd = measure('BEFORE markdown (all assistant bubbles re-parse)', () => {
  for (const t of assistantTexts) parseMarkdown(t)
})

let retained = []
const beforeTray = measure('BEFORE tray (extract 200 + nextRetained + setState work)', () => {
  const incoming = collectAgentUnitsFromMessages(messages, { maxMessages: 200 })
  retained = nextRetained({ prev: retained, incoming, isRestoreSnapshot: false })
})

const afterMd = measure('AFTER markdown (last growing segment only)', () => {
  parseMarkdown(lastGrowing)
})

let cachedUnits = collectAgentUnitsFromMessages(messages, { maxMessages: 200 })
let cachedSig = toolActivitySignature(messages, 200)
const afterTray = measure('AFTER tray (sig only; skip extract when unchanged)', () => {
  const sig = toolActivitySignature(messages, 200)
  if (sig !== cachedSig) {
    cachedSig = sig
    cachedUnits = collectAgentUnitsFromMessages(messages, { maxMessages: 200 })
    retained = nextRetained({ prev: retained, incoming: cachedUnits, isRestoreSnapshot: false })
  }
})

// Also show the streaming-row-only cost without list memo (full text re-parse).
const beforeStreamOnly = measure('REF: streaming row alone (full text re-parse)', () => {
  parseMarkdown(streamingFullText)
})

const beforeTotal = beforeMd + beforeTray
const afterTotal = afterMd + afterTray
console.log('')
console.log('─'.repeat(76))
console.log(`ONE TOKEN at ~${MESSAGE_COUNT} messages (this machine)`)
console.log(
  `  BEFORE  ${beforeTotal.toFixed(2)} ms   = markdown ${beforeMd.toFixed(2)} + tray ${beforeTray.toFixed(2)}`
)
console.log(
  `  AFTER   ${afterTotal.toFixed(2)} ms   = markdown ${afterMd.toFixed(2)} + tray ${afterTray.toFixed(2)}`
)
console.log(
  `  SPEEDUP ${(beforeTotal / Math.max(afterTotal, 0.001)).toFixed(1)}×     (Δ ${(beforeTotal - afterTotal).toFixed(2)} ms saved per token)`
)
console.log(
  `  Work:   BEFORE ${assistantTexts.length} md parses + tray extract every token;`
)
console.log(`          AFTER  1 md parse + tray extract 0 times (tools unchanged).`)
console.log(
  `  Note:   streaming-row full-text re-parse alone was ${beforeStreamOnly.toFixed(2)} ms; segment memo → ${afterMd.toFixed(2)} ms.`
)
console.log('─'.repeat(76))
