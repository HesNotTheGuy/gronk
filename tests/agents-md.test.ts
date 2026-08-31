import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const text = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8')

test('AGENTS.md keeps a Hard rules section every agent can see', () => {
  assert.match(text, /^## Hard rules\b/m)
})

test('AGENTS.md still forbids dropping --permission-mode', () => {
  assert.match(text, /--permission-mode/)
  assert.match(text, /Never remove or skip/)
})

test('AGENTS.md still requires assertTrustedSender on every handler', () => {
  assert.match(text, /assertTrustedSender/)
  assert.match(text, /ipc-handler-guard\.test\.ts/)
})

test('AGENTS.md marks argument validation as required but unenforced', () => {
  assert.match(text, /ipc\/validate\.ts/)
  assert.match(text, /Nothing enforces this/)
  assert.doesNotMatch(
    text,
    /validates its arguments[\s\S]{0,120}Covered by `tests\/ipc-handler-guard/
  )
})

test('AGENTS.md still forbids simplifying path containment', () => {
  assert.match(text, /isPathInside/)
  assert.match(text, /Do not simplify containment/)
})

test('AGENTS.md names the hot modules that must stay one-behaviour PRs', () => {
  assert.match(text, /^## Hot modules\b/m)
  assert.match(text, /agent-manager\.ts/)
  assert.match(text, /useGronk\.ts/)
  assert.match(text, /acp\/client\.ts/)
  assert.match(text, /store\.ts/)
})

test('AGENTS.md no longer points agents at a CLAUDE.md outside the repo', () => {
  assert.doesNotMatch(text, /one level above this repo/)
  assert.doesNotMatch(text, /CLAUDE\.md/)
})
