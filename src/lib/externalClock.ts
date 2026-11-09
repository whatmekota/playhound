/**
 * The clock of a video that plays somewhere else (a VR headset), steadied.
 *
 * The other app reports where it is a few times a second, and the reports
 * come late and unevenly: one 180 ms after the last, the next 40 ms after
 * that. Taken as they are, every report would nudge the device forwards or
 * back. Here the clock runs on its own at the reported rate between reports,
 * and each report only bends its speed (by up to MAX_SKEW) until the
 * difference is made up, so it follows the other app without ever stepping
 * backwards while playing.
 *
 * A report far from where the clock is (a seek, a loop, a long stall over
 * there) is taken as it is: the clock jumps and says so. A clock that hears
 * nothing for STALE_MS while playing stops by itself, so a headset that went
 * to sleep or a dropped connection never leaves the device going.
 *
 * Times are in ms and `now` is any monotonic ms clock (performance.now()).
 */

/**
 * What the device sync reads off the video it follows: the <video> element
 * has all of it, and a video playing elsewhere is made to look the same
 * (src/stores/playbackStore.ts).
 */
export interface MediaClock {
  readonly currentTime: number
  readonly playbackRate: number
  readonly paused: boolean
  readonly seeking: boolean
  readonly ended: boolean
  readonly readyState: number
}

/** A report from the other app. */
export interface ExternalSample {
  /** Where the video is, seconds. */
  time: number
  playing: boolean
  /** Its playback speed, 1 is normal. */
  rate?: number
}

/** What a report changed, for whoever follows the clock. */
export type ExternalEvent = 'play' | 'pause' | 'seek'

export interface ExternalReading {
  timeMs: number
  /** Playing, and heard from recently enough. */
  playing: boolean
  rate: number
  /** Nothing heard for a while: stopped, though the other app said it plays. */
  stale: boolean
}

export interface ExternalClockOptions {
  /** Silence while playing that counts as stopped. */
  staleMs?: number
  /** A report this far from the clock (scaled by the rate) is a jump, not drift. */
  jumpMs?: number
}

/** How long the clock takes to make up a difference, ms. */
const CATCH_UP_MS = 1000
/** The most it bends its speed to do so: ±10%. */
const MAX_SKEW = 0.1
const STALE_MS = 2500
const JUMP_MS = 900

export interface ExternalClock {
  /** Take a report. Says what changed; nothing for an ordinary tick. */
  update: (s: ExternalSample, now: number) => ExternalEvent[]
  read: (now: number) => ExternalReading
  /** Whether anything has been reported yet. */
  readonly started: boolean
}

const clampRate = (r: unknown) => (typeof r === 'number' && Number.isFinite(r) && r > 0 ? Math.min(10, Math.max(0.1, r)) : 1)

export function createExternalClock(opts: ExternalClockOptions = {}): ExternalClock {
  const staleMs = opts.staleMs ?? STALE_MS
  const jumpMs = opts.jumpMs ?? JUMP_MS
  let started = false
  /** The clock's time at `baseAt`. */
  let base = 0
  let baseAt = 0
  let rate = 1
  /** The speed it runs at to make up the last difference, as a share of `rate`. */
  let skew = 0
  /** Until when the skew applies (it made up the difference by then). */
  let skewUntil = 0
  let playing = false
  let heardAt = 0

  /** Where the clock is at `now`, without caring whether it has gone quiet. */
  function at(now: number): number {
    if (!playing)
      return base
    const dt = Math.max(0, now - baseAt)
    const skewed = Math.max(0, Math.min(dt, skewUntil - baseAt))
    return base + dt * rate + skewed * rate * skew
  }

  function rebase(now: number, t: number) {
    base = t
    baseAt = now
    skew = 0
    skewUntil = now
  }

  return {
    get started() {
      return started
    },
    update(s, now) {
      const t = Number.isFinite(s.time) ? Math.max(0, s.time * 1000) : at(now)
      const r = clampRate(s.rate)
      const events: ExternalEvent[] = []
      const wasStale = playing && now - heardAt > staleMs
      const wasPlaying = playing && !wasStale
      heardAt = now
      if (!started) {
        started = true
        playing = !!s.playing
        rate = r
        rebase(now, t)
        events.push(playing ? 'play' : 'pause')
        return events
      }
      if (!s.playing) {
        const cur = at(now)
        playing = false
        rate = r
        if (wasPlaying)
          events.push('pause')
        // Paused, a move is someone scrubbing over there: follow it exactly.
        if (Math.abs(t - cur) > 1)
          events.push('seek')
        rebase(now, t)
        return events
      }
      // Playing.
      if (!wasPlaying) {
        const cur = at(now)
        playing = true
        rate = r
        if (Math.abs(t - cur) > jumpMs * Math.max(1, r))
          events.push('seek')
        rebase(now, t)
        events.push('play')
        return events
      }
      const cur = at(now)
      if (r !== rate) {
        // A new speed: carry on from here at it.
        base = cur
        baseAt = now
        rate = r
      }
      const err = t - cur
      if (Math.abs(err) > jumpMs * Math.max(1, r)) {
        rebase(now, t)
        events.push('seek')
        return events
      }
      // Bend the speed to make the difference up over CATCH_UP_MS, never
      // past ±MAX_SKEW: slower, never backwards.
      base = cur
      baseAt = now
      skew = Math.max(-MAX_SKEW, Math.min(MAX_SKEW, err / (CATCH_UP_MS * rate)))
      skewUntil = now + Math.abs(err) / (Math.abs(skew) * rate || 1)
      return events
    },
    read(now) {
      if (!started)
        return { timeMs: 0, playing: false, rate: 1, stale: false }
      const stale = playing && now - heardAt > staleMs
      // Gone quiet: stopped where it was when the silence started counting.
      const timeMs = stale ? at(heardAt + staleMs) : at(now)
      return { timeMs, playing: playing && !stale, rate, stale }
    },
  }
}
