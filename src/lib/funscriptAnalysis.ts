/**
 * Deriving a beat from a funscript.
 *
 * A funscript is just a position curve, but it carries exactly what the audio
 * session wants: how fast the strokes are coming, how deep they are, and where
 * in the current stroke we are right now. This module extracts that as plain
 * data so the audio engine can be driven from the script the user is actually
 * watching, rather than from a fixed tempo.
 *
 * Vue-free and side-effect-free so it can be unit tested directly.
 */

export interface Action {
  /** milliseconds */
  at: number
  /** 0-1 */
  pos: number
}

export interface Peak {
  /** milliseconds */
  at: number
  /** 0-1 position at the turning point */
  pos: number
  /** How far this peak rose above the preceding trough, 0-1. */
  prominence: number
}

export interface EnvelopeSample {
  /** milliseconds */
  at: number
  /** Stroke cycles per minute at this point. */
  spm: number
  /** Mean absolute speed in position-units per second (pos is 0-1). */
  speed: number
  /** Mean stroke range, 0-1. */
  depth: number
}

/** Ignore wobble smaller than this when picking turning points. */
const MIN_PROMINENCE = 0.06

/**
 * Local maxima of the position curve, which is where a stroke "lands" and so
 * where a pulse should fall. Flat runs are collapsed to their midpoint, and
 * shallow wobble is rejected so dense scripts do not produce phantom peaks.
 */
export function detectPeaks(actions: Action[], minProminence = MIN_PROMINENCE): Peak[] {
  if (actions.length < 3)
    return []

  const peaks: Peak[] = []
  let lastTrough = actions[0].pos
  let i = 1

  while (i < actions.length - 1) {
    const prev = actions[i - 1].pos
    const cur = actions[i].pos

    // Walk across any plateau so a flat top yields one peak, not several.
    let j = i
    while (j < actions.length - 1 && actions[j + 1].pos === cur) j++
    const next = actions[Math.min(j + 1, actions.length - 1)].pos

    if (cur > prev && cur >= next) {
      const prominence = cur - lastTrough
      if (prominence >= minProminence) {
        const at = (actions[i].at + actions[j].at) / 2
        peaks.push({ at, pos: cur, prominence })
      }
    }
    else if (cur < prev && cur <= next) {
      lastTrough = Math.min(lastTrough, cur)
      if (cur < lastTrough || peaks.length)
        lastTrough = cur
    }

    i = j + 1
  }
  return peaks
}

/**
 * Where we are within the current stroke cycle, measured peak to peak.
 *
 * Phase 0 is a peak, so aligning the audio pulse to this makes the pulse land
 * on the stroke rather than merely run at the same tempo. Returns null outside
 * the scripted range or when there is nothing to lock to.
 */
export function strokePhaseAt(peaks: Peak[], tMs: number): { phase: number, rateHz: number } | null {
  if (peaks.length < 2)
    return null
  if (tMs < peaks[0].at || tMs > peaks[peaks.length - 1].at)
    return null

  // Binary search for the cycle containing tMs.
  let lo = 0
  let hi = peaks.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (peaks[mid].at <= tMs)
      lo = mid
    else
      hi = mid
  }

  const span = peaks[hi].at - peaks[lo].at
  if (span <= 0)
    return null

  return {
    phase: Math.min(1, Math.max(0, (tMs - peaks[lo].at) / span)),
    rateHz: 1000 / span,
  }
}

/**
 * Sample the script into a fixed-resolution envelope of rate, speed and depth,
 * each averaged over a trailing window so the result is stable enough to drive
 * audio without chattering.
 */
export function buildEnvelope(
  actions: Action[],
  resolutionMs = 250,
  windowMs = 3000,
): EnvelopeSample[] {
  if (actions.length < 2)
    return []

  const peaks = detectPeaks(actions)
  const endMs = actions[actions.length - 1].at
  const out: EnvelopeSample[] = []

  for (let t = 0; t <= endMs; t += resolutionMs) {
    const from = t - windowMs
    const to = t

    // Speed: mean |dpos|/dt over the window.
    let moved = 0
    let elapsed = 0
    for (let i = 1; i < actions.length; i++) {
      const a = actions[i - 1]
      const b = actions[i]
      if (b.at < from || a.at > to)
        continue
      moved += Math.abs(b.pos - a.pos)
      elapsed += b.at - a.at
    }
    const speed = elapsed > 0 ? (moved / elapsed) * 1000 : 0

    // Rate and depth from the peaks inside the window.
    const inWin = peaks.filter(p => p.at >= from && p.at <= to)
    let spm = 0
    if (inWin.length >= 2) {
      const span = inWin[inWin.length - 1].at - inWin[0].at
      if (span > 0)
        spm = ((inWin.length - 1) / span) * 60000
    }
    const depth = inWin.length
      ? inWin.reduce((s, p) => s + p.prominence, 0) / inWin.length
      : 0

    out.push({ at: t, spm, speed, depth })
  }
  return out
}

/** Linear interpolation into an envelope built by `buildEnvelope`. */
export function sampleEnvelope(env: EnvelopeSample[], tMs: number): EnvelopeSample | null {
  if (!env.length)
    return null
  if (tMs <= env[0].at)
    return env[0]
  if (tMs >= env[env.length - 1].at)
    return env[env.length - 1]

  const step = env.length > 1 ? env[1].at - env[0].at : 1
  const idx = Math.min(env.length - 2, Math.max(0, Math.floor(tMs / step)))
  const a = env[idx]
  const b = env[idx + 1]
  const span = b.at - a.at
  const f = span > 0 ? (tMs - a.at) / span : 0

  return {
    at: tMs,
    spm: a.spm + (b.spm - a.spm) * f,
    speed: a.speed + (b.speed - a.speed) * f,
    depth: a.depth + (b.depth - a.depth) * f,
  }
}

/**
 * Normalise a script's speed to 0-1 for driving session intensity.
 *
 * `refSpeed` is the position-units per second treated as "fully intense".
 * 1.8 corresponds to roughly 180 conventional funscript speed units, which is
 * brisk without being the ceiling.
 */
export function speedToIntensity(speed: number, refSpeed = 1.8): number {
  return Math.min(1, Math.max(0, speed / refSpeed))
}

/**
 * Shortest signed distance from `from` to `to` on a 0-1 circle, in [-0.5, 0.5).
 * Used to steer the audio pulse onto the script's stroke phase.
 */
export function phaseError(from: number, to: number): number {
  let d = (to - from) % 1
  if (d < -0.5)
    d += 1
  if (d >= 0.5)
    d -= 1
  return d
}
