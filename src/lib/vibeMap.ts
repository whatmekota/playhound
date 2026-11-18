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

/** Follows what another axis is sent: twist, pitch… (its position, 0–1). */
export type AxisVibeSource = 'axis-L1' | 'axis-L2' | 'axis-R0' | 'axis-R1' | 'axis-R2'
export type VibeSource = 'script-speed' | 'script-position' | 'music' | 'session' | 'motion' | AxisVibeSource | 'off'
export type VibeCurve = 'linear' | 'gentle' | 'punchy'

export interface VibeSettings {
  source: VibeSource
  /** Floor while anything is happening, 0–1. */
  min: number
  /** Ceiling, 0–1. */
  max: number
  curve: VibeCurve
  /**
   * Script speed only: how much each stroke is felt, 0–1. The strength still
   * comes from the speed, but dips toward the top of every stroke and swells
   * at the bottom, so a steady pattern pulses in time instead of a flat hum.
   * Absent in settings saved before it existed: DEFAULT_VIBE's then.
   */
  pulse?: number
  /**
   * How much earlier the toy is sent its level, ms, for the lag of its
   * Bluetooth link, so a stroke's swell lands with the stroke. Script
   * sources only (the others are live). Absent: 0.
   */
  leadMs?: number
  /**
   * A source per motor, by Buttplug feature index, for toys with several
   * (a vibrator and a rotator, two vibrators). A motor not listed follows
   * the toy's own source.
   */
  motors?: Record<string, VibeSource>
}

/** The most a toy's timing can lead by. */
export const VIBE_LEAD_MAX = 500

export const DEFAULT_VIBE: VibeSettings = { source: 'script-speed', min: 0.1, max: 1, curve: 'linear', pulse: 0.6 }

export const VIBE_SOURCES: { value: VibeSource, label: string }[] = [
  { value: 'script-speed', label: 'Script speed' },
  { value: 'script-position', label: 'Script position' },
  { value: 'music', label: 'Music loudness' },
  { value: 'session', label: 'Session intensity' },
  { value: 'motion', label: 'Generated motion' },
  { value: 'axis-L1', label: 'Surge axis' },
  { value: 'axis-L2', label: 'Sway axis' },
  { value: 'axis-R0', label: 'Twist axis' },
  { value: 'axis-R1', label: 'Roll axis' },
  { value: 'axis-R2', label: 'Pitch axis' },
  { value: 'off', label: 'Off' },
]

/** The TCode channel an axis source follows, or null. */
export function axisOfSource(source: VibeSource): string | null {
  return source.startsWith('axis-') ? source.slice(5) : null
}

/** A saved source that is still one there is (a later version may have added more). */
export function knownSource(source: unknown): VibeSource | null {
  return VIBE_SOURCES.some(s => s.value === source) ? source as VibeSource : null
}

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

/**
 * A script's own "fast": its 90th-percentile speed, sampled every half second
 * over the script, or null when it is too short to say. With it, speed maps to
 * strength in proportion (scriptSpeedLevel), so a brisk script's calm parts
 * sit well below its peaks instead of every stroke pinning the toy at full.
 * Clamped below, so a script of tiny twitches is not blown up to full.
 */
export function scriptFastSpeed(actions: Act[], stepMs = 500): number | null {
  if (actions.length < 4)
    return null
  const end = actions[actions.length - 1].at
  const speeds: number[] = []
  for (let t = actions[0].at; t <= end; t += stepMs) {
    const v = localSpeed(actions, t)
    if (v > 0.05)
      speeds.push(v)
  }
  if (speeds.length < 8)
    return null
  speeds.sort((a, b) => a - b)
  return Math.max(0.8, speeds[Math.min(speeds.length - 1, Math.floor(speeds.length * 0.9))])
}

/** Speed → 0–1 against the script's own fast speed: that lands at 90%, half of it at 45%, never past 1. */
export function scriptSpeedLevel(speed: number, fast: number | null): number {
  if (fast === null)
    return speedToLevel(speed)
  if (!(speed > 0))
    return 0
  return Math.min(1, 0.9 * speed / fast)
}

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
 * A speed level with each stroke in it: full at the bottom of a stroke
 * (position 0), down by `pulse` at the top (position 1).
 */
export function strokePulse(level: number, position: number, pulse: number): number {
  const p = Math.max(0, Math.min(1, pulse))
  const pos = Math.max(0, Math.min(1, position))
  return level * (1 - p * pos)
}

/**
 * A vibe script (.vib, 0–100) made from a stroke script, the way a toy on
 * Script speed plays it: strength from how fast the script moves, swelling
 * at the bottom of each stroke by `pulse`, within the range and curve. A
 * point at each of the script's own, and every 300 ms through a long one,
 * so a long hold goes quiet instead of ramping across it. Points that only
 * repeat their neighbours are left out. In: positions 0–1, as parsed; out:
 * a funscript's 0–100.
 */
export function vibeScriptFrom(actions: Act[], s: Pick<VibeSettings, 'min' | 'max' | 'curve'> & { pulse: number }): Act[] {
  if (actions.length < 2)
    return []
  const fast = scriptFastSpeed(actions)
  const times: number[] = []
  for (let i = 0; i < actions.length; i++) {
    times.push(actions[i].at)
    const next = actions[i + 1]
    if (next && next.at - actions[i].at > 600) {
      for (let t = actions[i].at + 300; t < next.at - 150; t += 300)
        times.push(t)
    }
  }
  const out: Act[] = []
  for (const t of times) {
    const level = scriptSpeedLevel(localSpeed(actions, t), fast)
    const pos = positionOf(actions, t)
    const v = Math.round(mapVibe(strokePulse(level, pos, s.pulse), s) * 100)
    const last = out[out.length - 1]
    const before = out[out.length - 2]
    // The middle of three equal points says nothing.
    if (last && before && last.pos === v && before.pos === v)
      last.at = Math.round(t)
    else
      out.push({ at: Math.round(t), pos: v })
  }
  return out
}

/** The script's position at `t`, straight between points. */
function positionOf(actions: Act[], t: number): number {
  const i = upperBound(actions, t)
  if (i <= 0)
    return actions[0].pos
  if (i >= actions.length)
    return actions[actions.length - 1].pos
  const a = actions[i - 1]
  const b = actions[i]
  const span = b.at - a.at
  return span > 0 ? a.pos + (b.pos - a.pos) * ((t - a.at) / span) : b.pos
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
