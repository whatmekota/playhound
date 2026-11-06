import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import path from 'node:path'
import { Resvg } from '@resvg/resvg-js'

/**
 * App icons from public/favicon.svg, so the brand mark has one source.
 *
 * Writes icon.png (512, for the window and electron-builder's Linux icon),
 * icon.ico (16–256, PNG-compressed entries, which every Windows since Vista
 * reads) and icon-1024.png, which electron-builder turns into the macOS .icns.
 */

/**
 * macOS icons leave a margin round the tile (824 of 1024 px in Apple's grid),
 * where Windows and Linux ones fill the canvas. The mark's tile spans 2–62 of
 * the SVG's 64 units, so widen the view box until those 60 units are 824/1024.
 */
function withMacMargin(svg) {
  const side = 60 * 1024 / 824
  const at = 32 - side / 2
  return Buffer.from(String(svg).replace(/viewBox="0 0 64 64"/, `viewBox="${at} ${at} ${side} ${side}"`))
}

const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]

function render(svg, size) {
  return new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng()
}

function ico(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // 1 = icon
  header.writeUInt16LE(images.length, 4)

  const entries = []
  let offset = 6 + 16 * images.length
  for (const { size, png } of images) {
    const e = Buffer.alloc(16)
    e.writeUInt8(size >= 256 ? 0 : size, 0) // 0 means 256
    e.writeUInt8(size >= 256 ? 0 : size, 1)
    e.writeUInt8(0, 2) // no palette
    e.writeUInt8(0, 3)
    e.writeUInt16LE(1, 4) // colour planes
    e.writeUInt16LE(32, 6) // bits per pixel
    e.writeUInt32LE(png.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += png.length
    entries.push(e)
  }
  return Buffer.concat([header, ...entries, ...images.map(i => i.png)])
}

/** Render the icons into `outDir`; returns their paths. */
export function makeIcons(root, outDir) {
  const svg = fs.readFileSync(path.join(root, 'public', 'favicon.svg'))
  fs.mkdirSync(outDir, { recursive: true })
  const png = path.join(outDir, 'icon.png')
  const icoPath = path.join(outDir, 'icon.ico')
  const large = path.join(outDir, 'icon-1024.png')
  fs.writeFileSync(png, render(svg, 512))
  fs.writeFileSync(icoPath, ico(ICO_SIZES.map(size => ({ size, png: render(svg, size) }))))
  fs.writeFileSync(large, render(withMacMargin(svg), 1024))
  return { png, ico: icoPath, large }
}

/** makeIcons, unless they already exist and are newer than the SVG. */
export function ensureIcons(root, outDir) {
  const src = fs.statSync(path.join(root, 'public', 'favicon.svg')).mtimeMs
  const png = path.join(outDir, 'icon.png')
  const icoPath = path.join(outDir, 'icon.ico')
  const fresh = [png, icoPath].every(p => fs.existsSync(p) && fs.statSync(p).mtimeMs >= src)
  return fresh ? { png, ico: icoPath } : makeIcons(root, outDir)
}
