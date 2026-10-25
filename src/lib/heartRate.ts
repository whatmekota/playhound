/**
 * Heart rate: reading the standard Bluetooth packet, and turning a noisy beat
 * count into something a session can act on.
 *
 * Wrist sensors report every second or so, jump by a few beats on any arm
 * movement, and sometimes drop to a nonsense value when contact slips. What
 * the session wants is slower: is this person above where they rest, and is
 * it climbing fast? So the readings are smoothed, a resting baseline is kept
 * as a low percentile of the last few minutes (a percentile, not a minimum,
 * so one bad sample cannot drag it down), and the rise over a short window is
 * measured on the smoothed line.
 *
 * Pure: the composable (useHeartRate) owns Bluetooth and the clock and hands
 * readings in.
 */

// ─── GATT Heart Rate Measurement (0x2A37) ────────────────────────────────────

export interface HeartRatePacket {
  bpm: number
  /** Skin contact: true/false when the sensor reports it, null when it cannot tell. */
  contact: boolean | null
  /** Cumulative energy expended, kJ, when present. */
  energyKj: number | null
  /** Beat-to-beat intervals in ms, when present (often several per packet). */
  rrMs: number[]
}

/**
 * Parse a Heart Rate Measurement notification.
 *
 * Flags byte, per the Bluetooth Heart Rate Service spec:
 * - bit 0: bpm is uint16 (else uint8)
 * - bit 1: contact detected; bit 2: contact detection supported
 * - bit 3: energy expended (uint16, kJ) follows
 * - bit 4: RR intervals (uint16 each, 1/1024 s) fill the rest
 * All multi-byte fields are little-endian. Returns null for a packet too
 * short to hold what its flags promise.
 */
export function parseHeartRateMeasurement(view: DataView): HeartRatePacket | null {
  if (view.byteLength < 2)
    return null
  const flags = view.getUint8(0)
  let i = 1
  let bpm: number
  if (flags & 0x01) {
    if (view.byteLength < 3)
      return null
    bpm = view.getUint16(i, true)
    i += 2
  }
  else {
    bpm = view.getUint8(i)
    i += 1
  }

  const contact = flags & 0x04 ? !!(flags & 0x02) : null

  let energyKj: number | null = null
  if (flags & 0x08) {
    if (view.byteLength < i + 2)
      return null
    energyKj = view.getUint16(i, true)
    i += 2
  }

  const rrMs: number[] = []
  if (flags & 0x10) {
    for (; i + 1 < view.byteLength; i += 2)
      rrMs.push(Math.round(view.getUint16(i, true) * 1000 / 1024))
  }

  return { bpm, contact, energyKj, rrMs }
}

// ─── Processing ──────────────────────────────────────────────────────────────

/** Outside this, a reading is a glitch (lost contact, a packet of zeros). */
export const BPM_MIN = 30
export const BPM_MAX = 230

export interface HeartRateOptions {
  /** Smoothing time constant, seconds. */
  smoothSec: number
  /** How much history the resting baseline looks at, seconds. */
  baselineWindowSec: number
  /** Which low percentile of that history counts as resting, 0–1. */
  baselinePercentile: number
  /** Seconds of data before the baseline is trusted. */
  baselineMinSec: number
  /** Beats above baseline that count as fully aroused (arousal 1). */
  arousalSpanBpm: number
  /** Window the rise is measured over, seconds. */
  riseWindowSec: number
}

export const DEFAULT_HR_OPTIONS: HeartRateOptions = {
  smoothSec: 4,
  baselineWindowSec: 600,
  baselinePercentile: 0.1,
  baselineMinSec: 45,
  arousalSpanBpm: 40,
  riseWindowSec: 15,
}

export interface HeartRateReading {
  /** Wall clock, ms. */
  at: number
  /** As reported. */
  raw: number
  /** Smoothed. */
  bpm: number
  /** Resting estimate; null until there is enough history. */
  baseline: number | null
  /** 0–1: how far above resting, 0 until there is a baseline. */
  arousal: number
  /** Smoothed beats gained over the rise window (negative when falling). */
  rise: number
}

/** The q-quantile (0–1) of `values`, linear between ranks. */
export function percentile(values: number[], q: number): number {
  if (!values.length)
    return Number.NaN
  const s = [...values].sort((a, b) => a - b)
  const pos = Math.max(0, Math.min(1, q)) * (s.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return s[lo] + (s[hi] - s[lo]) * (pos - lo)
}

/** Map beats above resting to 0–1, eased so the first few beats count less than the next. */
export function arousalFrom(bpm: number, baseline: number | null, spanBpm: number): number {
  if (baseline === null || spanBpm <= 0)
    return 0
  const x = Math.max(0, Math.min(1, (bpm - baseline) / spanBpm))
  return x * x * (3 - 2 * x)
}

/**
 * Feed readings in as they arrive; get smoothed values out. Time is passed
 * in (ms) so tests can run without a clock.
 */
export function createHeartRateProcessor(opts: Partial<HeartRateOptions> = {}) {
  const o = { ...DEFAULT_HR_OPTIONS, ...opts }
  let smooth: number | null = null
  let lastAt = 0
  let firstAt = 0
  /** Smoothed bpm, decimated to about one a second, for baseline and rise. */
  let history: { at: number, bpm: number }[] = []

  function reset() {
    smooth = null
    lastAt = 0
    firstAt = 0
    history = []
  }

  function push(raw: number, at: number): HeartRateReading | null {
    if (!Number.isFinite(raw) || raw < BPM_MIN || raw > BPM_MAX)
      return null
    // A long silence (out of range, watch off) means the old line is stale.
    if (smooth !== null && at - lastAt > 30_000)
      reset()

    if (smooth === null) {
      smooth = raw
      firstAt = at
    }
    else {
      // Exponential smoothing that respects irregular gaps between packets.
      const dt = Math.max(0, (at - lastAt) / 1000)
      const k = 1 - Math.exp(-dt / Math.max(0.1, o.smoothSec))
      smooth += (raw - smooth) * k
    }
    lastAt = at

    const last = history[history.length - 1]
    if (!last || at - last.at >= 900)
      history.push({ at, bpm: smooth })
    const keepFrom = at - o.baselineWindowSec * 1000
    while (history.length > 1 && history[0].at < keepFrom)
      history.shift()

    const enough = (at - firstAt) / 1000 >= o.baselineMinSec
    const baseline = enough ? percentile(history.map(h => h.bpm), o.baselinePercentile) : null

    // Rise: now against the oldest sample still inside the window.
    const riseFrom = at - o.riseWindowSec * 1000
    const ref = history.find(h => h.at >= riseFrom) ?? history[0]
    const rise = smooth - ref.bpm

    return {
      at,
      raw,
      bpm: smooth,
      baseline,
      arousal: arousalFrom(smooth, baseline, o.arousalSpanBpm),
      rise,
    }
  }

  return { push, reset }
}

// ─── Guard ───────────────────────────────────────────────────────────────────

export interface HeartGuardSettings {
  enabled: boolean
  /** Fire only above resting + this many beats. */
  aboveRestBpm: number
  /** …and only when it climbed at least this much over the rise window. */
  riseBpm: number
  /** Must drop this far below the trigger level before it can fire again. */
  hysteresisBpm: number
  /** And never twice within this many seconds. */
  refractorySec: number
}

export const DEFAULT_GUARD: HeartGuardSettings = {
  enabled: false,
  aboveRestBpm: 20,
  riseBpm: 10,
  hysteresisBpm: 6,
  refractorySec: 60,
}

export interface GuardState {
  /** Ready to fire. Cleared on firing, set again once below threshold − hysteresis. */
  armed: boolean
  /** When it last fired, ms; -Infinity when never. */
  firedAt: number
}

export function createGuardState(): GuardState {
  return { armed: true, firedAt: Number.NEGATIVE_INFINITY }
}

/**
 * One guard step. Returns the next state and whether to call an edge now.
 *
 * Needs a baseline: "fast and high" means nothing without knowing where this
 * person rests. A high but steady rate does not fire (sitting at 110 for ten
 * minutes is a session, not a moment); a fast climb that stays low does not
 * either (standing up).
 */
export function stepGuard(
  state: GuardState,
  r: Pick<HeartRateReading, 'at' | 'bpm' | 'baseline' | 'rise'>,
  s: HeartGuardSettings,
): { state: GuardState, fire: boolean } {
  if (!s.enabled || r.baseline === null)
    return { state, fire: false }
  const threshold = r.baseline + s.aboveRestBpm
  let armed = state.armed
  if (!armed && r.bpm < threshold - s.hysteresisBpm)
    armed = true

  const cooling = r.at - state.firedAt < s.refractorySec * 1000
  if (armed && !cooling && r.bpm >= threshold && r.rise >= s.riseBpm)
    return { state: { armed: false, firedAt: r.at }, fire: true }

  return { state: armed === state.armed ? state : { ...state, armed }, fire: false }
}
