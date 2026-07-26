/**
 * Generates the app icon set from code — no image tooling, no dependencies.
 *
 * The repo takes no new npm packages (SECURITY.md), and there is no ImageMagick
 * or sharp available, so the icon is drawn pixel by pixel and encoded with
 * node's built-in zlib. Regenerate with `npm run icon` after changing the
 * design constants below.
 *
 * Design: a white-phosphor intensifier aperture — a glowing core inside a thin
 * ring. Deliberately not a terminal prompt: OpenAI Codex already uses >_ for an
 * AI coding tool, so that glyph would read as derivative here.
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build')

// Phosphor white, matching --ignite in styles.css.
const PHOSPHOR = [234, 255, 251]
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
const PNG_SIZE = 1024

// ── PNG encoding ───────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** RGBA pixel buffer -> PNG. */
function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // truecolour + alpha
  // 10,11,12 = deflate / adaptive filtering / no interlace, all zero

  // Each scanline is prefixed with its filter type. Filter 0 (none) keeps this
  // encoder trivial; the images are small and compression is not the point.
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// ── Drawing ────────────────────────────────────────────────────────

/** Smooth 0..1 ramp, used for antialiased edges and bloom falloff. */
function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/** Signed distance to a rounded rectangle centred on the origin. */
function roundedRectDistance(px, py, halfW, halfH, radius) {
  const qx = Math.abs(px) - (halfW - radius)
  const qy = Math.abs(py) - (halfH - radius)
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
  return outside + Math.min(Math.max(qx, qy), 0) - radius
}

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4)
  const c = (size - 1) / 2
  // One pixel at 256px, scaled — keeps edges equally soft at every size rather
  // than crisp when large and blurry when small.
  const aa = size / 256

  const tileHalf = size * 0.5
  const tileRadius = size * 0.22

  // An intensifier aperture: thin ring, glowing core, nothing else.
  //
  // NOT a `>_` prompt. OpenAI Codex already uses that glyph for an AI coding
  // tool, so a prompt mark here would read as derivative of a direct competitor
  // no matter how the tile around it is styled.
  // Optical sizing: proportions that look right at 256px fall apart at 16px,
  // where a 0.028 ring is under half a pixel and smears into a grey blob. The
  // ring thickens and the core grows as the canvas shrinks, so the mark stays
  // readable in a taskbar instead of only in a preview.
  const small = 1 - Math.min(1, Math.max(0, (size - 16) / 48))
  const ringRadius = size * (0.315 - 0.025 * small)
  const ringHalf = size * (0.028 + 0.032 * small)
  const coreRadius = size * (0.085 + 0.05 * small)
  // Bloom must die BEFORE the ring. Letting it reach across filled the middle
  // with flat grey and the whole thing read as a camera lens.
  const bloomRadius = size * (0.21 - 0.03 * small)

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - c
      const dy = y - c

      // Tile: opaque black body, antialiased rounded corners.
      const tileD = roundedRectDistance(dx, dy, tileHalf, tileHalf, tileRadius)
      const tileA = 1 - smoothstep(-aa, aa, tileD)
      if (tileA <= 0) continue

      const r = Math.hypot(dx, dy)

      const ring = 1 - smoothstep(ringHalf - aa, ringHalf + aa, Math.abs(r - ringRadius))
      const core = 1 - smoothstep(coreRadius - aa, coreRadius + aa, r)
      // Falls to nothing well inside the ring, so the gap between core and ring
      // stays black and the core reads as a light source rather than a disc.
      const bloom = 0.30 * (1 - smoothstep(coreRadius, bloomRadius, r))

      // Brightest element wins; summing overlapping alpha blows out to a blob.
      const lit = Math.min(1, Math.max(Math.max(ring, core), bloom))

      const i = (y * size + x) * 4
      rgba[i] = Math.round(PHOSPHOR[0] * lit)
      rgba[i + 1] = Math.round(PHOSPHOR[1] * lit)
      rgba[i + 2] = Math.round(PHOSPHOR[2] * lit)
      rgba[i + 3] = Math.round(255 * tileA)
    }
  }
  return rgba
}

// ── ICO container ──────────────────────────────────────────────────

/**
 * ICO is a directory of images; each entry here embeds a whole PNG, which every
 * Windows version since Vista reads and which avoids hand-rolling BMP+mask.
 */
function encodeIco(pngs) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(pngs.length, 4)

  const entries = []
  let offset = 6 + pngs.length * 16
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16)
    e[0] = size >= 256 ? 0 : size // 0 means 256
    e[1] = size >= 256 ? 0 : size
    e[2] = 0 // palette
    e[3] = 0
    e.writeUInt16LE(1, 4) // colour planes
    e.writeUInt16LE(32, 6) // bits per pixel
    e.writeUInt32LE(data.length, 8)
    e.writeUInt32LE(offset, 12)
    entries.push(e)
    offset += data.length
  }

  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)])
}

// ── Emit ───────────────────────────────────────────────────────────

mkdirSync(OUT_DIR, { recursive: true })

const icoParts = ICO_SIZES.map((size) => ({ size, data: encodePng(drawIcon(size), size) }))
writeFileSync(path.join(OUT_DIR, 'icon.ico'), encodeIco(icoParts))
console.log(`icon.ico   ${ICO_SIZES.join(', ')}`)

writeFileSync(path.join(OUT_DIR, 'icon.png'), encodePng(drawIcon(PNG_SIZE), PNG_SIZE))
console.log(`icon.png   ${PNG_SIZE}x${PNG_SIZE}`)

// Linux packaging wants a directory of sized PNGs.
const iconsDir = path.join(OUT_DIR, 'icons')
mkdirSync(iconsDir, { recursive: true })
for (const size of [16, 32, 48, 64, 128, 256, 512]) {
  writeFileSync(path.join(iconsDir, `${size}x${size}.png`), encodePng(drawIcon(size), size))
}
console.log('icons/     16..512 png')
