/**
 * Drawing a share card: three looks (Forum, Candy, Poster) in two sizes.
 *
 * Everything is laid out in card units (1200 wide) and drawn at CARD_SCALE,
 * on whatever 2D context it is given: an OffscreenCanvas for the export, the
 * same for the dialog's preview. The numbers, the heatmap's columns and
 * colours, and the text fitting come from ~/lib/shareCard.
 *
 * Fonts must already be loaded (see cardAssets.ts): a canvas does not wait
 * for a web font, it draws in the fallback.
 */
import type { Action } from '~/lib/funscriptAnalysis'
import type { CardChapter, CardSize, CardStats, CardStyle, HeatBin, HeatPalette, Measure, MixBand, Rect } from '~/lib/shareCard'
import {
  busiestWindow,
  CARD_SCALE,
  CARD_SIZES,
  cardStats,
  chapterLabels,
  coverCrop,
  ellipsize,
  fitText,
  fitWrapped,
  formatCount,
  formatDuration,
  heatBins,
  heatColor,
  speedMix,
  stackRows,
  timeTicks,
} from '~/lib/shareCard'

export interface CardAxis {
  /** "stroke", "twist", … */
  name: string
  actions: Action[]
}

export interface CardData {
  title: string
  creator: string
  /** The video's length when known, else the script's. */
  durationMs: number
  /** The main axis first (stroke when there is one). */
  axes: CardAxis[]
  chapters: CardChapter[]
}

/** An image and its size. */
export interface Pic {
  img: CanvasImageSource
  w: number
  h: number
}

export interface CardAssets {
  /** The wordmark in the night colouring, for dark cards. */
  wordmarkNight: Pic | null
  /** The wordmark in the sly-grin colouring, for Candy. */
  wordmarkCandy: Pic | null
  /** The logo as a sticker, tongue out. */
  stickerCandy: Pic | null
  /** A frame of the video, when the user wants it behind the card. */
  frame?: Pic | null
}

export interface CardOptions {
  style: CardStyle
  size: CardSize
  palette: HeatPalette
  chapters: boolean
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
type Canvas = HTMLCanvasElement | OffscreenCanvas

export const SANS = 'Geist, Inter, system-ui, sans-serif'
export const MONO = '"Geist Mono", ui-monospace, Consolas, monospace'
export const ROUND = 'Fredoka, Geist, system-ui, sans-serif'

/** Draw the card onto `canvas`, resizing it to the card at CARD_SCALE. */
export function drawCard(canvas: Canvas, data: CardData, assets: CardAssets, opts: CardOptions): void {
  const { w, h } = CARD_SIZES[opts.size]
  canvas.width = w * CARD_SCALE
  canvas.height = h * CARD_SCALE
  const ctx = canvas.getContext('2d') as Ctx | null
  if (!ctx)
    return
  ctx.setTransform(CARD_SCALE, 0, 0, CARD_SCALE, 0, 0)
  ctx.clearRect(0, 0, w, h)
  ctx.textBaseline = 'alphabetic'
  ctx.imageSmoothingQuality = 'high'
  const kit = makeKit(ctx, w, h, data, assets, opts)
  if (opts.style === 'candy')
    paintCandy(kit)
  else if (opts.style === 'poster')
    paintPoster(kit)
  else
    paintForum(kit)
}

// ─── Kit: what every look needs ───────────────────────────────────────────────

interface Kit {
  ctx: Ctx
  W: number
  H: number
  data: CardData
  assets: CardAssets
  opts: CardOptions
  stats: CardStats
  main: CardAxis | null
  extra: CardAxis[]
  chapters: CardChapter[]
  tall: boolean
}

function makeKit(ctx: Ctx, W: number, H: number, data: CardData, assets: CardAssets, opts: CardOptions): Kit {
  const main = data.axes[0] ?? null
  const stats = cardStats(main?.actions ?? [], data.durationMs)
  return {
    ctx,
    W,
    H,
    data: { ...data, durationMs: stats.durationMs },
    assets,
    opts,
    stats,
    main,
    extra: data.axes.slice(1),
    chapters: opts.chapters ? data.chapters.filter(c => c.name.trim()) : [],
    tall: opts.size === 'tall',
  }
}

interface Stat { label: string, value: string }

function statList(k: Kit, more = false): Stat[] {
  const s = k.stats
  const list: Stat[] = [
    { label: 'Length', value: formatDuration(s.durationMs) },
    { label: 'Actions', value: formatCount(s.actions) },
    { label: 'Avg speed', value: String(Math.round(s.avgSpeed)) },
    { label: 'Max speed', value: String(Math.round(s.maxSpeed)) },
  ]
  if (more) {
    list.splice(2, 0, { label: 'Strokes', value: formatCount(s.strokes) })
    list.push({ label: 'Strokes/min', value: String(Math.round(s.strokesPerMin)) })
  }
  return list
}

/** "by Name · 4 axes · 6 chapters", leaving out what is not there. */
function metaLine(k: Kit, withCreator = true): string {
  const parts: string[] = []
  if (withCreator && k.data.creator.trim())
    parts.push(`by ${k.data.creator.trim()}`)
  const n = k.data.axes.length
  parts.push(n > 1 ? `${n} axes` : 'Single axis')
  if (k.chapters.length > 1)
    parts.push(`${k.chapters.length} chapters`)
  return parts.join('  ·  ')
}

/**
 * A title on one line when it fits at `oneMin` or larger, else wrapped onto
 * two from a little smaller down to `twoMin`.
 */
function fitTitle(m: Measure, s: string, maxW: number, max: number, oneMin: number, twoMin: number): { lines: string[], size: number } {
  const one = fitText(m, s, maxW, max, oneMin)
  if (one.text === s)
    return { lines: [s], size: one.size }
  return fitWrapped(m, s, maxW, 2, Math.min(max, oneMin + 4), twoMin)
}

function setFont(ctx: Ctx, weight: number | string, size: number, family: string, spacing = 0) {
  ctx.font = `${weight} ${size}px ${family}`
  ctx.letterSpacing = `${spacing}px`
}

function measurer(ctx: Ctx, weight: number | string, family: string, spacing = 0): Measure {
  return (text, size) => {
    setFont(ctx, weight, size, family, spacing)
    return ctx.measureText(text).width
  }
}

function text(ctx: Ctx, s: string, x: number, y: number, o: { weight: number | string, size: number, family: string, color: string, spacing?: number, align?: CanvasTextAlign }) {
  setFont(ctx, o.weight, o.size, o.family, o.spacing ?? 0)
  ctx.fillStyle = o.color
  ctx.textAlign = o.align ?? 'left'
  ctx.fillText(s, x, y)
  ctx.textAlign = 'left'
  return ctx.measureText(s).width
}

function rrect(ctx: Ctx, r: Rect, radius: number | number[]) {
  ctx.beginPath()
  ctx.roundRect(r.x, r.y, r.w, r.h, radius)
}

function inset(r: Rect, dx: number, dy = dx): Rect {
  return { x: r.x + dx, y: r.y + dy, w: r.w - dx * 2, h: r.h - dy * 2 }
}

function drawPic(ctx: Ctx, pic: Pic | null, x: number, y: number, h: number, alpha = 1): number {
  if (!pic)
    return 0
  const w = (h * pic.w) / pic.h
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.drawImage(pic.img, x, y, w, h)
  ctx.restore()
  return w
}

function picWidth(pic: Pic | null, h: number) {
  return pic ? (h * pic.w) / pic.h : 0
}

/** The video frame, cover-fit into `r`. */
function drawFrame(ctx: Ctx, pic: Pic, r: Rect, filter = 'none') {
  const src = coverCrop(pic.w, pic.h, r)
  ctx.save()
  ctx.filter = filter
  ctx.drawImage(pic.img, src.x, src.y, src.w, src.h, r.x, r.y, r.w, r.h)
  ctx.restore()
}

// ─── Heat ─────────────────────────────────────────────────────────────────────

/**
 * The funscript.io-style heatmap: one column per bin, coloured by speed and
 * spanning the range the strokes cover there. `full` fills each column top to
 * bottom instead (the plain strip used for the extra axes).
 */
const REST_SPEED = 2

function drawHeat(ctx: Ctx, r: Rect, bins: HeatBin[], palette: HeatPalette, o: { full?: boolean, minBand?: number, alpha?: number } = {}) {
  const cw = r.w / bins.length
  const minBand = o.minBand ?? 2
  for (let i = 0; i < bins.length; i++) {
    const b = bins[i]
    // At rest: leave the background, rather than paint a black hairline on it.
    if (b.speed === null || b.speed < REST_SPEED)
      continue
    let top = r.y
    let bot = r.y + r.h
    if (!o.full) {
      top = r.y + (1 - b.hi) * r.h
      bot = r.y + (1 - b.lo) * r.h
      if (bot - top < minBand) {
        const mid = (top + bot) / 2
        top = Math.max(r.y, mid - minBand / 2)
        bot = Math.min(r.y + r.h, top + minBand)
      }
    }
    ctx.fillStyle = heatColor(b.speed, palette, o.alpha ?? 1)
    // A hair wider than the column, so no seams show between them.
    ctx.fillRect(r.x + i * cw, top, cw + 0.6, bot - top)
  }
}

function binsFor(k: Kit, axis: CardAxis | null, width: number): HeatBin[] {
  return heatBins(axis?.actions ?? [], Math.max(40, Math.round(width)), k.data.durationMs)
}

/** The busiest `ms` of the main axis drawn as its position line, each segment in its speed's colour. */
function drawCloseUp(ctx: Ctx, r: Rect, actions: Action[], win: { start: number, end: number }, palette: HeatPalette, lineW: number, glow = 0) {
  const span = win.end - win.start || 1
  const X = (t: number) => r.x + ((t - win.start) / span) * r.w
  const Y = (p: number) => r.y + (1 - p) * r.h
  let i = 0
  while (i < actions.length - 1 && actions[i + 1].at < win.start)
    i++
  const segs: { x0: number, y0: number, x1: number, y1: number, color: string }[] = []
  for (; i < actions.length - 1 && actions[i].at <= win.end; i++) {
    const a = actions[i]
    const b = actions[i + 1]
    const dt = b.at - a.at
    if (dt <= 0)
      continue
    const speed = (Math.abs(b.pos - a.pos) * 100_000) / dt
    // Clip the segment to the window.
    const t0 = Math.max(a.at, win.start)
    const t1 = Math.min(b.at, win.end)
    const p0 = a.pos + (b.pos - a.pos) * ((t0 - a.at) / dt)
    const p1 = a.pos + (b.pos - a.pos) * ((t1 - a.at) / dt)
    segs.push({ x0: X(t0), y0: Y(p0), x1: X(t1), y1: Y(p1), color: heatColor(Math.max(speed, 30), palette) })
  }
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  const pass = (width: number, alpha: number, filter: string) => {
    ctx.filter = filter
    ctx.globalAlpha = alpha
    ctx.lineWidth = width
    for (const s of segs) {
      ctx.strokeStyle = s.color
      ctx.beginPath()
      ctx.moveTo(s.x0, s.y0)
      ctx.lineTo(s.x1, s.y1)
      ctx.stroke()
    }
  }
  if (glow > 0)
    pass(lineW * 2.2, 0.55, `blur(${glow}px)`)
  pass(lineW, 1, 'none')
  ctx.restore()
}

function drawMixBar(ctx: Ctx, r: Rect, mix: MixBand[], palette: HeatPalette, radius: number) {
  ctx.save()
  rrect(ctx, r, radius)
  ctx.clip()
  ctx.fillStyle = 'rgba(0,0,0,0.5)'
  ctx.fillRect(r.x, r.y, r.w, r.h)
  let x = r.x
  for (const b of mix) {
    if (b.share <= 0)
      continue
    const w = b.share * r.w
    ctx.fillStyle = heatColor(b.sample, palette)
    ctx.fillRect(x, r.y, w + 0.5, r.h)
    x += w
  }
  ctx.restore()
}

/**
 * The bands under the mix bar as columns: a dot and the range, the share
 * big under it. `top` is the range's baseline.
 */
function drawMixLegend(ctx: Ctx, x: number, top: number, w: number, mix: MixBand[], palette: HeatPalette, o: { family: string, rangeColor: string, pctColor: string, pctSize: number, pctWeight: number, rangeWeight?: number }) {
  const pct = percents(mix)
  const colW = w / mix.length
  mix.forEach((b, i) => {
    const cx = x + i * colW
    ctx.fillStyle = heatColor(b.sample, palette)
    ctx.beginPath()
    ctx.arc(cx + 5, top - 4.5, 5, 0, Math.PI * 2)
    ctx.fill()
    text(ctx, b.label, cx + 16, top, { weight: o.rangeWeight ?? 500, size: 12.5, family: o.family, color: o.rangeColor })
    text(ctx, `${pct[i]}%`, cx, top + o.pctSize + 8, { weight: o.pctWeight, size: o.pctSize, family: o.family, color: o.pctColor, spacing: -0.5 })
  })
}

/** The shares as whole percentages that add up to 100. */
function percents(mix: MixBand[]): number[] {
  const raw = mix.map(b => b.share * 100)
  const out = raw.map(Math.floor)
  let left = Math.round(raw.reduce((a, b) => a + b, 0)) - out.reduce((a, b) => a + b, 0)
  const order = raw.map((v, i) => [v - Math.floor(v), i] as const).sort((a, b) => b[0] - a[0])
  for (const [, i] of order) {
    if (left <= 0)
      break
    out[i]++
    left--
  }
  return out
}

/** Chapter dividers through `r`, at each chapter's start but the first. */
function drawChapterLines(ctx: Ctx, r: Rect, k: Kit, color: string, width = 1, dash: number[] = []) {
  if (k.chapters.length < 2)
    return
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.setLineDash(dash)
  for (const c of k.chapters) {
    if (c.start <= 0)
      continue
    const x = Math.round(r.x + (c.start / k.data.durationMs) * r.w) + 0.5
    if (x >= r.x + r.w - 1)
      continue
    ctx.beginPath()
    ctx.moveTo(x, r.y)
    ctx.lineTo(x, r.y + r.h)
    ctx.stroke()
  }
  ctx.restore()
}

/** Chapter names along the top of `r`, baseline at `y`. */
function drawChapterNames(ctx: Ctx, r: Rect, k: Kit, y: number, o: { weight: number, size: number, family: string, color: string, mark?: string, spacing?: number, minX?: number }) {
  if (k.chapters.length < 2)
    return
  const labels = chapterLabels(k.chapters, k.data.durationMs, r.w, measurer(ctx, o.weight, o.family, o.spacing ?? 0), o.size, 14)
  for (const l of labels) {
    const x = Math.max(o.minX ?? Number.NEGATIVE_INFINITY, r.x + l.x)
    if (o.mark) {
      ctx.fillStyle = o.mark
      ctx.fillRect(x, y - o.size * 0.72, 2, o.size * 0.8)
    }
    text(ctx, l.text, x + (o.mark ? 6 : 0), y, o)
  }
}

/** Time labels under `r`, baseline at `y`, kept left of `stopX`. */
function drawTicks(ctx: Ctx, r: Rect, k: Kit, y: number, o: { size: number, family: string, color: string, weight?: number, stopX?: number, maxTicks?: number }) {
  const ticks = timeTicks(k.data.durationMs, o.maxTicks ?? 8)
  const stop = o.stopX ?? r.x + r.w
  const end = formatDuration(k.data.durationMs)
  setFont(ctx, o.weight ?? 400, o.size, o.family)
  const endW = ctx.measureText(end).width
  let lastRight = Number.NEGATIVE_INFINITY
  for (const t of ticks) {
    const x = r.x + (t / k.data.durationMs) * r.w
    const label = formatDuration(t)
    const w = ctx.measureText(label).width
    if (x < lastRight + 12 || x + w > stop - 8)
      continue
    if (stop >= r.x + r.w - 1 && x + w > r.x + r.w - endW - 20)
      continue
    text(ctx, label, x, y, { weight: o.weight ?? 400, size: o.size, family: o.family, color: o.color })
    lastRight = x + w
  }
  if (stop >= r.x + r.w - 1)
    text(ctx, end, r.x + r.w, y, { weight: o.weight ?? 400, size: o.size, family: o.family, color: o.color, align: 'right' })
}

function closeUpWindow(k: Kit) {
  const d = k.data.durationMs
  const ms = Math.min(20_000, Math.max(6000, d * 0.12))
  return k.main ? busiestWindow(k.main.actions, ms) : null
}

/** "1:23–1:43". */
function spanLabel(win: { start: number, end: number }) {
  return `${formatDuration(win.start)}–${formatDuration(win.end)}`
}

// ─── Decorations ──────────────────────────────────────────────────────────────

function sparkle(ctx: Ctx, cx: number, cy: number, r: number, color: string) {
  ctx.beginPath()
  ctx.moveTo(cx, cy - r)
  ctx.quadraticCurveTo(cx + r * 0.12, cy - r * 0.12, cx + r, cy)
  ctx.quadraticCurveTo(cx + r * 0.12, cy + r * 0.12, cx, cy + r)
  ctx.quadraticCurveTo(cx - r * 0.12, cy + r * 0.12, cx - r, cy)
  ctx.quadraticCurveTo(cx - r * 0.12, cy - r * 0.12, cx, cy - r)
  ctx.fillStyle = color
  ctx.fill()
}

function heart(ctx: Ctx, cx: number, cy: number, s: number, color: string, angle = 0) {
  ctx.save()
  ctx.translate(cx, cy)
  ctx.rotate(angle)
  ctx.beginPath()
  ctx.moveTo(0, s * 0.35)
  ctx.bezierCurveTo(-s * 0.1, s * 0.25, -s * 0.5, 0, -s * 0.5, -s * 0.2)
  ctx.bezierCurveTo(-s * 0.5, -s * 0.45, -s * 0.2, -s * 0.55, 0, -s * 0.3)
  ctx.bezierCurveTo(s * 0.2, -s * 0.55, s * 0.5, -s * 0.45, s * 0.5, -s * 0.2)
  ctx.bezierCurveTo(s * 0.5, 0, s * 0.1, s * 0.25, 0, s * 0.35)
  ctx.fillStyle = color
  ctx.fill()
  ctx.restore()
}

/** A little "~~~" squiggle like the ones around the header's logo. */
function squiggle(ctx: Ctx, x: number, y: number, w: number, amp: number, color: string, width: number, angle = 0) {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(angle)
  ctx.beginPath()
  const n = 3
  const step = w / (n * 2)
  ctx.moveTo(0, 0)
  for (let i = 0; i < n * 2; i++)
    ctx.quadraticCurveTo(step * i + step / 2, i % 2 ? amp : -amp, step * (i + 1), 0)
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.stroke()
  ctx.restore()
}

/** Seeded so a card always comes out the same. */
function rng(seed: number) {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return ((s >>> 0) % 100_000) / 100_000
  }
}

function grain(ctx: Ctx, r: Rect, amount: number, seed = 7) {
  const rand = rng(seed)
  ctx.save()
  for (let i = 0; i < amount; i++) {
    const x = r.x + rand() * r.w
    const y = r.y + rand() * r.h
    ctx.fillStyle = rand() > 0.5 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.25)'
    ctx.fillRect(x, y, 1, 1)
  }
  ctx.restore()
}

// ─── Forum ────────────────────────────────────────────────────────────────────
// Sits in a Discourse dark theme post: a neutral grey card, information first,
// type in the app's own Geist, the mark small in a corner.

const FORUM = {
  bg: '#202125',
  bgTop: '#26272c',
  well: '#111113',
  tile: '#2a2b30',
  line: 'rgba(255,255,255,0.07)',
  text: '#f2f2f4',
  muted: '#a3a3ad',
  faint: '#73737d',
  accent: '#e879f9',
}

function paintForum(k: Kit) {
  const { ctx, W, H } = k
  const card: Rect = { x: 0, y: 0, w: W, h: H }
  ctx.save()
  rrect(ctx, card, 18)
  ctx.clip()
  const g = ctx.createLinearGradient(0, 0, 0, H)
  g.addColorStop(0, FORUM.bgTop)
  g.addColorStop(1, FORUM.bg)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, W, H)
  if (k.assets.frame) {
    drawFrame(ctx, k.assets.frame, card, 'blur(3px) brightness(0.32) saturate(0.8)')
    ctx.fillStyle = 'rgba(24,24,28,0.45)'
    ctx.fillRect(0, 0, W, H)
  }
  // A whisper of the brand along the top edge.
  const top = ctx.createLinearGradient(0, 0, W, 0)
  top.addColorStop(0, 'rgba(232,121,249,0)')
  top.addColorStop(0.5, 'rgba(232,121,249,0.55)')
  top.addColorStop(1, 'rgba(232,121,249,0)')
  ctx.fillStyle = top
  ctx.fillRect(0, 0, W, 2)

  if (k.tall)
    forumTall(k)
  else
    forumBanner(k)
  ctx.restore()

  rrect(ctx, inset(card, 0.5), 17.5)
  ctx.strokeStyle = 'rgba(255,255,255,0.08)'
  ctx.lineWidth = 1
  ctx.stroke()
}

function forumHeatBlock(k: Kit, area: Rect, o: { gutter: number, rowH: number, minHero: number }) {
  const { ctx } = k
  const heatArea: Rect = { x: area.x + o.gutter, y: area.y, w: area.w - o.gutter, h: area.h }
  const { hero, rows } = stackRows(heatArea, k.extra.length, o.rowH, 6, o.minHero)
  rrect(ctx, hero, 8)
  ctx.fillStyle = FORUM.well
  ctx.fill()
  ctx.save()
  rrect(ctx, hero, 8)
  ctx.clip()
  drawHeat(ctx, inset(hero, 0, 6), binsFor(k, k.main, hero.w), k.opts.palette)
  drawChapterLines(ctx, hero, k, 'rgba(255,255,255,0.45)', 1, [3, 3])
  ctx.restore()
  rows.forEach((r, i) => {
    ctx.save()
    rrect(ctx, r, 3)
    ctx.fillStyle = FORUM.well
    ctx.fill()
    ctx.clip()
    drawHeat(ctx, r, binsFor(k, k.extra[i], r.w), k.opts.palette, { full: true })
    ctx.restore()
  })
  if (o.gutter > 0) {
    const label = (s: string, r: Rect) => text(ctx, s, area.x + o.gutter - 12, r.y + r.h / 2 + 4.5, { weight: 500, size: 13, family: SANS, color: FORUM.muted, align: 'right' })
    label(k.main?.name ?? 'stroke', hero)
    rows.forEach((r, i) => label(k.extra[i].name, r))
  }
  return { hero, rows }
}

function forumBanner(k: Kit) {
  const { ctx, W, H } = k
  const P = 32
  const multi = k.extra.length > 0

  // Stats, right-aligned along the top.
  const stats = statList(k)
  const labelM = measurer(ctx, 600, SANS, 1.1)
  const valueM = measurer(ctx, 600, SANS, -0.6)
  const cols = stats.map(s => Math.max(labelM(s.label.toUpperCase(), 11), valueM(s.value, 28)))
  const gap = 32
  let x = W - P - cols.reduce((a, b) => a + b, 0) - gap * (cols.length - 1)
  const statsLeft = x
  stats.forEach((s, i) => {
    if (i > 0) {
      ctx.fillStyle = FORUM.line
      ctx.fillRect(x - gap / 2, 38, 1, 52)
    }
    text(ctx, s.label.toUpperCase(), x, 52, { weight: 600, size: 11, family: SANS, color: FORUM.faint, spacing: 1.1 })
    text(ctx, s.value, x, 87, { weight: 600, size: 28, family: SANS, color: FORUM.text, spacing: -0.6 })
    x += cols[i] + gap
  })

  // Title and what it is.
  const maxW = statsLeft - P - 36
  const t = fitText(measurer(ctx, 600, SANS, -0.3), k.data.title, maxW, 31, 22)
  text(ctx, t.text, P, 64, { weight: 600, size: t.size, family: SANS, color: FORUM.text, spacing: -0.3 })
  const meta = ellipsize(measurer(ctx, 400, SANS), metaLine(k), 15.5, maxW)
  text(ctx, meta, P, 92, { weight: 400, size: 15.5, family: SANS, color: FORUM.muted })

  // The heatmap.
  const named = k.chapters.length > 1
  const top = named ? 138 : 120
  const area: Rect = { x: P, y: top, w: W - P * 2, h: H - 46 - top }
  const { hero } = forumHeatBlock(k, area, { gutter: multi ? 64 : 0, rowH: 11, minHero: 70 })
  if (named)
    drawChapterNames(ctx, hero, k, top - 9, { weight: 500, size: 12.5, family: SANS, color: FORUM.muted, mark: FORUM.accent })

  // Time along the bottom, the mark in the corner.
  const markH = 32
  const markW = picWidth(k.assets.wordmarkNight, markH)
  drawPic(ctx, k.assets.wordmarkNight, W - P - markW + 4, H - markH - 7, markH)
  drawTicks(ctx, hero, k, H - 20, { size: 11.5, family: MONO, color: FORUM.faint, stopX: W - P - markW - 4 })
}

function forumTall(k: Kit) {
  const { ctx, W, H } = k
  const P = 44
  const multi = k.extra.length > 0

  // Header: title (two lines at most), what it is, the mark.
  const markH = 44
  const markW = picWidth(k.assets.wordmarkNight, markH)
  drawPic(ctx, k.assets.wordmarkNight, W - P - markW + 6, 34, markH)
  const maxW = W - P * 2 - markW - 36
  const t = fitTitle(measurer(ctx, 600, SANS, -0.6), k.data.title, maxW, 42, 34, 28)
  let y = 42 + t.size * 0.9
  t.lines.forEach((line, i) => {
    if (i > 0)
      y += t.size * 1.1
    text(ctx, line, P, y, { weight: 600, size: t.size, family: SANS, color: FORUM.text, spacing: -0.6 })
  })
  const meta = ellipsize(measurer(ctx, 400, SANS), metaLine(k), 17, maxW)
  y += 34
  text(ctx, meta, P, y, { weight: 400, size: 17, family: SANS, color: FORUM.muted })

  // Stat tiles.
  const stats = statList(k, true)
  const tilesY = y + 28
  const gap = 12
  const tw = (W - P * 2 - gap * (stats.length - 1)) / stats.length
  stats.forEach((s, i) => {
    const r: Rect = { x: P + i * (tw + gap), y: tilesY, w: tw, h: 80 }
    rrect(ctx, r, 10)
    ctx.fillStyle = FORUM.tile
    ctx.fill()
    text(ctx, s.label.toUpperCase(), r.x + 16, r.y + 27, { weight: 600, size: 11, family: SANS, color: FORUM.faint, spacing: 1.1 })
    const v = fitText(measurer(ctx, 600, SANS, -0.6), s.value, r.w - 32, 30, 18)
    text(ctx, v.text, r.x + 16, r.y + 63, { weight: 600, size: v.size, family: SANS, color: FORUM.text, spacing: -0.6 })
  })

  // Bottom up: the panels, the time axis, and the heatmap in what is left.
  const panelH = 168
  const panelY = H - 40 - panelH
  const ticksY = panelY - 34
  const named = k.chapters.length > 1
  const headY = tilesY + 80 + 40
  text(ctx, 'SPEED', P, headY, { weight: 600, size: 11, family: SANS, color: FORUM.faint, spacing: 1.1 })
  const top = headY + (named ? 32 : 14)
  const area: Rect = { x: P, y: top, w: W - P * 2, h: ticksY - 22 - top }
  const { hero } = forumHeatBlock(k, area, { gutter: multi ? 70 : 0, rowH: 15, minHero: 100 })
  if (named)
    drawChapterNames(ctx, hero, k, top - 11, { weight: 500, size: 13, family: SANS, color: FORUM.muted, mark: FORUM.accent })
  drawTicks(ctx, hero, k, ticksY, { size: 12, family: MONO, color: FORUM.faint, maxTicks: 10 })

  // A close-up of the busiest stretch, and how the time splits by speed.
  const leftW = Math.round((W - P * 2) * 0.58)
  const win = closeUpWindow(k)
  text(ctx, 'BUSIEST STRETCH', P, panelY + 4, { weight: 600, size: 11, family: SANS, color: FORUM.faint, spacing: 1.1 })
  if (win)
    text(ctx, spanLabel(win), P + leftW, panelY + 4, { weight: 400, size: 12, family: MONO, color: FORUM.faint, align: 'right' })
  const well: Rect = { x: P, y: panelY + 16, w: leftW, h: panelH - 16 }
  rrect(ctx, well, 8)
  ctx.fillStyle = FORUM.well
  ctx.fill()
  if (win && k.main)
    drawCloseUp(ctx, inset(well, 14, 12), k.main.actions, win, k.opts.palette, 2.6)

  const mx = P + leftW + 36
  const mw = W - P - mx
  text(ctx, 'TIME AT EACH SPEED', mx, panelY + 4, { weight: 600, size: 11, family: SANS, color: FORUM.faint, spacing: 1.1 })
  const mix = speedMix(k.main?.actions ?? [])
  drawMixBar(ctx, { x: mx, y: panelY + 16, w: mw, h: 14 }, mix, k.opts.palette, 4)
  drawMixLegend(ctx, mx, panelY + 66, mw, mix, k.opts.palette, { family: SANS, rangeColor: FORUM.muted, pctColor: FORUM.text, pctSize: 26, pctWeight: 600 })
  text(ctx, movingLine(k), mx, panelY + panelH - 4, { weight: 400, size: 14, family: SANS, color: FORUM.faint })
}

/** "Moving 94% of the time, speeds in units a second". */
function movingLine(k: Kit) {
  return `Moving ${Math.round(k.stats.moving * 100)}% of the time · speeds in units a second`
}

// ─── Candy ────────────────────────────────────────────────────────────────────
// playhound's own look: a glossy pink sticker with a white rim, magenta icing
// dripping off the top, Fredoka type, the heatmap in a dark candy-glass well.

const CANDY = {
  halo: '#fff4fd',
  rim: '#c026d3',
  faceTop: '#ffeefa',
  faceBot: '#fbcdef',
  ink: '#5b0b5e',
  inkSoft: '#a21caf',
  label: '#c026d3',
  well: '#2a0a31',
  wellEdge: '#ffffff',
  pill: '#ffffff',
  sparkle: '#e879f9',
  sparkleSoft: '#f5b6fb',
}

interface Drip { x: number, len: number, w: number }

/**
 * Where the icing drips: [fraction of the width, length, width] in banner
 * units. Long ones end in a drop; short ones are just a bulge in the edge.
 */
const DRIPS: [number, number, number][] = [
  [0.035, 12, 30],
  [0.095, 32, 20],
  [0.165, 14, 34],
  [0.235, 24, 18],
  [0.31, 11, 30],
  [0.375, 36, 21],
  [0.45, 13, 32],
  [0.525, 27, 18],
  [0.6, 12, 34],
  [0.675, 38, 22],
  [0.75, 13, 30],
  [0.825, 26, 19],
  [0.895, 12, 32],
  [0.96, 33, 21],
]

/** A drip is a drop when it is long enough to have a neck. */
const isDrop = (d: Drip) => d.len >= d.w * 1.15

function icingPath(ctx: Ctx, face: Rect, band: number, drips: Drip[]) {
  const base = face.y + band
  ctx.beginPath()
  ctx.moveTo(face.x, face.y)
  ctx.lineTo(face.x + face.w, face.y)
  ctx.lineTo(face.x + face.w, base)
  const sorted = [...drips].sort((a, b) => b.x - a.x)
  let cx = face.x + face.w
  for (const d of sorted) {
    const r = d.w / 2
    const f = Math.min(7, r * 0.8)
    // A soft wave between drips, then a rounded shoulder into each.
    ctx.quadraticCurveTo((cx + d.x + r + f) / 2, base + 2.5, d.x + r + f, base)
    ctx.quadraticCurveTo(d.x + r, base, d.x + r, base + f)
    // A finger of icing with a round end, like the drips on the logo.
    const end = base + Math.max(f, d.len - r)
    ctx.lineTo(d.x + r, end)
    ctx.arc(d.x, end, r, 0, Math.PI)
    ctx.lineTo(d.x - r, base + f)
    ctx.quadraticCurveTo(d.x - r, base, d.x - r - f, base)
    cx = d.x - r - f
  }
  ctx.quadraticCurveTo((cx + face.x) / 2, base + 2.5, face.x, base)
  ctx.closePath()
}

function candyFace(k: Kit): Rect {
  const { ctx, W, H } = k
  const outer: Rect = { x: 2, y: 2, w: W - 4, h: H - 4 }
  const R = k.tall ? 48 : 40
  // Halo, rim, face: the sticker.
  rrect(ctx, outer, R)
  ctx.fillStyle = CANDY.halo
  ctx.fill()
  const rim = inset(outer, 8)
  rrect(ctx, rim, R - 8)
  ctx.fillStyle = CANDY.rim
  ctx.fill()
  const face = inset(rim, 3)
  rrect(ctx, face, R - 11)
  const g = ctx.createLinearGradient(0, face.y, 0, face.y + face.h)
  g.addColorStop(0, CANDY.faceTop)
  g.addColorStop(1, CANDY.faceBot)
  ctx.fillStyle = g
  ctx.fill()

  ctx.save()
  rrect(ctx, face, R - 11)
  ctx.clip()
  if (k.assets.frame) {
    drawFrame(ctx, k.assets.frame, face, 'blur(2px) saturate(1.1)')
    const tint = ctx.createLinearGradient(0, face.y, 0, face.y + face.h)
    tint.addColorStop(0, 'rgba(255,238,250,0.9)')
    tint.addColorStop(1, 'rgba(251,205,239,0.84)')
    ctx.fillStyle = tint
    ctx.fillRect(face.x, face.y, face.w, face.h)
  }
  // Soft light from the top left, like the logo's tile.
  const shine = ctx.createRadialGradient(face.x + face.w * 0.18, face.y, 10, face.x + face.w * 0.18, face.y, face.w * 0.55)
  shine.addColorStop(0, 'rgba(255,255,255,0.7)')
  shine.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = shine
  ctx.fillRect(face.x, face.y, face.w, face.h)

  // Icing.
  const band = k.tall ? 18 : 14
  const scale = k.tall ? 1.05 : 0.82
  const drips: Drip[] = DRIPS.map(([fx, len, w]) => ({ x: face.x + fx * face.w, len: len * scale, w: w * scale }))
  ctx.save()
  ctx.shadowColor = 'rgba(134,25,143,0.4)'
  ctx.shadowBlur = 8
  ctx.shadowOffsetY = 3
  icingPath(ctx, face, band, drips)
  const ig = ctx.createLinearGradient(0, face.y, 0, face.y + band + 36 * scale)
  ig.addColorStop(0, '#f5c2fc')
  ig.addColorStop(0.3, '#e05cf5')
  ig.addColorStop(1, '#a21caf')
  ctx.fillStyle = ig
  ctx.fill()
  ctx.restore()
  // Gloss: a highlight along the band and on each drop.
  ctx.fillStyle = 'rgba(255,255,255,0.45)'
  ctx.beginPath()
  ctx.roundRect(face.x + 30, face.y + 4, face.w - 60, band * 0.32, band * 0.16)
  ctx.fill()
  ctx.fillStyle = 'rgba(255,255,255,0.42)'
  for (const d of drips) {
    if (!isDrop(d))
      continue
    const r = d.w / 2
    const top = face.y + band + d.len * 0.25
    const bot = face.y + band + d.len - r * 0.8
    ctx.beginPath()
    ctx.roundRect(d.x - r * 0.55, top, r * 0.32, bot - top, r * 0.16)
    ctx.fill()
  }
  ctx.restore()
  return face
}

/** A dark glossy well, like a boiled sweet. */
function candyWell(ctx: Ctx, r: Rect, radius: number) {
  ctx.save()
  ctx.shadowColor = 'rgba(134,25,143,0.4)'
  ctx.shadowBlur = 14
  ctx.shadowOffsetY = 5
  rrect(ctx, r, radius)
  ctx.fillStyle = CANDY.well
  ctx.fill()
  ctx.restore()
}

function candyGloss(ctx: Ctx, r: Rect, radius: number) {
  ctx.save()
  rrect(ctx, r, radius)
  ctx.clip()
  const g = ctx.createLinearGradient(0, r.y, 0, r.y + r.h * 0.5)
  g.addColorStop(0, 'rgba(255,255,255,0.22)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  rrect(ctx, { x: r.x + 6, y: r.y + 4, w: r.w - 12, h: r.h * 0.45 }, [radius - 4, radius - 4, 40, 40])
  ctx.fill()
  ctx.restore()
  rrect(ctx, r, radius)
  ctx.strokeStyle = CANDY.wellEdge
  ctx.lineWidth = 3
  ctx.stroke()
}

function candyHeatBlock(k: Kit, area: Rect, o: { gutter: number, rowH: number, minHero: number, radius: number }) {
  const { ctx } = k
  const r = { x: area.x + o.gutter, y: area.y, w: area.w - o.gutter, h: area.h }
  candyWell(ctx, r, o.radius)
  const innerPad = 12
  const inner = inset(r, innerPad, 10)
  const { hero, rows } = stackRows(inner, k.extra.length, o.rowH, 6, o.minHero)
  ctx.save()
  rrect(ctx, r, o.radius)
  ctx.clip()
  drawHeat(ctx, hero, binsFor(k, k.main, hero.w), k.opts.palette)
  drawChapterLines(ctx, { ...hero, y: r.y, h: hero.h + (hero.y - r.y) }, k, 'rgba(255,255,255,0.55)', 1.5, [2, 4])
  rows.forEach((row, i) => {
    rrect(ctx, row, row.h / 2)
    ctx.save()
    ctx.clip()
    ctx.fillStyle = 'rgba(0,0,0,0.4)'
    ctx.fillRect(row.x, row.y, row.w, row.h)
    drawHeat(ctx, row, binsFor(k, k.extra[i], row.w), k.opts.palette, { full: true })
    ctx.restore()
  })
  ctx.restore()
  candyGloss(ctx, r, o.radius)
  if (o.gutter > 0) {
    const size = Math.min(14, o.rowH + 3)
    const label = (s: string, row: Rect) => text(ctx, s, area.x + o.gutter - 14, row.y + row.h / 2 + size * 0.36, { weight: 600, size, family: ROUND, color: CANDY.inkSoft, align: 'right' })
    label(k.main?.name ?? 'stroke', hero)
    rows.forEach((row, i) => label(k.extra[i].name, row))
  }
  return { well: r, hero, rows }
}

function candyPill(ctx: Ctx, r: Rect, s: Stat, valueSize: number) {
  ctx.save()
  ctx.shadowColor = 'rgba(192,38,211,0.28)'
  ctx.shadowBlur = 10
  ctx.shadowOffsetY = 4
  rrect(ctx, r, r.h / 2)
  ctx.fillStyle = CANDY.pill
  ctx.fill()
  ctx.restore()
  rrect(ctx, r, r.h / 2)
  ctx.strokeStyle = '#f5d0fe'
  ctx.lineWidth = 2
  ctx.stroke()
  const cx = r.x + r.w / 2
  text(ctx, s.label.toUpperCase(), cx, r.y + r.h * 0.36 + 2, { weight: 600, size: 11, family: ROUND, color: CANDY.label, spacing: 1, align: 'center' })
  text(ctx, s.value, cx, r.y + r.h * 0.36 + valueSize + 4, { weight: 700, size: valueSize, family: ROUND, color: CANDY.ink, align: 'center' })
}

function paintCandy(k: Kit) {
  const face = candyFace(k)
  if (k.tall)
    candyTall(k, face)
  else
    candyBanner(k, face)
}

function candyBanner(k: Kit, face: Rect) {
  const { ctx, W, H } = k
  const P = 42
  const multi = k.extra.length > 0

  // Stat pills, right.
  const stats = statList(k)
  const lm = measurer(ctx, 600, ROUND, 1)
  const vm = measurer(ctx, 700, ROUND)
  const widths = stats.map(s => Math.max(lm(s.label.toUpperCase(), 11), vm(s.value, 22)) + 36)
  const gap = 10
  let x = W - P - widths.reduce((a, b) => a + b, 0) - gap * (widths.length - 1)
  const statsLeft = x
  stats.forEach((s, i) => {
    candyPill(ctx, { x, y: 56, w: widths[i], h: 54 }, s, 22)
    x += widths[i] + gap
  })

  // Title.
  const maxW = statsLeft - P - 28
  const t = fitText(measurer(ctx, 700, ROUND), k.data.title, maxW, 34, 22)
  text(ctx, t.text, P, 88, { weight: 700, size: t.size, family: ROUND, color: CANDY.ink })
  const meta = ellipsize(measurer(ctx, 500, ROUND), metaLine(k), 16, maxW)
  text(ctx, meta, P, 112, { weight: 500, size: 16, family: ROUND, color: CANDY.inkSoft })

  // Heatmap.
  const named = k.chapters.length > 1
  const top = named ? 146 : 128
  const area: Rect = { x: P - 6, y: top, w: W - (P - 6) * 2, h: face.y + face.h - 46 - top }
  const { hero, well } = candyHeatBlock(k, area, { gutter: multi ? 64 : 0, rowH: 10, minHero: 60, radius: 18 })
  if (named)
    drawChapterNames(ctx, hero, k, top - 9, { weight: 600, size: 13, family: ROUND, color: CANDY.inkSoft, mark: CANDY.rim })

  // The wordmark, a sparkle or two, and time.
  const markH = 42
  const markW = picWidth(k.assets.wordmarkCandy, markH)
  drawPic(ctx, k.assets.wordmarkCandy, W - P - markW + 10, H - markH - 16, markH)
  drawTicks(ctx, { ...hero, x: well.x + 12 }, k, H - 26, { size: 12.5, family: ROUND, weight: 500, color: CANDY.inkSoft, stopX: W - P - markW })
  sparkle(ctx, W - 30, 50, 7, CANDY.sparkle)
  sparkle(ctx, statsLeft - 16, 60, 5, CANDY.sparkleSoft)
}

function candyTall(k: Kit, face: Rect) {
  const { ctx, W, H } = k
  const P = 52
  const multi = k.extra.length > 0

  // Logo sticker and wordmark, like the header.
  const logo = 118
  drawPic(ctx, k.assets.stickerCandy, P - 8, 62, logo)
  const markH = 54
  const markW = picWidth(k.assets.wordmarkCandy, markH)
  drawPic(ctx, k.assets.wordmarkCandy, W - P - markW + 10, 66, markH)

  const tx = P + logo + 10
  const maxW = W - P - tx - markW - 16
  const t = fitTitle(measurer(ctx, 700, ROUND), k.data.title, maxW, 46, 36, 30)
  const lineH = t.size * 1.04
  // Title and meta line centred on the logo.
  const block = t.size * 0.72 + (t.lines.length - 1) * lineH + 34
  let y = 62 + logo / 2 - block / 2 + t.size * 0.72
  t.lines.forEach((line, i) => {
    if (i > 0)
      y += lineH
    text(ctx, line, tx, y, { weight: 700, size: t.size, family: ROUND, color: CANDY.ink })
  })
  const meta = ellipsize(measurer(ctx, 500, ROUND), metaLine(k), 18, maxW)
  text(ctx, meta, tx, y + 34, { weight: 500, size: 18, family: ROUND, color: CANDY.inkSoft })

  // Stat pills.
  const stats = statList(k, true)
  const gap = 12
  const pw = (W - P * 2 - gap * (stats.length - 1)) / stats.length
  stats.forEach((s, i) => candyPill(ctx, { x: P + i * (pw + gap), y: 212, w: pw, h: 64 }, s, 26))

  // Heatmap.
  const named = k.chapters.length > 1
  const top = named ? 330 : 308
  const panelH = 172
  const panelY = face.y + face.h - 24 - panelH
  const ticksY = panelY - 26
  const area: Rect = { x: P - 6, y: top, w: W - (P - 6) * 2, h: ticksY - 26 - top }
  const { hero } = candyHeatBlock(k, area, { gutter: multi ? 70 : 0, rowH: 14, minHero: 110, radius: 22 })
  if (named)
    drawChapterNames(ctx, hero, k, top - 10, { weight: 600, size: 14, family: ROUND, color: CANDY.inkSoft, mark: CANDY.rim })
  drawTicks(ctx, hero, k, ticksY, { size: 13, family: ROUND, weight: 500, color: CANDY.inkSoft, maxTicks: 10 })

  // Close-up and speed mix, in candy cards.
  const leftW = Math.round((W - P * 2) * 0.58)
  const left: Rect = { x: P - 6, y: panelY, w: leftW, h: panelH }
  const right: Rect = { x: P - 6 + leftW + 18, y: panelY, w: W - (P - 6) * 2 - leftW - 18, h: panelH }
  const win = closeUpWindow(k)
  candyWell(ctx, left, 20)
  ctx.save()
  rrect(ctx, left, 20)
  ctx.clip()
  if (win && k.main)
    drawCloseUp(ctx, { x: left.x + 18, y: left.y + 40, w: left.w - 36, h: left.h - 54 }, k.main.actions, win, k.opts.palette, 3, 4)
  ctx.restore()
  candyGloss(ctx, left, 20)
  text(ctx, 'busiest stretch', left.x + 20, left.y + 28, { weight: 600, size: 15, family: ROUND, color: '#f5d0fe' })
  if (win)
    text(ctx, spanLabel(win), left.x + left.w - 20, left.y + 28, { weight: 500, size: 14, family: ROUND, color: '#e9a8f5', align: 'right' })

  ctx.save()
  ctx.shadowColor = 'rgba(192,38,211,0.25)'
  ctx.shadowBlur = 12
  ctx.shadowOffsetY = 4
  rrect(ctx, right, 20)
  ctx.fillStyle = '#ffffff'
  ctx.fill()
  ctx.restore()
  text(ctx, 'time at each speed', right.x + 20, right.y + 28, { weight: 600, size: 15, family: ROUND, color: CANDY.inkSoft })
  const mix = speedMix(k.main?.actions ?? [])
  drawMixBar(ctx, { x: right.x + 20, y: right.y + 42, w: right.w - 40, h: 16 }, mix, k.opts.palette, 8)
  drawMixLegend(ctx, right.x + 20, right.y + 92, right.w - 40, mix, k.opts.palette, { family: ROUND, rangeColor: CANDY.inkSoft, pctColor: CANDY.ink, pctSize: 26, pctWeight: 700, rangeWeight: 600 })
  text(ctx, movingLine(k), right.x + 20, right.y + right.h - 20, { weight: 500, size: 14, family: ROUND, color: '#c86fc9' })

  sparkle(ctx, P + logo + 2, 70, 9, CANDY.sparkle)
  sparkle(ctx, W - 40, 150, 7, CANDY.sparkleSoft)
  heart(ctx, P - 2, 196, 13, CANDY.sparkleSoft, -0.3)
  squiggle(ctx, W - P - 70, 160, 40, 4, CANDY.sparkleSoft, 3, -0.1)
  void H
}

// ─── Poster ───────────────────────────────────────────────────────────────────
// Bold and dark: the heatmap runs edge to edge and glows, the type is big, the
// numbers are the second thing you read.

const POSTER = {
  bg: '#08080a',
  text: '#fafafa',
  muted: '#a1a1aa',
  faint: '#5f5f69',
  accent: '#f0abfc',
  hot: '#e879f9',
}

function posterHero(k: Kit, r: Rect, glow: number) {
  const { ctx } = k
  const bins = binsFor(k, k.main, r.w)
  // The glow: the same heatmap, blurred, under the sharp one.
  ctx.save()
  ctx.filter = `blur(${glow}px)`
  ctx.globalAlpha = 0.65
  drawHeat(ctx, r, bins, k.opts.palette)
  ctx.restore()
  drawHeat(ctx, r, bins, k.opts.palette)
  drawChapterLines(ctx, { x: r.x, y: r.y - 6, w: r.w, h: r.h + 12 }, k, 'rgba(255,255,255,0.5)', 1)
}

function posterRows(k: Kit, rows: Rect[], labelX: number) {
  const { ctx } = k
  rows.forEach((row, i) => {
    ctx.fillStyle = 'rgba(255,255,255,0.04)'
    ctx.fillRect(row.x, row.y, row.w, row.h)
    drawHeat(ctx, row, binsFor(k, k.extra[i], row.w), k.opts.palette, { full: true })
    text(ctx, k.extra[i].name.toUpperCase(), labelX, row.y + row.h / 2 + 4, { weight: 500, size: 10.5, family: MONO, color: POSTER.muted, spacing: 1.6 })
  })
}

function posterBackdrop(k: Kit, heroMid: number) {
  const { ctx, W, H } = k
  ctx.fillStyle = POSTER.bg
  ctx.fillRect(0, 0, W, H)
  if (k.assets.frame) {
    const r: Rect = { x: 0, y: 0, w: W, h: H }
    drawFrame(ctx, k.assets.frame, r, 'saturate(0.9) brightness(0.55)')
    const fade = ctx.createLinearGradient(0, 0, 0, H)
    fade.addColorStop(0, 'rgba(8,8,10,0.55)')
    fade.addColorStop(0.55, 'rgba(8,8,10,0.82)')
    fade.addColorStop(1, 'rgba(8,8,10,0.97)')
    ctx.fillStyle = fade
    ctx.fillRect(0, 0, W, H)
  }
  const glow = ctx.createRadialGradient(W * 0.5, heroMid, 20, W * 0.5, heroMid, W * 0.62)
  glow.addColorStop(0, 'rgba(217,70,239,0.16)')
  glow.addColorStop(1, 'rgba(217,70,239,0)')
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, W, H)
  grain(ctx, { x: 0, y: 0, w: W, h: H }, Math.round((W * H) / 220))
}

function paintPoster(k: Kit) {
  const { ctx, W, H } = k
  ctx.save()
  rrect(ctx, { x: 0, y: 0, w: W, h: H }, 14)
  ctx.clip()
  if (k.tall)
    posterTall(k)
  else
    posterBanner(k)
  ctx.restore()
}

function kicker(k: Kit): string {
  const c = k.data.creator.trim()
  return c ? `script by ${c}` : 'funscript'
}

/** Speed legend: a gradient bar from 0 to where the colours top out, the ends labelled. */
function posterLegend(k: Kit, x: number, y: number, w: number) {
  const { ctx } = k
  const max = k.opts.palette === 'ofs' ? 400 : 600
  const g = ctx.createLinearGradient(x, 0, x + w, 0)
  for (let i = 0; i <= 24; i++)
    g.addColorStop(i / 24, heatColor((i / 24) * max, k.opts.palette))
  rrect(ctx, { x, y, w, h: 6 }, 3)
  ctx.fillStyle = g
  ctx.fill()
  const o = { weight: 500, size: 10.5, family: MONO, color: POSTER.faint, spacing: 1.2 }
  text(ctx, '0', x, y + 22, o)
  text(ctx, `${max}+ U/S`, x + w, y + 22, { ...o, align: 'right' })
  text(ctx, 'SPEED', x + w / 2, y + 22, { ...o, align: 'center' })
}

function posterBanner(k: Kit) {
  const { ctx, W, H } = k
  const P = 36
  const named = k.chapters.length > 1
  const heroTop = named ? 126 : 112
  const extra = k.extra.length
  const rowStep = 13
  // Bottom up: numbers, then the extra axes, the heatmap in what is left.
  const statsTop = H - 72
  const rowsH = extra ? extra * rowStep + 6 : 0
  const heroH = Math.max(60, statsTop - 14 - rowsH - heroTop)
  posterBackdrop(k, heroTop + heroH / 2)

  // Top: kicker, title, the mark.
  const markH = 34
  const markW = picWidth(k.assets.wordmarkNight, markH)
  drawPic(ctx, k.assets.wordmarkNight, W - P - markW + 8, 22, markH)
  const kick = ellipsize(measurer(ctx, 500, MONO, 3), kicker(k).toUpperCase(), 12, W - P * 2 - markW - 30)
  text(ctx, kick, P, 42, { weight: 500, size: 12, family: MONO, color: POSTER.hot, spacing: 3 })
  const t = fitText(measurer(ctx, 800, SANS, -1.2), k.data.title, W - P * 2 - markW - 30, 46, 28)
  text(ctx, t.text, P - 2, 88, { weight: 800, size: t.size, family: SANS, color: POSTER.text, spacing: -1.2 })

  // The heatmap, edge to edge.
  const hero: Rect = { x: 0, y: heroTop, w: W, h: heroH }
  posterHero(k, hero, 14)
  if (named)
    drawChapterNames(ctx, hero, k, heroTop - 10, { weight: 500, size: 11, family: MONO, color: POSTER.muted, spacing: 0.5, minX: P })
  const rows: Rect[] = []
  for (let i = 0; i < extra; i++)
    rows.push({ x: P + 70, y: heroTop + heroH + 8 + i * rowStep, w: W - P * 2 - 70, h: 8 })
  posterRows(k, rows, P)

  // Bottom: the numbers, big; a legend on the right.
  const stats = statList(k)
  let x = P
  const by = H - 24
  stats.forEach((s) => {
    text(ctx, s.label.toUpperCase(), x, by - 34, { weight: 500, size: 10.5, family: MONO, color: POSTER.faint, spacing: 1.6 })
    const w = text(ctx, s.value, x - 1, by, { weight: 700, size: 30, family: SANS, color: POSTER.text, spacing: -0.8 })
    x += Math.max(w, 90) + 38
  })
  posterLegend(k, W - P - 220, by - 30, 220)
}

function posterTall(k: Kit) {
  const { ctx, W, H } = k
  const P = 48
  const named = k.chapters.length > 1
  const heroTop = named ? 128 : 108
  const extra = k.extra.length
  const heroH = extra ? 250 : 330
  posterBackdrop(k, heroTop + heroH / 2)

  const markH = 44
  const markW = picWidth(k.assets.wordmarkNight, markH)
  drawPic(ctx, k.assets.wordmarkNight, W - P - markW + 10, 30, markH)
  const kick = ellipsize(measurer(ctx, 500, MONO, 3), kicker(k).toUpperCase(), 13, W - P * 2 - markW - 30)
  text(ctx, kick, P, 62, { weight: 500, size: 13, family: MONO, color: POSTER.hot, spacing: 3 })

  const hero: Rect = { x: 0, y: heroTop, w: W, h: heroH }
  posterHero(k, hero, 22)
  if (named)
    drawChapterNames(ctx, hero, k, heroTop - 12, { weight: 500, size: 12, family: MONO, color: POSTER.muted, spacing: 0.5, minX: P })
  const rows: Rect[] = []
  for (let i = 0; i < extra; i++)
    rows.push({ x: P + 80, y: heroTop + heroH + 14 + i * 18, w: W - P * 2 - 80, h: 11 })
  posterRows(k, rows, P)
  const below = rows.length ? rows[rows.length - 1].y + rows[rows.length - 1].h : heroTop + heroH
  drawTicks(ctx, { x: P + (extra ? 80 : 0), y: 0, w: W - P * 2 - (extra ? 80 : 0), h: 0 }, k, below + 26, { size: 11.5, family: MONO, color: POSTER.faint, maxTicks: 10 })

  // The title, huge, sitting on the numbers.
  const rowY = H - 50
  const t = fitTitle(measurer(ctx, 800, SANS, -2.5), k.data.title, W - P * 2, 80, 64, 40)
  const lineH = t.size * 0.98
  let y = rowY - 112 - (t.lines.length - 1) * lineH
  // Never up into the time axis.
  y = Math.max(y, below + 56 + t.size * 0.75)
  for (const line of t.lines) {
    text(ctx, line, P - 3, y, { weight: 800, size: t.size, family: SANS, color: POSTER.text, spacing: -2.5 })
    y += lineH
  }

  // Numbers, in a row of six with hairlines between.
  const stats = statList(k, true)
  const colW = (W - P * 2) / stats.length
  stats.forEach((s, i) => {
    const x = P + i * colW
    if (i > 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.08)'
      ctx.fillRect(x - 14, rowY - 62, 1, 70)
    }
    text(ctx, s.label.toUpperCase(), x, rowY - 44, { weight: 500, size: 11, family: MONO, color: POSTER.faint, spacing: 1.6 })
    const v = fitText(measurer(ctx, 700, SANS, -1), s.value, colW - 28, 40, 24)
    text(ctx, v.text, x - 1, rowY, { weight: 700, size: v.size, family: SANS, color: POSTER.text, spacing: -1 })
  })

  // How the time splits by speed: a thin bar along the bottom edge.
  const mix = speedMix(k.main?.actions ?? [])
  let x = 0
  for (const b of mix) {
    if (b.share <= 0)
      continue
    ctx.fillStyle = heatColor(b.sample, k.opts.palette)
    ctx.fillRect(x, H - 6, b.share * W + 0.5, 6)
    x += b.share * W
  }
  posterLegend(k, W - P - markW - 56 - 220, 48, 220)
}
