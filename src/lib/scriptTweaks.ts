import type { ScaleAction } from './scriptScale'
import { scaleScript } from './scriptScale'

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
  /** The existing script offset, ms; positive plays the script earlier. Applied at play time, not here. */
  offsetMs: number
}

/** A video's tweaks as saved with it, by channel; only channels with something set. */
export type SavedTweaks = Record<string, Partial<ScriptTweaks>>

export const DEFAULT_TWEAKS: Readonly<ScriptTweaks> = Object.freeze({
  min: 0,
  max: 100,
  invert: false,
  speedCap: 0,
  smooth: 'off',
  offsetMs: 0,
})

/** The slowest cap offered: below this a script barely moves. */
export const MIN_SPEED_CAP = 50
export const MAX_SPEED_CAP = 1000

/** How far either side of a point smoothing looks, ms. */
const SMOOTH_WINDOW: Record<SmoothLevel, number> = { off: 0, light: 50, medium: 100 }

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

/** A tweak record as stored (or as typed), made safe: anything missing or odd is the default. */
export function normaliseTweaks(raw: unknown): ScriptTweaks {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof ScriptTweaks, unknown>>
  let min = clamp(Math.round(num(r.min, 0)), 0, 100)
  let max = clamp(Math.round(num(r.max, 100)), 0, 100)
  if (min > max)
    [min, max] = [max, min]
  const cap = Math.round(num(r.speedCap, 0))
  return {
    min,
    max,
    invert: r.invert === true,
    speedCap: cap <= 0 ? 0 : clamp(cap, MIN_SPEED_CAP, MAX_SPEED_CAP),
    smooth: r.smooth === 'light' || r.smooth === 'medium' ? r.smooth : 'off',
    offsetMs: clamp(Math.round(num(r.offsetMs, 0)), -9999, 9999),
  }
}

/** True when the tweaks leave the script's shape alone (the offset may still be set). */
export function shapeIsIdentity(t: ScriptTweaks): boolean {
  return t.min === 0 && t.max === 100 && !t.invert && t.speedCap === 0 && t.smooth === 'off'
}

/** True when nothing is tweaked at all, offset included. */
export function isDefaultTweaks(t: ScriptTweaks): boolean {
  return shapeIsIdentity(t) && t.offsetMs === 0
}

/** Short words for what is on, for a summary line: "Range 10–90 · inverted". */
export function describeTweaks(t: ScriptTweaks): string[] {
  const out: string[] = []
  if (t.min !== 0 || t.max !== 100)
    out.push(`Range ${t.min}–${t.max}`)
  if (t.invert)
    out.push('Inverted')
  if (t.speedCap)
    out.push(`Max ${t.speedCap}/s`)
  if (t.smooth !== 'off')
    out.push(t.smooth === 'light' ? 'Light smoothing' : 'Medium smoothing')
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
 * The curve is piecewise linear, so the average is exact: the integral of
 * the curve up to each point is accumulated once, and each window is a
 * difference of two integrals.
 */
export function smoothActions(actions: readonly ScaleAction[], halfWindowMs: number): ScaleAction[] {
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
    if (i === 0 || i === n - 1) {
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
 * The script as it plays with `t` applied. Order matters: smoothing first
 * (on the shape as written), then invert and the output range, then the
 * speed cap last, so the cap holds on what actually reaches the device.
 * The speed cap shortens the travel of strokes that are too fast rather than
 * moving anything in time (the same method as the intensity knob).
 *
 * Returns new objects; the input is left alone. The offset is not applied:
 * it is a play-time setting.
 */
export function applyTweaks(actions: readonly ScaleAction[], t: ScriptTweaks): ScaleAction[] {
  let out: ScaleAction[] = t.smooth !== 'off'
    ? smoothActions(actions, SMOOTH_WINDOW[t.smooth])
    : actions.map(a => ({ at: a.at, pos: a.pos }))

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
