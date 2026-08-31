/**
 * AGENTS.md is the control surface every coding agent loads. If the hard-rule
 * section is deleted or renamed away, Claude / Grok / Cursor stop seeing the
 * same non-negotiables — which is how "cleanup" PRs reopen IPC and permission
 * holes. This file pins the headings and the load-bearing phrases.
 */
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
