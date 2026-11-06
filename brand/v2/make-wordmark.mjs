/**
 * Generates the 2.0 candy wordmark as one static SVG, for the splash screen.
 *
 * The design sheet (index.html) draws it live with the Fredoka web font; the
 * app can't rely on that font being there (offline desktop), so here the
 * letters are turned into outlines with opentype.js. Colours are CSS custom
 * properties (--wm-*), so the splash can follow the theme's accent. Each
 * letter's pieces are wrapped in `<g class="wl" style="--i:n">` in every layer
 * (halo, rim, fill, icing), so CSS can move a letter as one piece even though
 * its layers are drawn separately (translate only: the layers' boxes differ,
 * so a scale would pull them apart).
 *
 * Fredoka is under the SIL Open Font License, which allows this.
 *
 *   npm i opentype.js@1.3.4 (anywhere), then
 *   OPENTYPE=<that>/node_modules/opentype.js FONT=<Fredoka-700.ttf> node brand/v2/make-wordmark.mjs
 *   -> src/assets/brand/wordmark.svg
 */
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'

const require = createRequire(import.meta.url)
const opentype = require(process.env.OPENTYPE)
const font = opentype.loadSync(process.env.FONT)
const OUT = path.resolve(import.meta.dirname, '../../src/assets/brand/wordmark.svg')

const WORD = 'playhound'
const SIZE = 230
const SPACING = -10
const BASE = 360
const f = n => Math.round(n * 10) / 10

// ── Layout ──────────────────────────────────────────────────────────────────
const glyphs = font.stringToGlyphs(WORD)
const scale = SIZE / font.unitsPerEm
let x = 0
const ch = glyphs.map((g, i) => {
  const p = g.getPath(x, BASE, SIZE)
  const bb = p.getBoundingBox()
  const k = { c: WORD[i], d: p.toPathData(1), x0: bb.x1, x1: bb.x2, top: bb.y1, bot: bb.y2 }
  k.w = k.x1 - k.x0
  k.cx = (k.x0 + k.x1) / 2
  x += g.advanceWidth * scale + SPACING
  if (glyphs[i + 1])
    x += font.getKerningValue(g, glyphs[i + 1]) * scale
  return k
})
function rnd(i, a = 0, b = 1) {
  const v = Math.sin(i * 127.1 + 311.7) * 43758.5453
  return a + (v - Math.floor(v)) * (b - a)
}

const HEART = 'M0 4 C-7 -1.5 -10 -5.5 -7.5 -9 C-5.4 -11.8 -1.6 -11.2 0 -7.6 C1.6 -11.2 5.4 -11.8 7.5 -9 C10 -5.5 7 -1.5 0 4Z'
function heartAt(hx, hy, s, rot = 0) {
  const k = s / 12
  const a = rot * Math.PI / 180
  return HEART.replace(/(-?[\d.]+) (-?[\d.]+)/g, (_, px, py) => {
    const X = px * k
    const Y = py * k
    return `${f(hx + X * Math.cos(a) - Y * Math.sin(a))} ${f(hy + X * Math.sin(a) + Y * Math.cos(a))}`
  })
}

// ── Pieces attached to letters ──────────────────────────────────────────────
const extra = ch.map(() => [])
// Goo melting off the bottoms of a few letters (under a solid part, not a gap).
ch.forEach((k, i) => {
  if (!'anl'.includes(k.c))
    return
  const cx = k.c === 'n' ? k.x1 - k.w * 0.16 : k.cx + rnd(i * 7, -0.12, 0.12) * k.w
  const w = rnd(i * 3, 9, 14)
  const L = rnd(i * 11, 28, 62)
  extra[i].push(`M${f(cx - w)} ${BASE - 26} C${f(cx - w)} ${f(BASE + L * 0.55)} ${f(cx - w * 0.78)} ${f(BASE + L)} ${f(cx)} ${f(BASE + L)} C${f(cx + w * 0.78)} ${f(BASE + L)} ${f(cx + w)} ${f(BASE + L * 0.55)} ${f(cx + w)} ${BASE - 26}Z`)
})
// Ears on the o, leaving its curve along the tangent so the outline flows into them.
const oi = ch.findIndex(k => k.c === 'o')
const o = ch[oi]
const r = o.w / 2
const ocx = o.cx
const ocy = (o.top + o.bot) / 2
// No counter: a solid disc fills the o's hole (its edge sits inside the ring, so no rim
// shows), and the heart takes its place.
{
  const rx = r * 0.62
  const ry = ((o.bot - o.top) / 2) * 0.62
  extra[oi].push(`M${f(ocx - rx)} ${f(ocy)} a${f(rx)} ${f(ry)} 0 1 0 ${f(2 * rx)} 0 a${f(rx)} ${f(ry)} 0 1 0 ${f(-2 * rx)} 0Z`)
}
for (const side of [-1, 1]) {
  const X = dx => ocx + side * dx
  const po = [X(0.866 * (r - 2)), ocy - 0.5 * (r - 2)]
  const c1 = [X(0.866 * (r - 2) - 0.5 * 0.42 * r), po[1] - 0.866 * 0.42 * r]
  const tip = [X(0.6 * r), o.top - 0.74 * r]
  const c2 = [X(0.66 * r), tip[1] + 0.3 * r]
  const c3 = [X(0.44 * r), tip[1] + 0.16 * r]
  const pi = [X(0.08 * r), ocy - 0.86 * r]
  const c4 = [X(0.2 * r), pi[1] - 0.2 * r]
  extra[oi].push(`M${f(po[0])} ${f(po[1])} C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(tip[0])} ${f(tip[1])} C${f(c3[0])} ${f(c3[1])} ${f(c4[0])} ${f(c4[1])} ${f(pi[0])} ${f(pi[1])} L${f(ocx)} ${f(ocy)} Z`)
}
// A tail curling out of the d, tipped with a heart.
const di = ch.length - 1
const d = ch[di]
const tail = `M${f(d.x1 - 16)} ${BASE - 14} C${f(d.x1 + 40)} ${BASE + 26} ${f(d.x1 + 104)} ${BASE + 14} ${f(d.x1 + 108)} ${BASE - 46} C${f(d.x1 + 111)} ${BASE - 92} ${f(d.x1 + 72)} ${BASE - 104} ${f(d.x1 + 80)} ${BASE - 146}`
const tailTip = heartAt(d.x1 + 82, BASE - 160, 44, 8)
// The fang on the o, drawn under the fill so it grows out of the letter.
const fx = o.cx + o.w * 0.14
const fang = `M${f(fx - 16)} ${BASE - 40} C${f(fx - 16)} ${BASE + 16} ${f(fx - 8)} ${BASE + 42} ${f(fx + 6)} ${BASE + 62} C${f(fx + 12)} ${BASE + 38} ${f(fx + 16)} ${BASE + 12} ${f(fx + 15)} ${BASE - 40}Z`

// Icing, per letter (none on the o: its ears and heart make the face).
function icing(k, i) {
  const depth = (k.bot - k.top) * ('lhd'.includes(k.c) ? 0.17 : 0.24)
  const edge = k.top + depth
  const x0 = k.x0 - 8
  const x1 = k.x1 + 8
  let p = `M${f(x0)} ${f(k.top - 150)} H${f(x1)} V${f(edge)}`
  const drips = [rnd(i * 5, 0.2, 0.42), rnd(i * 9, 0.58, 0.82)].sort((a, b) => b - a)
  let at = x1
  for (const fr of drips) {
    const px = x0 + (x1 - x0) * fr
    const w = rnd(i * 13 + fr * 10, 9, 13)
    const L = rnd(i * 17 + fr * 10, 22, 56)
    p += ` Q${f((at + px + w) / 2)} ${f(edge + 8)} ${f(px + w)} ${f(edge)} C${f(px + w)} ${f(edge + L)} ${f(px - w)} ${f(edge + L)} ${f(px - w)} ${f(edge)}`
    at = px - w
  }
  return `${p} Q${f((at + x0) / 2)} ${f(edge + 8)} ${f(x0)} ${f(edge)} Z`
}

// ── Assemble ────────────────────────────────────────────────────────────────
const shape = i => [ch[i].d, ...extra[i], ...(i === di ? [tailTip] : [])].map(p => `<path d="${p}"/>`).join('')
const layer = (body, attrs) => `<g ${attrs}>${ch.map((k, i) => `<g class="wl" style="--i:${i}">${body(i)}</g>`).join('')}</g>`
const tailFor = (i, w) => (i === di ? `<path d="${tail}" fill="none" stroke-width="${w}"/>` : '')

const minX = Math.min(...ch.map(k => k.x0)) - 40
const maxX = d.x1 + 150
const minY = o.top - 0.74 * r - 40
const maxY = BASE + 90
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${f(minX)} ${f(minY)} ${f(maxX - minX)} ${f(maxY - minY)}" class="wordmark" role="img" aria-label="playhound">
<defs>
<linearGradient id="wmf" x1="0" y1="${f(o.top - 80)}" x2="0" y2="${BASE + 40}" gradientUnits="userSpaceOnUse"><stop offset="0" style="stop-color:var(--wm-top)"/><stop offset=".55" style="stop-color:var(--wm-mid)"/><stop offset="1" style="stop-color:var(--wm-bot)"/></linearGradient>
<linearGradient id="wmi" x1="0" y1="${f(o.top - 80)}" x2="0" y2="${BASE}" gradientUnits="userSpaceOnUse"><stop offset="0" style="stop-color:var(--wm-icing)"/><stop offset="1" style="stop-color:var(--wm-icing-shade)"/></linearGradient>
${ch.map((k, i) => `<clipPath id="wmc${i}">${shape(i)}</clipPath>`).join('')}
</defs>
${layer(i => shape(i) + tailFor(i, 59), 'class="wm-halo" stroke-linejoin="round" stroke-linecap="round" stroke-width="39" style="fill:var(--wm-halo);stroke:var(--wm-halo)"')}
${layer(i => shape(i) + tailFor(i, 40), 'class="wm-rim" stroke-linejoin="round" stroke-linecap="round" stroke-width="20" style="fill:var(--wm-rim);stroke:var(--wm-rim)"')}
${layer(i => (i === di ? `<path d="${tail}" fill="none" stroke="url(#wmf)" stroke-width="20" stroke-linecap="round"/>` : '') + (i === oi ? `<path d="${fang}" fill="#fff" stroke-width="6" stroke-linejoin="round" style="stroke:var(--wm-rim)"/>` : ''), 'class="wm-under"')}
${layer(i => shape(i), 'class="wm-fill" fill="url(#wmf)"')}
${layer(i => (i === oi
  ? ''
  : `<g clip-path="url(#wmc${i})"><path d="${icing(ch[i], i)}" fill="url(#wmi)"/><ellipse cx="${f(ch[i].x0 + ch[i].w * 0.3)}" cy="${f(ch[i].top + 16)}" rx="${f(Math.min(14, ch[i].w * 0.12))}" ry="6" transform="rotate(-18 ${f(ch[i].x0 + ch[i].w * 0.3)} ${f(ch[i].top + 16)})" fill="#fff" opacity=".8"/></g>`), 'class="wm-icing"')}
${layer(i => (i === oi ? `<path class="wm-heart" d="${heartAt(o.cx, ocy + o.w * 0.3 * 0.33, o.w * 0.3)}" stroke-width="7" stroke-linejoin="round" style="fill:var(--wm-heart);stroke:var(--wm-rim)"/>` : ''), 'class="wm-face"')}
</svg>
`
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, svg)
process.stdout.write(`wrote ${OUT} (${(svg.length / 1024).toFixed(1)} KB)
`)
