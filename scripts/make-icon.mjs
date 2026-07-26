/**
 * Generates the app icon set from code — no image tooling, no dependencies.
 *
 * The repo takes no new npm packages (SECURITY.md), and there is no ImageMagick
 * or sharp available, so the icon is drawn pixel by pixel and encoded with
 * node's built-in zlib. Regenerate with `npm run icon` after changing the
 * design constants below.
 *
 * Design: a rim-lit stone in white phosphor. Deliberately not a terminal prompt:
 * OpenAI Codex already uses >_ for an AI coding tool, so that glyph would read
 * as derivative here.
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

/** Distance from a point to a line segment — gives strokes with round caps. */
function segmentDistance(px, py, ax, ay, bx, by) {
  const vx = bx - ax
  const vy = by - ay
  const wx = px - ax
  const wy = py - ay
  const len2 = vx * vx + vy * vy
  const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, (wx * vx + wy * vy) / len2))
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy))
}

/** Ray-casting point-in-polygon. Vertices are [x, y] pairs. */
function pointInPolygon(px, py, poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** Distance to the nearest polygon edge, unsigned. */
function polygonEdgeDistance(px, py, poly) {
  let best = Infinity
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const d = segmentDistance(px, py, poly[j][0], poly[j][1], poly[i][0], poly[i][1])
    if (d < best) best = d
  }
  return best
}

/**
 * An irregular stone, in normalised units (multiplied by size at draw time).
 * Asymmetric on purpose — a symmetric outline reads as a gem or a shield, not a
 * rock somebody picked up.
 */
const ROCK = [
  [-0.335, 0.055],
  [-0.25, -0.15],
  [-0.05, -0.275],
  [0.145, -0.22],
  [0.325, -0.02],
  [0.265, 0.185],
  [0.02, 0.265],
  [-0.235, 0.215]
]

/**
 * Fracture planes, not spokes. Radiating every seam from one interior point made
 * a pie chart, and two near-parallel seams read as stripes. One plane cutting
 * clean across with a second branching off it splits the body into three unequal
 * faces, which is how stone actually breaks.
 */
const ROCK_MAIN_SEAM = [[-0.05, -0.275], [0.245, 0.21]]
const ROCK_BRANCH_SEAM = [[0.075, -0.035], [-0.245, 0.19]]
const ROCK_FACETS = [ROCK_MAIN_SEAM, ROCK_BRANCH_SEAM]

/** Which side of a line a point falls on. Sign only; magnitude is unused. */
function sideOfLine(px, py, [ax, ay], [bx, by]) {
  return (bx - ax) * (py - ay) - (by - ay) * (px - ax)
}

/**
 * Per-face brightness, implying a single light source up and to the left. Flat
 * fill made the shape read as a polygon; it is the brightness *step* across a
 * seam that makes it read as a solid object with faces.
 */
function faceShade(nx, ny) {
  // Positive side of the main seam is the upper-left of the body — checked
  // numerically, not by eye, because the first version lit the wrong face.
  if (sideOfLine(nx, ny, ROCK_MAIN_SEAM[0], ROCK_MAIN_SEAM[1]) > 0) {
    return sideOfLine(nx, ny, ROCK_BRANCH_SEAM[0], ROCK_BRANCH_SEAM[1]) > 0 ? 0.44 : 0.28
  }
  return 0.15
}

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4)
  const c = (size - 1) / 2
  // One pixel at 256px, scaled — keeps edges equally soft at every size rather
  // than crisp when large and blurry when small.
  const aa = size / 256

  const tileHalf = size * 0.5
  const tileRadius = size * 0.22

  // A rock, lit by phosphor.
  //
  // NOT a `>_` prompt. OpenAI Codex already uses that glyph for an AI coding
  // tool, so a prompt mark here would read as derivative of a direct competitor
  // no matter how the tile around it is styled.
  //
  // Optical sizing: what reads at 256px turns to mush at 16px. The seams are the
  // first thing to go — below ~40px they are thinner than a pixel and just
  // dirty the silhouette — leaving a solid stone, which still reads.
  const small = 1 - Math.min(1, Math.max(0, (size - 16) / 48))
  const edgeHalf = size * (0.016 + 0.020 * small)
  const seamHalf = size * (0.011 + 0.010 * small)
  const showSeams = size >= 40
  // Faces dim together at small sizes so the silhouette stays readable once the
  // seams drop out and the shading has nothing left to describe.
  const bodyScale = 1 - 0.25 * small

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - c
      const dy = y - c

      // Tile: opaque black body, antialiased rounded corners.
      const tileD = roundedRectDistance(dx, dy, tileHalf, tileHalf, tileRadius)
      const tileA = 1 - smoothstep(-aa, aa, tileD)
      if (tileA <= 0) continue

      // Work in normalised units so the polygon constants are size-independent.
      const nx = dx / size
      const ny = dy / size
      const naa = aa / size

      const inside = pointInPolygon(nx, ny, ROCK)
      const edgeD = polygonEdgeDistance(nx, ny, ROCK)

      const body = inside ? faceShade(nx, ny) * bodyScale : 0
      const edge = 1 - smoothstep(edgeHalf / size - naa, edgeHalf / size + naa, edgeD)

      let seams = 0
      if (showSeams && inside) {
        let best = Infinity
        for (const [a, b] of ROCK_FACETS) {
          const d = segmentDistance(nx, ny, a[0], a[1], b[0], b[1])
          if (d < best) best = d
        }
        // Seams are dimmer than the rim: they are creases catching light, not
        // the lit edge itself, and at full brightness they shatter the shape.
        seams = 0.62 * (1 - smoothstep(seamHalf / size - naa, seamHalf / size + naa, best))
      }

      // Brightest element wins; summing overlapping alpha blows out to a blob.
      const lit = Math.min(1, Math.max(Math.max(body, edge), seams))

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
