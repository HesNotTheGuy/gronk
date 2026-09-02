import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Public README screenshots must be the shots-harness fixtures, not a live
 * Gronk profile. Home is a landing pad (Chat, Build, heatmap); folder and
 * session catalogs live on Build / Chat.
 *
 * These tests fail if Home grows those lists back, if the harness starts
 * inventing real-looking personal paths, or if docs/images/ drifts from the
 * visual readme-* baselines that capture.js actually photographs.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')

test('HomeView is still a landing pad: no Folders or Build sessions headings', () => {
  const src = read('src/components/HomeView.tsx')
  assert.match(src, /Landing pad/)
  // JSX text, not the sentence "Your folders and sessions live there".
  assert.doesNotMatch(src, />Folders</)
  assert.doesNotMatch(src, />Build sessions</)
  assert.doesNotMatch(src, /browse-grid/)
  assert.doesNotMatch(src, /workspace-folder-list/)
})

test('the shots harness only advertises the filler /home/dev/projects trio', () => {
  const shots = read('src/__shots.tsx')
  assert.match(shots, /cwd: '\/home\/dev\/projects\/orbital-api'/)
  assert.match(shots, /cwd: '\/home\/dev\/projects\/flux-dashboard'/)
  assert.match(shots, /cwd: '\/home\/dev\/projects\/packet-relay'/)
  assert.deepEqual(
    [...shots.matchAll(/cwd: '([^']+)'/g)].filter((m) => m[1].includes('projects')).map((m) => m[1]),
    [
      '/home/dev/projects/orbital-api',
      '/home/dev/projects/flux-dashboard',
      '/home/dev/projects/packet-relay'
    ]
  )
  assert.doesNotMatch(shots, /\/Users\//)
  assert.doesNotMatch(shots, /HesNotTheGuy/)
})

test('README Home caption is Chat/Build/heatmap, not a folders catalog', () => {
  const readme = read('README.md')
  const home = readme.match(/!\[([^\]]+)\]\(docs\/images\/home\.png\)/)
  assert.ok(home, 'README no longer embeds docs/images/home.png')
  const alt = home[1]
  assert.match(alt, /heatmap/i)
  assert.match(alt, /Chat/i)
  assert.match(alt, /Build/i)
  assert.doesNotMatch(alt, /recent projects/i)
  assert.doesNotMatch(alt, /Folders/)
  assert.doesNotMatch(alt, /Build sessions/)
})

test('published README shots are the fixture readme-* baselines, not a live profile', () => {
  const pairs: Array<[string, string]> = [
    ['docs/images/home.png', 'tests/visual/baseline/readme-home.png'],
    ['docs/images/build.png', 'tests/visual/baseline/readme-build.png']
  ]
  for (const [published, baseline] of pairs) {
    const a = fs.readFileSync(path.join(ROOT, published))
    const b = fs.readFileSync(path.join(ROOT, baseline))
    assert.equal(
      a.equals(b),
      true,
      `${published} is not ${baseline}: copy the fixture shot, do not paste a live Gronk window`
    )
  }
})
