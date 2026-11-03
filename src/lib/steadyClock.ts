/**
 * The video's clock, steadied.
 *
 * Chromium's currentTime follows the audio clock, which arrives in uneven
 * steps: one frame it moves 2.7 ms in a 6.9 ms frame, the next it catches up.
 * Script positions read off it wobble with it, which shows as kinks along the
 * Motion trace's straight strokes and as a fine jitter in what the device is
 * sent. This runs its own clock at the playback rate and pulls it gently
 * toward currentTime each frame, so it tracks the video without the steps.
 *
 * Anything bigger than jitter (a seek, a stall, a loop, a pause) is taken as
 * is: the clock jumps to the real time instead of drifting there.
 */

/** Past this far off, the video moved for real; follow at once. */
const JUMP_MS = 120
/** Share of the error corrected each frame. */
const PULL = 0.08

export interface SteadyClock {
  /** The steadied time in ms, given the raw currentTime (ms) and the time now (ms). */
  read: (rawMs: number, now: number, rate: number, running: boolean) => number
  reset: () => void
}

export function createSteadyClock(): SteadyClock {
  let t: number | null = null
  let at = 0
  let wasRunning = false

  return {
    read(rawMs, now, rate, running) {
      // Stopped, or just started again: the real time, as it is.
      if (t === null || !running || !wasRunning) {
        t = rawMs
        at = now
        wasRunning = running
        return rawMs
      }
      const predicted = t + Math.max(0, now - at) * rate
      const err = rawMs - predicted
      at = now
      if (Math.abs(err) > JUMP_MS * Math.max(1, rate)) {
        t = rawMs
        return t
      }
      // Never backwards while playing: a correction only slows it down.
      t = Math.max(t, predicted + err * PULL)
      return t
    },
    reset() {
      t = null
      wasRunning = false
    },
  }
}
