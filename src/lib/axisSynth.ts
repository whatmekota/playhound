import { clamp } from './motionMath'

/**
 * Deriving the other axes from the stroke axis.
 *
 * Most scripts are L0 only, so a multi-axis device mostly sits still. The
 * stroke curve already implies plausible motion for the rest: how fast it is
 * moving, and where it is in the cycle.
 *
 * This invents nothing about the content — it is a physical embellishment, not
 * a guess at what a scripter intended, and it only ever fills channels the
 * script does not already drive.
 */

export interface SynthConfig {
  depth: number
  twist: boolean
  roll: boolean
  surge: boolean
}

export const DEFAULT_SYNTH: SynthConfig = {
  depth: 0.35,
  twist: true,
  roll: true,
  surge: false,
}

/**
 * Stroke speed treated as full deflection, in position units per second.
 * Roughly a full stroke in a third of a second, which is brisk.
 */
const REFERENCE_SPEED = 3

/** Normalised rate of change of the stroke axis, clamped to -1..1. */
export function estimateVelocity(prevPos: number, pos: number, dtSec: number): number {
  if (dtSec <= 0)
    return 0
  return clamp((pos - prevPos) / dtSec / REFERENCE_SPEED, -1, 1)
}

/**
 * Advance the twist oscillator.
 *
 * Twist runs at a fraction of the stroke rate so it reads as a slow turn
 * rather than a jitter locked to every stroke. Phase is accumulated, so a
 * change in stroke rate alters how fast it turns without making it jump.
 */
export function advanceTwistPhase(
  phase: number,
  strokeHz: number,
  dtSec: number,
  ratio = 0.5,
): number {
  const next = phase + Math.max(0, strokeHz) * ratio * Math.max(0, dtSec)
  return next % 1
}

/**
 * Positions for the derived axes, each 0–1 and centred at 0.5.
 *
 * - twist turns slowly and continuously
 * - roll leans into the direction of travel, so it changes sense at each
 *   turnaround rather than following position
 * - surge trails the stroke at reduced amplitude
 */
export function synthAxes(
  input: { pos: number, velocity: number, twistPhase: number },
  cfg: SynthConfig = DEFAULT_SYNTH,
): Record<string, number> {
  const d = clamp(cfg.depth, 0, 1) / 2
  const out: Record<string, number> = {}

  if (cfg.twist)
    out.R0 = clamp(0.5 + d * Math.sin(input.twistPhase * Math.PI * 2), 0, 1)

  if (cfg.roll)
    out.R1 = clamp(0.5 + d * input.velocity, 0, 1)

  if (cfg.surge)
    out.L1 = clamp(0.5 + d * (input.pos - 0.5) * 1.2, 0, 1)

  return out
}

/**
 * Which of the derived channels may be driven.
 *
 * A channel the script already drives is never touched — a real scripted twist
 * always beats an invented one.
 */
export function synthTargets(
  scriptChannels: Iterable<string>,
  cfg: SynthConfig = DEFAULT_SYNTH,
): string[] {
  const taken = new Set(scriptChannels)
  const wanted: string[] = []
  if (cfg.twist)
    wanted.push('R0')
  if (cfg.roll)
    wanted.push('R1')
  if (cfg.surge)
    wanted.push('L1')
  return wanted.filter(c => !taken.has(c))
}
