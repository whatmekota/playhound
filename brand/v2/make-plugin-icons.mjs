/**
 * Generates the official plugins' icons, in the 2.0 logo's family.
 *
 * Each is the logo's tile (make-icons.py): a 3-stop diagonal gradient in one of
 * the brand's colourings, the snout shade, the gloss at top-left and the thin
 * inner rim, with one bold glyph in the colouring's ink on top, white
 * highlights, and the accent sparingly.
 *
 * They're full-bleed squares, as docs/plugins.md asks of a store icon: the
 * tile fills the picture, and the app rounds its corners (PluginIcon: a
 * radius of 0.24 × the size). The rim follows that rounding, and the corners
 * the app cuts off are filled with the rim's colour, so the picture still
 * looks finished where it's shown square.
 *
 *   node brand/v2/make-plugin-icons.mjs
 *     -> brand/v2/plugin-icons/<id>.svg and <id>.png (256 × 256)
 *     -> src/assets/plugins/<id>.svg (the app's built-in icons for official plugins)
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { Resvg } from '@resvg/resvg-js'

const OUT = path.resolve(import.meta.dirname, 'plugin-icons')
const APP = path.resolve(import.meta.dirname, '../../src/assets/plugins')
fs.mkdirSync(OUT, { recursive: true })
fs.mkdirSync(APP, { recursive: true })

// The tile spans 2..62 of the logo's 64 grid; the picture is just the tile.
const VIEW = '2 2 60 60'
// The app's corner: 0.24 of the side.
const R = 14.4
// The logo's snout shade (make-icons.py BAND), so the tile is lit the same way.
const BAND = 'M-30 -30 H90 V90 H-30 Z M-20 -10.5 L1 -7.4 C26 -3.6 44 1 57 4.4 C59.6 5.2 61 6.6 61.8 9.4 C60.8 16 59.8 24 59 30 C58 37 57.2 42 56.8 46 C56.2 51.4 53.6 55.4 47.6 57.2 C36 59 20 59.6 -20 61 Z'
const GLOSS = 'M6.6 14.6 C7 10 10 7 15.6 6.6'

/** The brand's colourings (brand/v2/icons), plus cyan for the headset. */
const PALETTES = {
  'sly-grin': { stops: ['#f0abfc', '#d946ef', '#a21caf'], ink: '#2a0530', shade: '#701a75', shadeOp: 0.55, accent: '#fb923c' },
  'violet': { stops: ['#c4b5fd', '#7c3aed', '#3b0764'], ink: '#160626', shade: '#1e0a3c', shadeOp: 0.5, accent: '#f472b6' },
  'crimson': { stops: ['#fca5a5', '#e11d48', '#881337'], ink: '#2a0710', shade: '#4c0519', shadeOp: 0.5, accent: '#fda4af' },
  'orange': { stops: ['#fdba74', '#f97316', '#be123c'], ink: '#3b0a2a', shade: '#881337', shadeOp: 0.5, accent: '#f9a8d4' },
  'lime': { stops: ['#ecfccb', '#a3e635', '#4d7c0f'], ink: '#1a2e05', shade: '#365314', shadeOp: 0.5, accent: '#f472b6' },
  // Night: a dark tile, the glyph in fuchsia (its "ink" is the light colour
  // here), and the sticker's neon rim, so the tile holds its edge on a dark theme.
  'night': { tile: '#17171d', ink: '#d946ef', deep: '#3b0a45', shade: '#0b0b0f', shadeOp: 0.95, rim: '#c026d3', accent: '#f0abfc' },
  'cyan': { stops: ['#a5f3fc', '#06b6d4', '#155e75'], ink: '#062630', shade: '#164e63', shadeOp: 0.5, accent: '#f472b6' },
}

const n = v => Math.round(v * 100) / 100

/** A heart, its top edge at y, centred on cx, `w` wide. */
function heart(cx, y, w) {
  const s = w
  const x = cx - s / 2
  const P = (px, py) => `${n(x + px * s)} ${n(y + py * s)}`
  return `M${P(0.5, 0.92)} C${P(0.2, 0.7)} ${P(0, 0.52)} ${P(0, 0.3)} C${P(0, 0.12)} ${P(0.14, 0)} ${P(0.29, 0)} C${P(0.39, 0)} ${P(0.46, 0.05)} ${P(0.5, 0.14)} C${P(0.54, 0.05)} ${P(0.61, 0)} ${P(0.71, 0)} C${P(0.86, 0)} ${P(1, 0.12)} ${P(1, 0.3)} C${P(1, 0.52)} ${P(0.8, 0.7)} ${P(0.5, 0.92)}Z`
}

/** A rounded rectangle. */
function rr(x, y, w, h, r) {
  const k = r * 0.45
  const [x0, x1, x2, x3, y0, y1, y2, y3] = [x, x + k, x + r, x + w - r, y, y + k, y + r, y + h - r].map(n)
  const [x4, x5, y4, y5] = [x + w - k, x + w, y + h - k, y + h].map(n)
  return `M${x2} ${y0} H${x3} C${x4} ${y0} ${x5} ${y1} ${x5} ${y2} V${y3} C${x5} ${y4} ${x4} ${y5} ${x3} ${y5} H${x2} C${x1} ${y5} ${x0} ${y4} ${x0} ${y3} V${y2} C${x0} ${y1} ${x1} ${y0} ${x2} ${y0}Z`
}

/** A short white gloss stroke, the candy highlight on an ink shape. */
const gloss = (d, w = 2.2, op = 0.45) => `<path d="${d}" fill="none" stroke="#fff" stroke-width="${w}" stroke-linecap="round" opacity="${op}"/>`

const PLUGINS = [
  {
    // An AI partner that talks and drives the stroker: a speech bubble with a heart, and the hound's fang.
    id: 'playmate',
    palette: 'sly-grin',
    glyph: p => [
      `<path d="${rr(10, 12, 44, 32, 12)}" fill="${p.ink}"/>`,
      `<path d="M17.5 40 L13.4 53.4 L30 42.6 Z" fill="${p.ink}" stroke="${p.ink}" stroke-width="2.4" stroke-linejoin="round"/>`,
      `<path d="M38.6 43.2 C41.6 44.4 44 46.6 45.2 50.4 C46.8 47.4 47 45 46.2 43.2 Z" fill="#fff"/>`,
      `<path d="${heart(32, 19.4, 19)}" fill="${p.accent}"/>`,
      gloss('M26.8 22.6 C27.6 21.6 28.6 21.2 29.6 21.3', 1.9, 0.75),
      gloss('M14.4 22 C14.8 18.4 17 16.2 20.6 15.8', 2, 0.4),
    ],
  },
  {
    // Two people in sync: two hearts, linked.
    id: 'ph2gether',
    palette: 'violet',
    glyph: p => [
      `<path d="${heart(24.5, 17, 26)}" fill="${p.ink}"/>`,
      `<path d="${heart(39.5, 23, 26)}" fill="#fff" stroke="url(#t)" stroke-width="3.6" paint-order="stroke"/>`,
      gloss('M15.6 24.4 C15.8 21.8 17.6 20.4 20 20.4', 2, 0.4),
      `<path d="M34 30.2 C34.6 28.6 36 27.8 37.6 27.8" fill="none" stroke="${p.accent}" stroke-width="2.2" stroke-linecap="round" opacity=".9"/>`,
    ],
  },
  {
    // A web browser on the stage: a window with a pointer in it.
    id: 'phbrowser',
    palette: 'night',
    glyph: p => [
      `<path d="${rr(10, 13, 44, 38, 8)}" fill="${p.ink}"/>`,
      `<path d="${rr(14, 23, 36, 24, 4)}" fill="${p.deep}"/>`,
      `<circle cx="17" cy="18" r="2" fill="${p.deep}"/><circle cx="23" cy="18" r="2" fill="${p.deep}"/><circle cx="29" cy="18" r="2" fill="${p.deep}"/>`,
      `<path d="M29.6 27.4 V43.6 L33.6 39.8 L36.6 45.6 L39.6 44.2 L36.6 38.4 L42.2 38 Z" fill="#fff" stroke="${p.deep}" stroke-width="1.2" stroke-linejoin="round"/>`,
    ],
  },
  {
    // Finds forum threads: a needle, threaded.
    id: 'phthreads',
    palette: 'orange',
    glyph: p => [
      // The thread's short end, behind the needle.
      `<path d="M37.4 15.4 C40 16.8 42 18.6 43.6 20.6" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round"/>`,
      `<g transform="translate(32 32) rotate(-45)"><path d="M-25 0 L12 -4.2 C19.6 -5 25 -3.6 25 0 C25 3.6 19.6 5 12 4.2 Z" fill="${p.ink}"/><path d="${rr(12.4, -1.5, 8.6, 3, 1.5)}" fill="#fff"/></g>`,
      // Out of the eye and away in a loose curl.
      `<path d="M43.6 20.6 C48.6 25.4 51.4 31.6 47.4 36.4 C43.2 41.4 35.4 38 31.8 42.6 C28.6 46.8 32.4 51.6 39.4 50" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round"/>`,
      gloss('M17.4 42.4 L33.4 26.6', 1.4, 0.4),
    ],
  },
  {
    // A Cock Hero beat bar: beats running into the ring, a heart on its way.
    id: 'phbeatbar',
    palette: 'crimson',
    glyph: p => [
      `<path d="${rr(7, 20, 50, 24, 12)}" fill="${p.ink}"/>`,
      `<path d="${heart(17.4, 26.8, 11.4)}" fill="${p.accent}"/>`,
      `<circle cx="30" cy="32" r="3.6" fill="#fff"/>`,
      `<circle cx="44.8" cy="32" r="7.2" fill="none" stroke="#fff" stroke-width="3.6"/>`,
      `<circle cx="44.8" cy="32" r="2.4" fill="#fff"/>`,
      gloss('M11.6 27.6 C12.4 25.2 14 23.6 16.6 23', 1.8, 0.4),
    ],
  },
  {
    // In sync with a VR headset: the headset on its strap, the lenses catching the light.
    id: 'phvr',
    palette: 'cyan',
    glyph: p => [
      `<path d="M4 29.4 H60 V35.6 H4 Z" fill="${p.ink}"/>`,
      `<path d="M18 19 H46 C51 19 54 22 54 27 V38 C54 43 51 46 46 46 H39.6 C38.6 42 35.8 39.6 32 39.6 C28.2 39.6 25.4 42 24.4 46 H18 C13 46 10 43 10 38 V27 C10 22 13 19 18 19Z" fill="${p.ink}"/>`,
      `<path d="${rr(14.6, 24.6, 14.4, 10.4, 4.6)}" fill="${p.stops[0]}"/>`,
      `<path d="${rr(35, 24.6, 14.4, 10.4, 4.6)}" fill="${p.stops[0]}"/>`,
      `<path d="M17.6 31.6 L22.6 26.6 M38 31.6 L43 26.6" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>`,
      gloss('M13.4 23.4 C14 21.6 15.4 21 17.4 21', 1.6, 0.4),
    ],
  },
  {
    // A library source: an archive box.
    id: 'phstash',
    palette: 'lime',
    glyph: p => [
      `<path d="${rr(11, 15, 42, 10.4, 4)}" fill="${p.ink}"/>`,
      `<path d="${rr(14, 27.4, 36, 22, 4.4)}" fill="${p.ink}"/>`,
      `<path d="${rr(25, 32.2, 14, 5.4, 2.7)}" fill="#fff"/>`,
      gloss('M14.8 20 C15 18.6 15.8 18 17.4 18', 1.8, 0.45),
      gloss('M18 33 V39', 1.8, 0.35),
    ],
  },
]

function icon(plugin) {
  const p = PALETTES[plugin.palette]
  const grad = p.stops
    ? `<linearGradient id="t" x1="6" y1="4" x2="58" y2="62" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${p.stops[0]}"/><stop offset=".45" stop-color="${p.stops[1]}"/><stop offset="1" stop-color="${p.stops[2]}"/></linearGradient>`
    : ''
  const fill = p.stops ? 'url(#t)' : p.tile
  const shadeOp = Math.min(1, p.shadeOp * 0.9 + 0.05).toFixed(2)
  const ROUND = rr(2, 2, 60, 60, R)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEW}">
  <!-- playhound plugin icon · ${plugin.id} (${plugin.palette}), generated by brand/v2/make-plugin-icons.mjs -->
  <defs>${grad}</defs>
  <rect x="2" y="2" width="60" height="60" fill="${fill}"/>
  <path d="${BAND}" fill-rule="evenodd" fill="${p.shade}" opacity="${shadeOp}"/>
  <path d="${GLOSS}" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" opacity=".5"/>
  <path d="M2 2 H62 V62 H2 Z ${ROUND}" fill-rule="evenodd" fill="${p.rim ?? p.shade}" opacity=".55"/>
  <path d="${ROUND}" fill="none" stroke="${p.rim ?? p.shade}" stroke-width="2.4" opacity=".55"/>
    ${plugin.glyph(p).join('\n    ')}
</svg>
`
}

for (const plugin of PLUGINS) {
  const svg = icon(plugin)
  fs.writeFileSync(path.join(OUT, `${plugin.id}.svg`), svg)
  fs.writeFileSync(path.join(APP, `${plugin.id}.svg`), svg)
  fs.writeFileSync(path.join(OUT, `${plugin.id}.png`), new Resvg(svg, { fitTo: { mode: 'width', value: 256 } }).render().asPng())
}
process.stdout.write(`wrote ${PLUGINS.length} icons to ${OUT} and ${APP}\n`)
