import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { listSavedWorkflows } from '../electron/main/workflows'
import { savedWorkflowCommand, workflowManageCommand } from '../src/lib/workflows'

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gronk-wf-'))
}

function writeRhai(dir: string, filename: string, body: string): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, filename), body)
}

test('the builtin deep-research row is always first', async () => {
  const userDir = path.join(tmp(), 'missing')
  const list = await listSavedWorkflows({ userDir })
  assert.equal(list.length, 1)
  assert.equal(list[0].name, 'deep-research')
  assert.equal(list[0].source, 'builtin')
  assert.equal(list[0].slash, '/deep-research')
  assert.equal(list[0].path, 'built-in')
})

test('user and project rhai files are listed with source and display path', async () => {
  const home = tmp()
  const project = tmp()
  const userDir = path.join(home, 'workflows')
  writeRhai(
    userDir,
    'mine.rhai',
    'meta.name = "mine";\nmeta.description = "Personal";\n'
  )
  writeRhai(
    path.join(project, '.grok', 'workflows'),
    'review-changes.rhai',
    'meta.name = "review-changes";\nmeta.description = "Team review";\n'
  )

  const list = await listSavedWorkflows({ userDir, projectRoot: project })
  const names = list.map((w) => w.name)
  assert.deepEqual(names, ['deep-research', 'mine', 'review-changes'])
  const mine = list.find((w) => w.name === 'mine')
  const review = list.find((w) => w.name === 'review-changes')
  assert.equal(mine?.source, 'user')
  assert.equal(mine?.path, '~/.grok/workflows/mine.rhai')
  assert.equal(mine?.slash, '/mine')
  assert.equal(review?.source, 'project')
  assert.equal(review?.path, '.grok/workflows/review-changes.rhai')
})

test('a missing meta.name falls back to a safe filename stem', async () => {
  const userDir = path.join(tmp(), 'workflows')
  writeRhai(userDir, 'audit-routes.rhai', 'fn main() { complete("ok"); }\n')
  const list = await listSavedWorkflows({ userDir })
  assert.ok(list.some((w) => w.name === 'audit-routes' && w.source === 'user'))
})

test('project shadows user of the same name, and builtin shadows both', async () => {
  const home = tmp()
  const project = tmp()
  const userDir = path.join(home, 'workflows')
  writeRhai(userDir, 'review-changes.rhai', 'meta.name = "review-changes";\n')
  writeRhai(userDir, 'deep-research.rhai', 'meta.name = "deep-research";\n')
  writeRhai(
    path.join(project, '.grok', 'workflows'),
    'review-changes.rhai',
    'meta.name = "review-changes";\nmeta.description = "Project wins";\n'
  )

  const list = await listSavedWorkflows({ userDir, projectRoot: project })
  const reviews = list.filter((w) => w.name === 'review-changes')
  assert.equal(reviews.length, 1)
  assert.equal(reviews[0].source, 'project')
  assert.equal(reviews[0].description, 'Project wins')
  const deep = list.filter((w) => w.name === 'deep-research')
  assert.equal(deep.length, 1)
  assert.equal(deep[0].source, 'builtin')
})

test('a sibling workflows-evil directory is not a prefix escape into the catalog', async () => {
  const project = tmp()
  writeRhai(
    path.join(project, '.grok', 'workflows'),
    'ok.rhai',
    'meta.name = "ok";\n'
  )
  writeRhai(
    path.join(project, '.grok', 'workflows-evil'),
    'secret.rhai',
    'meta.name = "secret";\n'
  )
  const list = await listSavedWorkflows({
    userDir: path.join(tmp(), 'workflows'),
    projectRoot: project
  })
  assert.equal(
    list.some((w) => w.name === 'secret'),
    false,
    'listed a file from .grok/workflows-evil'
  )
  assert.ok(list.some((w) => w.name === 'ok'))
})

test('a symlink that points outside the workflows directory is skipped', async (t) => {
  const project = tmp()
  const outside = path.join(tmp(), 'outside.rhai')
  fs.writeFileSync(outside, 'meta.name = "escaped";\n')
  const wfDir = path.join(project, '.grok', 'workflows')
  fs.mkdirSync(wfDir, { recursive: true })
  try {
    fs.symlinkSync(outside, path.join(wfDir, 'escaped.rhai'))
  } catch (err) {
    t.skip(`symlink not permitted: ${err instanceof Error ? err.message : String(err)}`)
    return
  }

  const list = await listSavedWorkflows({
    userDir: path.join(tmp(), 'workflows'),
    projectRoot: project
  })
  assert.equal(
    list.some((w) => w.name === 'escaped'),
    false,
    'followed a symlink out of the project jail'
  )
})

test('flag-shaped and traversal filenames are not listed', async () => {
  const userDir = path.join(tmp(), 'workflows')
  writeRhai(userDir, '-evil.rhai', 'meta.name = "ok-name";\n')
  writeRhai(userDir, '..rhai', 'meta.name = "dots";\n')
  const list = await listSavedWorkflows({ userDir })
  assert.deepEqual(
    list.map((w) => w.name),
    ['deep-research']
  )
})

test('composer helpers emit the slash lines the CLI documents', () => {
  assert.equal(workflowManageCommand('runs'), '/workflow runs')
  assert.equal(workflowManageCommand('pause'), '/workflow pause ')
  assert.equal(workflowManageCommand('resume'), '/workflow resume ')
  assert.equal(workflowManageCommand('stop'), '/workflow stop ')
  assert.equal(workflowManageCommand('save'), '/workflow save ')
  assert.equal(savedWorkflowCommand('review-changes'), '/review-changes ')
})
