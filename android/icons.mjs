/* eslint-disable no-console -- a build script: its log is the interface */
/**
 * The Android app's launcher icons and splash screens from public/favicon.svg,
 * so the brand mark has one source (desktop/icons.mjs does the same for the
 * desktop app). Writes into android/app/src/main/res; run it after changing
 * the mark:  pnpm mobile:icons
 *
 * - mipmap-*: ic_launcher.png / ic_launcher_round.png for launchers without
 *   adaptive icons, and ic_launcher_foreground.png, the adaptive icon's front
 *   layer: the tile at the size of the area every mask shows (72 of 108 dp),
 *   over a background in the tile's own colour (values/ic_launcher_background.xml).
 * - drawable-*: splash.png at each size the template had, the mark in the
 *   middle of the app's background.
 */
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const res = path.join(root, 'android', 'app', 'src', 'main', 'res')
const mark = fs.readFileSync(path.join(root, 'public', 'favicon.svg'), 'utf8')
const inner = mark.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')

/** The tile `size` px wide at (x, y) on a `w` × `h` canvas, over `bg` (or nothing). */
function canvas(w, h, size, bg) {
  const x = (w - size) / 2
  const y = (h - size) / 2
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${
    bg ? `<rect width="${w}" height="${h}" fill="${bg}"/>` : ''
  }<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 64 64">${inner}</svg></svg>`
}

function png(svg, width) {
  return new Resvg(Buffer.from(svg), { fitTo: { mode: 'width', value: width } }).render().asPng()
}

function write(rel, data) {
  const file = path.join(res, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, data)
  console.log(`[mobile:icons] ${path.relative(root, file)}`)
}

const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 }
const APP_BG = '#08080a'

for (const [d, k] of Object.entries(DENSITIES)) {
  const legacy = Math.round(48 * k)
  write(`mipmap-${d}/ic_launcher.png`, png(canvas(64, 64, 60, null), legacy))
  write(`mipmap-${d}/ic_launcher_round.png`, png(canvas(64, 64, 58, null), legacy))
  const fg = Math.round(108 * k)
  write(`mipmap-${d}/ic_launcher_foreground.png`, png(canvas(108, 108, 76, null), fg))
}

// Splash screens: the sizes the template shipped, read from their PNG headers.
for (const dir of fs.readdirSync(res).filter(n => n.startsWith('drawable'))) {
  const file = path.join(res, dir, 'splash.png')
  if (!fs.existsSync(file))
    continue
  const head = fs.readFileSync(file).subarray(16, 24)
  const w = head.readUInt32BE(0)
  const h = head.readUInt32BE(4)
  write(`${dir}/splash.png`, png(canvas(w, h, Math.round(Math.min(w, h) * 0.32), APP_BG), w))
}
