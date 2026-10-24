/**
 * Device latency: how long after a command the hardware actually gets there.
 *
 * It is applied on top of each script's own offset and in the same direction
 * (see useVideoSync): a positive latency reads the script that much further
 * ahead, so a device that lags arrives on time.
 *
 * The calibration is a tap-along test. The device (or, without one, a bar on
 * screen) strokes at a steady rate; the user taps on every turn. Each tap is
 * matched to the turn it was aimed at, and the typical gap between the two is
 * the latency. People tapping to a steady beat anticipate rather than react,
 * so reaction time largely drops out — but a few taps are always fumbled, so
 * the estimate has to shrug those off.
 */

/** Furthest the setting goes either way. Past a second it is not latency, it is a different video. */
export const LATENCY_LIMIT_MS = 1000

export function clampLatency(ms: number): number {
  if (!Number.isFinite(ms))
    return 0
  return Math.max(-LATENCY_LIMIT_MS, Math.min(LATENCY_LIMIT_MS, Math.round(ms)))
}

/** Taps fewer than this and there is nothing worth reporting. */
export const MIN_TAPS = 6

/** Scale from median absolute deviation to a standard deviation, for normal data. */
const MAD_TO_SD = 1.4826

/**
 * Below this a spread is just as likely to be quantisation (frame timing,
 * key scan) as real, and a smaller MAD would make the outlier fence absurdly
 * tight around a lucky run of identical taps.
 */
const MIN_SPREAD_MS = 8

export type LatencyConfidence = 'high' | 'medium' | 'low'

export interface LatencyEstimate {
  /** Median tap-minus-turn of the taps that were kept, ms. Positive: device lags. */
  offsetMs: number
  /** Robust standard deviation of the kept taps, ms. */
  spreadMs: number
  /** Taps used / taps matched to a turn. */
  kept: number
  total: number
  confidence: LatencyConfidence
  /** Every matched offset with whether it was kept, for plotting. */
  samples: { offsetMs: number, kept: boolean }[]
}

export function median(values: number[]): number {
  if (!values.length)
    return Number.NaN
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * Offset of each tap from the turn it was aimed at.
 *
 * A tap belongs to the nearest turn, which is unambiguous as long as the
 * latency plus the user's slop stays under half the gap between turns — the
 * reason the test strokes slowly. Taps further than `maxGapMs` from any turn
 * (a stray press before the first or after the last) are dropped outright.
 */
export function matchTaps(turnsMs: number[], tapsMs: number[], maxGapMs: number): number[] {
  if (!turnsMs.length)
    return []
  const turns = [...turnsMs].sort((a, b) => a - b)
  const out: number[] = []
  let j = 0
  for (const tap of [...tapsMs].sort((a, b) => a - b)) {
    // Turns and taps are both sorted, so the nearest turn only ever moves forward.
    while (j < turns.length - 1 && Math.abs(turns[j + 1] - tap) <= Math.abs(turns[j] - tap))
      j++
    const d = tap - turns[j]
    if (Math.abs(d) <= maxGapMs)
      out.push(d)
  }
  return out
}

/**
 * Median offset with outliers rejected.
 *
 * The fence is three robust standard deviations around the median, worked
 * out from the MAD so a couple of wild taps cannot widen it the way they
 * would widen a plain standard deviation.
 */
export function robustOffset(offsets: number[]): Omit<LatencyEstimate, 'confidence'> | null {
  if (offsets.length < MIN_TAPS)
    return null

  const m0 = median(offsets)
  const mad = median(offsets.map(o => Math.abs(o - m0)))
  const fence = 3 * Math.max(MIN_SPREAD_MS, mad * MAD_TO_SD)

  const samples = offsets.map(o => ({ offsetMs: o, kept: Math.abs(o - m0) <= fence }))
  const kept = samples.filter(s => s.kept).map(s => s.offsetMs)
  if (kept.length < MIN_TAPS)
    return null

  const m = median(kept)
  const spread = Math.max(MIN_SPREAD_MS, median(kept.map(o => Math.abs(o - m))) * MAD_TO_SD)

  return {
    offsetMs: Math.round(m),
    spreadMs: Math.round(spread),
    kept: kept.length,
    total: offsets.length,
    samples,
  }
}

/**
 * How far to trust it: enough taps that the median has settled, tight enough
 * that they were aimed at the same thing, and few enough thrown away that the
 * user was actually following the stroke.
 */
export function rateConfidence(e: { spreadMs: number, kept: number, total: number }): LatencyConfidence {
  const keptRatio = e.total ? e.kept / e.total : 0
  if (e.kept >= 12 && e.spreadMs <= 35 && keptRatio >= 0.8)
    return 'high'
  if (e.kept >= 8 && e.spreadMs <= 70 && keptRatio >= 0.6)
    return 'medium'
  return 'low'
}

/**
 * The whole calibration in one call.
 *
 * `turnsMs` are the moments the stroke was commanded to reverse (send time
 * plus the move's own duration), `tapsMs` the user's presses, both on the same
 * clock. `skipFirst` drops the opening taps, while the user is still finding
 * the rhythm.
 */
export function estimateLatency(
  turnsMs: number[],
  tapsMs: number[],
  opts: { turnGapMs: number, skipFirst?: number } = { turnGapMs: 600 },
): LatencyEstimate | null {
  const skip = opts.skipFirst ?? 0
  const taps = [...tapsMs].sort((a, b) => a - b).slice(skip)
  const offsets = matchTaps(turnsMs, taps, opts.turnGapMs / 2)
  const r = robustOffset(offsets)
  if (!r)
    return null
  return { ...r, confidence: rateConfidence(r) }
}
