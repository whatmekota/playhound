/**
 * Drawing a share card: three looks (Forum, Candy, Poster) in two sizes, with
 * or without pictures from the video.
 *
 * Everything is laid out in card units (1200 wide) and drawn at CARD_SCALE,
 * on whatever 2D context it is given: an OffscreenCanvas for the export, the
 * same for the dialog's preview. The numbers, the stroke columns, the colour
 * scales and the text fitting come from ~/lib/shareCard.
 *
 * Fonts must already be loaded (see cardAssets.ts): a canvas does not wait
 * for a web font, it draws in the fallback.
 */
import type { Action } from '~/lib/funscriptAnalysis'
import type { CardChapter, CardPicture, CardSize, CardStats, CardStyle, HeatPalette, HeatScale, Measure, MixBand, Rect, StrokeCol } from '~/lib/shareCard'
import {
  bannerSplit,
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
  heatScale,
  rgbCss,
  speedMix,
  speedRange,
  stackRows,
  strokeColumns,
  tileGrid,
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

/** A picture from the video and when in it. */
export interface Shot {
  pic: Pic
  atMs: number
}

export interface CardAssets {
  /** The wordmark in the logo's own pink. */
  wordmark: Pic | null
  /** The logo as a sticker, tongue out. */
  sticker: Pic | null
  /** A frame of the video behind the card, or null for none. */
  frame?: Pic | null
  /** The pictures for the card itself: the main one first. */
  shots?: Shot[]
}

export interface CardOptions {
  style: CardStyle
  size: CardSize
  palette: HeatPalette
  fit: boolean
  chapters: boolean
  picture: CardPicture
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
  scale: HeatScale
  /** The pictures to show: one, or up to four in time order. Empty for none. */
  shots: Shot[]
}

function makeKit(ctx: Ctx, W: number, H: number, data: CardData, assets: CardAssets, opts: CardOptions): Kit {
  const main = data.axes[0] ?? null
  const stats = cardStats(main?.actions ?? [], data.durationMs)
  const all = opts.picture === 'none' ? [] : (assets.shots ?? []).filter(s => s.pic)
  const shots = opts.picture === 'four' ? all.slice(0, 4).sort((a, b) => a.atMs - b.atMs) : all.slice(0, 1)
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
    scale: heatScale(opts.palette, opts.fit ? speedRange(main?.actions ?? []) : null),
    shots,
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

interface TextOpts { weight: number | string, size: number, family: string, color: string, spacing?: number, align?: CanvasTextAlign, shadow?: string }

function text(ctx: Ctx, s: string, x: number, y: number, o: TextOpts) {
  setFont(ctx, o.weight, o.size, o.family, o.spacing ?? 0)
  ctx.fillStyle = o.color
  ctx.textAlign = o.align ?? 'left'
  if (o.shadow) {
    ctx.save()
    ctx.shadowColor = o.shadow
    ctx.shadowBlur = Math.max(4, o.size * 0.35)
    ctx.shadowOffsetY = 1
    ctx.fillText(s, x, y)
    ctx.restore()
  }
  else {
    ctx.fillText(s, x, y)
  }
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

/**
 * The wordmark, lifted off whatever is under it: the logo's own pink with its
 * pale rim, and a soft shadow so it stays crisp over a frame or a dark card.
 */
function drawMark(k: Kit, x: number, y: number, h: number, shadow = 'rgba(0,0,0,0.55)') {
  const { ctx } = k
  const pic = k.assets.wordmark
  if (!pic)
    return 0
  ctx.save()
  ctx.shadowColor = shadow
  ctx.shadowBlur = h * 0.28
  ctx.shadowOffsetY = h * 0.06
  const w = drawPic(ctx, pic, x, y, h)
  ctx.restore()
  return w
}

/** The video frame, cover-fit into `r`. */
function drawFrame(ctx: Ctx, pic: Pic, r: Rect, filter = 'none', focusY = 0.4) {
  const src = coverCrop(pic.w, pic.h, r, focusY)
  ctx.save()
  ctx.filter = filter
  ctx.drawImage(pic.img, src.x, src.y, src.w, src.h, r.x, r.y, r.w, r.h)
  ctx.restore()
}

/** The background frame: blurred harder when a sharp picture sits on top of it. */
function backdropBlur(k: Kit, base: number) {
  return k.shots.length ? base + 8 : base
}

/** A picture from the video in a rounded box, with when it is from in a chip. */
function drawShot(ctx: Ctx, shot: Shot, r: Rect, radius: number, o: { family: string, ring?: string, ringW?: number, shadow?: string, chip?: boolean, chipSize?: number }) {
  if (o.shadow) {
    ctx.save()
    ctx.shadowColor = o.shadow
    ctx.shadowBlur = 18
    ctx.shadowOffsetY = 6
    rrect(ctx, r, radius)
    ctx.fillStyle = '#000'
    ctx.fill()
    ctx.restore()
  }
  ctx.save()
  rrect(ctx, r, radius)
  ctx.clip()
  ctx.fillStyle = '#000'
  ctx.fillRect(r.x, r.y, r.w, r.h)
  drawFrame(ctx, shot.pic, r, 'none', 0.45)
  ctx.restore()
  if (o.ring) {
    rrect(ctx, inset(r, -(o.ringW ?? 1) / 2), radius + (o.ringW ?? 1) / 2)
    ctx.strokeStyle = o.ring
    ctx.lineWidth = o.ringW ?? 1
    ctx.stroke()
  }
  if (o.chip !== false) {
    const size = o.chipSize ?? 12
    const label = formatDuration(shot.atMs)
    setFont(ctx, 600, size, o.family)
    const w = ctx.measureText(label).width + size * 1.1
    const h = size * 1.7
    const chip: Rect = { x: r.x + 8, y: r.y + r.h - h - 8, w, h }
    rrect(ctx, chip, h / 2)
    ctx.fillStyle = 'rgba(10,10,14,0.72)'
    ctx.fill()
    text(ctx, label, chip.x + w / 2, chip.y + h / 2 + size * 0.36, { weight: 600, size, family: o.family, color: '#fff', align: 'center' })
  }
}

/** One big picture, or a grid of up to four. */
function drawShots(k: Kit, r: Rect, cols: number, gap: number, radius: number, o: Parameters<typeof drawShot>[4]) {
  const tiles = k.shots.length > 1 ? tileGrid(r, k.shots.length, cols, gap) : [r]
  k.shots.forEach((s, i) => drawShot(k.ctx, s, tiles[i], radius, { ...o, chipSize: k.shots.length > 1 ? (o.chipSize ?? 12) - 1 : o.chipSize }))
}

/** Little pins along the top of the heatmap where the pictures are from. */
function drawMomentPins(k: Kit, r: Rect, color: string, outline = 'rgba(0,0,0,0.6)') {
  if (!k.shots.length || k.data.durationMs <= 0)
    return
  const { ctx } = k
  for (const s of k.shots) {
    const x = r.x + (s.atMs / k.data.durationMs) * r.w
    ctx.beginPath()
    ctx.moveTo(x - 5, r.y - 7)
    ctx.lineTo(x + 5, r.y - 7)
    ctx.lineTo(x, r.y - 1)
    ctx.closePath()
    ctx.lineWidth = 2
    ctx.strokeStyle = outline
    ctx.stroke()
    ctx.fillStyle = color
    ctx.fill()
  }
}

// ─── Heat ─────────────────────────────────────────────────────────────────────

/** Below this (units/s) the line counts as holding still. */
const REST_SPEED = 2
/** Bands in the wash under the line, each fainter than the last. */
const WASH_STEPS = 6

/** One column per device pixel of `width` card units. */
function colsFor(k: Kit, axis: CardAxis | null, width: number, speedWindowMs?: number): StrokeCol[] {
  return strokeColumns(axis?.actions ?? [], Math.max(80, Math.round(width * CARD_SCALE)), k.data.durationMs, speedWindowMs)
}

/** Column `i` of `n` across `r`, snapped to device pixels so neighbours neither overlap nor gap. */
function colX(r: Rect, i: number, n: number): [number, number] {
  const x0 = Math.round((r.x + (i * r.w) / n) * CARD_SCALE) / CARD_SCALE
  const x1 = Math.round((r.x + ((i + 1) * r.w) / n) * CARD_SCALE) / CARD_SCALE
  return [x0, x1 - x0]
}

/**
 * The script's position line, one pixel column at a time, in the colour of
 * its speed there, with a wash of the same colour under it: each stroke a
 * peak and a valley, solid only where strokes are narrower than a pixel or
 * two. A hold is a thin pale line; the wash fades out as the line slows, so
 * a script sitting still mid-range is not a block.
 */
function drawStrokes(ctx: Ctx, r: Rect, cols: StrokeCol[], scale: HeatScale, o: { line?: number, wash?: number, hold?: string } = {}) {
  const n = cols.length
  const lw = o.line ?? 1.5
  const wash = o.wash ?? 0.3
  const top = r.y + lw / 2
  const span = r.h - lw
  const Y = (p: number) => top + (1 - p) * span
  const bottom = r.y + r.h
  const depth = r.h * 0.45
  for (let i = 0; i < n; i++) {
    const c = cols[i]
    if (c.speed === null)
      continue
    const [x, w] = colX(r, i, n)
    if (w <= 0)
      continue
    const yHi = Y(c.hi)
    const yLo = Y(c.lo)
    if (c.speed < REST_SPEED) {
      ctx.fillStyle = o.hold ?? 'rgba(255,255,255,0.3)'
      ctx.fillRect(x, yHi - lw * 0.3, w, yLo - yHi + lw * 0.6)
      continue
    }
    const rgb = scale.rgb(c.speed)
    const a = wash * Math.min(1, c.speed / 80)
    if (a > 0.01) {
      // Strongest just under the line, gone a little way down: a glow, not a block.
      const step = depth / WASH_STEPS
      for (let j = 0; j < WASH_STEPS; j++) {
        const y0 = yHi + j * step
        if (y0 >= bottom)
          break
        ctx.fillStyle = rgbCss(rgb, Math.round(a * (1 - j / WASH_STEPS) * 1000) / 1000)
        ctx.fillRect(x, y0, w, Math.min(step, bottom - y0))
      }
    }
    ctx.fillStyle = rgbCss(rgb)
    ctx.fillRect(x, yHi - lw / 2, w, yLo - yHi + lw)
  }
}

/** An extra axis as a thin strip: only the colour of its speed, column by column. */
function drawStrip(ctx: Ctx, r: Rect, cols: StrokeCol[], scale: HeatScale) {
  const n = cols.length
  for (let i = 0; i < n; i++) {
    const c = cols[i]
    if (c.speed === null || c.speed < REST_SPEED)
      continue
    const [x, w] = colX(r, i, n)
    ctx.fillStyle = scale.color(c.speed)
    ctx.fillRect(x, r.y, w, r.h)
  }
}

function drawAxisStrip(k: Kit, r: Rect, axis: CardAxis) {
  drawStrip(k.ctx, r, colsFor(k, axis, r.w, 800), k.scale)
}

/** The busiest `ms` of the main axis drawn as its position line, each segment in its speed's colour. */
function drawCloseUp(ctx: Ctx, r: Rect, actions: Action[], win: { start: number, end: number }, scale: HeatScale, lineW: number, glow = 0) {
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
    segs.push({ x0: X(t0), y0: Y(p0), x1: X(t1), y1: Y(p1), color: scale.color(Math.max(speed, 30)) })
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

function drawMixBar(ctx: Ctx, r: Rect, mix: MixBand[], scale: HeatScale, radius: number) {
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
    ctx.fillStyle = scale.color(b.sample)
    ctx.fillRect(x, r.y, w + 0.5, r.h)
    x += w
  }
  ctx.restore()
}

/**
 * The bands under the mix bar as columns: a dot and the range, the share
 * big under it. `top` is the range's baseline.
 */
function drawMixLegend(ctx: Ctx, x: number, top: number, w: number, mix: MixBand[], scale: HeatScale, o: { family: string, rangeColor: string, pctColor: string, pctSize: number, pctWeight: number, rangeWeight?: number }) {
  const pct = percents(mix)
  const colW = w / mix.length
  mix.forEach((b, i) => {
    const cx = x + i * colW
    ctx.fillStyle = scale.color(b.sample)
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

/** A speed for a legend: tens above a hundred. */
function legendSpeed(s: number) {
  return String(s >= 100 ? Math.round(s / 10) * 10 : Math.round(s))
}

/**
 * What the colours mean: a bar through the scale with the speeds at its ends
 * and middle, the bar's top at `y`. Fitted, it says so, and gives the
 * script's own range.
 */
function drawScaleLegend(k: Kit, x: number, y: number, w: number, o: { family: string, color: string, size?: number, barH?: number, caption?: boolean, shadow?: string, inline?: boolean }) {
  const { ctx, scale } = k
  const barH = o.barH ?? 6
  const size = o.size ?? 10.5
  const t: TextOpts = { weight: 500, size, family: o.family, color: o.color, spacing: 0.4, shadow: o.shadow }
  const lo = scale.fit ? legendSpeed(scale.at(0)) : '0'
  const hi = `${legendSpeed(scale.at(1))}+ u/s`
  const bar = (bx: number, bw: number, by: number) => {
    const g = ctx.createLinearGradient(bx, 0, bx + bw, 0)
    for (let i = 0; i <= 32; i++)
      g.addColorStop(i / 32, scale.color(scale.at(i / 32)))
    rrect(ctx, { x: bx, y: by, w: bw, h: barH }, barH / 2)
    ctx.fillStyle = g
    ctx.fill()
  }
  if (o.inline) {
    // One line, `y` its baseline: "0 ▬▬▬ 1100+ u/s", "fitted" before it when it is.
    const m = measurer(ctx, 500, o.family, 0.4)
    const fitted = scale.fit ? 'fitted  ' : ''
    const loW = m(fitted + lo, size)
    const hiW = m(hi, size)
    text(ctx, fitted + lo, x, y, t)
    bar(x + loW + 8, w - loW - hiW - 16, y - size * 0.36 - barH / 2)
    text(ctx, hi, x + w, y, { ...t, align: 'right' })
    return
  }
  bar(x, w, y)
  const ly = y + barH + size + 4
  text(ctx, lo, x, ly, t)
  text(ctx, legendSpeed(scale.at(0.5)), x + w / 2, ly, { ...t, align: 'center' })
  text(ctx, hi, x + w, ly, { ...t, align: 'right' })
  if (o.caption !== false)
    text(ctx, scale.fit ? 'fitted to this script' : 'speed', x + w, y - 6, { ...t, align: 'right' })
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
function drawChapterNames(ctx: Ctx, r: Rect, k: Kit, y: number, o: { weight: number, size: number, family: string, color: string, mark?: string, spacing?: number, minX?: number, shadow?: string }) {
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
function drawTicks(ctx: Ctx, r: Rect, k: Kit, y: number, o: { size: number, family: string, color: string, weight?: number, stopX?: number, maxTicks?: number, shadow?: string }) {
  const ticks = timeTicks(k.data.durationMs, o.maxTicks ?? 8)
  const stop = o.stopX ?? r.x + r.w
  const end = formatDuration(k.data.durationMs)
  setFont(ctx, o.weight ?? 400, o.size, o.family)
  const endW = ctx.measureText(end).width
  const t: TextOpts = { weight: o.weight ?? 400, size: o.size, family: o.family, color: o.color, shadow: o.shadow }
  let lastRight = Number.NEGATIVE_INFINITY
  for (const tick of ticks) {
    const x = r.x + (tick / k.data.durationMs) * r.w
    const label = formatDuration(tick)
    setFont(ctx, t.weight, t.size, t.family)
    const w = ctx.measureText(label).width
    if (x < lastRight + 12 || x + w > stop - 8)
      continue
    if (stop >= r.x + r.w - 1 && x + w > r.x + r.w - endW - 20)
      continue
    text(ctx, label, x, y, t)
    lastRight = x + w
  }
  if (stop >= r.x + r.w - 1)
    text(ctx, end, r.x + r.w, y, { ...t, align: 'right' })
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
// type in the app's own Geist, the mark in a corner.

const FORUM = {
  bg: '#202125',
  bgTop: '#26272c',
  well: '#111113',
  tile: '#2a2b30',
  line: 'rgba(255,255,255,0.07)',
  text: '#f2f2f4',
  muted: '#b4b4bd',
  faint: '#8a8a94',
  accent: '#e879f9',
}

/** Text over a frame gets a soft dark halo; on the plain card it needs none. */
function forumShadow(k: Kit) {
  return k.assets.frame ? 'rgba(0,0,0,0.65)' : undefined
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
    drawFrame(ctx, k.assets.frame, card, `blur(${backdropBlur(k, 3)}px) brightness(0.42) saturate(0.85)`)
    // Darker where the words are (the top) and under the heatmap.
    const veil = ctx.createLinearGradient(0, 0, 0, H)
    veil.addColorStop(0, 'rgba(22,22,26,0.55)')
    veil.addColorStop(0.5, 'rgba(22,22,26,0.35)')
    veil.addColorStop(1, 'rgba(22,22,26,0.6)')
    ctx.fillStyle = veil
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
  drawStrokes(ctx, inset(hero, 0, 6), colsFor(k, k.main, hero.w), k.scale)
  drawChapterLines(ctx, hero, k, 'rgba(255,255,255,0.45)', 1, [3, 3])
  ctx.restore()
  rows.forEach((r, i) => {
    ctx.save()
    rrect(ctx, r, 3)
    ctx.fillStyle = FORUM.well
    ctx.fill()
    ctx.clip()
    drawAxisStrip(k, r, k.extra[i])
    ctx.restore()
  })
  if (o.gutter > 0) {
    const label = (s: string, r: Rect) => text(ctx, s, area.x + o.gutter - 12, r.y + r.h / 2 + 4.5, { weight: 500, size: 13, family: SANS, color: FORUM.muted, align: 'right', shadow: forumShadow(k) })
    label(k.main?.name ?? 'stroke', hero)
    rows.forEach((r, i) => label(k.extra[i].name, r))
  }
  drawMomentPins(k, hero, FORUM.accent)
  return { hero, rows }
}

function forumPictures(k: Kit, r: Rect) {
  drawShots(k, r, 2, 8, 10, { family: SANS, ring: 'rgba(255,255,255,0.14)', shadow: 'rgba(0,0,0,0.45)' })
}

function forumBanner(k: Kit) {
  const { ctx, W, H } = k
  const P = 32
  const multi = k.extra.length > 0
  const sh = forumShadow(k)
  const split = k.shots.length ? bannerSplit({ x: P, y: P, w: W - P * 2, h: H - P * 2 }, 4 / 3, 30, 600) : null
  if (split)
    forumPictures(k, split.panel)
  const left = split ? split.rest.x : P

  const stats = statList(k)
  const labelM = measurer(ctx, 600, SANS, 1.1)
  let top: number
  if (!split) {
    // Stats, right-aligned along the top; the title beside them.
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
      text(ctx, s.label.toUpperCase(), x, 52, { weight: 600, size: 11, family: SANS, color: FORUM.faint, spacing: 1.1, shadow: sh })
      text(ctx, s.value, x, 87, { weight: 600, size: 28, family: SANS, color: FORUM.text, spacing: -0.6, shadow: sh })
      x += cols[i] + gap
    })
    const maxW = statsLeft - P - 36
    const t = fitText(measurer(ctx, 600, SANS, -0.3), k.data.title, maxW, 31, 22)
    text(ctx, t.text, P, 64, { weight: 600, size: t.size, family: SANS, color: FORUM.text, spacing: -0.3, shadow: sh })
    const meta = ellipsize(measurer(ctx, 400, SANS), metaLine(k), 15.5, maxW)
    text(ctx, meta, P, 92, { weight: 400, size: 15.5, family: SANS, color: FORUM.muted, shadow: sh })
    top = k.chapters.length > 1 ? 138 : 120
  }
  else {
    // Beside the picture: the title, then the stats in a row under it.
    const maxW = W - P - left
    const t = fitText(measurer(ctx, 600, SANS, -0.3), k.data.title, maxW, 28, 19)
    text(ctx, t.text, left, P + 24, { weight: 600, size: t.size, family: SANS, color: FORUM.text, spacing: -0.3, shadow: sh })
    const meta = ellipsize(measurer(ctx, 400, SANS), metaLine(k), 14.5, maxW)
    text(ctx, meta, left, P + 50, { weight: 400, size: 14.5, family: SANS, color: FORUM.muted, shadow: sh })
    const valueM = measurer(ctx, 600, SANS, -0.5)
    let x = left
    stats.forEach((s, i) => {
      if (i > 0) {
        ctx.fillStyle = FORUM.line
        ctx.fillRect(x - 14, P + 70, 1, 42)
      }
      text(ctx, s.label.toUpperCase(), x, P + 82, { weight: 600, size: 10.5, family: SANS, color: FORUM.faint, spacing: 1.1, shadow: sh })
      text(ctx, s.value, x, P + 108, { weight: 600, size: 23, family: SANS, color: FORUM.text, spacing: -0.5, shadow: sh })
      x += Math.max(labelM(s.label.toUpperCase(), 10.5), valueM(s.value, 23)) + 28
    })
    top = P + (k.chapters.length > 1 ? 146 : 128)
  }

  // The heatmap.
  const area: Rect = { x: left, y: top, w: W - P - left, h: H - 52 - top }
  const { hero } = forumHeatBlock(k, area, { gutter: multi ? 64 : 0, rowH: split ? 9 : 11, minHero: 64 })
  if (k.chapters.length > 1)
    drawChapterNames(ctx, hero, k, top - 9, { weight: 500, size: 12.5, family: SANS, color: FORUM.muted, mark: FORUM.accent, shadow: sh })

  // Along the bottom: time, the colours, the mark.
  const markH = 40
  const markW = picWidth(k.assets.wordmark, markH)
  drawMark(k, W - P - markW + 6, H - markH - 4, markH)
  const lw = 150
  const lx = W - P - markW - 22 - lw
  drawScaleLegend(k, lx, H - 38, lw, { family: MONO, color: FORUM.faint, size: 10, barH: 5, caption: false, shadow: sh })
  drawTicks(ctx, hero, k, H - 20, { size: 11.5, family: MONO, color: FORUM.faint, stopX: lx - 18, shadow: sh })
}

function forumTiles(k: Kit, stats: Stat[], area: Rect, cols: number, valueSize: number) {
  const { ctx } = k
  const tiles = tileGrid(area, stats.length, cols, 12)
  stats.forEach((s, i) => {
    const r = tiles[i]
    rrect(ctx, r, 10)
    ctx.fillStyle = k.assets.frame ? 'rgba(42,43,48,0.88)' : FORUM.tile
    ctx.fill()
    const midY = r.y + r.h / 2
    text(ctx, s.label.toUpperCase(), r.x + 16, midY - valueSize * 0.5 - 4, { weight: 600, size: 11, family: SANS, color: FORUM.faint, spacing: 1.1 })
    const v = fitText(measurer(ctx, 600, SANS, -0.6), s.value, r.w - 32, valueSize, 18)
    text(ctx, v.text, r.x + 16, midY + valueSize * 0.62, { weight: 600, size: v.size, family: SANS, color: FORUM.text, spacing: -0.6 })
  })
}

function forumTall(k: Kit) {
  const { ctx, W, H } = k
  const P = 44
  const multi = k.extra.length > 0
  const sh = forumShadow(k)

  // Header: title (two lines at most), what it is, the mark.
  const markH = 58
  const markW = picWidth(k.assets.wordmark, markH)
  drawMark(k, W - P - markW + 8, 30, markH)
  const maxW = W - P * 2 - markW - 36
  const t = fitTitle(measurer(ctx, 600, SANS, -0.6), k.data.title, maxW, 42, 34, 28)
  let y = 42 + t.size * 0.9
  t.lines.forEach((line, i) => {
    if (i > 0)
      y += t.size * 1.1
    text(ctx, line, P, y, { weight: 600, size: t.size, family: SANS, color: FORUM.text, spacing: -0.6, shadow: sh })
  })
  const meta = ellipsize(measurer(ctx, 400, SANS), metaLine(k), 17, maxW)
  y += 34
  text(ctx, meta, P, y, { weight: 400, size: 17, family: SANS, color: FORUM.muted, shadow: sh })

  const stats = statList(k, true)
  const bodyY = y + 28
  let headY: number
  if (k.shots.length === 1) {
    // The picture big on the left, the numbers in a block beside it.
    const ph = 360
    const pw = Math.round((ph * 16) / 9)
    forumPictures(k, { x: P, y: bodyY, w: pw, h: ph })
    forumTiles(k, stats, { x: P + pw + 24, y: bodyY, w: W - P * 2 - pw - 24, h: ph }, 2, 32)
    headY = bodyY + ph + 42
  }
  else if (k.shots.length > 1) {
    // The moments in a strip, the numbers in a row under them.
    const strip: Rect = { x: P, y: bodyY, w: W - P * 2, h: 0 }
    strip.h = Math.round(((strip.w - 12 * 3) / 4) * 9 / 16)
    drawShots(k, strip, 4, 12, 10, { family: SANS, ring: 'rgba(255,255,255,0.14)', shadow: 'rgba(0,0,0,0.45)' })
    forumTiles(k, stats, { x: P, y: strip.y + strip.h + 18, w: W - P * 2, h: 80 }, 6, 30)
    headY = strip.y + strip.h + 18 + 80 + 40
  }
  else {
    forumTiles(k, stats, { x: P, y: bodyY, w: W - P * 2, h: 80 }, 6, 30)
    headY = bodyY + 80 + 40
  }

  // With a picture the heatmap takes the rest; without, the panels sit under it.
  const pictured = k.shots.length > 0
  const panelH = 168
  const panelY = H - 40 - panelH
  const ticksY = pictured ? H - 30 : panelY - 34
  const named = k.chapters.length > 1
  text(ctx, 'SPEED', P, headY, { weight: 600, size: 11, family: SANS, color: FORUM.faint, spacing: 1.1, shadow: sh })
  drawScaleLegend(k, W - P - 300, headY, 300, { family: MONO, color: FORUM.faint, size: 11, barH: 6, shadow: sh, inline: true })
  const top = headY + (named ? 34 : 18)
  const area: Rect = { x: P, y: top, w: W - P * 2, h: ticksY - 22 - top }
  const { hero } = forumHeatBlock(k, area, { gutter: multi ? 70 : 0, rowH: 15, minHero: 90 })
  if (named)
    drawChapterNames(ctx, hero, k, top - 11, { weight: 500, size: 13, family: SANS, color: FORUM.muted, mark: FORUM.accent, shadow: sh })
  drawTicks(ctx, hero, k, ticksY, { size: 12, family: MONO, color: FORUM.faint, maxTicks: 10, shadow: sh })
  if (pictured)
    return

  // A close-up of the busiest stretch, and how the time splits by speed.
  const leftW = Math.round((W - P * 2) * 0.58)
  const win = closeUpWindow(k)
  text(ctx, 'BUSIEST STRETCH', P, panelY + 4, { weight: 600, size: 11, family: SANS, color: FORUM.faint, spacing: 1.1, shadow: sh })
  if (win)
    text(ctx, spanLabel(win), P + leftW, panelY + 4, { weight: 400, size: 12, family: MONO, color: FORUM.faint, align: 'right', shadow: sh })
  const well: Rect = { x: P, y: panelY + 16, w: leftW, h: panelH - 16 }
  rrect(ctx, well, 8)
  ctx.fillStyle = FORUM.well
  ctx.fill()
  if (win && k.main)
    drawCloseUp(ctx, inset(well, 14, 12), k.main.actions, win, k.scale, 2.6)

  const mx = P + leftW + 36
  const mw = W - P - mx
  text(ctx, 'TIME AT EACH SPEED', mx, panelY + 4, { weight: 600, size: 11, family: SANS, color: FORUM.faint, spacing: 1.1, shadow: sh })
  const mix = speedMix(k.main?.actions ?? [])
  drawMixBar(ctx, { x: mx, y: panelY + 16, w: mw, h: 14 }, mix, k.scale, 4)
  drawMixLegend(ctx, mx, panelY + 66, mw, mix, k.scale, { family: SANS, rangeColor: FORUM.muted, pctColor: FORUM.text, pctSize: 26, pctWeight: 600 })
  text(ctx, movingLine(k), mx, panelY + panelH - 4, { weight: 400, size: 14, family: SANS, color: FORUM.faint, shadow: sh })
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
    // The frame shows through the candy as a soft pink-tinted picture: light
    // enough for the dark ink on it, most of all at the top where the title is.
    drawFrame(ctx, k.assets.frame, face, `blur(${backdropBlur(k, 2)}px) saturate(1.1)`)
    const tint = ctx.createLinearGradient(0, face.y, 0, face.y + face.h)
    tint.addColorStop(0, 'rgba(255,238,250,0.9)')
    tint.addColorStop(0.45, 'rgba(253,222,246,0.8)')
    tint.addColorStop(1, 'rgba(251,205,239,0.76)')
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
  drawStrokes(ctx, hero, colsFor(k, k.main, hero.w), k.scale, { line: 1.6 })
  drawChapterLines(ctx, { ...hero, y: r.y, h: hero.h + (hero.y - r.y) }, k, 'rgba(255,255,255,0.55)', 1.5, [2, 4])
  rows.forEach((row, i) => {
    rrect(ctx, row, row.h / 2)
    ctx.save()
    ctx.clip()
    ctx.fillStyle = 'rgba(0,0,0,0.4)'
    ctx.fillRect(row.x, row.y, row.w, row.h)
    drawAxisStrip(k, row, k.extra[i])
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
  drawMomentPins(k, { ...r, y: r.y + 1 }, '#ffffff', CANDY.rim)
  return { well: r, hero, rows }
}

function candyPill(ctx: Ctx, r: Rect, s: Stat, valueSize: number) {
  ctx.save()
  ctx.shadowColor = 'rgba(192,38,211,0.28)'
  ctx.shadowBlur = 10
  ctx.shadowOffsetY = 4
  rrect(ctx, r, Math.min(r.h / 2, 32))
  ctx.fillStyle = CANDY.pill
  ctx.fill()
  ctx.restore()
  rrect(ctx, r, Math.min(r.h / 2, 32))
  ctx.strokeStyle = '#f5d0fe'
  ctx.lineWidth = 2
  ctx.stroke()
  const cx = r.x + r.w / 2
  const block = 11 + 6 + valueSize * 0.72
  const top = r.y + (r.h - block) / 2
  text(ctx, s.label.toUpperCase(), cx, top + 9, { weight: 600, size: 11, family: ROUND, color: CANDY.label, spacing: 1, align: 'center' })
  text(ctx, s.value, cx, top + block, { weight: 700, size: valueSize, family: ROUND, color: CANDY.ink, align: 'center' })
}

/** Pictures on Candy: framed in white like photos stuck on the sticker. */
function candyPictures(k: Kit, r: Rect, cols: number) {
  drawShots(k, r, cols, 10, 18, { family: ROUND, ring: '#ffffff', ringW: 5, shadow: 'rgba(134,25,143,0.4)' })
}

/** The wordmark on Candy: the pink face is its home, a lighter shadow does. */
function candyMark(k: Kit, x: number, y: number, h: number) {
  return drawMark(k, x, y, h, 'rgba(134,25,143,0.35)')
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
  const split = k.shots.length ? bannerSplit({ x: P - 6, y: 62, w: W - (P - 6) * 2, h: face.y + face.h - 62 - 22 }, 4 / 3, 26, 600) : null
  if (split)
    candyPictures(k, split.panel, 2)
  const left = split ? split.rest.x : P

  const stats = statList(k)
  const lm = measurer(ctx, 600, ROUND, 1)
  const vm = measurer(ctx, 700, ROUND)
  let top: number
  if (!split) {
    // Stat pills, right; the title left of them.
    const widths = stats.map(s => Math.max(lm(s.label.toUpperCase(), 11), vm(s.value, 22)) + 36)
    const gap = 10
    let x = W - P - widths.reduce((a, b) => a + b, 0) - gap * (widths.length - 1)
    const statsLeft = x
    stats.forEach((s, i) => {
      candyPill(ctx, { x, y: 56, w: widths[i], h: 54 }, s, 22)
      x += widths[i] + gap
    })
    const maxW = statsLeft - P - 28
    const t = fitText(measurer(ctx, 700, ROUND), k.data.title, maxW, 34, 22)
    text(ctx, t.text, P, 88, { weight: 700, size: t.size, family: ROUND, color: CANDY.ink })
    const meta = ellipsize(measurer(ctx, 500, ROUND), metaLine(k), 16, maxW)
    text(ctx, meta, P, 112, { weight: 500, size: 16, family: ROUND, color: CANDY.inkSoft })
    sparkle(ctx, W - 30, 50, 7, CANDY.sparkle)
    sparkle(ctx, statsLeft - 16, 60, 5, CANDY.sparkleSoft)
    top = k.chapters.length > 1 ? 146 : 128
  }
  else {
    const maxW = W - P - left
    // Below the longest drips.
    const t = fitText(measurer(ctx, 700, ROUND), k.data.title, maxW, 28, 20)
    text(ctx, t.text, left, 84, { weight: 700, size: t.size, family: ROUND, color: CANDY.ink })
    const meta = ellipsize(measurer(ctx, 500, ROUND), metaLine(k), 14.5, maxW)
    text(ctx, meta, left, 105, { weight: 500, size: 14.5, family: ROUND, color: CANDY.inkSoft })
    const gap = 8
    const widths = stats.map(s => Math.max(lm(s.label.toUpperCase(), 10.5), vm(s.value, 18)) + 28)
    let x = left
    stats.forEach((s, i) => {
      candyPill(ctx, { x, y: 115, w: widths[i], h: 40 }, s, 18)
      x += widths[i] + gap
    })
    sparkle(ctx, W - 30, 50, 7, CANDY.sparkle)
    top = k.chapters.length > 1 ? 180 : 166
  }

  // Heatmap.
  const area: Rect = { x: left - (split ? 0 : 6), y: top, w: W - (P - 6) - left + (split ? 0 : 6), h: face.y + face.h - 50 - top }
  const { hero, well } = candyHeatBlock(k, area, { gutter: multi ? 64 : 0, rowH: split ? 8 : 10, minHero: split ? 36 : 56, radius: 18 })
  if (k.chapters.length > 1)
    drawChapterNames(ctx, hero, k, top - 9, { weight: 600, size: 13, family: ROUND, color: CANDY.inkSoft, mark: CANDY.rim })

  // The wordmark, the colours, and time.
  const markH = 46
  const markW = picWidth(k.assets.wordmark, markH)
  candyMark(k, W - P - markW + 12, H - markH - 14, markH)
  const lw = 150
  const lx = W - P - markW - 18 - lw
  drawScaleLegend(k, lx, H - 44, lw, { family: ROUND, color: CANDY.inkSoft, size: 11, barH: 6, caption: false })
  drawTicks(ctx, { ...hero, x: well.x + 12 }, k, H - 26, { size: 12.5, family: ROUND, weight: 500, color: CANDY.inkSoft, stopX: lx - 14 })
}

function candyTall(k: Kit, face: Rect) {
  const { ctx, W } = k
  const P = 52
  const multi = k.extra.length > 0
  const pictured = k.shots.length > 0

  // Logo sticker and wordmark, like the header.
  const logo = 118
  const logoY = 62
  drawPic(ctx, k.assets.sticker, P - 8, logoY, logo)
  const markH = 64
  const markW = picWidth(k.assets.wordmark, markH)
  candyMark(k, W - P - markW + 12, logoY + 2, markH)

  const tx = P + logo + 10
  const maxW = W - P - tx - markW - 16
  const t = fitTitle(measurer(ctx, 700, ROUND), k.data.title, maxW, 46, 36, 30)
  const lineH = t.size * 1.04
  // Title and meta line centred on the logo.
  const block = t.size * 0.72 + (t.lines.length - 1) * lineH + 34
  let y = logoY + logo / 2 - block / 2 + t.size * 0.72
  t.lines.forEach((line, i) => {
    if (i > 0)
      y += lineH
    text(ctx, line, tx, y, { weight: 700, size: t.size, family: ROUND, color: CANDY.ink })
  })
  const meta = ellipsize(measurer(ctx, 500, ROUND), metaLine(k), 18, maxW)
  text(ctx, meta, tx, y + 34, { weight: 500, size: 18, family: ROUND, color: CANDY.inkSoft })

  const stats = statList(k, true)
  const gap = 12
  let top: number
  if (k.shots.length === 1) {
    // The picture big on the left, the pills stacked beside it.
    const ph = 340
    const pw = Math.round((ph * 16) / 9)
    const py = logoY + logo + 26
    candyPictures(k, { x: P, y: py, w: pw, h: ph }, 1)
    const tiles = tileGrid({ x: P + pw + 26, y: py, w: W - P * 2 - pw - 26, h: ph }, stats.length, 2, gap)
    stats.forEach((s, i) => candyPill(ctx, tiles[i], s, 30))
    top = py + ph + (k.chapters.length > 1 ? 52 : 34)
  }
  else if (k.shots.length > 1) {
    const py = logoY + logo + 26
    const strip: Rect = { x: P, y: py, w: W - P * 2, h: 0 }
    strip.h = Math.round(((strip.w - 14 * 3) / 4) * 9 / 16)
    drawShots(k, strip, 4, 14, 16, { family: ROUND, ring: '#ffffff', ringW: 5, shadow: 'rgba(134,25,143,0.4)' })
    const pw = (W - P * 2 - gap * (stats.length - 1)) / stats.length
    const pillY = strip.y + strip.h + 22
    stats.forEach((s, i) => candyPill(ctx, { x: P + i * (pw + gap), y: pillY, w: pw, h: 64 }, s, 26))
    top = pillY + 64 + (k.chapters.length > 1 ? 50 : 30)
  }
  else {
    const pw = (W - P * 2 - gap * (stats.length - 1)) / stats.length
    stats.forEach((s, i) => candyPill(ctx, { x: P + i * (pw + gap), y: 212, w: pw, h: 64 }, s, 26))
    top = k.chapters.length > 1 ? 330 : 308
  }

  // Heatmap: the rest of the card with a picture, else above the panels.
  const panelH = 172
  const panelY = face.y + face.h - 24 - panelH
  const ticksY = pictured ? face.y + face.h - 30 : panelY - 26
  const area: Rect = { x: P - 6, y: top, w: W - (P - 6) * 2, h: ticksY - 26 - top }
  const { hero } = candyHeatBlock(k, area, { gutter: multi ? 70 : 0, rowH: 14, minHero: 100, radius: 22 })
  if (k.chapters.length > 1)
    drawChapterNames(ctx, hero, k, top - 10, { weight: 600, size: 14, family: ROUND, color: CANDY.inkSoft, mark: CANDY.rim })
  const lw = 280
  drawScaleLegend(k, W - P - lw, ticksY, lw, { family: ROUND, color: CANDY.inkSoft, size: 13, barH: 7, inline: true })
  drawTicks(ctx, hero, k, ticksY, { size: 13, family: ROUND, weight: 500, color: CANDY.inkSoft, maxTicks: 10, stopX: W - P - lw - 24 })

  sparkle(ctx, P + logo + 2, logoY + 8, 9, CANDY.sparkle)
  sparkle(ctx, W - 40, logoY + 88, 7, CANDY.sparkleSoft)
  if (pictured)
    return
  heart(ctx, P - 2, 196, 13, CANDY.sparkleSoft, -0.3)
  squiggle(ctx, W - P - 70, 160, 40, 4, CANDY.sparkleSoft, 3, -0.1)

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
    drawCloseUp(ctx, { x: left.x + 18, y: left.y + 40, w: left.w - 36, h: left.h - 54 }, k.main.actions, win, k.scale, 3, 4)
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
  drawMixBar(ctx, { x: right.x + 20, y: right.y + 42, w: right.w - 40, h: 16 }, mix, k.scale, 8)
  drawMixLegend(ctx, right.x + 20, right.y + 92, right.w - 40, mix, k.scale, { family: ROUND, rangeColor: CANDY.inkSoft, pctColor: CANDY.ink, pctSize: 26, pctWeight: 700, rangeWeight: 600 })
  text(ctx, movingLine(k), right.x + 20, right.y + right.h - 20, { weight: 500, size: 14, family: ROUND, color: '#c86fc9' })
}

// ─── Poster ───────────────────────────────────────────────────────────────────
// Bold and dark: the heatmap runs edge to edge and glows, the type is big, the
// numbers are the second thing you read.

const POSTER = {
  bg: '#08080a',
  text: '#fafafa',
  muted: '#b4b4bc',
  faint: '#7c7c86',
  accent: '#f0abfc',
  hot: '#f0abfc',
}

const POSTER_SHADOW = 'rgba(0,0,0,0.7)'

function posterHero(k: Kit, r: Rect, glow: number) {
  const { ctx } = k
  const cols = colsFor(k, k.main, r.w)
  // The glow: the same heatmap, blurred, under the sharp one.
  ctx.save()
  ctx.filter = `blur(${glow}px)`
  ctx.globalAlpha = 0.6
  drawStrokes(ctx, r, cols, k.scale, { line: 3, wash: 0.5 })
  ctx.restore()
  drawStrokes(ctx, r, cols, k.scale, { line: 1.8, wash: 0.32 })
  drawChapterLines(ctx, { x: r.x, y: r.y - 6, w: r.w, h: r.h + 12 }, k, 'rgba(255,255,255,0.5)', 1)
  drawMomentPins(k, r, POSTER.accent)
}

function posterRows(k: Kit, rows: Rect[], labelX: number) {
  const { ctx } = k
  rows.forEach((row, i) => {
    ctx.fillStyle = 'rgba(255,255,255,0.05)'
    ctx.fillRect(row.x, row.y, row.w, row.h)
    drawAxisStrip(k, row, k.extra[i])
    text(ctx, k.extra[i].name.toUpperCase(), labelX, row.y + row.h / 2 + 4, { weight: 500, size: 10.5, family: MONO, color: POSTER.muted, spacing: 1.6, shadow: POSTER_SHADOW })
  })
}

function posterBackdrop(k: Kit, heroMid: number, under?: () => void) {
  const { ctx, W, H } = k
  ctx.fillStyle = POSTER.bg
  ctx.fillRect(0, 0, W, H)
  // A tall card's pictures across its top are its frame: they fade into the dark.
  if (k.assets.frame && !(k.tall && k.shots.length)) {
    const r: Rect = { x: 0, y: 0, w: W, h: H }
    drawFrame(ctx, k.assets.frame, r, `blur(${backdropBlur(k, 0)}px) saturate(0.95) brightness(0.62)`)
    // The picture up top where the type is big; dark under the heatmap so it glows.
    // With pictures on top, darker all over, so where they fade out meets it.
    const pics = k.shots.length > 0
    const fade = ctx.createLinearGradient(0, 0, 0, H)
    fade.addColorStop(0, `rgba(8,8,10,${pics ? 0.82 : 0.45})`)
    fade.addColorStop(0.5, `rgba(8,8,10,${pics ? 0.86 : 0.8})`)
    fade.addColorStop(1, 'rgba(8,8,10,0.95)')
    ctx.fillStyle = fade
    ctx.fillRect(0, 0, W, H)
  }
  // Pictures go in before the glow and the grain, so those lie over all of it alike.
  under?.()
  const glow = ctx.createRadialGradient(W * 0.5, heroMid, 20, W * 0.5, heroMid, W * 0.62)
  glow.addColorStop(0, 'rgba(217,70,239,0.14)')
  glow.addColorStop(1, 'rgba(217,70,239,0)')
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, W, H)
  grain(ctx, { x: 0, y: 0, w: W, h: H }, Math.round((W * H) / 220))
}

/**
 * Poster pictures run to the card's edge and melt into it: a fade on the
 * side (or the bottom) that meets the rest of the card.
 */
function posterPictures(k: Kit, r: Rect, cols: number, fade: 'right' | 'bottom') {
  const { ctx } = k
  const tiles = k.shots.length > 1 ? tileGrid(r, k.shots.length, cols, 3) : [r]
  k.shots.forEach((s, i) => {
    ctx.save()
    ctx.beginPath()
    ctx.rect(tiles[i].x, tiles[i].y, tiles[i].w, tiles[i].h)
    ctx.clip()
    ctx.fillStyle = '#000'
    ctx.fillRect(tiles[i].x, tiles[i].y, tiles[i].w, tiles[i].h)
    drawFrame(ctx, s.pic, tiles[i], 'none', 0.45)
    ctx.restore()
  })
  const g = fade === 'right'
    ? ctx.createLinearGradient(r.x + r.w - 200, 0, r.x + r.w, 0)
    : ctx.createLinearGradient(0, r.y + r.h * 0.45, 0, r.y + r.h)
  g.addColorStop(0, 'rgba(8,8,10,0)')
  g.addColorStop(0.6, 'rgba(8,8,10,0.62)')
  g.addColorStop(1, fade === 'right' ? 'rgba(8,8,10,0.9)' : 'rgba(8,8,10,1)')
  ctx.fillStyle = g
  ctx.fillRect(r.x, r.y, r.w, r.h)
  // Time chips, set in from the faded side.
  k.shots.forEach((s, i) => {
    const t = tiles[i]
    const label = formatDuration(s.atMs)
    setFont(ctx, 500, 11, MONO, 1)
    const w = ctx.measureText(label).width + 14
    // One big picture has the title over its foot: its chip goes top right, under the mark.
    const big = fade === 'bottom' && k.shots.length === 1
    const x = big ? t.x + t.w - 48 - w : t.x + 12
    const y = big ? t.y + 100 : t.y + t.h - 30
    rrect(ctx, { x, y, w, h: 20 }, 4)
    ctx.fillStyle = 'rgba(8,8,10,0.72)'
    ctx.fill()
    text(ctx, label, x + w / 2, y + 14, { weight: 500, size: 11, family: MONO, color: POSTER.text, spacing: 1, align: 'center' })
  })
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

function posterLegend(k: Kit, x: number, y: number, w: number) {
  drawScaleLegend(k, x, y, w, { family: MONO, color: POSTER.muted, size: 10.5, barH: 6, caption: true, shadow: POSTER_SHADOW })
}

function posterBanner(k: Kit) {
  const { ctx, W, H } = k
  const P = 36
  const named = k.chapters.length > 1
  const extra = k.extra.length
  const rowStep = 13
  const split = k.shots.length ? bannerSplit({ x: 0, y: 0, w: W, h: H }, 1.12, 0, 700) : null
  const left = split ? split.panel.w + 4 : P
  const heroTop = named ? 126 : 112
  // Bottom up: numbers, then the extra axes, the heatmap in what is left.
  const statsTop = H - 72
  const rowsH = extra ? extra * rowStep + 6 : 0
  const heroH = Math.max(60, statsTop - 14 - rowsH - heroTop)
  posterBackdrop(k, heroTop + heroH / 2)
  if (split)
    posterPictures(k, split.panel, 2, 'right')

  // Top: kicker, title, the mark.
  const markH = 44
  const markW = picWidth(k.assets.wordmark, markH)
  drawMark(k, W - P - markW + 8, 18, markH)
  const textX = split ? left + 20 : P
  const kick = ellipsize(measurer(ctx, 500, MONO, 3), kicker(k).toUpperCase(), 12, W - textX - P - markW - 30)
  text(ctx, kick, textX, 42, { weight: 500, size: 12, family: MONO, color: POSTER.hot, spacing: 3, shadow: POSTER_SHADOW })
  const t = fitText(measurer(ctx, 800, SANS, -1.2), k.data.title, W - textX - P - markW - 30, 46, 26)
  text(ctx, t.text, textX - 2, 88, { weight: 800, size: t.size, family: SANS, color: POSTER.text, spacing: -1.2, shadow: POSTER_SHADOW })

  // The heatmap, to the edge.
  const hero: Rect = { x: left, y: heroTop, w: W - left, h: heroH }
  posterHero(k, hero, 14)
  if (named)
    drawChapterNames(ctx, hero, k, heroTop - 10, { weight: 500, size: 11, family: MONO, color: POSTER.muted, spacing: 0.5, minX: textX, shadow: POSTER_SHADOW })
  const rowX = (split ? textX : P) + 70
  const rows: Rect[] = []
  for (let i = 0; i < extra; i++)
    rows.push({ x: rowX, y: heroTop + heroH + 8 + i * rowStep, w: W - P - rowX, h: 8 })
  posterRows(k, rows, split ? textX : P)

  // Bottom: the numbers, big; the legend on the right.
  const stats = statList(k)
  let x = textX
  const by = H - 24
  const lw = 220
  stats.forEach((s) => {
    text(ctx, s.label.toUpperCase(), x, by - 34, { weight: 500, size: 10.5, family: MONO, color: POSTER.faint, spacing: 1.6, shadow: POSTER_SHADOW })
    const w = text(ctx, s.value, x - 1, by, { weight: 700, size: split ? 27 : 30, family: SANS, color: POSTER.text, spacing: -0.8, shadow: POSTER_SHADOW })
    x += Math.max(w, split ? 76 : 90) + (split ? 28 : 38)
  })
  if (split)
    drawScaleLegend(k, W - P - 240, by - 6, 240, { family: MONO, color: POSTER.muted, size: 11, barH: 6, shadow: POSTER_SHADOW, inline: true })
  else
    posterLegend(k, W - P - lw, by - 24, lw)
}

function posterTall(k: Kit) {
  const { ctx, W, H } = k
  const P = 48
  const named = k.chapters.length > 1
  const extra = k.extra.length
  const one = k.shots.length === 1
  const four = k.shots.length > 1

  const rowY = H - 50
  const markH = 58
  const markW = picWidth(k.assets.wordmark, markH)
  const pictured = one || four
  // Where things go, top down. With pictures: the pictures, the title (over
  // the foot of one big one, under four), the heatmap in what is left above
  // the numbers. Without: the heatmap up top, the title huge on the numbers.
  const picH = one ? 380 : four ? Math.round(((W - 9) / 4) * 9 / 16) : 0
  const kickY = four ? picH + 44 : 62
  let title: { lines: string[], size: number, y: number, spacing: number } | null = null
  let heroTop: number
  let heroH: number
  const rowsH = extra ? extra * 18 + 14 : 0
  if (pictured) {
    const spacing = -2
    const t = one
      ? fitTitle(measurer(ctx, 800, SANS, spacing), k.data.title, W - P * 2, 64, 50, 38)
      : fitTitle(measurer(ctx, 800, SANS, spacing), k.data.title, W - P * 2, 60, 46, 36)
    const lineH = t.size * 0.98
    // One big: the last line sits on the picture's foot. Four: under the kicker.
    const first = one ? picH + 22 - (t.lines.length - 1) * lineH : kickY + 18 + t.size * 0.78
    title = { ...t, y: first, spacing }
    const last = first + (t.lines.length - 1) * lineH
    heroTop = last + (named ? 58 : 38)
    heroH = Math.max(90, rowY - 70 - 36 - rowsH - heroTop)
  }
  else {
    heroTop = named ? 128 : 108
    heroH = extra ? 250 : 330
  }
  posterBackdrop(k, heroTop + heroH / 2, pictured
    ? () => {
        posterPictures(k, { x: 0, y: 0, w: W, h: picH }, 4, 'bottom')
        // The top of a picture under the kicker and the mark: darkened a little.
        const g = ctx.createLinearGradient(0, 0, 0, 110)
        g.addColorStop(0, 'rgba(8,8,10,0.6)')
        g.addColorStop(1, 'rgba(8,8,10,0)')
        ctx.fillStyle = g
        ctx.fillRect(0, 0, W, 110)
      }
    : undefined)

  drawMark(k, W - P - markW + 10, 24, markH)
  const kick = ellipsize(measurer(ctx, 500, MONO, 3), kicker(k).toUpperCase(), 13, W - P * 2 - markW - 30)
  text(ctx, kick, P, kickY, { weight: 500, size: 13, family: MONO, color: POSTER.hot, spacing: 3, shadow: POSTER_SHADOW })

  const hero: Rect = { x: 0, y: heroTop, w: W, h: heroH }
  posterHero(k, hero, 22)
  if (named)
    drawChapterNames(ctx, hero, k, heroTop - 12, { weight: 500, size: 12, family: MONO, color: POSTER.muted, spacing: 0.5, minX: P, shadow: POSTER_SHADOW })
  const rows: Rect[] = []
  for (let i = 0; i < extra; i++)
    rows.push({ x: P + 80, y: heroTop + heroH + 14 + i * 18, w: W - P * 2 - 80, h: 11 })
  posterRows(k, rows, P)
  const below = rows.length ? rows[rows.length - 1].y + rows[rows.length - 1].h : heroTop + heroH
  const tickArea: Rect = { x: P + (extra ? 80 : 0), y: 0, w: W - P * 2 - (extra ? 80 : 0), h: 0 }
  if (pictured) {
    // The legend shares the time axis's line, the ticks stopping short of it.
    const lw = 300
    drawScaleLegend(k, W - P - lw, below + 26, lw, { family: MONO, color: POSTER.muted, size: 11, barH: 6, shadow: POSTER_SHADOW, inline: true })
    drawTicks(ctx, tickArea, k, below + 26, { size: 11.5, family: MONO, color: POSTER.faint, maxTicks: 10, shadow: POSTER_SHADOW, stopX: W - P - lw - 24 })
  }
  else {
    drawTicks(ctx, tickArea, k, below + 26, { size: 11.5, family: MONO, color: POSTER.faint, maxTicks: 10, shadow: POSTER_SHADOW })
  }

  // The title, huge: placed above with pictures, else on the numbers.
  if (title) {
    let y = title.y
    for (const line of title.lines) {
      text(ctx, line, P - 3, y, { weight: 800, size: title.size, family: SANS, color: POSTER.text, spacing: title.spacing, shadow: POSTER_SHADOW })
      y += title.size * 0.98
    }
  }
  else {
    const t = fitTitle(measurer(ctx, 800, SANS, -2.5), k.data.title, W - P * 2, 80, 64, 40)
    const lineH = t.size * 0.98
    let y = rowY - 112 - (t.lines.length - 1) * lineH
    // Never up into the time axis.
    y = Math.max(y, below + 56 + t.size * 0.75)
    for (const line of t.lines) {
      text(ctx, line, P - 3, y, { weight: 800, size: t.size, family: SANS, color: POSTER.text, spacing: -2.5, shadow: POSTER_SHADOW })
      y += lineH
    }
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
    ctx.fillStyle = k.scale.color(b.sample)
    ctx.fillRect(x, H - 6, b.share * W + 0.5, 6)
    x += b.share * W
  }
  // Without pictures the legend sits up by the mark.
  if (!pictured)
    posterLegend(k, W - P - markW - 56 - 220, 48, 220)
}
