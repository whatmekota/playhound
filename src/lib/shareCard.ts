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
export type HeatPalette = 'playhound' | 'funscriptio' | 'ofs' | 'eroscripts'
/** Pictures from the video on the card: none, one big one, or four moments. */
export type CardPicture = 'none' | 'one' | 'four'

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
  { id: 'playhound', label: 'playhound' },
  { id: 'funscriptio', label: 'funscript.io' },
  { id: 'ofs', label: 'OpenFunScripter' },
  { id: 'eroscripts', label: 'EroScripts' },
]

export const CARD_PICTURES: { id: CardPicture, label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'one', label: '1 big' },
  { id: 'four', label: '4 frames' },
]

export interface CardPrefs {
  style: CardStyle
  size: CardSize
  palette: HeatPalette
  /** Stretch the colours over this script's own speeds rather than the scale's fixed ones. */
  fit: boolean
  chapters: boolean
  /** A frame of the video behind the card. */
  frame: boolean
  picture: CardPicture
}

export const DEFAULT_CARD_PREFS: CardPrefs = { style: 'forum', size: 'banner', palette: 'playhound', fit: false, chapters: true, frame: true, picture: 'none' }

/** Bumped when a default changes in a way saved prefs should pick up. */
const PREFS_VERSION = 2

/** Saved prefs, with anything missing or unknown put back to the default. */
export function normaliseCardPrefs(v: unknown): CardPrefs & { v: number } {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const pick = <T extends string>(x: unknown, ok: readonly T[], d: T): T => (ok.includes(x as T) ? x as T : d)
  const bool = (x: unknown, d: boolean) => (typeof x === 'boolean' ? x : d)
  // Before v2 the colours were saved with everything else whether picked or
  // not; the playhound scale is the new default, so they start from it.
  const old = o.v !== PREFS_VERSION
  return {
    v: PREFS_VERSION,
    style: pick(o.style, ['forum', 'candy', 'poster'], DEFAULT_CARD_PREFS.style),
    size: pick(o.size, ['banner', 'tall'], DEFAULT_CARD_PREFS.size),
    palette: old ? DEFAULT_CARD_PREFS.palette : pick(o.palette, ['playhound', 'funscriptio', 'ofs', 'eroscripts'], DEFAULT_CARD_PREFS.palette),
    fit: bool(o.fit, DEFAULT_CARD_PREFS.fit),
    chapters: bool(o.chapters, DEFAULT_CARD_PREFS.chapters),
    frame: bool(o.frame, DEFAULT_CARD_PREFS.frame),
    picture: pick(o.picture, ['none', 'one', 'four'], DEFAULT_CARD_PREFS.picture),
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

/**
 * playhound's own: cool and slow to hot and fast, through blue, cyan, green,
 * yellow, orange and red, then on past where the others stop, into pink,
 * violet and indigo to a white-hot lilac at 1100. Speeds between marks are placed by
 * their ratio, not their difference, so 300, 450 and 600 are as far apart as
 * 60, 90 and 120: a gentle script uses the cool half and an intense one still
 * has steps left. Every mark is bright enough to read on a dark well and over
 * a frame.
 */
const PLAYHOUND: [number, Rgb][] = [
  [0, [52, 72, 170]],
  [25, [64, 98, 235]],
  [55, [36, 148, 255]],
  [95, [0, 200, 235]],
  [150, [24, 214, 140]],
  [210, [140, 226, 46]],
  [280, [255, 214, 30]],
  [350, [255, 140, 26]],
  [440, [255, 62, 52]],
  [550, [255, 34, 136]],
  [690, [214, 52, 255]],
  [870, [150, 110, 255]],
  [1100, [236, 214, 255]],
]

function playhound(speed: number): Rgb {
  const last = PLAYHOUND[PLAYHOUND.length - 1]
  if (speed >= last[0])
    return last[1]
  for (let i = 1; i < PLAYHOUND.length; i++) {
    const [b, cb] = PLAYHOUND[i]
    if (speed > b)
      continue
    const [a, ca] = PLAYHOUND[i - 1]
    // By ratio between marks (the first span, from 0, by difference).
    const t = a > 0 ? Math.log(speed / a) / Math.log(b / a) : speed / b
    return mixOklab(ca, cb, t)
  }
  return last[1]
}

/** The colour for `speed` (units/s) on `palette`, as [r, g, b] 0-255. */
export function heatRgb(speed: number, palette: HeatPalette = 'playhound'): Rgb {
  const s = Number.isFinite(speed) ? Math.max(0, speed) : 0
  if (palette === 'ofs')
    return ofs(s)
  if (palette === 'eroscripts')
    return eroscripts(s)
  if (palette === 'funscriptio')
    return funscriptio(s)
  return playhound(s)
}

export function heatColor(speed: number, palette: HeatPalette = 'playhound', alpha = 1): string {
  return rgbCss(heatRgb(speed, palette), alpha)
}

export function rgbCss([r, g, b]: Rgb, alpha = 1): string {
  return alpha >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha})`
}

// ─── Heat scales ──────────────────────────────────────────────────────────────

/**
 * The speeds a palette's colours run over: below `lo` is its first colour,
 * above `hi` its last. `log` when it is spaced by ratio.
 */
const RANGES: Record<HeatPalette, { lo: number, hi: number, log: boolean }> = {
  playhound: { lo: 25, hi: 1100, log: true },
  // Black below this, so a fitted script starts on the blue.
  funscriptio: { lo: 40, hi: 610, log: false },
  ofs: { lo: 12, hi: 400, log: false },
  eroscripts: { lo: 0, hi: 780, log: false },
}

/** The speeds a scale is stretched over when fitted to a script. */
export interface SpeedRange { lo: number, hi: number }

/**
 * A palette ready to colour a card: plain, or stretched over one script's
 * speeds so even an all-intense script shows where it eases off and where it
 * peaks. `at(u)` is the speed at `u` (0-1) along the legend.
 */
export interface HeatScale {
  palette: HeatPalette
  fit: SpeedRange | null
  rgb: (speed: number) => Rgb
  color: (speed: number, alpha?: number) => string
  at: (u: number) => number
}

export function heatScale(palette: HeatPalette, fit: SpeedRange | null = null): HeatScale {
  const range = RANGES[palette]
  const native = (u: number) => {
    const f = clamp01(u)
    return range.log ? range.lo * (range.hi / range.lo) ** f : range.lo + (range.hi - range.lo) * f
  }
  // Fitted, speeds are placed by ratio across the script's own range, and
  // then given the palette's colour for that place along its own range.
  const rgb = fit
    ? (s: number) => (s <= 0 ? heatRgb(0, palette) : heatRgb(native(Math.log(s / fit.lo) / Math.log(fit.hi / fit.lo)), palette))
    : (s: number) => heatRgb(s, palette)
  const at = fit
    ? (u: number) => fit.lo * (fit.hi / fit.lo) ** clamp01(u)
    : native
  return { palette, fit, rgb, color: (s, a = 1) => rgbCss(rgb(s), a), at }
}

/**
 * The spread of a script's speeds while it moves, time-weighted: the
 * `loQ` and `hiQ` quantiles, what "fit to this script" stretches the colours
 * over. Kept at least a fifth apart, so a script at one steady speed is not
 * all one end of the scale or the other. Null for one that never moves.
 */
export function speedRange(actions: Action[], loQ = 0.05, hiQ = 0.98): SpeedRange | null {
  const segs: [number, number][] = []
  let total = 0
  for (let i = 1; i < actions.length; i++) {
    const dt = actions[i].at - actions[i - 1].at
    const dp = Math.abs(actions[i].pos - actions[i - 1].pos) * 100
    if (dt <= 0 || dp === 0)
      continue
    segs.push([(dp / dt) * 1000, dt])
    total += dt
  }
  if (!segs.length)
    return null
  segs.sort((a, b) => a[0] - b[0])
  const quantile = (q: number) => {
    let acc = 0
    for (const [s, dt] of segs) {
      acc += dt
      if (acc >= q * total)
        return s
    }
    return segs[segs.length - 1][0]
  }
  let lo = Math.max(5, quantile(loQ))
  let hi = Math.max(lo, quantile(hiQ))
  if (hi < lo * 1.5) {
    const mid = Math.sqrt(lo * hi)
    lo = mid / 1.25
    hi = mid * 1.25
  }
  return { lo, hi }
}

// OKLab, for blending between the playhound marks without muddy middles.
function toLin(c: number) {
  const x = c / 255
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
}

function rgbToOklab([r, g, b]: Rgb): [number, number, number] {
  const R = toLin(r)
  const G = toLin(g)
  const B = toLin(b)
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B)
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B)
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B)
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ]
}

function mixOklab(a: Rgb, b: Rgb, t: number): Rgb {
  const f = clamp01(t)
  const A = rgbToOklab(a)
  const B = rgbToOklab(b)
  const L = A[0] + (B[0] - A[0]) * f
  const x = A[1] + (B[1] - A[1]) * f
  const y = A[2] + (B[2] - A[2]) * f
  return oklchToRgb(L, Math.hypot(x, y), (Math.atan2(y, x) * 180) / Math.PI)
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

export interface StrokeCol {
  /** Speed around here in units/s; 0 holding still; null before the script starts or after it ends. */
  speed: number | null
  /** Lowest and highest position the script passes through in this column, 0-1. */
  lo: number
  hi: number
}

/**
 * The script's position line cut into `count` columns over `durationMs`, one
 * per pixel of the drawing: where the line goes in each (its lowest and
 * highest point there, from the actions themselves, so every stroke shows as
 * a peak and a valley until strokes are narrower than a pixel) and how fast it
 * moves around then. The speed is taken over `speedWindowMs` (or the column,
 * when that is wider) and only over the time spent moving, so a stroke keeps
 * its colour through the pause at its turn and a hold shows as no speed.
 */
export function strokeColumns(actions: Action[], count: number, durationMs: number, speedWindowMs = 240): StrokeCol[] {
  const n = Math.max(1, Math.floor(count))
  const span = durationMs > 0 ? durationMs : (actions.length ? actions[actions.length - 1].at : 0)
  const out: StrokeCol[] = Array.from({ length: n }, () => ({ speed: null, lo: 0.5, hi: 0.5 }))
  const m = actions.length
  if (m < 2 || span <= 0)
    return out
  const colMs = span / n
  const first = actions[0].at
  const last = actions[m - 1].at

  // Running totals at each action: distance travelled and time spent moving.
  const travel = new Float64Array(m)
  const moving = new Float64Array(m)
  for (let i = 1; i < m; i++) {
    const dt = actions[i].at - actions[i - 1].at
    const dp = Math.abs(actions[i].pos - actions[i - 1].pos) * 100
    travel[i] = travel[i - 1] + (dt > 0 ? dp : 0)
    moving[i] = moving[i - 1] + (dt > 0 && dp > 0 ? dt : 0)
  }
  /** Index of the segment holding `t`: the last action at or before it. */
  const seg = (t: number) => {
    let lo = 0
    let hi = m - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (actions[mid].at <= t)
        lo = mid
      else
        hi = mid - 1
    }
    return Math.min(lo, m - 2)
  }
  const posAt = (i: number, t: number) => {
    const a = actions[i]
    const b = actions[i + 1]
    const dt = b.at - a.at
    return dt > 0 ? a.pos + (b.pos - a.pos) * Math.min(1, Math.max(0, (t - a.at) / dt)) : b.pos
  }
  /** Distance travelled and time moving from the start up to `t`. */
  const totals = (t: number): [number, number] => {
    const c = Math.min(last, Math.max(first, t))
    const i = seg(c)
    const a = actions[i]
    const b = actions[i + 1]
    const dt = b.at - a.at
    const f = dt > 0 ? Math.min(1, Math.max(0, (c - a.at) / dt)) : 0
    const dp = travel[i + 1] - travel[i]
    return [travel[i] + dp * f, moving[i] + (dp > 0 ? (moving[i + 1] - moving[i]) * f : 0)]
  }

  const half = Math.max(colMs, speedWindowMs) / 2
  for (let k = 0; k < n; k++) {
    const t0 = k * colMs
    const t1 = t0 + colMs
    if (t1 <= first || t0 > last)
      continue
    const a = Math.max(t0, first)
    const b = Math.min(t1, last)
    let i = seg(a)
    let lo = posAt(i, a)
    let hi = lo
    // Every action point inside the column, then where the line leaves it.
    while (i + 1 < m && actions[i + 1].at <= b) {
      i++
      lo = Math.min(lo, actions[i].pos)
      hi = Math.max(hi, actions[i].pos)
    }
    const pb = posAt(Math.min(i, m - 2), b)
    lo = Math.min(lo, pb)
    hi = Math.max(hi, pb)
    const mid = (t0 + t1) / 2
    const [d0, m0] = totals(mid - half)
    const [d1, m1] = totals(mid + half)
    const mt = m1 - m0
    out[k] = { speed: mt > 1e-6 ? ((d1 - d0) / mt) * 1000 : 0, lo, hi }
  }
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

/**
 * `n` equal tiles filling `area` in `cols` columns, `gap` apart, row by row.
 * Rounded to whole card units so their edges stay crisp.
 */
export function tileGrid(area: Rect, n: number, cols: number, gap: number): Rect[] {
  const c = Math.max(1, Math.min(cols, n))
  const rows = Math.max(1, Math.ceil(n / c))
  const w = (area.w - gap * (c - 1)) / c
  const h = (area.h - gap * (rows - 1)) / rows
  const out: Rect[] = []
  for (let i = 0; i < n; i++) {
    const x = Math.round(area.x + (i % c) * (w + gap))
    const y = Math.round(area.y + Math.floor(i / c) * (h + gap))
    out.push({ x, y, w: Math.round(area.x + (i % c) * (w + gap) + w) - x, h: Math.round(area.y + Math.floor(i / c) * (h + gap) + h) - y })
  }
  return out
}

/**
 * Where a picture panel goes on a banner: a box `aspect` wide per unit of
 * height on the left of `area` (the card less its padding), and what is left
 * beside it after `gap`. No panel (null) when the rest would be narrower than
 * `minRest`: then the frame is only the background.
 */
export function bannerSplit(area: Rect, aspect: number, gap: number, minRest: number): { panel: Rect, rest: Rect } | null {
  const w = Math.round(area.h * aspect)
  const restW = area.w - w - gap
  if (restW < minRest)
    return null
  return {
    panel: { x: area.x, y: area.y, w, h: area.h },
    rest: { x: area.x + w + gap, y: area.y, w: restW, h: area.h },
  }
}

/**
 * The moments a card's pictures start at: `first` (where the player is, or a
 * third of the way in), then the rest spread evenly over the video, away from
 * it. Seconds, in time order after the first.
 */
export function defaultMoments(durationSec: number, first: number | null, count = 4): number[] {
  const d = Math.max(0, durationSec)
  const start = first !== null && first > 0 && first < d ? first : d * 0.33
  const spread = Array.from({ length: count }, (_, i) => (d * (i + 0.5)) / count)
  // Drop the evenly spread one nearest the first, keep the others.
  let near = 0
  spread.forEach((t, i) => {
    if (Math.abs(t - start) < Math.abs(spread[near] - start))
      near = i
  })
  return [start, ...spread.filter((_, i) => i !== near)].map(t => Math.round(t * 10) / 10)
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
