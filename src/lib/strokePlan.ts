import type { StrokeShape } from '~/stores/motionStore'
import { applyDepth } from './motionMath'

/**
 * Motion as moves — "go to P, taking T ms" — for devices that take moves
 * rather than a stream of positions: Intiface linear strokers and the Handy's
 * direct protocol (HDSP).
 *
 * Two lessons from players that drive these devices live:
 *
 * - aim every move at the end of the stroke, not at the next sample
 *   (HandyVRC-OSC). A move to the turning point, timed to arrive with it,
 *   needs one command per half-stroke, and the device never chases jitter.
 * - send each move early by the link's one-way delay (MultiFunPlayer
 *   measures the round trip for this): the move the device should be making
 *   `lead` ms from now is the one sent now.
 *
 * Pure: the motion engine and the script follower hand in their state.
 */

export interface Move {
  /** 0–1, before the axis range. */
  pos: number
  ms: number
}

const TAU = Math.PI * 2

/** Where in a cycle the top of the stroke is: half way for the smooth shapes, a third for pulse's quick rise. */
function topPhase(shape: StrokeShape): number {
  return shape === 'pulse' ? TAU / 3 : Math.PI
}

export interface OscillatorState {
  /** Phase in radians, unwrapped (it keeps counting past 2π). */
  phase: number
  spm: number
  depth: number
  center: number
  shape: StrokeShape
}

/**
 * The half-stroke the device should be on `leadMs` from now, if the
 * oscillator keeps its rate: its turning point (a key that changes once per
 * half-stroke) and the move to it.
 */
export function oscillatorMove(s: OscillatorState, leadMs: number): { key: number, move: Move } | null {
  if (!(s.spm > 0.5) || s.depth < 0.01)
    return null
  const perMs = (TAU * s.spm) / 60_000
  const at = s.phase + perMs * Math.max(0, leadMs)
  const top = topPhase(s.shape)
  const cycle = Math.floor(at / TAU)
  const within = at - cycle * TAU
  const [end, unit, key] = within < top
    ? [cycle * TAU + top, 1, cycle * 2 + 1]
    : [(cycle + 1) * TAU, 0, cycle * 2 + 2]
  return { key, move: { pos: applyDepth(unit, s.center, s.depth), ms: (end - at) / perMs } }
}

/**
 * The move for a script, `t` being the script time at which the move will
 * land: to the next action, in the time left to it at this playback rate.
 * Actions are 0–100, as the device takes them.
 */
export function scriptMove(actions: readonly { at: number, pos: number }[], t: number, rate: number): { key: number, move: Move } | null {
  let lo = 0
  let hi = actions.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (actions[mid].at <= t)
      lo = mid + 1
    else
      hi = mid
  }
  const next = actions[lo]
  if (!next)
    return null
  return { key: next.at, move: { pos: next.pos / 100, ms: (next.at - t) / (rate > 0 ? rate : 1) } }
}

/** Below this, a move is not worth a command: the device would only twitch. */
const MIN_MOVE_MS = 30
/** The same turning point is aimed again only if depth or centre moved it this far. */
const RESEND_POS = 0.05
/** Direct (gamepad) control: a new target at most this often, and only for a change this big. */
export const DIRECT_INTERVAL_MS = 100
const DIRECT_MIN_CHANGE = 0.02

/**
 * Decides which moves actually go out. Planned moves go once per turning
 * point (again only if depth or centre shifted it noticeably); direct
 * control, which cannot be planned, goes at a steady pace when the stick
 * has moved.
 */
export function createMovePlanner() {
  let lastKey: number | null = null
  let lastPos = Number.NaN
  let lastAt = Number.NEGATIVE_INFINITY

  return {
    planned(next: { key: number, move: Move } | null): Move | null {
      if (!next || next.move.ms < MIN_MOVE_MS)
        return null
      if (next.key === lastKey && Math.abs(next.move.pos - lastPos) < RESEND_POS)
        return null
      lastKey = next.key
      lastPos = next.move.pos
      return next.move
    },
    direct(pos: number, now: number): Move | null {
      if (now - lastAt < DIRECT_INTERVAL_MS || Math.abs(pos - lastPos) < DIRECT_MIN_CHANGE)
        return null
      lastAt = now
      lastPos = pos
      lastKey = null
      return { pos, ms: DIRECT_INTERVAL_MS + 20 }
    },
    reset() {
      lastKey = null
      lastPos = Number.NaN
      lastAt = Number.NEGATIVE_INFINITY
    },
  }
}

/** Keeps a phase that wraps at 2π counting on, so turning points have stable keys. */
export function createPhaseUnwrapper() {
  let turns = 0
  let prev: number | null = null
  return {
    next(phase: number): number {
      if (prev !== null && phase < prev - Math.PI)
        turns++
      else if (prev !== null && phase > prev + Math.PI)
        turns--
      prev = phase
      return phase + turns * TAU
    },
    reset() {
      turns = 0
      prev = null
    },
  }
}
