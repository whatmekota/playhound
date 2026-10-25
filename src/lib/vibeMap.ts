/**
 * Turning a session into vibration strength, for toys that only know "how
 * hard" (Buttplug vibrate, rotate, oscillate).
 *
 * A stroke script says *where* to be; a vibrator needs *how much*. The most
 * faithful translation is how fast the script is moving around the playhead —
 * quick strokes buzz, slow ones hum, a still stretch goes quiet — but position,
 * the music's loudness, the session intensity or the generated motion are
 * offered too. Each toy picks its own source and range.
 *
 * Toys and their Bluetooth links are slow: Buttplug devices are happiest at
 * around ten commands a second, and many drop or queue anything faster. So the
 * level is smoothed (quick to rise, slower to fall, which reads as "responsive"
 * without flicker), and only sent when it has moved enough and enough time has
 * passed.
 *
 * Pure: useVibeSync samples the stores and the clock and hands them in.
 */

export type VibeSource = 'script-speed' | 'script-position' | 'music' | 'session' | 'motion' | 'off'
export type VibeCurve = 'linear' | 'gentle' | 'punchy'

export interface VibeSettings {
  source: VibeSource
  /** Floor while anything is happening, 0–1. */
  min: number
  /** Ceiling, 0–1. */
  max: number
  curve: VibeCurve
}

export const DEFAULT_VIBE: VibeSettings = { source: 'script-speed', min: 0.1, max: 1, curve: 'linear' }

export const VIBE_SOURCES: { value: VibeSource, label: string }[] = [
  { value: 'script-speed', label: 'Script speed' },
  { value: 'script-position', label: 'Script position' },
  { value: 'music', label: 'Music loudness' },
  { value: 'session', label: 'Session intensity' },
  { value: 'motion', label: 'Generated motion' },
  { value: 'off', label: 'Off' },
]

/** Below this the source is "nothing happening" and the toy goes fully quiet, not to `min`. */
export const VIBE_DEADZONE = 0.03

/** Shape a 0–1 level. Gentle keeps low levels low; punchy lifts them. */
export function applyCurve(x: number, curve: VibeCurve): number {
  const v = Math.max(0, Math.min(1, x))
  if (curve === 'gentle')
    return v * v
  if (curve === 'punchy')
    return Math.sqrt(v)
  return v
}

/**
 * Source level (0–1) → strength to send (0–1).
 *
 * The range is applied first and the session's effective intensity (knob ×
 * edge hold-back) last, so an edge takes the toy right down rather than only
 * to its floor.
 */
export function mapVibe(level: number, s: Pick<VibeSettings, 'min' | 'max' | 'curve'>, intensity = 1): number {
  if (!(level > VIBE_DEADZONE))
    return 0
  const lo = Math.max(0, Math.min(1, Math.min(s.min, s.max)))
  const hi = Math.max(0, Math.min(1, Math.max(s.min, s.max)))
  const out = lo + (hi - lo) * applyCurve(level, s.curve)
  return Math.max(0, Math.min(1, out * Math.max(0, Math.min(1, intensity))))
}

/**
 * Script speed (position units per second, 0–1 scale) → 0–1. Saturating, so
 * a frantic section does not just pin the ceiling and everything between slow
 * and brisk still reads as different. 1.2 units/s (one up-and-down stroke a
 * second over 60% of the range) lands near two thirds.
 */
export function speedToLevel(speed: number, ref = 1.2): number {
  if (!(speed > 0))
    return 0
  return 1 - Math.exp(-speed / ref)
}

interface Act { at: number, pos: number }

/** First index whose `at` is greater than `t`. */
function upperBound(actions: Act[], t: number): number {
  let lo = 0
  let hi = actions.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (actions[mid].at <= t)
      lo = mid + 1
    else
      hi = mid
  }
  return lo
}

/**
 * How fast the script moves around `tMs`: distance travelled inside
 * [t − half, t + half] divided by the window. Centred rather than trailing so
 * the toy swells with a fast section instead of after it; the window is short
 * enough to follow a change of pace within a stroke or two.
 */
export function localSpeed(actions: Act[], tMs: number, halfWindowMs = 600): number {
  if (actions.length < 2 || halfWindowMs <= 0)
    return 0
  const from = tMs - halfWindowMs
  const to = tMs + halfWindowMs
  let i = Math.max(0, upperBound(actions, from) - 1)
  let dist = 0
  for (; i < actions.length - 1; i++) {
    const a = actions[i]
    const b = actions[i + 1]
    if (a.at >= to)
      break
    const span = b.at - a.at
    if (span <= 0)
      continue
    const s = Math.max(a.at, from)
    const e = Math.min(b.at, to)
    if (e <= s)
      continue
    dist += Math.abs(b.pos - a.pos) * ((e - s) / span)
  }
  return dist / ((to - from) / 1000)
}

/**
 * Music loudness with a little lift on each beat, so a vibrator can be felt
 * keeping time without becoming a metronome. `beatPhase` is 0 on the beat.
 */
export function musicLevel(energy: number, beatPhase: number | null): number {
  const e = Math.max(0, Math.min(1, energy))
  if (beatPhase === null)
    return e
  const accent = Math.exp(-Math.max(0, beatPhase) * 6)
  return Math.min(1, e * (0.75 + 0.35 * accent))
}

/** Rise in ~attack ms, fall in ~release ms. Frame-rate independent. */
export function smoothLevel(prev: number, target: number, dtMs: number, attackMs = 80, releaseMs = 250): number {
  const tau = target > prev ? attackMs : releaseMs
  if (tau <= 0 || dtMs <= 0)
    return dtMs <= 0 ? prev : target
  const k = 1 - Math.exp(-dtMs / tau)
  return prev + (target - prev) * k
}

export interface SendGate {
  /** Last value actually sent; null before the first. */
  value: number | null
  at: number
}

export const MIN_SEND_INTERVAL_MS = 100
export const MIN_SEND_DELTA = 0.02

/**
 * Whether a toy should be sent `value` now. At most every `minIntervalMs`,
 * only when it moved by `minDelta`, but a stop (0) always goes through once
 * the interval allows, and so does reaching the top — those are the two
 * values a person notices being missed.
 */
export function shouldSend(gate: SendGate, value: number, now: number, minIntervalMs = MIN_SEND_INTERVAL_MS, minDelta = MIN_SEND_DELTA): boolean {
  if (gate.value === null)
    return true
  if (now - gate.at < minIntervalMs)
    return false
  if (value === gate.value)
    return false
  if (value === 0 || value === 1)
    return true
  return Math.abs(value - gate.value) >= minDelta
}

/** Strengths are sent rounded; the toys cannot tell 0.503 from 0.5 anyway. */
export function quantize(v: number, steps = 100): number {
  return Math.round(Math.max(0, Math.min(1, v)) * steps) / steps
}
