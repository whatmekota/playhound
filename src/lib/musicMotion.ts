/**
 * Turning a music track into motion.
 *
 * The first version stroked once per detected beat and took its phase from
 * the most recent onset. Both were wrong in ways you could feel:
 *
 * - once per beat put most PMVs (140–180 bpm) at or above the speed ceiling,
 *   so every track felt the same — the ceiling, not the music, set the pace
 * - any onset reset the phase, including off-beat hats and snares, so the
 *   stroke stuttered between them: the "vibrating" feel
 * - depth came from the session intensity, which knows nothing about the song
 *
 * Here the beat is a grid that onsets only *nudge* when they land near it, the
 * stroke rate is a musical subdivision of the tempo chosen to sit in the
 * user's band, the stroke is steered onto the grid rather than snapped to it,
 * and depth follows how loud the music is.
 *
 * Vue-free so all of it is testable with synthetic onsets.
 */

// ─── Beat grid ───────────────────────────────────────────────────────────────

export interface BeatGridOptions {
  /** How far, as a fraction of the period, an onset may sit from the grid and still count. */
  window?: number
  /** How much of an on-grid onset's error the anchor absorbs. */
  gain?: number
  /** How quickly a new tempo estimate is adopted. */
  periodGain?: number
}

const GRID_DEFAULTS: Required<BeatGridOptions> = { window: 0.18, gain: 0.25, periodGain: 0.3 }

/**
 * A beat grid that onsets steer, as a phase-locked loop would.
 *
 * Only onsets close to where the grid says a beat should be move it, and only
 * part of the way, so syncopation and fills do not drag it about.
 */
export function createBeatGrid(opts: BeatGridOptions = {}) {
  const o = { ...GRID_DEFAULTS, ...opts }
  let anchorMs = 0
  let periodMs = 0
  /** Recent onsets: true when they fit the grid (on the beat or the half beat). */
  const hits: boolean[] = []

  function record(onGrid: boolean) {
    hits.push(onGrid)
    if (hits.length > 16)
      hits.shift()
  }

  return {
    /** Feed the latest tempo estimate (ms per beat). */
    setPeriod(p: number) {
      if (!(p > 0))
        return
      if (periodMs <= 0) {
        periodMs = p
        return
      }
      // A tempo that moved a lot is a new section or a misread octave; take it
      // whole rather than crawling there over many seconds.
      if (Math.abs(p - periodMs) / periodMs > 0.12)
        periodMs = p
      else
        periodMs += (p - periodMs) * o.periodGain
    },

    /** Feed an onset. Returns whether it counted as on the beat. */
    onset(tMs: number): boolean {
      if (periodMs <= 0)
        return false
      if (anchorMs === 0) {
        anchorMs = tMs
        record(true)
        return true
      }
      const beats = (tMs - anchorMs) / periodMs
      const nearest = Math.round(beats)
      const err = (beats - nearest) * periodMs
      const onGrid = Math.abs(err) <= o.window * periodMs
      if (onGrid)
        anchorMs += err * o.gain
      // Eighth notes — hats, off-beat bass — sit on the half beat. They agree
      // with the grid without saying anything about where the beat is, so
      // they count toward confidence but never move it.
      const half = beats * 2
      const onHalf = !onGrid && Math.abs(half - Math.round(half)) * periodMs / 2 <= o.window * periodMs / 2
      record(onGrid || onHalf)
      // Lost the plot entirely (a tempo change the estimate has not caught
      // yet): re-anchor on this onset rather than drift forever.
      if (hits.length >= 8 && hits.slice(-8).every(h => !h)) {
        anchorMs = tMs
        hits.length = 0
      }
      return onGrid
    },

    /** Beats elapsed since the anchor, as a continuous number. */
    beatsAt(tMs: number): number {
      return periodMs > 0 && anchorMs !== 0 ? (tMs - anchorMs) / periodMs : 0
    },

    /** Share of recent onsets that fit the grid (beat or half beat), 0–1. */
    confidence(): number {
      return hits.length ? hits.filter(Boolean).length / hits.length : 0
    },

    get periodMs() {
      return periodMs
    },
    get ready() {
      return periodMs > 0 && anchorMs !== 0
    },

    reset() {
      anchorMs = 0
      periodMs = 0
      hits.length = 0
    },
  }
}

export type BeatGrid = ReturnType<typeof createBeatGrid>

// ─── How many strokes per beat ───────────────────────────────────────────────

/** Musical subdivisions on offer, as strokes per beat. All land on bar lines. */
export const STROKES_PER_BEAT = [2, 1, 0.5, 0.25] as const

/**
 * Pick strokes per beat for a tempo.
 *
 * Only subdivisions that stay under the ceiling and inside the user's band are
 * candidates. Among those, `energy` (0–1) picks the spot in the band: a quiet
 * passage settles toward the slow end, a drop toward the fast one. With
 * nothing in band, the fastest subdivision under the ceiling wins, and if even
 * a quarter-time stroke is too fast, quarter time.
 */
export function pickStrokesPerBeat(
  bpm: number,
  band: { lo: number, hi: number },
  maxSpm: number,
  energy = 0.5,
): number {
  if (!(bpm > 0))
    return 1
  const legal = STROKES_PER_BEAT.filter(k => bpm * k <= maxSpm)
  if (!legal.length)
    return STROKES_PER_BEAT[STROKES_PER_BEAT.length - 1]

  const inBand = legal.filter(k => bpm * k >= band.lo && bpm * k <= band.hi)
  if (!inBand.length)
    return legal[0]

  const lo = Math.max(band.lo, 0)
  const hi = Math.min(band.hi, maxSpm)
  const want = lo + (hi - lo) * Math.min(1, Math.max(0, energy))
  let best = inBand[0]
  for (const k of inBand) {
    if (Math.abs(bpm * k - want) < Math.abs(bpm * best - want))
      best = k
  }
  return best
}

/**
 * Hold a subdivision until the music has really changed.
 *
 * A new choice is only taken on a bar line (every four beats, where every
 * subdivision's stroke starts together, so the switch is seamless) and only
 * once the same choice has held for a whole bar.
 */
export function createSubdivisionHold(beatsPerBar = 4) {
  let current = 0
  let candidate = 0
  let candidateSinceBar = Number.NaN
  let lastBar = Number.NaN

  return {
    /** `beats` is the grid position; returns the subdivision to use now. */
    update(beats: number, wanted: number): number {
      if (current === 0)
        current = wanted
      const bar = Math.floor(beats / beatsPerBar)
      if (wanted !== candidate) {
        candidate = wanted
        candidateSinceBar = bar
      }
      if (bar !== lastBar) {
        lastBar = bar
        if (candidate !== current && bar - candidateSinceBar >= 1)
          current = candidate
      }
      return current
    },
    get current() {
      return current
    },
    reset() {
      current = 0
      candidate = 0
      candidateSinceBar = Number.NaN
      lastBar = Number.NaN
    },
  }
}

// ─── Steering the stroke onto the grid ───────────────────────────────────────

/** Shortest signed distance between two 0–1 phases, in [-0.5, 0.5). */
export function phaseDelta(from: number, to: number): number {
  let d = (to - from) % 1
  if (d < -0.5)
    d += 1
  if (d >= 0.5)
    d -= 1
  return d
}

/**
 * Advance a 0–1 stroke phase toward a target phase without ever jumping.
 *
 * The phase moves at `rateHz`, bent by at most `maxBend` (a fraction of the
 * rate) toward the target, so a nudged grid or a new subdivision eases in over
 * a stroke or two. The bend never pushes the rate past `maxRateHz` — the speed
 * ceiling holds even while catching up.
 */
export function steerPhase(
  phase: number,
  target: number,
  rateHz: number,
  dt: number,
  opts: { gain?: number, maxBend?: number, maxRateHz?: number } = {},
): number {
  const { gain = 1.5, maxBend = 0.2, maxRateHz = Number.POSITIVE_INFINITY } = opts
  const err = phaseDelta(phase, target)
  const bend = Math.max(-maxBend, Math.min(maxBend, err * gain))
  const rate = Math.min(maxRateHz, rateHz * (1 + bend))
  const next = phase + rate * dt
  return next - Math.floor(next)
}

// ─── Loudness ────────────────────────────────────────────────────────────────

/**
 * How loud the music is right now, relative to this track, 0–1.
 *
 * Absolute levels mean nothing across videos, so the follower tracks the
 * track's own quiet floor and loud ceiling (both slowly forgetting) and
 * reports where the current level sits between them. Rises register quickly,
 * falls slowly, so a drop lands at once and a single quiet beat does not.
 */
export function createEnergyFollower(opts: { attackS?: number, releaseS?: number, memoryS?: number } = {}) {
  const { attackS = 0.25, releaseS = 1.6, memoryS = 30 } = opts
  let level = Number.NaN
  let floor = Number.NaN
  let ceil = Number.NaN
  let energy = 0

  return {
    /** Feed a loudness reading (any monotonic scale, e.g. mean dB) and the seconds since the last. */
    push(value: number, dt: number): number {
      if (!Number.isFinite(value) || dt <= 0)
        return energy
      if (Number.isNaN(level)) {
        level = floor = ceil = value
        return energy
      }
      const tc = value > level ? attackS : releaseS
      level += (value - level) * Math.min(1, dt / tc)

      // The range relaxes toward the current level so an old peak or silence
      // does not set the scale for the rest of the track.
      const relax = Math.min(1, dt / memoryS)
      floor = Math.min(level, floor + (level - floor) * relax)
      ceil = Math.max(level, ceil + (level - ceil) * relax)

      const span = ceil - floor
      energy = span > 1e-6 ? (level - floor) / span : 0
      return energy
    },
    get energy() {
      return energy
    },
    reset() {
      level = floor = ceil = Number.NaN
      energy = 0
    },
  }
}
