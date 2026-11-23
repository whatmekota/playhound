import type { ScaleAction } from './scriptScale'
import { lowerBound, positionAt, segmentSpeed } from './scriptEdit'
import { scaleScript, turningPoints } from './scriptScale'
import { formatTime } from './time'

/**
 * Per-video script tweaks: changes to how a script plays that never touch
 * the file. They are saved with the video (like its tags) and applied when
 * the script loads, so the timeline, every device (the Handy's upload too)
 * and plugins all see the same tweaked script.
 *
 * Positions are 0–1 here, as the app keeps them; the settings are in
 * funscript units (0–100), as people know them.
 */

export type SmoothLevel = 'off' | 'light' | 'medium'
/** As written, twice the strokes, or half as many, on the script's own beats. */
export type StrokeCount = 'as-is' | 'double' | 'half'
/** How much each turn of the script is varied: not at all, a little, a little more. */
export type HumaniseLevel = 'off' | 'light' | 'medium'

export interface ScriptTweaks {
  /** Lowest output position, 0–100. */
  min: number
  /** Highest output position, 0–100. */
  max: number
  /** Up becomes down. */
  invert: boolean
  /** Fastest movement allowed, funscript units per second; 0 for none. */
  speedCap: number
  smooth: SmoothLevel
  /** Smooth only where the script moves faster than this, units per second; 0 smooths everywhere. */
  smoothAbove: number
  strokes: StrokeCount
  /** Small variations in each turn's timing and depth, the same every time this video plays. */
  humanise: HumaniseLevel
  /**
   * A stretch of the video, ms, that plays again and again from its end to
   * the end of the video, in place of what the script has there. Both 0 when off.
   */
  repeatFromMs: number
  repeatToMs: number
  /**
   * Another loaded axis whose script this one plays (its channel, 'R1'), with
   * this axis's own tweaks on top; '' for its own. The script store does the
   * swap, since only it knows what else is loaded.
   */
  plays: string
  /** The existing script offset, ms; positive plays the script earlier. Applied at play time, not here. */
  offsetMs: number
}

/** A video's tweaks as saved with it, by channel; only channels with something set. */
export type SavedTweaks = Record<string, Partial<ScriptTweaks>>

/** What the tweaks need to know beyond the script itself. */
export interface TweakContext {
  /** The video's length, ms, once known: a repeated stretch fills up to it. 0 or absent: up to the script's end. */
  videoMs?: number
  /** What humanising draws its variations from: the same seed, the same variations, every time. */
  seed?: string
}

export const DEFAULT_TWEAKS: Readonly<ScriptTweaks> = Object.freeze({
  min: 0,
  max: 100,
  invert: false,
  speedCap: 0,
  smooth: 'off',
  smoothAbove: 0,
  strokes: 'as-is',
  humanise: 'off',
  repeatFromMs: 0,
  repeatToMs: 0,
  plays: '',
  offsetMs: 0,
})

/** The slowest cap offered: below this a script barely moves. */
export const MIN_SPEED_CAP = 50
export const MAX_SPEED_CAP = 1000

/** The shortest stretch that can repeat: about one stroke. */
export const MIN_REPEAT_MS = 500
/** Nothing is longer than a day; a time past it is a typo. */
const MAX_REPEAT_MS = 24 * 3600 * 1000

/** How far either side of a point smoothing looks, ms. */
const SMOOTH_WINDOW: Record<SmoothLevel, number> = { off: 0, light: 50, medium: 100 }

/** How far humanising may move a turn: in time (ms) and in depth (0–1). */
const HUMANISE: Record<HumaniseLevel, { ms: number, depth: number }> = {
  off: { ms: 0, depth: 0 },
  light: { ms: 15, depth: 0.04 },
  medium: { ms: 35, depth: 0.08 },
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const level = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? v as T : fallback)

/**
 * A tweak record as stored (or as typed), made safe: anything missing or odd
 * is the default, so records saved before a tweak existed load as they were.
 * `channel` is the axis the record belongs to: playing its own script is the
 * same as playing nothing else.
 */
export function normaliseTweaks(raw: unknown, channel?: string): ScriptTweaks {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof ScriptTweaks, unknown>>
  let min = clamp(Math.round(num(r.min, 0)), 0, 100)
  let max = clamp(Math.round(num(r.max, 100)), 0, 100)
  if (min > max)
    [min, max] = [max, min]
  const cap = Math.round(num(r.speedCap, 0))
  const smooth = level(r.smooth, ['light', 'medium'], 'off')
  // Only meaningful with smoothing on; dropped with it, so "off" is one record, not many.
  const above = smooth === 'off' ? 0 : Math.round(num(r.smoothAbove, 0))
  let from = clamp(Math.round(num(r.repeatFromMs, 0)), 0, MAX_REPEAT_MS)
  let to = clamp(Math.round(num(r.repeatToMs, 0)), 0, MAX_REPEAT_MS)
  if (from > to)
    [from, to] = [to, from]
  if (to - from < MIN_REPEAT_MS)
    from = to = 0
  const plays = typeof r.plays === 'string' && /^[A-Z][A-Z0-9]{0,7}$/i.test(r.plays) && r.plays !== channel ? r.plays : ''
  return {
    min,
    max,
    invert: r.invert === true,
    speedCap: cap <= 0 ? 0 : clamp(cap, MIN_SPEED_CAP, MAX_SPEED_CAP),
    smooth,
    smoothAbove: above <= 0 ? 0 : clamp(above, MIN_SPEED_CAP, MAX_SPEED_CAP),
    strokes: level(r.strokes, ['double', 'half'], 'as-is'),
    humanise: level(r.humanise, ['light', 'medium'], 'off'),
    repeatFromMs: from,
    repeatToMs: to,
    plays,
    offsetMs: clamp(Math.round(num(r.offsetMs, 0)), -9999, 9999),
  }
}

/** True when a stretch is set to repeat. */
export const repeats = (t: ScriptTweaks | undefined): boolean => !!t && t.repeatToMs > t.repeatFromMs

/** True when the tweaks leave the script's shape alone (the offset may still be set). */
export function shapeIsIdentity(t: ScriptTweaks): boolean {
  return t.min === 0 && t.max === 100 && !t.invert && t.speedCap === 0 && t.smooth === 'off' && t.strokes === 'as-is'
    && t.humanise === 'off' && !repeats(t) && !t.plays
}

/** True when nothing is tweaked at all, offset included. */
export function isDefaultTweaks(t: ScriptTweaks): boolean {
  return shapeIsIdentity(t) && t.offsetMs === 0
}

/** Short words for what is on, for a summary line: "Range 10–90 · inverted". */
export function describeTweaks(t: ScriptTweaks): string[] {
  const out: string[] = []
  if (t.plays)
    out.push(`Plays ${t.plays}`)
  if (repeats(t))
    out.push(`Repeats ${formatTime(t.repeatFromMs / 1000)}–${formatTime(t.repeatToMs / 1000)}`)
  if (t.min !== 0 || t.max !== 100)
    out.push(`Range ${t.min}–${t.max}`)
  if (t.invert)
    out.push('Inverted')
  if (t.speedCap)
    out.push(`Max ${t.speedCap}/s`)
  if (t.strokes !== 'as-is')
    out.push(t.strokes === 'double' ? 'Double strokes' : 'Half strokes')
  if (t.smooth !== 'off')
    out.push(`${t.smooth === 'light' ? 'Light' : 'Medium'} smoothing${t.smoothAbove ? ` over ${t.smoothAbove}/s` : ''}`)
  if (t.humanise !== 'off')
    out.push(t.humanise === 'light' ? 'Light humanise' : 'Medium humanise')
  if (t.offsetMs)
    out.push(`${t.offsetMs > 0 ? '+' : ''}${t.offsetMs} ms`)
  return out
}

/**
 * Smoothing: each point takes the average of the script's own curve over a
 * short window around it. On a dense, jittery script that irons out the
 * jitter; on a hand-made one it softens the turnarounds a little (a fast
 * stroke loses a few units at each end). Times never move, and the point
 * count stays the same.
 *
 * With `aboveSpeed` (units per second), only points on a part moving faster
 * than that take the average: jittery, fast parts are smoothed, while slow,
 * deliberate ones stay exactly as written. A point's speed is the faster of
 * the two lines that meet at it.
 *
 * The curve is piecewise linear, so the average is exact: the integral of
 * the curve up to each point is accumulated once, and each window is a
 * difference of two integrals.
 */
export function smoothActions(actions: readonly ScaleAction[], halfWindowMs: number, aboveSpeed = 0): ScaleAction[] {
  const n = actions.length
  if (n < 3 || halfWindowMs <= 0)
    return actions.map(a => ({ at: a.at, pos: a.pos }))
  // cum[i]: integral of the curve from actions[0].at to actions[i].at.
  const cum = new Float64Array(n)
  for (let i = 1; i < n; i++)
    cum[i] = cum[i - 1] + (actions[i].at - actions[i - 1].at) * (actions[i].pos + actions[i - 1].pos) / 2

  const first = actions[0].at
  const last = actions[n - 1].at
  // Integral from the start to time t, with a moving segment index (t only grows per caller).
  const integral = (t: number, hint: { i: number }): number => {
    if (t <= first)
      return (t - first) * actions[0].pos
    if (t >= last)
      return cum[n - 1] + (t - last) * actions[n - 1].pos
    let i = hint.i
    while (i < n - 2 && actions[i + 1].at <= t)
      i++
    while (i > 0 && actions[i].at > t)
      i--
    hint.i = i
    const a = actions[i]
    const b = actions[i + 1]
    const span = b.at - a.at
    const u = span > 0 ? (t - a.at) / span : 0
    const posT = a.pos + (b.pos - a.pos) * u
    return cum[i] + (t - a.at) * (a.pos + posT) / 2
  }

  const lo = { i: 0 }
  const hi = { i: 0 }
  const out: ScaleAction[] = Array.from({ length: n })
  for (let i = 0; i < n; i++) {
    const t = actions[i].at
    // The first and last points stay put: there is no curve beyond them to average.
    // Nor do slow ones, when only the fast parts are smoothed.
    if (i === 0 || i === n - 1
      || (aboveSpeed > 0 && Math.max(segmentSpeed(actions[i - 1], actions[i]), segmentSpeed(actions[i], actions[i + 1])) <= aboveSpeed)) {
      out[i] = { at: t, pos: actions[i].pos }
      continue
    }
    const w = halfWindowMs * 2
    const avg = (integral(t + halfWindowMs, hi) - integral(t - halfWindowMs, lo)) / w
    out[i] = { at: t, pos: clamp(avg, 0, 1) }
  }
  return out
}

/**
 * Twice the strokes or half as many, on the script's own beats. The strokes
 * come out straight (a curve along one is not kept); holds stay holds.
 *
 * Double: every turning point becomes the bottom of a stroke, with its top
 * halfway to the next, so each stroke of the script is two, landing on the
 * same moments. Twice as fast for the same travel: the speed limit below
 * shortens what a device can't keep up with.
 *
 * Half: one stroke where the script has two. The turning point that starts
 * each pair and the one that ends it stay where they are; between them, at
 * the turning point in the middle, the furthest of the pair's two tops.
 *
 * "Bottom" and "top" are relative: a script that starts at its top works the
 * same way with the two swapped.
 */
export function restroke(actions: readonly ScaleAction[], count: StrokeCount): ScaleAction[] {
  const copy = () => actions.map(a => ({ at: a.at, pos: a.pos }))
  const keys = turningPoints(actions)
  if (count === 'as-is' || keys.length < 3)
    return copy()
  const e = keys.map(k => actions[k])
  const n = e.length
  const out: ScaleAction[] = []

  if (count === 'double') {
    // Which way the script's own first stroke goes: its turning points become that stroke's start.
    const up = e[1].pos >= e[0].pos
    const flat = (i: number) => i >= 0 && i < n - 1 && e[i].pos === e[i + 1].pos
    for (let i = 0; i < n; i++) {
      const near = [e[i - 1]?.pos, e[i].pos, e[i + 1]?.pos].filter((p): p is number => p !== undefined)
      // A hold keeps its own level at both ends.
      const start = flat(i) || flat(i - 1) ? e[i].pos : up ? Math.min(...near) : Math.max(...near)
      out.push({ at: e[i].at, pos: start })
      if (i < n - 1 && !flat(i) && e[i + 1].at - e[i].at >= 2) {
        const turn = up ? Math.max(e[i].pos, e[i + 1].pos) : Math.min(e[i].pos, e[i + 1].pos)
        out.push({ at: Math.round((e[i].at + e[i + 1].at) / 2), pos: turn })
      }
    }
    return out
  }

  // Half: pairs of strokes, four turning points apart.
  let j = 0
  out.push({ at: e[0].at, pos: e[0].pos })
  while (j + 4 < n) {
    const goingUp = e[j + 1].pos >= e[j].pos
    const turn = goingUp ? Math.max(e[j + 1].pos, e[j + 3].pos) : Math.min(e[j + 1].pos, e[j + 3].pos)
    out.push({ at: e[j + 2].at, pos: turn })
    out.push({ at: e[j + 4].at, pos: e[j + 4].pos })
    j += 4
  }
  // Fewer than two strokes left: as they are.
  for (let k = j + 1; k < n; k++)
    out.push({ at: e[k].at, pos: e[k].pos })
  return out
}

/** Which way the script leaves point `i`: 1 up, -1 down, 0 holding (the last point: the way it came in, reversed). */
function leaves(actions: readonly ScaleAction[], i: number): number {
  const n = actions.length
  return i < n - 1 ? Math.sign(actions[i + 1].pos - actions[i].pos) : -Math.sign(actions[i].pos - actions[i - 1].pos)
}

/**
 * Where a repeated stretch really starts and ends, ms: at the turning points
 * nearest the times asked for, with the end on one that leaves the same way
 * as the start (a bottom for a bottom), so each repeat runs into the next
 * like the strokes it was cut from. Within a quarter of the stretch (and two
 * seconds) of what was asked; past that, or with no such turn, the times as
 * asked, and the seam is one straight line.
 */
function snapStretch(actions: readonly ScaleAction[], from: number, to: number): [number, number] {
  const reach = Math.min((to - from) / 4, 2000)
  const keys = turningPoints(actions)
  const nearest = (t: number, ok: (i: number) => boolean) => {
    let best = -1
    for (const k of keys) {
      const d = Math.abs(actions[k].at - t)
      if (d <= reach && ok(k) && (best < 0 || d < Math.abs(actions[best].at - t)))
        best = k
    }
    return best
  }
  const a = nearest(from, () => true)
  if (a < 0)
    return [from, to]
  const way = leaves(actions, a)
  const b = nearest(to, k => k > a && leaves(actions, k) === way)
  if (b < 0 || actions[b].at - actions[a].at < MIN_REPEAT_MS)
    return [from, to]
  return [actions[a].at, actions[b].at]
}

/**
 * Repeat a stretch, for a script that stops early or goes wrong near the
 * end: the script as it is up to the stretch's end, then the stretch again
 * and again, back to back, up to `endMs`, in place of whatever the script
 * had there (and nothing past `endMs`). The ends snap to nearby turning
 * points (see snapStretch). A stretch with nothing in it, or one that ends
 * at or past `endMs`, leaves the script as it is.
 */
export function repeatStretch(actions: readonly ScaleAction[], fromMs: number, toMs: number, endMs: number): ScaleAction[] {
  const copy = () => actions.map(a => ({ at: a.at, pos: a.pos }))
  if (actions.length < 2 || toMs - fromMs < MIN_REPEAT_MS)
    return copy()
  const [a, b] = snapStretch(actions, fromMs, toMs)
  const len = b - a
  // The stretch: where the curve is at its start, then every point inside it.
  const body: ScaleAction[] = [{ at: a, pos: positionAt(actions, a) }]
  for (let i = lowerBound(actions, a); i < actions.length && actions[i].at < b; i++) {
    if (actions[i].at > a)
      body.push(actions[i])
  }
  if (body.length < 2 || endMs <= b)
    return copy()

  const out = actions.slice(0, lowerBound(actions, b)).map(p => ({ at: p.at, pos: p.pos }))
  // A long video and a short, dense stretch is a lot of points; past this it is surely a mistake.
  const limit = 2_000_000
  for (let k = 1; out.length < limit; k++) {
    for (const q of body) {
      const at = q.at + k * len
      if (at > endMs) {
        // Right up to the end: where the curve is then.
        const last = out[out.length - 1]
        if (last.at < endMs)
          out.push({ at: endMs, pos: last.pos + (q.pos - last.pos) * (endMs - last.at) / (at - last.at) })
        return out
      }
      out.push({ at, pos: q.pos })
    }
  }
  return out
}

/** A 32-bit hash of a string (FNV-1a), to seed humanising. */
function hashString(s: string): number {
  let h = 0x811C9DC5
  for (let i = 0; i < s.length; i++)
    h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return h >>> 0
}

/** A number in -1..1 that depends only on the seed, a time and which variation it is for. */
function wobble(seed: number, at: number, salt: number): number {
  let h = (seed ^ Math.imul(Math.round(at) + salt * 0x632BE5AB, 0x9E3779B1)) >>> 0
  h = Math.imul(h ^ (h >>> 16), 0x85EBCA6B)
  h = Math.imul(h ^ (h >>> 13), 0xC2B2AE35)
  h = (h ^ (h >>> 16)) >>> 0
  return h / 0xFFFFFFFF * 2 - 1
}

/**
 * Humanise: each turn of the script lands a little early or late and goes a
 * little further or less far, so a looped or generated pattern stops feeling
 * mechanical. The variations come from `seed` and each turn's own time, so
 * the same video and axis play the same way every time (and an edit only
 * changes the turns it touches).
 *
 * Nothing is reordered or crosses over: a turn moves in time by at most a
 * fifth of the gap to the points either side of it, and in depth by at most
 * a quarter of its travel to the turns either side (so a hold, with no
 * travel, stays a hold). The points between two turns follow them in
 * position, keeping their place along the way. The first and last points stay
 * as they are.
 */
export function humanise(actions: readonly ScaleAction[], amount: HumaniseLevel, seed: string): ScaleAction[] {
  const out = actions.map(a => ({ at: a.at, pos: a.pos }))
  const keys = turningPoints(actions)
  const { ms, depth } = HUMANISE[amount]
  if (amount === 'off' || keys.length < 3)
    return out
  const base = hashString(seed)
  for (let j = 1; j < keys.length - 1; j++) {
    const i = keys[j]
    const p = actions[i]
    const room = Math.floor(Math.min(p.at - actions[i - 1].at, actions[i + 1].at - p.at) / 5)
    out[i].at = p.at + Math.round(wobble(base, p.at, 1) * Math.min(ms, room))
    const travel = Math.min(Math.abs(p.pos - actions[keys[j - 1]].pos), Math.abs(p.pos - actions[keys[j + 1]].pos))
    out[i].pos = clamp(p.pos + wobble(base, p.at, 2) * Math.min(depth, travel / 4), 0, 1)
  }
  // Between two turns the line runs one way; its points are stretched to the turns' new depths.
  for (let j = 0; j < keys.length - 1; j++) {
    const a = keys[j]
    const b = keys[j + 1]
    const from = actions[a].pos
    const span = actions[b].pos - from
    if (b - a < 2 || span === 0)
      continue
    const scale = (out[b].pos - out[a].pos) / span
    for (let i = a + 1; i < b; i++)
      out[i].pos = clamp(out[a].pos + (actions[i].pos - from) * scale, 0, 1)
  }
  return out
}

/**
 * The script as it plays with `t` applied. Order matters:
 *
 * 1. Which script (its own, or another axis's) is the script store's choice,
 *    made before this.
 * 2. The repeated stretch first: it decides what the script says over time,
 *    and everything after treats the result as if it were written that way
 *    (doubled strokes double the repeats too).
 * 3. The stroke count, which decides where the turning points are.
 * 4. Smoothing, on that shape, to iron out its jitter.
 * 5. Humanising after smoothing, so smoothing does not iron the variations
 *    away, and before the range, so they stay inside it.
 * 6. Invert and the output range.
 * 7. The speed cap last, so it holds on what actually reaches the device.
 *    It shortens the travel of strokes that are too fast rather than moving
 *    anything in time (the same method as the intensity knob).
 *
 * The stretch to repeat is in video time, as the player shows it; it is
 * moved by the offset into the script's own time here.
 *
 * Returns new objects; the input is left alone. The offset is not applied:
 * it is a play-time setting.
 */
export function applyTweaks(actions: readonly ScaleAction[], t: ScriptTweaks, ctx: TweakContext = {}): ScaleAction[] {
  let shaped = actions
  if (repeats(t) && actions.length > 1) {
    const end = ctx.videoMs && ctx.videoMs > 0 ? ctx.videoMs + t.offsetMs : actions[actions.length - 1].at
    shaped = repeatStretch(actions, t.repeatFromMs + t.offsetMs, t.repeatToMs + t.offsetMs, end)
  }
  if (t.strokes !== 'as-is')
    shaped = restroke(shaped, t.strokes)
  if (t.smooth !== 'off')
    shaped = smoothActions(shaped, SMOOTH_WINDOW[t.smooth], t.smoothAbove)
  if (t.humanise !== 'off')
    shaped = humanise(shaped, t.humanise, ctx.seed ?? '')
  let out: ScaleAction[] = shaped === actions ? actions.map(a => ({ at: a.at, pos: a.pos })) : shaped as ScaleAction[]

  const lo = t.min / 100
  const span = (t.max - t.min) / 100
  if (t.invert || lo !== 0 || span !== 1) {
    for (const a of out) {
      const p = t.invert ? 1 - a.pos : a.pos
      a.pos = clamp(lo + p * span, 0, 1)
    }
  }

  if (t.speedCap > 0 && out.length > 1)
    out = scaleScript(out, { amplitude: 1, speedCap: t.speedCap }).actions

  return out
}

/**
 * Bake an offset into the times, for exporting a script that plays in sync
 * in another player: a positive offset (script earlier) moves every point
 * earlier. Points pushed before zero are dropped, keeping where the curve
 * was at zero so the start does not jump.
 */
export function bakeOffset(actions: readonly ScaleAction[], offsetMs: number): ScaleAction[] {
  if (!offsetMs)
    return actions.map(a => ({ at: a.at, pos: a.pos }))
  const shifted = actions.map(a => ({ at: Math.round(a.at - offsetMs), pos: a.pos }))
  const firstKept = shifted.findIndex(a => a.at >= 0)
  if (firstKept <= 0)
    return firstKept === 0 ? shifted : []
  const out = shifted.slice(firstKept)
  if (out[0].at > 0) {
    const a = shifted[firstKept - 1]
    const b = shifted[firstKept]
    const u = (0 - a.at) / (b.at - a.at)
    out.unshift({ at: 0, pos: a.pos + (b.pos - a.pos) * u })
  }
  return out
}
