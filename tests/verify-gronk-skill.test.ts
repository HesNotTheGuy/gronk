import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * Drive the verify-gronk CLI only. Importing control-gronk.mjs into this
 * TypeScript project has no declarations, and tsc -p tsconfig.test.json
 * fails closed on that (TS7016). The CLI is what agents run.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SKILL = path.join(ROOT, '.cursor/skills/verify-gronk/SKILL.md')
const DRIVER = path.join(ROOT, '.cursor/skills/verify-gronk/control-gronk.mjs')
const FEATURES = path.join(ROOT, '.cursor/skills/verify-gronk/features')
const EVIDENCE = path.join(ROOT, 'artifacts', 'verify-gronk')

function driver(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, [DRIVER, ...args], {
    encoding: 'utf8',
    cwd: ROOT,
    env
  })
}

function paths(env: NodeJS.ProcessEnv = process.env) {
  const r = driver(['paths'], env)
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout) as {
    repo: string
    defaultUserData: string
    scratch: string
    evidence: string
    instance: string
    cdpPort: number
  }
}

test('SKILL.md registers as verify-gronk and names the five jobs', () => {
  const text = fs.readFileSync(SKILL, 'utf8')
  assert.match(text, /^---\nname: verify-gronk\n/m)
  assert.match(text, /^## Launch/m)
  assert.match(text, /^## Doctor/m)
  assert.match(text, /^## Drive/m)
  assert.match(text, /^## Evidence/m)
  assert.match(text, /^## Cleanup/m)
  assert.match(text, /control-gronk\.mjs launch/)
  assert.match(text, /artifacts\/verify-gronk/)
})

test('feature map files use the four required H2s', () => {
  const index = fs.readFileSync(path.join(FEATURES, 'README.md'), 'utf8')
  assert.match(index, /\[Home\]\(\.\/home\.md\)/)
  assert.match(index, /\[Chat\]\(\.\/chat\.md\)/)
  assert.match(index, /\[Build\]\(\.\/build\.md\)/)
  assert.match(index, /\[Focus\]\(\.\/focus\.md\)/)
  assert.match(index, /\[Permission prompts\]\(\.\/permission-prompts\.md\)/)

  for (const name of ['home.md', 'chat.md', 'build.md', 'focus.md', 'permission-prompts.md']) {
    const body = fs.readFileSync(path.join(FEATURES, name), 'utf8')
    assert.match(body, /^## Sub-features/m, name)
    assert.match(body, /^## How to get to it \(user POV\)/m, name)
    assert.match(body, /^## Driving it with control-gronk/m, name)
    assert.match(body, /^## Gotchas/m, name)
    assert.match(body, /Preconditions:/, name)
  }
})

test('verify-gronk skill files are not gitignored', () => {
  for (const rel of [
    '.cursor/skills/verify-gronk/SKILL.md',
    '.cursor/skills/verify-gronk/control-gronk.mjs',
    '.cursor/skills/verify-gronk/features/home.md'
  ]) {
    const r = spawnSync('git', ['check-ignore', '-q', rel], { cwd: ROOT })
    assert.notEqual(r.status, 0, `${rel} is gitignored`)
  }
})

test('doctor without a launch is not healthy', () => {
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'gronk-verify-test-'))
  const r = driver(['doctor'], { ...process.env, GRONK_VERIFY_DIR: isolated })
  assert.notEqual(r.status, 0)
  assert.match(`${r.stdout}\n${r.stderr}`, /no verification instance/)
  fs.rmSync(isolated, { recursive: true, force: true })
})

test('paths refuses the real Gronk directory and names tmp scratch', () => {
  const json = paths()
  assert.equal(path.basename(json.defaultUserData), 'gronk')
  assert.notEqual(json.defaultUserData, json.scratch)
  assert.ok(
    json.instance.startsWith(json.scratch),
    'instance file must live in scratch, not the real data dir'
  )
  assert.equal(json.evidence, EVIDENCE)
  assert.equal(json.cdpPort, 9333)
})

test('cleanup deletes scratch and leaves evidence', () => {
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'gronk-verify-test-'))
  fs.mkdirSync(EVIDENCE, { recursive: true })
  const proof = path.join(EVIDENCE, 'cleanup-sentinel.txt')
  fs.writeFileSync(proof, 'keep me\n')
  fs.writeFileSync(path.join(isolated, 'scratch-only.txt'), 'drop me\n')

  const r = driver(['cleanup'], { ...process.env, GRONK_VERIFY_DIR: isolated })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(fs.existsSync(isolated), false)
  assert.equal(fs.readFileSync(proof, 'utf8'), 'keep me\n')
  fs.unlinkSync(proof)
})

test('click without a target is a usage error, not a silent success', () => {
  const r = driver(['click'])
  assert.equal(r.status, 2)
  assert.match(`${r.stdout}\n${r.stderr}`, /--text or --selector/)
})
