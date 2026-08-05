/**
 * Before/after cost of one permission accept with ~30 sessions in the store.
 *
 * BEFORE: what appendPermissionAudit used to do — read whole store, copy backup,
 * pretty-print JSON, atomic write.
 * AFTER: dedicated audit file append (current code).
 *
 * Run: node --import ./tests/ts-loader.mjs ./scripts/measure-permission-audit.mjs
 */
import { performance } from 'node:perf_hooks'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')

const { __freshUserData } = await import(
  pathToFileURL(path.join(root, 'tests/stubs/electron.ts')).href
)
const { writeFileAtomicSync } = await import(
  pathToFileURL(path.join(root, 'electron/main/data-dir.ts')).href
)
const {
  appendPermissionAudit,
  __resetPermissionAuditMigrationForTests
} = await import(pathToFileURL(path.join(root, 'electron/main/permission-audit.ts')).href)
const { upsertSession, saveTranscript, setSettings } = await import(
  pathToFileURL(path.join(root, 'electron/main/store.ts')).href
)

const SESSION_COUNT = 30
const MSGS_PER = 20

function seedFatStore(userData) {
  for (let i = 0; i < SESSION_COUNT; i++) {
    const id = `s${i}`
    upsertSession({
      id,
      cwd: `C:/work/project-${i % 5}`,
      createdAt: 1000 + i,
      updatedAt: 2000 + i,
      title: `Session ${i}`,
      surface: 'project'
    })
    const messages = []
    for (let m = 0; m < MSGS_PER; m++) {
      messages.push({
        id: `${id}-m${m}`,
        role: m % 2 === 0 ? 'user' : 'assistant',
        text:
          `Message ${m} for session ${i}. `.repeat(40) +
          '```ts\nconst x = ' +
          m +
          '\n```\n',
        createdAt: 1000 + m
      })
    }
    saveTranscript(id, messages)
  }
  setSettings({ theme: 'dark' })
  const storePath = path.join(userData, 'gronk-store.json')
  const bytes = fs.statSync(storePath).size
  return { storePath, bytes }
}

function mean(samples) {
  return samples.reduce((a, b) => a + b, 0) / samples.length
}

function measure(label, fn, runs = 40) {
  for (let i = 0; i < 5; i++) fn()
  const samples = []
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    fn()
    samples.push(performance.now() - t0)
  }
  const avg = mean(samples)
  console.log(
    `${label.padEnd(52)} ${avg.toFixed(2)} ms  (min ${Math.min(...samples).toFixed(2)}, max ${Math.max(...samples).toFixed(2)})`
  )
  return avg
}

// ── AFTER (current path) ────────────────────────────────────────────
const userData = __freshUserData('gronk-audit-bench-')
__resetPermissionAuditMigrationForTests()
const { storePath, bytes } = seedFatStore(userData)
console.log(`Store: ${SESSION_COUNT} sessions × ${MSGS_PER} messages ≈ ${(bytes / 1024).toFixed(0)} KB`)
console.log(`userData: ${userData}`)
console.log('')

let n = 0
const after = measure('AFTER  appendPermissionAudit (own file)', () => {
  appendPermissionAudit({
    id: `after-${n++}`,
    at: Date.now(),
    sessionId: 's0',
    cwd: 'C:/work/project-0',
    toolCallId: 't1',
    title: 'Read package.json',
    decision: 'allow-once',
    rawInputPreview: '{"path":"package.json"}'
  })
})

// ── BEFORE (simulate the old store rewrite) ─────────────────────────
function oldAppendViaStoreRewrite() {
  const text = fs.readFileSync(storePath, 'utf8')
  const data = JSON.parse(text)
  const safe = {
    id: `before-${n++}`,
    at: Date.now(),
    sessionId: 's0',
    cwd: 'C:/work/project-0',
    toolCallId: 't1',
    title: 'Read package.json',
    decision: 'allow-once',
    rawInputPreview: '{"path":"package.json"}'
  }
  data.permissionAudit = [safe, ...(data.permissionAudit || [])].slice(0, 200)
  try {
    if (fs.statSync(storePath).size > 0) {
      fs.copyFileSync(storePath, path.join(userData, 'gronk-store.backup.json'))
    }
  } catch {
    /* */
  }
  writeFileAtomicSync(storePath, JSON.stringify(data, null, 2))
}

const before = measure('BEFORE rewrite whole gronk-store.json', () => {
  oldAppendViaStoreRewrite()
})

console.log('')
console.log('─'.repeat(72))
console.log(`ONE permission accept with ~${SESSION_COUNT} sessions in the store`)
console.log(`  BEFORE  ${before.toFixed(2)} ms`)
console.log(`  AFTER   ${after.toFixed(2)} ms`)
console.log(
  `  SPEEDUP ${before > 0 ? (before / Math.max(after, 0.001)).toFixed(1) : 'n/a'}×   (Δ ${(before - after).toFixed(2)} ms saved)`
)
console.log('─'.repeat(72))
