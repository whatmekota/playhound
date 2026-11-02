/**
 * Tap tempo: a few taps on the beat set the music source's tempo and where
 * the beat falls, for a track the analysis gets wrong or cannot hear.
 *
 * Taps are times on the video's clock (seconds), so a tapped beat survives a
 * pause and follows a speed change. The tempo is a least-squares line through
 * the taps rather than the last interval, so one early or late tap only
 * nudges it, and every tap after the third refines it.
 *
 * Pure: useVideoBeat owns the taps and reads the video clock.
 */

export interface TappedTempo {
  /** Video time of a beat, seconds. */
  anchorSec: number
  /** Seconds per beat, in video time. */
  periodSec: number
}

export const TAP_MIN_BPM = 40
export const TAP_MAX_BPM = 240
/** Taps needed before there is a tempo. */
export const TAPS_FOR_TEMPO = 3
/** A longer gap than this starts a new count (slower than 30 bpm is no beat). */
export const TAP_RESET_SEC = 2
const MAX_TAPS = 16

/** The beat line through a run of taps, one beat apart. Null for fewer than three or an implausible tempo. */
export function fitTaps(times: readonly number[]): TappedTempo | null {
  const n = times.length
  if (n < TAPS_FOR_TEMPO)
    return null
  const meanX = (n - 1) / 2
  const meanY = times.reduce((a, b) => a + b, 0) / n
  let cov = 0
  let varX = 0
  for (let i = 0; i < n; i++) {
    cov += (i - meanX) * (times[i] - meanY)
    varX += (i - meanX) ** 2
  }
  const periodSec = cov / varX
  const bpm = 60 / periodSec
  if (!Number.isFinite(bpm) || bpm < TAP_MIN_BPM || bpm > TAP_MAX_BPM)
    return null
  // Anchored on the fitted last tap: the most recent is where the user is listening.
  return { anchorSec: meanY + periodSec * (n - 1 - meanX), periodSec }
}

export function tappedBpm(t: TappedTempo): number {
  return 60 / t.periodSec
}

/** Beats since the anchor at video time `sec`: a continuous count, like the other grids. */
export function tappedBeats(t: TappedTempo, sec: number): number {
  return (sec - t.anchorSec) / t.periodSec
}

/** Double or halve a tapped tempo, keeping its beat where it is. */
export function scaleTempo(t: TappedTempo, factor: number): TappedTempo | null {
  const periodSec = t.periodSec / factor
  const bpm = 60 / periodSec
  return bpm >= TAP_MIN_BPM && bpm <= TAP_MAX_BPM ? { anchorSec: t.anchorSec, periodSec } : null
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/**
 * A run of taps. Each tap returns the tempo as it stands: a fresh fit once
 * there are three or more; until then, an existing tempo kept and re-aligned
 * so its beat falls on this tap ("tap once to put the beat back").
 */
export function createTapper() {
  let taps: number[] = []
  return {
    tap(sec: number, current: TappedTempo | null): TappedTempo | null {
      const last = taps.at(-1)
      if (last !== undefined) {
        const gap = sec - last
        if (gap <= 0 || gap > TAP_RESET_SEC) {
          // A pause, a seek, or a new count.
          taps = []
        }
        else if (taps.length >= 2) {
          // Far off the running interval (a missed or doubled beat): count again from the last tap.
          const intervals = taps.slice(1).map((t, i) => t - taps[i])
          const m = median(intervals)
          if (gap < m * 0.6 || gap > m * 1.5)
            taps = [last]
        }
      }
      taps.push(sec)
      if (taps.length > MAX_TAPS)
        taps.shift()
      const fit = fitTaps(taps)
      if (fit)
        return fit
      return current ? { anchorSec: sec, periodSec: current.periodSec } : null
    },
    /** Taps in the current run. */
    get count() {
      return taps.length
    },
    reset() {
      taps = []
    },
  }
}
