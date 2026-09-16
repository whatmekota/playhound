/**
 * Beat detection from an audio spectrum.
 *
 * Aimed at PMVs, where the video already has a hard beat grid that the app
 * otherwise ignores completely — the session invents its own tempo while the
 * music plays underneath, unrelated to it.
 *
 * Deliberately Vue-free and stateless where possible, so the awkward parts
 * (thresholding, tempo estimation) can be tested against synthetic input
 * instead of by ear.
 */

/**
 * Spectral flux: how much energy *rose* between two spectra.
 *
 * Only increases count — a note starting is an onset, a note ending is not.
 */
export function spectralFlux(prev: Float32Array, cur: Float32Array): number {
  const n = Math.min(prev.length, cur.length)
  let sum = 0
  for (let i = 0; i < n; i++) {
    const d = cur[i] - prev[i]
    if (d > 0)
      sum += d
  }
  return sum / (n || 1)
}

export interface OnsetOptions {
  /** How many flux samples the running threshold looks back over. */
  window?: number
  /** Standard deviations above the mean before a peak counts. */
  sensitivity?: number
  /** Ignore onsets closer together than this, in ms. */
  minGapMs?: number
}

const DEFAULTS: Required<OnsetOptions> = {
  window: 43, // ~1s at 43 frames/sec
  sensitivity: 1.5,
  minGapMs: 120, // 500 bpm ceiling; nothing musical is faster
}

/**
 * Adaptive onset detector.
 *
 * A fixed threshold cannot work across quiet intros and loud drops, so the
 * threshold follows the recent mean and spread of the flux itself.
 */
export function createOnsetDetector(opts: OnsetOptions = {}) {
  const { window, sensitivity, minGapMs } = { ...DEFAULTS, ...opts }
  const history: number[] = []
  let lastOnsetMs = Number.NEGATIVE_INFINITY

  return {
    /** Returns true when this sample is an onset. */
    push(flux: number, tMs: number): boolean {
      history.push(flux)
      if (history.length > window)
        history.shift()

      // Not enough context yet to say what "loud" means here.
      if (history.length < Math.min(8, window))
        return false

      const mean = history.reduce((s, v) => s + v, 0) / history.length
      const variance = history.reduce((s, v) => s + (v - mean) ** 2, 0) / history.length
      const threshold = mean + sensitivity * Math.sqrt(variance)

      if (flux <= threshold || flux <= 0)
        return false
      if (tMs - lastOnsetMs < minGapMs)
        return false

      lastOnsetMs = tMs
      return true
    },
    reset() {
      history.length = 0
      lastOnsetMs = Number.NEGATIVE_INFINITY
    },
  }
}

/** Musical tempo range, in ms per beat. 200 bpm down to 60 bpm. */
const MIN_PERIOD_MS = 300
const MAX_PERIOD_MS = 1000

/**
 * Estimate the beat period from onset times.
 *
 * Uses the median inter-onset interval rather than the mean, since a missed or
 * spurious onset would drag a mean badly. Intervals are folded into the musical
 * range first: onsets often land on eighths or half-bars, and a period of twice
 * or half the true beat is the same grid.
 */
export function estimatePeriod(onsetsMs: number[]): number | null {
  if (onsetsMs.length < 4)
    return null

  const intervals: number[] = []
  for (let i = 1; i < onsetsMs.length; i++) {
    let iv = onsetsMs[i] - onsetsMs[i - 1]
    if (iv <= 0)
      continue
    // Fold octaves: 2x or 0.5x the beat is the same grid.
    while (iv < MIN_PERIOD_MS) iv *= 2
    while (iv > MAX_PERIOD_MS) iv /= 2
    if (iv >= MIN_PERIOD_MS && iv <= MAX_PERIOD_MS)
      intervals.push(iv)
  }

  if (intervals.length < 3)
    return null

  intervals.sort((a, b) => a - b)
  const mid = Math.floor(intervals.length / 2)
  const median = intervals.length % 2
    ? intervals[mid]
    : (intervals[mid - 1] + intervals[mid]) / 2

  // Average the intervals close to the median, so a steady beat is precise.
  const near = intervals.filter(v => Math.abs(v - median) < median * 0.15)
  if (!near.length)
    return median
  return near.reduce((s, v) => s + v, 0) / near.length
}

export function periodToBpm(periodMs: number): number {
  return periodMs > 0 ? 60000 / periodMs : 0
}

/**
 * Phase within the beat at a given moment, 0 at the beat itself.
 *
 * Extrapolates forward from the last onset, so it keeps running between
 * detections instead of only updating when one lands.
 */
export function beatPhaseAt(lastOnsetMs: number, periodMs: number, tMs: number): number {
  if (periodMs <= 0)
    return 0
  const elapsed = tMs - lastOnsetMs
  const phase = (elapsed % periodMs) / periodMs
  return phase < 0 ? phase + 1 : phase
}
