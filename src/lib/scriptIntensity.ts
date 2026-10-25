/**
 * How hard a script goes, in words and bars a library can show.
 *
 * The director's ScriptSummary carries a mean and a peak speed; this turns
 * those into a five-step level and three bands (gentle / medium / intense),
 * and builds the fuller profile the info dialog shows for one video.
 *
 * Speeds here are position-units per second with positions 0-1, the same as
 * funscriptAnalysis. Multiply by 100 for the "units/s" scripters talk in.
 *
 * Vue-free so it can be unit tested directly.
 */
import type { Action, EnvelopeSample } from './funscriptAnalysis'
import { buildEnvelope, detectPeaks } from './funscriptAnalysis'

/**
 * Mean-speed edges between the five levels. Calibrated on a real library of
 * ~400 scripts, where the median mean speed is about 2.8 and the middle two
 * thirds sit between 2 and 3.5. `speedToIntensity` saturates at 1.8, which is
 * right for driving audio but would put most of a library in the top bar.
 */
export const LEVEL_EDGES = [1.4, 2.1, 2.8, 3.5] as const

export type IntensityBand = 'gentle' | 'medium' | 'intense'

export interface BandDef {
  key: IntensityBand
  label: string
  /** Inclusive lower bound on mean speed. */
  min: number
  /** Exclusive upper bound on mean speed. */
  max: number
}

/** Roughly the bottom quarter, the middle half and the top quarter of a typical library. */
export const BANDS: readonly BandDef[] = [
  { key: 'gentle', label: 'Gentle', min: 0, max: 2 },
  { key: 'medium', label: 'Medium', min: 2, max: 3.2 },
  { key: 'intense', label: 'Intense', min: 3.2, max: Number.POSITIVE_INFINITY },
]

/**
 * A whole script's mean speed as 0-1, on the same calibration as the levels:
 * the gentlest scripts near 0, a typical one (mean ≈ 2.8) a little above the
 * middle, the hardest near 1.
 *
 * Use this when comparing scripts with each other or with a session target
 * (the director, programmes). `speedToIntensity` is for the *instantaneous*
 * speed driving sound and pulse, and pinned most whole scripts at 1.
 */
export const SCRIPT_SPEED_FLOOR = 1.0
export const SCRIPT_SPEED_CEIL = 4.2

export function meanSpeedToIntensity(meanSpeed: number): number {
  if (!Number.isFinite(meanSpeed))
    return 0
  return Math.min(1, Math.max(0, (meanSpeed - SCRIPT_SPEED_FLOOR) / (SCRIPT_SPEED_CEIL - SCRIPT_SPEED_FLOOR)))
}

/** 1 (barely moving) to 5 (relentless). */
export function intensityLevel(meanSpeed: number): number {
  let level = 1
  for (const edge of LEVEL_EDGES) {
    if (meanSpeed >= edge)
      level++
  }
  return level
}

export function intensityBand(meanSpeed: number): IntensityBand {
  for (const b of BANDS) {
    if (meanSpeed >= b.min && meanSpeed < b.max)
      return b.key
  }
  return 'gentle'
}

/** Speed in the conventional funscript units per second, rounded. */
export function speedUnits(speed: number): number {
  return Math.round(speed * 100)
}

/** Below this a stretch counts as a pause, not as slow movement. */
const MOVING_SPEED = 0.05

/**
 * The speeds of a script's moving stretches, sorted, so one moment can be
 * ranked against the rest of the same script. Pauses are left out: a script
 * that stops a lot should not make every stroke look like its top gear.
 */
export function speedDistribution(env: EnvelopeSample[]): Float64Array {
  const out = new Float64Array(env.filter(s => s.speed > MOVING_SPEED).map(s => s.speed))
  return out.sort()
}

/** Share of the script's moving time that goes slower than `speed`, 0-1. */
export function speedRank(speed: number, sorted: Float64Array): number {
  if (!sorted.length || !Number.isFinite(speed))
    return 0
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid] < speed)
      lo = mid + 1
    else
      hi = mid
  }
  return lo / sorted.length
}

/** How much of `momentIntensity` is the moment's rank within its own script. */
export const MOMENT_RELATIVE_WEIGHT = 0.6

/**
 * How intense this moment of a script is, 0-1, for things that react to it
 * as it plays (the face's mood).
 *
 * `speedToIntensity` saturates at 1.8 while a typical script averages about
 * 2.8, so on its own it pinned most of a library at 1 and the face sat at its
 * top mood through every steady stretch. Mostly this ranks the moment within
 * its own script instead, so a steady section reads as the middle and only the
 * script's real peaks reach the top; the rest is the absolute calibration, so
 * a gentle script's busiest part is still not a hard script's.
 */
export function momentIntensity(speed: number, sorted: Float64Array): number {
  if (!Number.isFinite(speed) || speed <= MOVING_SPEED)
    return 0
  const v = MOMENT_RELATIVE_WEIGHT * speedRank(speed, sorted)
    + (1 - MOMENT_RELATIVE_WEIGHT) * meanSpeedToIntensity(speed)
  return Math.min(1, Math.max(0, v))
}

export interface Stretch {
  startMs: number
  endMs: number
  /** Mean speed across the stretch. */
  speed: number
}

/**
 * The longest run where the script stays in its own top gear: envelope
 * samples at or above `threshold` (by default the script's 80th percentile,
 * and never below its mean). Dips shorter than `bridgeMs` do not break a run,
 * since a scripter's breath between two bursts is still one busy section.
 *
 * Relative rather than absolute so a gentle script still has a busiest part.
 */
export function busiestStretch(
  env: EnvelopeSample[],
  opts: { threshold?: number, bridgeMs?: number, minMs?: number } = {},
): Stretch | null {
  if (env.length < 2)
    return null
  const step = env[1].at - env[0].at || 250
  const bridge = Math.max(0, Math.round((opts.bridgeMs ?? 4000) / step))
  const minMs = opts.minMs ?? 2000

  let threshold = opts.threshold
  if (threshold === undefined) {
    const moving = env.map(s => s.speed).filter(s => s > 0).sort((a, b) => a - b)
    if (!moving.length)
      return null
    const mean = moving.reduce((a, b) => a + b, 0) / moving.length
    threshold = Math.max(mean, moving[Math.floor(moving.length * 0.8)])
  }

  // Runs as [from, to] sample indices; the longest wins, the earliest on a tie.
  let a = -1
  let b = -1
  let from = -1
  let lastHot = -1
  for (let i = 0; i <= env.length; i++) {
    const hot = i < env.length && env[i].speed >= threshold && env[i].speed > 0
    const gapEnds = from >= 0 && (i === env.length || (hot && i - lastHot - 1 > bridge))
    if (gapEnds) {
      if (a < 0 || lastHot - from > b - a) {
        a = from
        b = lastHot
      }
      from = -1
    }
    if (hot) {
      if (from < 0)
        from = i
      lastHot = i
    }
  }
  if (a < 0)
    return null

  const startMs = env[a].at
  const endMs = env[b].at + step
  if (endMs - startMs < minMs)
    return null
  let sum = 0
  for (let i = a; i <= b; i++)
    sum += env[i].speed
  return { startMs, endMs, speed: sum / (b - a + 1) }
}

/** Mean speed in `points` equal slices, for a sparkline. */
export function speedCurve(env: EnvelopeSample[], points = 64): number[] {
  if (!env.length)
    return []
  const n = Math.min(points, env.length)
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const lo = Math.floor((i * env.length) / n)
    const hi = Math.max(lo + 1, Math.floor(((i + 1) * env.length) / n))
    let sum = 0
    for (let j = lo; j < hi; j++)
      sum += env[j].speed
    out.push(sum / (hi - lo))
  }
  return out
}

export interface ScriptProfile {
  meanSpeed: number
  peakSpeed: number
  /** Mean stroke cycles per minute. */
  meanSpm: number
  /** Turning points at the top of a stroke, i.e. how many strokes. */
  strokes: number
  durationMs: number
  busiest: Stretch | null
  /** Speed over time, `speedCurve` of the envelope. */
  curve: number[]
}

/** Everything the info dialog says about one script. Linear in the action count. */
export function scriptProfile(actions: Action[], curvePoints = 64): ScriptProfile {
  const env = buildEnvelope(actions)
  let speedSum = 0
  let spmSum = 0
  let peakSpeed = 0
  for (const s of env) {
    speedSum += s.speed
    spmSum += s.spm
    if (s.speed > peakSpeed)
      peakSpeed = s.speed
  }
  return {
    meanSpeed: env.length ? speedSum / env.length : 0,
    peakSpeed,
    meanSpm: env.length ? spmSum / env.length : 0,
    strokes: detectPeaks(actions).length,
    durationMs: actions.length ? actions[actions.length - 1].at : 0,
    busiest: busiestStretch(env),
    curve: speedCurve(env, curvePoints),
  }
}
