/**
 * Share cards: the picture of a script that goes up with it on the forum.
 *
 * This is the part with no canvas in it: the numbers on the card, the
 * heatmap's columns and colours, where things go and how text is made to fit.
 * src/components/share/drawCard.ts does the drawing.
 *
 * Speeds here are in the units scripters talk in: position (0-100) per second.
 * Actions come in as the app holds them, with `pos` 0-1.
 *
 * Vue-free and side-effect-free so it can be unit tested directly.
 */
import type { Action } from './funscriptAnalysis'
import { detectPeaks } from './funscriptAnalysis'

// ─── Options ──────────────────────────────────────────────────────────────────

export type CardStyle = 'forum' | 'candy' | 'poster'
export type CardSize = 'banner' | 'tall'
export type HeatPalette = 'funscriptio' | 'ofs' | 'eroscripts'

export const CARD_STYLES: { id: CardStyle, label: string, note: string }[] = [
  { id: 'forum', label: 'Forum', note: 'Clean and compact, made for EroScripts\' dark theme' },
  { id: 'candy', label: 'Candy', note: 'Pink and glossy, like the logo' },
  { id: 'poster', label: 'Poster', note: 'Dark and bold, the heatmap up front' },
]

export const CARD_SIZES: Record<CardSize, { w: number, h: number, label: string }> = {
  // Discourse shows post images at most 690 wide and 500 tall. A banner of
  // this shape comes out about 690 × 200, a tall card 690 × 460: both whole,
  // neither cropped nor shrunk to fit the height.
  banner: { w: 1200, h: 340, label: 'Banner' },
  tall: { w: 1200, h: 800, label: 'Tall' },
}

/** Pixels per card unit in the exported PNG: sharp on high-DPI screens and in the lightbox. */
export const CARD_SCALE = 2

export const PALETTES: { id: HeatPalette, label: string }[] = [
  { id: 'funscriptio', label: 'funscript.io' },
  { id: 'ofs', label: 'OpenFunScripter' },
  { id: 'eroscripts', label: 'EroScripts' },
]

export interface CardPrefs {
  style: CardStyle
  size: CardSize
  palette: HeatPalette
  chapters: boolean
}

export const DEFAULT_CARD_PREFS: CardPrefs = { style: 'forum', size: 'banner', palette: 'funscriptio', chapters: true }

/** Saved prefs, with anything missing or unknown put back to the default. */
export function normaliseCardPrefs(v: unknown): CardPrefs {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const pick = <T extends string>(x: unknown, ok: readonly T[], d: T): T => (ok.includes(x as T) ? x as T : d)
  return {
    style: pick(o.style, ['forum', 'candy', 'poster'], DEFAULT_CARD_PREFS.style),
    size: pick(o.size, ['banner', 'tall'], DEFAULT_CARD_PREFS.size),
    palette: pick(o.palette, ['funscriptio', 'ofs', 'eroscripts'], DEFAULT_CARD_PREFS.palette),
    chapters: typeof o.chapters === 'boolean' ? o.chapters : DEFAULT_CARD_PREFS.chapters,
  }
}

// ─── Stats ────────────────────────────────────────────────────────────────────

/**
 * Segments shorter than this are left out of the top speed. Two points a
 * few milliseconds apart are a slip of the mouse, and one of them would put
 * an impossible number on the card.
 */
export const MIN_SEGMENT_MS = 34

export interface CardStats {
  /** Last action, or the video's length when that is longer. */
  durationMs: number
  actions: number
  /** Mean speed while moving: holds and pauses are left out. */
  avgSpeed: number
  maxSpeed: number
  /** Strokes (top turning points) per minute of moving time. */
  strokesPerMin: number
  strokes: number
  /** Share of the script's span spent moving, 0-1. */
  moving: number
}

export function cardStats(actions: Action[], videoMs = 0): CardStats {
  const n = actions.length
  const scriptEnd = n ? actions[n - 1].at : 0
  let travel = 0
  let movingMs = 0
  let maxSpeed = 0
  for (let i = 1; i < n; i++) {
    const dt = actions[i].at - actions[i - 1].at
    const dp = Math.abs(actions[i].pos - actions[i - 1].pos) * 100
    if (dt <= 0 || dp === 0)
      continue
    travel += dp
    movingMs += dt
    if (dt >= MIN_SEGMENT_MS)
      maxSpeed = Math.max(maxSpeed, (dp / dt) * 1000)
  }
  const strokes = n >= 3 ? detectPeaks(actions).length : 0
  const span = n ? scriptEnd - actions[0].at : 0
  return {
    durationMs: Math.max(scriptEnd, videoMs),
    actions: n,
    avgSpeed: movingMs > 0 ? (travel / movingMs) * 1000 : 0,
    maxSpeed,
    strokesPerMin: movingMs > 0 ? strokes / (movingMs / 60_000) : 0,
    strokes,
    moving: span > 0 ? Math.min(1, movingMs / span) : 0,
  }
}

// ─── Heatmap colours ──────────────────────────────────────────────────────────

type Rgb = [number, number, number]

/**
 * funscript.io's scale (funscript-utils, after Lucifie's heatmaps): the one
 * most heatmaps posted on EroScripts use. Black, then blue at 60, green at
 * 180, gold at 300, red at 420, purple at 540 and a deep indigo from 600.
 */
const FUNSCRIPTIO: Rgb[] = [
  [0, 0, 0],
  [30, 144, 255],
  [34, 139, 34],
  [255, 215, 0],
  [220, 20, 60],
  [147, 112, 219],
  [37, 22, 122],
]

function funscriptio(speed: number): Rgb {
  const step = 120
  if (speed <= 0)
    return FUNSCRIPTIO[0]
  if (speed > 5 * step)
    return FUNSCRIPTIO[6]
  const s = speed + step / 2
  const i = Math.floor(s / step)
  return mix(FUNSCRIPTIO[i], FUNSCRIPTIO[i + 1], (s - i * step) / step)
}

/**
 * OpenFunScripter's: black at rest, dodger blue for anything moving, then
 * cyan, green and yellow to red at 400 (its MaxSpeedPerSecond).
 */
const OFS_MARKS: [number, Rgb][] = [
  [0, [0, 0, 0]],
  [1e-6, [0x1E, 0x90, 0xFF]],
  [0.4, [0x00, 0xFF, 0xFF]],
  [0.6, [0x00, 0xFF, 0x00]],
  [0.8, [0xFF, 0xFF, 0x00]],
  [1, [0xFF, 0x00, 0x00]],
]

function ofs(speed: number): Rgb {
  const t = Math.min(1, Math.max(0, speed / 400))
  for (let i = 1; i < OFS_MARKS.length; i++) {
    const [b, cb] = OFS_MARKS[i]
    if (t <= b) {
      const [a, ca] = OFS_MARKS[i - 1]
      return mix(ca, cb, (t - a) / (b - a))
    }
  }
  return OFS_MARKS[OFS_MARKS.length - 1][1]
}

/**
 * EroScripts' funlib scale, the one the timeline uses: blue through green and
 * yellow to red as speed rises, darkening past 500 and greying past 800.
 */
function eroscripts(speed: number): Rgb {
  const hue = (((210 - speed / 2.4) % 360) + 360) % 360
  const l = 0.8 - 0.4 * clamp01((speed - 500) / 100)
  const c = 0.4 - 0.3 * clamp01((speed - 800) / 100)
  return oklchToRgb(l, c, hue)
}

/** The colour for `speed` (units/s) on `palette`, as [r, g, b] 0-255. */
export function heatRgb(speed: number, palette: HeatPalette = 'funscriptio'): Rgb {
  const s = Number.isFinite(speed) ? Math.max(0, speed) : 0
  if (palette === 'ofs')
    return ofs(s)
  if (palette === 'eroscripts')
    return eroscripts(s)
  return funscriptio(s)
}

export function heatColor(speed: number, palette: HeatPalette = 'funscriptio', alpha = 1): string {
  const [r, g, b] = heatRgb(speed, palette)
  return alpha >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha})`
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const f = clamp01(t)
  return [0, 1, 2].map(i => Math.round(a[i] + (b[i] - a[i]) * f)) as Rgb
}

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v))
}

/**
 * OKLCH to sRGB, with chroma pulled in until it fits: funlib asks for more
 * chroma than sRGB has, and a browser maps such colours into gamut the same
 * way rather than clipping each channel.
 */
export function oklchToRgb(l: number, c: number, hDeg: number): Rgb {
  const h = (hDeg * Math.PI) / 180
  const toLinear = (cc: number): [number, number, number] => {
    const a = cc * Math.cos(h)
    const b = cc * Math.sin(h)
    const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
    const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
    const s_ = (l - 0.0894841775 * a - 1.2914855480 * b) ** 3
    return [
      4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
      -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
      -0.0041960863 * l_ - 0.7034186147 * m_ + 1.7076147010 * s_,
    ]
  }
  const fits = (rgb: number[]) => rgb.every(v => v >= -1e-4 && v <= 1 + 1e-4)
  let lin = toLinear(c)
  if (!fits(lin)) {
    let lo = 0
    let hi = c
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2
      if (fits(toLinear(mid)))
        lo = mid
      else
        hi = mid
    }
    lin = toLinear(lo)
  }
  const enc = (v: number) => {
    const x = clamp01(v)
    const s = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055
    return Math.round(clamp01(s) * 255)
  }
  return [enc(lin[0]), enc(lin[1]), enc(lin[2])]
}

// ─── Heatmap columns ──────────────────────────────────────────────────────────

export interface HeatBin {
  /** Mean speed in units/s; null where the script has not started or has ended. */
  speed: number | null
  /** Bottom and top of the strokes around here, 0-1. */
  lo: number
  hi: number
}

/** How far around each column the speed is averaged, so colours do not flicker stroke by stroke. */
const SPEED_WINDOW_MS = 2400
/** How far around each column to look for the bottom and top of the stroke. */
const RANGE_WINDOW_MS = 1600

/**
 * The script cut into `count` columns over `durationMs`: the speed in each
 * (time-weighted over its segments, averaged across a couple of seconds the
 * way funscript.io's does) and the range the strokes cover there, which is
 * what gives a funscript.io heatmap its shape.
 */
export function heatBins(actions: Action[], count: number, durationMs: number): HeatBin[] {
  const n = Math.max(1, Math.floor(count))
  const span = durationMs > 0 ? durationMs : (actions.length ? actions[actions.length - 1].at : 0)
  const out: HeatBin[] = Array.from({ length: n }, () => ({ speed: null, lo: 0.5, hi: 0.5 }))
  if (actions.length < 2 || span <= 0)
    return out
  const binMs = span / n
  const weight = new Float64Array(n)
  const sum = new Float64Array(n)
  const lo = new Float64Array(n).fill(Number.POSITIVE_INFINITY)
  const hi = new Float64Array(n).fill(Number.NEGATIVE_INFINITY)

  for (let i = 1; i < actions.length; i++) {
    const a = actions[i - 1]
    const b = actions[i]
    const dt = b.at - a.at
    if (dt <= 0)
      continue
    const speed = (Math.abs(b.pos - a.pos) * 100 * 1000) / dt
    const first = Math.max(0, Math.floor(a.at / binMs))
    const last = Math.min(n - 1, Math.floor(Math.max(a.at, b.at - 1e-6) / binMs))
    for (let k = first; k <= last; k++) {
      const t0 = Math.max(a.at, k * binMs)
      const t1 = Math.min(b.at, (k + 1) * binMs)
      if (t1 < t0)
        continue
      const w = t1 - t0
      weight[k] += w
      sum[k] += speed * w
      const p0 = a.pos + (b.pos - a.pos) * ((t0 - a.at) / dt)
      const p1 = a.pos + (b.pos - a.pos) * ((t1 - a.at) / dt)
      lo[k] = Math.min(lo[k], p0, p1)
      hi[k] = Math.max(hi[k], p0, p1)
    }
  }

  const covered = (k: number) => weight[k] > 0
  const reach = (ms: number) => Math.max(0, Math.round(ms / 2 / binMs))
  const sr = reach(SPEED_WINDOW_MS)
  const rr = reach(RANGE_WINDOW_MS)
  for (let k = 0; k < n; k++) {
    if (!covered(k))
      continue
    let w = 0
    let s = 0
    for (let j = Math.max(0, k - sr); j <= Math.min(n - 1, k + sr); j++) {
      w += weight[j]
      s += sum[j]
    }
    let l = Number.POSITIVE_INFINITY
    let h = Number.NEGATIVE_INFINITY
    for (let j = Math.max(0, k - rr); j <= Math.min(n - 1, k + rr); j++) {
      if (!covered(j))
        continue
      l = Math.min(l, lo[j])
      h = Math.max(h, hi[j])
    }
    out[k] = { speed: w > 0 ? s / w : 0, lo: l, hi: h }
  }

  // Ease the edges of the stroke band so it reads as a shape, not a comb.
  const smooth = (get: (b: HeatBin) => number, set: (b: HeatBin, v: number) => void) => {
    const vals = out.map(get)
    for (let k = 0; k < n; k++) {
      if (out[k].speed === null)
        continue
      let s = 0
      let c = 0
      for (let j = Math.max(0, k - 2); j <= Math.min(n - 1, k + 2); j++) {
        if (out[j].speed === null)
          continue
        s += vals[j]
        c++
      }
      set(out[k], s / c)
    }
  }
  smooth(b => b.lo, (b, v) => (b.lo = v))
  smooth(b => b.hi, (b, v) => (b.hi = v))
  return out
}

// ─── Speed mix ────────────────────────────────────────────────────────────────

/** Edges of the speed bands in the mix bar, units/s. */
export const MIX_EDGES = [100, 200, 300, 400] as const

export interface MixBand {
  from: number
  /** Infinity for the last. */
  to: number
  /** Share of the moving time, 0-1. */
  share: number
  /** A speed inside the band, for its colour. */
  sample: number
  label: string
}

/** How the moving time splits across the speed bands. */
export function speedMix(actions: Action[]): MixBand[] {
  const edges = [0, ...MIX_EDGES, Number.POSITIVE_INFINITY]
  const time = Array.from({ length: edges.length - 1 }, () => 0)
  let total = 0
  for (let i = 1; i < actions.length; i++) {
    const dt = actions[i].at - actions[i - 1].at
    const dp = Math.abs(actions[i].pos - actions[i - 1].pos) * 100
    if (dt <= 0 || dp === 0)
      continue
    const speed = (dp / dt) * 1000
    const k = edges.findIndex((e, j) => j > 0 && speed < e) - 1
    time[k < 0 ? time.length - 1 : k] += dt
    total += dt
  }
  return time.map((t, k) => {
    const from = edges[k]
    const to = edges[k + 1]
    return {
      from,
      to,
      share: total > 0 ? t / total : 0,
      sample: Number.isFinite(to) ? (from + to) / 2 : from + 60,
      label: Number.isFinite(to) ? `${from}–${to}` : `${from}+`,
    }
  })
}

/**
 * The `windowMs` of the script that travels the furthest: the close-up a
 * tall card shows. Null for a script with nothing moving.
 */
export function busiestWindow(actions: Action[], windowMs: number): { start: number, end: number } | null {
  const n = actions.length
  if (n < 2 || windowMs <= 0)
    return null
  const first = actions[0].at
  const last = actions[n - 1].at
  if (last - first <= windowMs)
    return { start: first, end: last }
  // Segment i runs from action i to i + 1; the window [t, t + windowMs]
  // starting at action `lo` takes every segment that ends inside it.
  let best = -1
  let bestAt = first
  let sum = 0
  let hi = 0
  for (let lo = 0; lo < n - 1; lo++) {
    const t = actions[lo].at
    if (t + windowMs > last)
      break
    while (hi + 1 < n && actions[hi + 1].at <= t + windowMs) {
      sum += Math.abs(actions[hi + 1].pos - actions[hi].pos)
      hi++
    }
    if (sum > best) {
      best = sum
      bestAt = t
    }
    if (hi > lo)
      sum -= Math.abs(actions[lo + 1].pos - actions[lo].pos)
    else
      hi = lo + 1
  }
  if (best <= 0)
    return null
  return { start: bestAt, end: bestAt + windowMs }
}

// ─── Words and numbers ────────────────────────────────────────────────────────

/** "3:43", "1:02:03". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** "12,345": always with commas, so a card reads the same wherever it was made. */
export function formatCount(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** The video's name for the title: no extension, no folder. */
export function titleFromName(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? name
  return base.replace(/\.funscript$/i, '').replace(/\.[a-z0-9]{2,4}$/i, '').trim()
}

/** The creator a script names in its metadata, or ''. */
export function creatorOf(metadata: unknown): string {
  const m = metadata as Record<string, unknown> | null | undefined
  const c = m?.creator ?? m?.author ?? m?.scripter
  return typeof c === 'string' ? c.trim() : ''
}

/** "clip.mp4" → "clip.card.png", with characters no file system takes swapped out. */
export function cardFileName(videoOrTitle: string): string {
  const base = titleFromName(videoOrTitle) || 'script'
  const safe = Array.from(base, ch => (ch.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(ch) ? '_' : ch)).join('')
  return `${safe}.card.png`
}

/** The axis names for a card, in the device's order: "stroke", "twist", … */
export function axisName(label: string): string {
  return label.toLowerCase()
}

// ─── Fitting text ─────────────────────────────────────────────────────────────

/** Width of `text` at font size `size`. */
export type Measure = (text: string, size: number) => number

/** `text` cut with an ellipsis to fit `maxWidth` at `size`; '' when not even "…" fits. */
export function ellipsize(measure: Measure, text: string, size: number, maxWidth: number): string {
  if (measure(text, size) <= maxWidth)
    return text
  const chars = Array.from(text)
  let lo = 0
  let hi = chars.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (measure(`${chars.slice(0, mid).join('').trimEnd()}…`, size) <= maxWidth)
      lo = mid
    else
      hi = mid - 1
  }
  if (lo === 0)
    return measure('…', size) <= maxWidth ? '…' : ''
  return `${chars.slice(0, lo).join('').trimEnd()}…`
}

/**
 * The biggest size from `max` down to `min` (in `step`s) at which `text` fits
 * on one line, ellipsized at `min` when even that is too wide.
 */
export function fitText(measure: Measure, text: string, maxWidth: number, max: number, min: number, step = 1): { text: string, size: number } {
  for (let size = max; size >= min; size -= step) {
    if (measure(text, size) <= maxWidth)
      return { text, size }
  }
  return { text: ellipsize(measure, text, min, maxWidth), size: min }
}

/**
 * `text` broken into at most `maxLines` lines no wider than `maxWidth`, by
 * words, the last line ellipsized if it all does not fit. A word too long for
 * a line on its own is cut.
 */
export function wrapText(measure: Measure, text: string, size: number, maxWidth: number, maxLines: number): string[] {
  // A dash between two parts of a name stays with the part before it, so a
  // line never starts with one.
  const words: string[] = []
  for (const w of text.split(/\s+/).filter(Boolean)) {
    if (/^[-–—|·]$/.test(w) && words.length)
      words[words.length - 1] += ` ${w}`
    else
      words.push(w)
  }
  const lines: string[] = []
  let cur = ''
  for (const word of words) {
    const next = cur ? `${cur} ${word}` : word
    if (measure(next, size) <= maxWidth) {
      cur = next
      continue
    }
    if (cur)
      lines.push(cur)
    cur = word
  }
  if (cur)
    lines.push(cur)
  if (lines.length > maxLines && maxLines > 0) {
    const rest = lines.splice(maxLines - 1).join(' ')
    lines.push(rest)
  }
  // A line still too wide is a single word longer than the line, or the rest piled into the last.
  return lines.map(l => (measure(l, size) <= maxWidth ? l : ellipsize(measure, l, size, maxWidth)))
}

/**
 * The largest size (from `max` down to `min`) at which `text` wraps into
 * `maxLines` lines without being cut; at `min` it is cut.
 */
export function fitWrapped(measure: Measure, text: string, maxWidth: number, maxLines: number, max: number, min: number, step = 2): { lines: string[], size: number } {
  const whole = text.trim().replace(/\s+/g, ' ')
  for (let size = max; size >= min; size -= step) {
    const lines = wrapText(measure, text, size, maxWidth, maxLines)
    if (lines.join(' ') === whole)
      return { lines, size }
  }
  return { lines: wrapText(measure, text, min, maxWidth, maxLines), size: min }
}

// ─── Layout ───────────────────────────────────────────────────────────────────

export interface Rect { x: number, y: number, w: number, h: number }

/**
 * Split `area` into the stroke heatmap and one thin row per extra axis
 * beneath it: rows of `rowH` with `gap` between, the hero taking the rest
 * (but never less than `minHero`; rows shrink first).
 */
export function stackRows(area: Rect, extra: number, rowH: number, gap: number, minHero: number): { hero: Rect, rows: Rect[] } {
  if (extra <= 0)
    return { hero: { ...area }, rows: [] }
  let h = rowH
  let g = gap
  const need = () => extra * (h + g)
  if (area.h - need() < minHero) {
    const room = Math.max(0, area.h - minHero)
    const scale = room / need()
    h = Math.max(4, Math.floor(h * scale))
    g = Math.max(2, Math.floor(g * scale))
  }
  const heroH = Math.max(0, area.h - extra * (h + g))
  const rows: Rect[] = []
  for (let i = 0; i < extra; i++)
    rows.push({ x: area.x, y: area.y + heroH + g + i * (h + g), w: area.w, h })
  return { hero: { x: area.x, y: area.y, w: area.w, h: heroH }, rows }
}

/** Tidy steps for time ticks, ms. */
const TICK_STEPS = [10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600].map(s => s * 1000)

/** Tick times along a `durationMs` axis: round steps, at most `maxTicks`, never at the very end. */
export function timeTicks(durationMs: number, maxTicks: number): number[] {
  if (durationMs <= 0 || maxTicks < 1)
    return []
  const step = TICK_STEPS.find(s => durationMs / s <= maxTicks) ?? Math.ceil(durationMs / maxTicks / 3_600_000) * 3_600_000
  const out: number[] = []
  for (let t = 0; t < durationMs - step * 0.35; t += step)
    out.push(t)
  return out
}

export interface CardChapter { name: string, start: number, end: number }

export interface ChapterLabel { chapter: CardChapter, x: number, text: string }

/**
 * Which chapter names fit along a strip `width` wide: each sits at its
 * chapter's start, cut to the room before the next label, and is dropped
 * when even a short cut does not fit.
 */
export function chapterLabels(chapters: CardChapter[], durationMs: number, width: number, measure: Measure, size: number, pad = 8, minChars = 3): ChapterLabel[] {
  if (!chapters.length || durationMs <= 0)
    return []
  const xs = chapters.map(c => (Math.max(0, c.start) / durationMs) * width)
  const out: ChapterLabel[] = []
  let lastEnd = Number.NEGATIVE_INFINITY
  for (let i = 0; i < chapters.length; i++) {
    const x = xs[i]
    if (x < lastEnd || x >= width)
      continue
    const nextX = xs.slice(i + 1).find(v => v > x + 1) ?? width
    const room = Math.min(width, nextX) - x - pad
    const name = chapters[i].name.trim()
    if (!name || room <= 0)
      continue
    const text = ellipsize(measure, name, size, room)
    const kept = text.endsWith('…') ? Array.from(text).length - 1 : Array.from(text).length
    if (!text || (text !== name && kept < Math.min(minChars, Array.from(name).length)))
      continue
    out.push({ chapter: chapters[i], x, text })
    lastEnd = x + measure(text, size) + pad
  }
  return out
}

/** Cover-fit an image of `iw` × `ih` into `box`: the source rect to draw from. */
export function coverCrop(iw: number, ih: number, box: { w: number, h: number }, focusY = 0.4): Rect {
  if (iw <= 0 || ih <= 0)
    return { x: 0, y: 0, w: 0, h: 0 }
  const want = box.w / box.h
  if (iw / ih > want) {
    const w = ih * want
    return { x: (iw - w) / 2, y: 0, w, h: ih }
  }
  const h = iw / want
  return { x: 0, y: Math.max(0, Math.min(ih - h, ih * focusY - h / 2)), w: iw, h }
}
