const fs = require('fs')
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="1500">' +
  '<rect width="2400" height="1500" fill="#0e1112"/>' +
  '<circle cx="820" cy="750" r="380" fill="#eafffb" opacity="0.85"/>' +
  '<text x="1300" y="780" fill="#eafffb" font-family="monospace" font-size="96">wide image</text>' +
  '</svg>'
const big = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')

const f = 'src/__shots.tsx'
let s = fs.readFileSync(f, 'utf8')
const before = s

const anchor =
  '  readLocalImage: async (p: string) => ({\n' +
  '    // Mirrors the real handler, which reads the file and returns a data URL.\n' +
  '    dataUrl:\n'
if (!s.includes(anchor)) { console.error('anchor not found'); process.exit(1) }

s = s.replace(
  anchor,
  '  readLocalImage: async (p: string) => ({\n' +
  '    // Mirrors the real handler, which reads the file and returns a data URL.\n' +
  '    // The lightbox scenario needs an image LARGER than the window, or the\n' +
  '    // max-width cap never binds and the overflow it exists to prevent cannot\n' +
  '    // be reproduced at all.\n' +
  '    dataUrl:\n' +
  "      SCENARIO === 'lightbox'\n" +
  '        ? BIG_IMAGE\n' +
  '        :\n'
)

s = s.replace(
  'const api: Record<string, unknown> = {',
  '/** Deliberately larger than any window the harness renders at. */\n' +
  "const BIG_IMAGE =\n  '" + big + "'\n\n" +
  'const api: Record<string, unknown> = {'
)

if (s === before) { console.error('nothing changed'); process.exit(1) }
fs.writeFileSync(f, s)
console.log('patched')
