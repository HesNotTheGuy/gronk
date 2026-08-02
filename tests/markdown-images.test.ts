import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { mount, flush } from './helpers/render'
import { installFakeBridge } from './helpers/gronk-api'
import { Markdown } from '../src/components/Markdown'

/**
 * A remote image in model output must render as a LINK showing its destination
 * host, never as an <img>, so nothing is fetched until the user chooses.
 *
 * v0.1.6 shipped that rule as `/^https?:\/\//i`, which is not what a URL parser
 * considers remote. Every case below reached either the local-image reader or a
 * bare <img> instead of the link, and none of it was visible from reading the
 * component: react-markdown percent-encodes whitespace in a destination and
 * drops unsafe schemes before the component ever sees the value, so the only
 * way to know what a given markdown string produces is to render it.
 *
 * Under the app's CSP (`img-src 'self' data: blob:`) a missed remote path fails
 * closed and loads nothing, so the ones that landed on <img> were cosmetic. The
 * ones routed to the local-image reader were not quite: that reader stats every
 * candidate path before the jail check rejects it, and on Windows
 * `//host/share/x.png` normalises to a UNC path, which makes the stat an
 * outbound SMB connection to a host the model picked.
 */

interface Rendered {
  html: string
  /** Every path handed to the local-image IPC while rendering. */
  reads: string[]
  query: (selector: string) => Element | null
  queryAll: (selector: string) => Element[]
  done: () => void
}

async function render(
  text: string,
  options: { suppressImagePaths?: string[]; dataUrl?: string } = {}
): Promise<Rendered> {
  const reads: string[] = []
  const bridge = installFakeBridge({
    readLocalImage: async (path: string) => {
      reads.push(path)
      return options.dataUrl
        ? { dataUrl: options.dataUrl, path, mimeType: 'image/png' }
        : { error: 'Image not found' }
    }
  })
  const mounted = await mount(
    createElement(Markdown, { text, suppressImagePaths: options.suppressImagePaths })
  )
  // The local-image branch loads through an async effect, so its DOM only
  // exists after the microtask queue drains.
  await flush()
  return {
    html: mounted.container.innerHTML,
    reads,
    query: mounted.query,
    queryAll: mounted.queryAll,
    done: () => {
      mounted.unmount()
      bridge.restore()
    }
  }
}

/** The whole rule in one assertion: a labelled link, no fetch of any kind. */
async function assertOfferedAsLink(markdown: string, expectedHost: string): Promise<void> {
  const r = await render(markdown)
  try {
    const link = r.query('a.md-remote-img')
    assert.ok(link, `no remote-image link for ${JSON.stringify(markdown)}: ${r.html}`)
    assert.equal(
      r.query('a.md-remote-img .md-remote-img-host')?.textContent,
      expectedHost,
      `wrong host chip for ${JSON.stringify(markdown)}`
    )
    assert.equal(r.query('img'), null, `an <img> was rendered for ${JSON.stringify(markdown)}`)
    assert.deepEqual(
      r.reads,
      [],
      `a remote src was sent to the local-image reader: ${JSON.stringify(r.reads)}`
    )
  } finally {
    r.done()
  }
}

// ── The shape the rule was already written for ──────────────────────

test('a plain https image is offered as a link naming its host', async () => {
  await assertOfferedAsLink('![shot](https://example.com/x.png)', 'example.com')
})

test('the label is the alt text, and falls back to a word rather than the URL', async () => {
  const r = await render('![a diagram](https://example.com/x.png)')
  try {
    assert.equal(r.query('.md-remote-img-label')?.textContent, 'a diagram')
  } finally {
    r.done()
  }
  const bare = await render('![](https://example.com/x.png)')
  try {
    assert.equal(bare.query('.md-remote-img-label')?.textContent, 'Image')
  } finally {
    bare.done()
  }
})

// ── Forms a URL parser calls remote and `/^https?:\/\//` did not ────

test('an uppercase scheme is remote', async () => {
  await assertOfferedAsLink('![shot](HTTPS://example.com/x.png)', 'example.com')
  await assertOfferedAsLink('![shot](HTTP://example.com/x.png)', 'example.com')
})

/*
 * The one that mattered. `//host/x.png` has an image extension, so
 * looksLikeImagePath claimed it and the local-image reader resolved it — on
 * Windows into `\\host\x.png`, a UNC path that fs.existsSync probes over the
 * network before any allow-list check runs.
 */
test('a protocol-relative src is remote, and never reaches the local-image reader', async () => {
  await assertOfferedAsLink('![shot](//example.com/x.png)', 'example.com')
  await assertOfferedAsLink('![shot](///example.com/x.png)', 'example.com')
})

test('a protocol-relative src with no image extension is a link, not a broken <img>', async () => {
  // This one used to reach the final <img> fallback, where the CSP blocked it
  // and the user got a broken-image icon instead of a labelled destination.
  await assertOfferedAsLink('![shot](//example.com/track)', 'example.com')
})

test('a query string does not stop a remote src being recognised', async () => {
  // looksLikeImagePath rejects any src containing `?`, so this fell through to
  // <img> — exactly the src shape a tracking pixel has.
  await assertOfferedAsLink('![shot](//example.com/x.png?id=abc)', 'example.com')
  await assertOfferedAsLink('![shot](https://example.com/x.png?id=abc)', 'example.com')
})

test('a scheme without its double slash is remote', async () => {
  // `https:host/x` and `https:/host/x` resolve to the same origin as
  // `https://host/x`, so matching the slashes rather than the colon missed them
  // and the reader was handed a URL to look for on disk.
  await assertOfferedAsLink('![shot](https:example.com/x.png)', 'example.com')
  await assertOfferedAsLink('![shot](https:/example.com/x.png)', 'example.com')
})

test('userinfo in the URL cannot disguise the host', async () => {
  await assertOfferedAsLink('![shot](https://example.com@evil.example/x.png)', 'evil.example')
})

// ── Whitespace ──────────────────────────────────────────────────────

/*
 * Whitespace never arrives as whitespace. A destination in <> may contain
 * spaces and tabs, and the markdown parser percent-encodes them, so ` //host/x`
 * reaches the component as the literal `%20//host/x`. trim() sees nothing to
 * trim and the scheme test sees no scheme.
 */
test('percent-encoded leading whitespace does not hide a remote src', async () => {
  await assertOfferedAsLink('![shot](< //example.com/x.png>)', 'example.com')
  await assertOfferedAsLink('![shot](<\t//example.com/x.png>)', 'example.com')
  await assertOfferedAsLink('![shot](< //example.com/track>)', 'example.com')
})

test('trailing whitespace does not stop a remote src being recognised', async () => {
  await assertOfferedAsLink('![shot](<//example.com/x.png >)', 'example.com')
})

test('whitespace inside the host still yields a host-shaped chip, not the whole URL', async () => {
  // The URL parser rejects this outright, and printing the entire URL in a chip
  // sized for a hostname defeats the point of showing one.
  const r = await render('![shot](<https://exa\tmple.com/x.png>)')
  try {
    assert.ok(r.query('a.md-remote-img'), r.html)
    assert.equal(r.query('.md-remote-img-host')?.textContent, 'exa%09mple.com')
    assert.equal(r.query('img'), null)
    assert.deepEqual(r.reads, [])
  } finally {
    r.done()
  }
})

/*
 * Whitespace BEFORE a scheme is a different case: `%20https://host` has a colon
 * that is not a scheme, so react-markdown's own sanitiser blanks the URL and
 * nothing renders at all. Asserted as an invariant rather than as "renders
 * nothing", so that if a react-markdown upgrade stops blanking it, the src has
 * to arrive at the link branch rather than at an <img>.
 */
test('whitespace before a scheme never produces an <img> or a disk read', async () => {
  for (const md of ['![shot](< https://example.com/x.png>)', '![shot](<\thttps://example.com/x.png>)']) {
    const r = await render(md)
    try {
      assert.equal(r.query('img'), null, `an <img> was rendered for ${JSON.stringify(md)}`)
      assert.deepEqual(r.reads, [], `a disk read for ${JSON.stringify(md)}`)
      const link = r.query('a')
      if (link) assert.ok(link.classList.contains('md-remote-img'), r.html)
    } finally {
      r.done()
    }
  }
})

// ── data: ───────────────────────────────────────────────────────────

/*
 * A data: URL must never take the link branch. There is no host to name — the
 * chip would be the base64 payload — and no server to notify, because the bytes
 * are already in the message. react-markdown blocks data: in markdown outright,
 * so the branch that matters is the one in the component, which returns before
 * the remote check is reached.
 */
test('a data: URL in markdown is never offered as a remote link', async () => {
  const r = await render('![shot](data:image/png;base64,iVBORw0KGgo=)')
  try {
    assert.equal(r.query('a.md-remote-img'), null, `data: reached the link branch: ${r.html}`)
    assert.deepEqual(r.reads, [])
  } finally {
    r.done()
  }
})

test('a generated image still renders inline from the data: URL the reader returns', async () => {
  const r = await render('![a cat](images/1.jpg)', { dataUrl: 'data:image/png;base64,iVBORw0KGgo=' })
  try {
    assert.deepEqual(r.reads, ['images/1.jpg'])
    const img = r.query('img.local-image-img')
    assert.ok(img, `generated image did not render: ${r.html}`)
    assert.equal(img.getAttribute('src'), 'data:image/png;base64,iVBORw0KGgo=')
    assert.equal(r.query('a.md-remote-img'), null)
  } finally {
    r.done()
  }
})

// ── Local paths, unchanged ──────────────────────────────────────────

test('local image paths still go to the local-image reader', async () => {
  for (const [md, expected] of [
    ['![shot](images/1.jpg)', 'images/1.jpg'],
    ['![shot](./images/1.jpg)', './images/1.jpg'],
    ['![shot](/home/u/shot.png)', '/home/u/shot.png']
  ]) {
    const r = await render(md)
    try {
      assert.deepEqual(r.reads, [expected], `${md} -> ${r.html}`)
      assert.equal(r.query('a.md-remote-img'), null, `${md} was treated as remote`)
    } finally {
      r.done()
    }
  }
})

/*
 * A drive letter is a colon followed by a slash, which is the exact shape a
 * scheme test can mistake for a scheme. It does not reach that test: react-
 * markdown reads `C:` as an unknown scheme and blanks the destination, so an
 * absolute Windows path never arrives through markdown at all. Those images
 * reach the UI through tool cards instead. Recorded so the next person to look
 * at scheme detection knows this case is decided upstream, not here.
 */
test('an absolute Windows path is blanked upstream and is never treated as remote', async () => {
  const r = await render('![shot](C:/Users/u/shot.png)')
  try {
    assert.equal(r.query('a.md-remote-img'), null, `a drive letter read as a scheme: ${r.html}`)
    assert.deepEqual(r.reads, [])
  } finally {
    r.done()
  }
})

test('an unrecognised relative src still falls back to a plain img', async () => {
  const r = await render('![shot](foo/bar)')
  try {
    const img = r.query('img.md-img')
    assert.ok(img, r.html)
    assert.equal(img.getAttribute('src'), 'foo/bar')
    assert.deepEqual(r.reads, [])
  } finally {
    r.done()
  }
})

test('no fallback img is ever given a src that could reach a host', async () => {
  // The broad sweep: whatever else changes, nothing that addresses a host may
  // end up on an element the renderer fetches.
  const sources = [
    'https://example.com/x.png',
    'HTTPS://example.com/x.png',
    'https:example.com/x.png',
    '//example.com/x.png',
    '//example.com/track',
    '///example.com/x.png',
    '//example.com/x.png?id=abc',
    '< //example.com/x.png>',
    '<//example.com/x.png >'
  ]
  for (const src of sources) {
    const r = await render(`![shot](${src})`)
    try {
      for (const img of r.queryAll('img')) {
        const value = img.getAttribute('src') || ''
        assert.ok(
          !/^\s*(?:%(?:09|0a|0b|0c|0d|20))*(?:https?:|\/\/)/i.test(value),
          `img src can reach a host: ${value} (from ${src})`
        )
      }
    } finally {
      r.done()
    }
  }
})

// ── Suppression ─────────────────────────────────────────────────────

test('an image already shown in a tool card is still collapsed to a caption', async () => {
  const r = await render('![a cat](images/1.jpg)', {
    suppressImagePaths: ['/home/u/session/images/1.jpg']
  })
  try {
    assert.ok(r.query('.md-image-ref'), r.html)
    assert.deepEqual(r.reads, [])
  } finally {
    r.done()
  }
})

test('a remote URL is not collapsed by a suppressed local file with the same name', async () => {
  // Suppression matches on basename, so `//evil.example/1.jpg` matched a local
  // `images/1.jpg` and rendered as that file's caption: the user is told they
  // have already seen this, about a URL they have never seen.
  const r = await render('![a cat](//evil.example/1.jpg)', {
    suppressImagePaths: ['/home/u/session/images/1.jpg']
  })
  try {
    assert.equal(r.query('.md-image-ref'), null, `remote src was collapsed as seen: ${r.html}`)
    assert.equal(r.query('.md-remote-img-host')?.textContent, 'evil.example')
  } finally {
    r.done()
  }
})

// ── Links, which take a second route into the local-image reader ────

test('a remote href that looks like an image stays an ordinary link', async () => {
  // looksLikeImagePath only declines a LOWERCASE http/https prefix, so these
  // were treated as generated images and handed to the local-image reader.
  for (const href of [
    'HTTPS://example.com/x.png',
    '//example.com/x.png',
    'https:example.com/x.png',
    'https://example.com/x.png'
  ]) {
    const r = await render(`[x](${href})`)
    try {
      assert.deepEqual(r.reads, [], `${href} was read from disk`)
      const link = r.query('a')
      assert.ok(link, `${href} rendered no link: ${r.html}`)
      assert.equal(link.textContent, 'x')
      assert.equal(r.query('img'), null, `${href} rendered an img`)
    } finally {
      r.done()
    }
  }
})

test('a link to a generated image still renders the image', async () => {
  // Grok writes [images/1.jpg](images/1.jpg); that has to keep working.
  const r = await render('[images/1.jpg](images/1.jpg)', {
    dataUrl: 'data:image/png;base64,iVBORw0KGgo='
  })
  try {
    assert.deepEqual(r.reads, ['images/1.jpg'])
    assert.ok(r.query('img.local-image-img'), r.html)
  } finally {
    r.done()
  }
})
