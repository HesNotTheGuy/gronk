/**
 * ImageGallery hard-caps how many LocalImage nodes mount. The constant alone is
 * not a test: raising MAX_GALLERY_IMAGES to 999 would leave every unit test
 * green. Pin the rendered behaviour — count of tiles and the overflow chip.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { mount, flush } from './helpers/render'
import { installFakeBridge } from './helpers/gronk-api'
import { ImageGallery, MAX_GALLERY_IMAGES } from '../src/components/LocalImage'
import type { ImageRef } from '../src/lib/image-refs'

function refs(n: number): ImageRef[] {
  return Array.from({ length: n }, (_, i) => ({
    path: `C:\\Users\\sam\\.grok\\sessions\\x\\images\\${i + 1}.jpg`,
    label: `images/${i + 1}.jpg`
  }))
}

test('MAX_GALLERY_IMAGES is the exact render budget, not a soft upper bound', async () => {
  // A silent raise of the constant would make "more than the cap" still show
  // every tile and drop the overflow chip. Assert the real numbers.
  assert.equal(MAX_GALLERY_IMAGES, 8)

  const extra = 5
  const images = refs(MAX_GALLERY_IMAGES + extra)
  const bridge = installFakeBridge({
    readLocalImage: async (path: string) => ({
      dataUrl: 'data:image/png;base64,aa',
      path,
      mimeType: 'image/png'
    })
  })
  const mounted = await mount(createElement(ImageGallery, { images }))
  await flush()
  try {
    const tiles = mounted.queryAll('.local-image')
    assert.equal(
      tiles.length,
      MAX_GALLERY_IMAGES,
      `expected exactly ${MAX_GALLERY_IMAGES} tiles, got ${tiles.length}`
    )

    const more = mounted.query('.image-gallery-more')
    assert.ok(more, 'overflow chip missing when the list exceeds the cap')
    assert.equal(more.textContent?.trim(), `+${extra} more`)

    // Exactly at the cap: no overflow chip, all tiles present.
    await mounted.rerender(createElement(ImageGallery, { images: refs(MAX_GALLERY_IMAGES) }))
    await flush()
    assert.equal(mounted.queryAll('.local-image').length, MAX_GALLERY_IMAGES)
    assert.equal(mounted.query('.image-gallery-more'), null)
  } finally {
    mounted.unmount()
    bridge.restore()
  }
})
