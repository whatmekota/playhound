/**
 * The shape of an edge over time, as a pure function of the clock.
 *
 *   holdBack
 *   1 ┤   ┌──────────┐
 *     │  ╱            ╲
 *     │ ╱              ╲___
 *   0 ┼┘ fall   hold   rebuild
 *
 * Falls in about a second (fast enough to matter, slow enough not to jolt a
 * device), holds for the cooldown, then rebuilds along a smoothstep so the
 * return is gentle at both ends. `depth` sets how far down it goes.
 */

export interface EdgeTiming {
  cooldownSec: number
  rebuildSec: number
  depth: number
}

export interface EdgeSample {
  holdBack: number
  phase: 'idle' | 'falling' | 'holding' | 'rebuilding'
  /** Seconds until fully back to normal; 0 when idle. */
  remainingSec: number
}

/** Seconds to fall to the hold level. */
export const EDGE_FALL_SEC = 1.2

function smoothstep(x: number): number {
  const t = Math.max(0, Math.min(1, x))
  return t * t * (3 - 2 * t)
}

export function createEdgeEnvelope() {
  /** When the current edge was called, ms; NaN when idle. */
  let startMs = Number.NaN
  /** When the hold was ended early by release(), ms. */
  let releasedMs = Number.NaN
  /** holdBack at the moment of a re-trigger, so a second press does not dip and climb. */
  let fromLevel = 0

  function sample(now: number, t: EdgeTiming): EdgeSample {
    if (Number.isNaN(startMs))
      return { holdBack: 0, phase: 'idle', remainingSec: 0 }

    const depth = Math.max(0, Math.min(1, t.depth))
    const el = (now - startMs) / 1000
    const holdEnd = Number.isNaN(releasedMs)
      ? EDGE_FALL_SEC + t.cooldownSec
      : Math.max(0, (releasedMs - startMs) / 1000)
    const end = holdEnd + t.rebuildSec

    if (el < EDGE_FALL_SEC && el < holdEnd) {
      const h = fromLevel + (depth - fromLevel) * smoothstep(el / EDGE_FALL_SEC)
      return { holdBack: h, phase: 'falling', remainingSec: end - el }
    }
    if (el < holdEnd)
      return { holdBack: depth, phase: 'holding', remainingSec: end - el }
    if (el < end) {
      // Rebuild from wherever the fall had got to, if released early.
      const top = el >= EDGE_FALL_SEC || holdEnd >= EDGE_FALL_SEC
        ? depth
        : fromLevel + (depth - fromLevel) * smoothstep(holdEnd / EDGE_FALL_SEC)
      const h = top * (1 - smoothstep((el - holdEnd) / Math.max(0.001, t.rebuildSec)))
      return { holdBack: h, phase: 'rebuilding', remainingSec: end - el }
    }
    startMs = Number.NaN
    releasedMs = Number.NaN
    fromLevel = 0
    return { holdBack: 0, phase: 'idle', remainingSec: 0 }
  }

  return {
    trigger(now: number, t: EdgeTiming) {
      fromLevel = sample(now, t).holdBack
      startMs = now
      releasedMs = Number.NaN
    },
    release(now: number, t: EdgeTiming) {
      const s = sample(now, t)
      if (s.phase === 'falling' || s.phase === 'holding')
        releasedMs = now
    },
    reset() {
      startMs = Number.NaN
      releasedMs = Number.NaN
      fromLevel = 0
    },
    sample,
  }
}
