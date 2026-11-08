import { estimateTempo } from './beatTrack'

/**
 * The tempo of music heard live (a web page, or a video before its whole
 * soundtrack is analysed).
 *
 * This used to be the median gap between neighbouring onsets, folded into one
 * octave. Off-beats and syncopation fold into wrong tempos (a hit a beat and
 * a half later reads as a beat of three quarters), so on a busy track the
 * median wandered: one steady song read anywhere from 118 to 135 bpm.
 *
 * Now it is the soundtrack analysis's own method on a rolling window: the
 * onset strength over the last few seconds, autocorrelated, so every hit
 * votes for every beat period it fits rather than only the gap to its
 * neighbour. And it holds on to what it has: a reading close to the tempo
 * nudges it, an octave of it is the same tempo, and a different tempo takes
 * over only once it has come up several times running.
 *
 * Vue-free and fed by time stamps, so it is tested with synthetic music.
 */

export interface LiveTempoOptions {
  /** Envelope frames per second. */
  fps?: number
  /** Seconds of music each reading looks at. */
  windowS?: number
  /** Seconds heard before the first reading. */
  minS?: number
  /** Seconds between readings. */
  everyS?: number
  minBpm?: number
  maxBpm?: number
}

/** Readings this close (as a ratio) are the same tempo. */
const SAME = 0.04
/** How much of a close reading's difference is taken. */
const NUDGE = 0.2
/** Readings in a row it takes for a different tempo to take over. */
const SWITCH_AFTER = 4
/** Below this the music has no clear beat in the window, and the reading is ignored. */
const MIN_STRENGTH = 0.04

function movingAverage(x: Float64Array, radius: number): Float64Array {
  const out = new Float64Array(x.length)
  let sum = 0
  let lo = 0
  let hi = -1
  for (let i = 0; i < x.length; i++) {
    while (hi < Math.min(x.length - 1, i + radius))
      sum += x[++hi]
    while (lo < i - radius)
      sum -= x[lo++]
    out[i] = sum / (hi - lo + 1)
  }
  return out
}

export function createLiveTempo(opts: LiveTempoOptions = {}) {
  // 100 a second: at 50, frames landing on either side of a bin edge put a
  // couple of bpm of jitter into the reading.
  const fps = opts.fps ?? 100
  const size = Math.round(fps * (opts.windowS ?? 8))
  const minFrames = Math.round(fps * (opts.minS ?? 4))
  const every = Math.max(1, Math.round(fps * (opts.everyS ?? 0.5)))
  const minBpm = opts.minBpm ?? 60
  const maxBpm = opts.maxBpm ?? 200

  const ring = new Float64Array(size)
  let filled = 0
  let lastFrame = -1
  let lastValue = 0
  let nextReading = 0
  let bpm = 0
  let candidate = 0
  let candidateRuns = 0

  function reset() {
    ring.fill(0)
    filled = 0
    lastFrame = -1
    lastValue = 0
    nextReading = 0
    bpm = 0
    candidate = 0
    candidateRuns = 0
  }

  /** The window, oldest first, with its slow level taken out (as the analysis does). */
  function envelope(): Float64Array {
    const n = Math.min(filled, size)
    const env = new Float64Array(n)
    for (let i = 0; i < n; i++)
      env[i] = ring[(lastFrame - n + 1 + i + size * 4) % size]
    const mean = movingAverage(env, Math.round(fps * 0.5))
    for (let i = 0; i < n; i++)
      env[i] -= mean[i]
    return env
  }

  function accept(reading: number): boolean {
    if (bpm === 0) {
      bpm = reading
      return true
    }
    const r = reading / bpm
    // An octave of the tempo held is the same tempo; which octave to stroke
    // at is the pace setting's business, not a reason to jump.
    if (Math.abs(r - 2) / 2 <= SAME || Math.abs(r - 0.5) / 0.5 <= SAME)
      return false
    if (Math.abs(r - 1) <= SAME) {
      bpm += (reading - bpm) * NUDGE
      candidateRuns = 0
      return true
    }
    if (candidate && Math.abs(reading / candidate - 1) <= SAME) {
      candidateRuns++
    }
    else {
      candidate = reading
      candidateRuns = 1
    }
    if (candidateRuns >= SWITCH_AFTER) {
      bpm = candidate
      candidateRuns = 0
      candidate = 0
      return true
    }
    return false
  }

  return {
    /** One frame's onset strength (spectral flux) at `tMs`. Returns true when the tempo changed. */
    push(flux: number, tMs: number): boolean {
      const frame = Math.floor((tMs / 1000) * fps)
      if (lastFrame >= 0 && (frame < lastFrame || frame - lastFrame > fps * 2))
        reset()
      if (lastFrame < 0) {
        lastFrame = frame - 1
        nextReading = frame + minFrames
      }
      if (frame === lastFrame) {
        // Several analyser frames in one envelope frame: the strongest counts.
        ring[frame % size] = Math.max(ring[frame % size], flux)
      }
      else {
        // Frames the analyser skipped hold the last value rather than read as silence.
        for (let f = lastFrame + 1; f < frame; f++)
          ring[f % size] = lastValue
        ring[frame % size] = flux
        filled += frame - lastFrame
        lastFrame = frame
      }
      lastValue = flux
      if (filled < minFrames || frame < nextReading)
        return false
      nextReading = frame + every
      const { period, strength } = estimateTempo(envelope(), fps, minBpm, maxBpm)
      if (!(period > 0) || strength < MIN_STRENGTH)
        return false
      return accept((fps * 60) / period)
    },
    /** The tempo, or 0 before there is one. */
    get bpm() {
      return bpm
    },
    reset,
  }
}
