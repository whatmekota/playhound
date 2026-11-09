/**
 * E-stim audio: the stroke turned into a stereo signal for a stim box with an
 * audio input. Experimental.
 *
 * The signal is one carrier (a sine, 300–1500 Hz) on both channels, with each
 * channel's amplitude and phase set by where the stroke is. Any amplitude and
 * phase of a sine is a mix of the carrier's sine and cosine, so each channel
 * is described by two numbers (`c`, `s`): channel = c·cos(ωt) + s·sin(ωt).
 * The audio graph (useEstim) is two oscillators, sin and cos, into four gain
 * nodes; this file only says what those four gains should be, and how fast
 * the master volume may move.
 *
 * Mappings:
 *
 * - `threephase`: restim's continuous three-phase signal, for a three-
 *   electrode setup (common, left, right) on a stereo box. From restim
 *   (github.com/diglet48/restim, stim_math/threephase.py and
 *   audio_gen/continuous.py, read at commit 8d0524b):
 *
 *       r = min(1, |(α, β)|)
 *       a = (2 − r + α)/2 · cos θ − β/2 · sin θ
 *       b = −β/2 · cos θ + (2 − r − α)/2 · sin θ
 *       L = (√3/2)·a − b/2
 *       R = (√3/2)·a + b/2
 *
 *   with θ the carrier's phase. restim reads TCode L0 as alpha, from -1 to 1,
 *   so here α = 2·position − 1 and β = 0: the stroke moves the sensation from
 *   between the left and right electrodes (bottom) to the common one (top),
 *   with all three even at the middle.
 *
 *   What restim does that this does not: it turns a 1-D funscript into alpha
 *   AND beta, drawing each stroke as a half circle with a 10% chance of
 *   swapping sides (funscript/funscript_conversion.py), where this stays on
 *   the alpha line; its centre calibration (−0.6 dB at the middle) and
 *   up-down/left-right hardware calibration; pulse-based waveforms, four-
 *   phase and FOC devices; volume, carrier and pulse settings driven by
 *   their own scripts (V0, C0, P0–P3); its inactivity volume reduction and
 *   slow volume ramp.
 *
 * - `balance`: two independent channels (two pairs of electrodes, or a
 *   two-channel box). The carrier pans between them at constant power: all
 *   left at the bottom, all right at the top, even at the middle.
 *
 * Safety lives in the master volume, which only ever moves through
 * `stepLevel`: it starts from silence, rises slowly, falls fast, stays under
 * the ceiling, and drops to zero at once on panic.
 */

export type EstimMapping = 'threephase' | 'balance'

/** One channel: amplitude of the carrier's cosine and of its sine. */
export interface ChannelMix { c: number, s: number }

export interface StereoMix { left: ChannelMix, right: ChannelMix }

export const CARRIER_MIN_HZ = 300
export const CARRIER_MAX_HZ = 1500
export const CARRIER_DEFAULT_HZ = 700

export function clampCarrier(hz: number): number {
  if (!Number.isFinite(hz))
    return CARRIER_DEFAULT_HZ
  return Math.max(CARRIER_MIN_HZ, Math.min(CARRIER_MAX_HZ, Math.round(hz)))
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5)
const SQRT3_2 = Math.sqrt(3) / 2

/** restim's continuous three-phase mix for a point (alpha, beta) in the unit circle. */
export function threePhaseMix(alpha: number, beta: number): StereoMix {
  let a = Number.isFinite(alpha) ? alpha : 0
  let b = Number.isFinite(beta) ? beta : 0
  // restim keeps the point inside the unit circle.
  const len = Math.hypot(a, b)
  if (len > 1) {
    a /= len
    b /= len
  }
  const r = Math.min(1, Math.hypot(a, b))
  // a(θ) = ac·cos θ + as·sin θ, and the same for b.
  const ac = (2 - r + a) / 2
  const as = -b / 2
  const bc = -b / 2
  const bs = (2 - r - a) / 2
  return {
    left: { c: SQRT3_2 * ac - bc / 2, s: SQRT3_2 * as - bs / 2 },
    right: { c: SQRT3_2 * ac + bc / 2, s: SQRT3_2 * as + bs / 2 },
  }
}

/** Constant-power pan: left at 0, right at 1. */
export function balanceMix(position: number): StereoMix {
  const p = clamp01(position)
  return {
    left: { c: Math.cos(p * Math.PI / 2), s: 0 },
    right: { c: Math.sin(p * Math.PI / 2), s: 0 },
  }
}

/** The carrier mix for a stroke position (0 bottom, 1 top). Each channel's amplitude is at most 1. */
export function mixFor(mapping: EstimMapping, position: number): StereoMix {
  const p = clamp01(position)
  return mapping === 'balance' ? balanceMix(p) : threePhaseMix(2 * p - 1, 0)
}

export function amplitude(ch: ChannelMix): number {
  return Math.hypot(ch.c, ch.s)
}

// ─── Master volume ────────────────────────────────────────────────────────────

/** A start, from silence, takes at least this long. */
export const START_SEC = 5
/** Never louder faster than this: 10% of full scale a second. */
export const MAX_RISE_PER_SEC = 0.1
/** Pausing, stopping or turning down: full scale to silence in under half a second. */
export const FALL_PER_SEC = 2.5
/** Below this the output counts as silent, and the next rise is a fresh start. */
export const SILENT = 0.002
/** Hardest ceiling the settings allow. */
export const CEILING_MAX = 1

export interface LevelInput {
  /** Started by the user this launch, and not stopped or panicked since. */
  armed: boolean
  panicked: boolean
  /** Something is moving the stroke right now (a script playing, a generator). */
  live: boolean
  /** The user's volume, 0–1 of full scale. */
  volume: number
  /** The user's limit, 0–1 of full scale. */
  ceiling: number
  /** The intensity knob and any edge, 0–1 (sessionControl.effectiveIntensity). */
  intensity: number
}

/** Where the master volume is heading: 0 unless armed, live and not panicked; never above the ceiling. */
export function targetLevel(i: LevelInput): number {
  if (i.panicked || !i.armed || !i.live)
    return 0
  const ceiling = Math.max(0, Math.min(CEILING_MAX, Number.isFinite(i.ceiling) ? i.ceiling : 0))
  const volume = Math.max(0, Number.isFinite(i.volume) ? i.volume : 0)
  const intensity = Math.max(0, Math.min(1, Number.isFinite(i.intensity) ? i.intensity : 0))
  return Math.min(ceiling, volume) * intensity
}

export interface LevelState {
  level: number
  /** Rising from silence: the rise is spread over START_SEC. */
  starting: boolean
}

export const SILENCE: LevelState = { level: 0, starting: false }

/**
 * Move the master volume one step of `dtSec` toward the target for `input`.
 *
 * - Panic: silence now, no ramp.
 * - Down (pause, stop, the knob, an edge, a lower volume): fast, FALL_PER_SEC.
 * - Up from silence: a start, spread evenly over START_SEC (longer when the
 *   target is loud, since MAX_RISE_PER_SEC still holds).
 * - Up otherwise: MAX_RISE_PER_SEC.
 *
 * The result never exceeds the ceiling, even if the ceiling was just lowered
 * below the current level: that is a fall like any other, but it is clamped
 * at once rather than ramped, since the ceiling is the user's hard limit.
 */
export function stepLevel(state: LevelState, input: LevelInput, dtSec: number): LevelState {
  if (input.panicked)
    return { level: 0, starting: false }
  const dt = Math.max(0, Math.min(0.25, Number.isFinite(dtSec) ? dtSec : 0))
  const ceiling = Math.max(0, Math.min(CEILING_MAX, Number.isFinite(input.ceiling) ? input.ceiling : 0))
  const target = targetLevel(input)
  let level = Math.min(Math.max(0, state.level), ceiling)
  let starting = state.starting

  if (target < level) {
    level = Math.max(target, level - FALL_PER_SEC * dt)
    starting = false
  }
  else if (target > level) {
    if (level <= SILENT)
      starting = true
    const rate = starting ? Math.min(MAX_RISE_PER_SEC, target / START_SEC) : MAX_RISE_PER_SEC
    level = Math.min(target, level + rate * dt)
    if (level >= target)
      starting = false
  }
  if (level <= SILENT && target === 0)
    level = 0
  return { level, starting }
}

/** How long a rise from silence to `target` takes, in seconds. */
export function startDuration(target: number): number {
  if (target <= 0)
    return 0
  return target / Math.min(MAX_RISE_PER_SEC, target / START_SEC)
}

// ─── Motion ───────────────────────────────────────────────────────────────────

/**
 * The stroke counts as live while commands keep arriving: the script and the
 * generators send one every frame, and pause, stop and panic stop them.
 */
export const LIVE_MS = 300

export function isLive(lastCommandAt: number, now: number): boolean {
  return Number.isFinite(lastCommandAt) && now - lastCommandAt <= LIVE_MS
}

/**
 * If the page stops updating the audio (a hung tab, a hidden browser tab),
 * the master volume fades out on its own: each update holds the level for
 * this long and then ramps to silence over DEADMAN_FADE_SEC.
 */
export const DEADMAN_HOLD_SEC = 0.5
export const DEADMAN_FADE_SEC = 0.3

// ─── Sound outputs ────────────────────────────────────────────────────────────

export interface OutputDevice {
  deviceId: string
  label: string
  groupId: string
}

/**
 * Why `deviceId` may not be used for e-stim, or null when it may.
 *
 * The box must get this signal and nothing else, so the system's default
 * output is refused (that is where the video's sound and every other app's
 * goes), by name and by being the same physical device as the default.
 */
export function outputProblem(deviceId: string, devices: OutputDevice[]): string | null {
  if (!deviceId)
    return 'Pick the sound output the stim box is plugged into.'
  if (deviceId === 'default' || deviceId === 'communications')
    return 'That is the system default, where the video\'s sound goes too. Pick the stim box\'s output by name.'
  const dev = devices.find(d => d.deviceId === deviceId)
  if (!dev)
    return 'That output is not there any more. Plug it back in or pick another.'
  const def = devices.find(d => d.deviceId === 'default')
  if (def?.groupId && def.groupId === dev.groupId)
    return 'That is also the system default output, so the video\'s sound would go to the box too. Make something else the default in your system settings, or pick another output.'
  return null
}
