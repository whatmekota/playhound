/**
 * Pure maths for the generative motion source.
 *
 * Kept free of Vue and Pinia so it can be unit-tested directly, and so the
 * safety-relevant parts (speed ceiling, ramping) are easy to reason about.
 */

export type StrokeShape = 'sine' | 'ease' | 'pulse'

const TAU = Math.PI * 2

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** Linear interpolation of `t` (0–1) across [a, b]. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp(t, 0, 1)
}

/**
 * Advance the stroke phase by `dt` seconds at `spm` strokes per minute.
 *
 * The engine accumulates phase rather than recomputing it from elapsed time,
 * so changing the rate never makes the position jump — it only changes how
 * fast the phase advances from where it already is.
 */
export function advancePhase(phase: number, spm: number, dt: number): number {
  const next = phase + TAU * (Math.max(0, spm) / 60) * dt
  return next % TAU
}

/** Map a stroke phase (radians) to a 0–1 position. 0 = fully retracted. */
export function strokePosition(phase: number, shape: StrokeShape = 'sine'): number {
  const p = ((phase % TAU) + TAU) % TAU

  if (shape === 'sine')
    return (1 - Math.cos(p)) / 2

  if (shape === 'ease') {
    // Smoothstep the sine so the stroke dwells at both ends.
    const s = (1 - Math.cos(p)) / 2
    return s * s * (3 - 2 * s)
  }

  // pulse: quick rise over the first third, slower fall over the rest.
  const t = p / TAU
  if (t < 1 / 3) {
    const u = t * 3
    return 1 - (1 - u) ** 3
  }
  const u = (t - 1 / 3) / (2 / 3)
  return 1 - (u < 0.5 ? 4 * u ** 3 : 1 - (-2 * u + 2) ** 3 / 2)
}

/**
 * Move `current` toward `target`, never faster than `perSec` units per second.
 * This is what stops a phase change from slamming the axis.
 */
export function rampToward(current: number, target: number, perSec: number, dt: number): number {
  const maxStep = Math.abs(perSec) * Math.max(0, dt)
  const delta = target - current
  if (Math.abs(delta) <= maxStep)
    return target
  return current + Math.sign(delta) * maxStep
}

/** Session intensity (0–1) to strokes per minute. */
export function spmFromIntensity(intensity: number, minSpm: number, maxSpm: number): number {
  return lerp(minSpm, maxSpm, intensity)
}

/** Session intensity (0–1) to stroke depth (fraction of the axis range). */
export function depthFromIntensity(intensity: number, minDepth: number, maxDepth: number): number {
  return lerp(minDepth, maxDepth, intensity)
}

/**
 * Choose a power-of-two divisor that brings a binaural beat frequency down to
 * a usable stroke rate — a 6 Hz beat is 360 strokes/min raw, which no hardware
 * should attempt. Prefers a divisor landing inside [lo, hi]; if none does,
 * returns whichever gets closest to the middle of the band.
 */
export function pickBeatDivisor(beatHz: number, lo: number, hi: number): number {
  const target = (lo + hi) / 2
  let best = 1
  let bestErr = Number.POSITIVE_INFINITY

  for (const d of [1, 2, 4, 8, 16, 32, 64]) {
    const spm = (beatHz * 60) / d
    const inBand = spm >= lo && spm <= hi
    // Out-of-band candidates are only considered if nothing lands in band.
    const err = Math.abs(spm - target) + (inBand ? 0 : 1e6)
    if (err < bestErr) {
      bestErr = err
      best = d
    }
  }
  return best
}

/**
 * Turn a 0–1 stroke position into an axis position, given the midpoint and how
 * much of the range to use. Always stays within 0–1; per-axis min/max and
 * inversion are applied further down in the TCode encoder.
 */
export function applyDepth(unit: number, center: number, depth: number): number {
  const half = clamp(depth, 0, 1) / 2
  const lo = clamp(center - half, 0, 1)
  const hi = clamp(center + half, 0, 1)
  return lerp(lo, hi, unit)
}
