/**
 * The shape of an edge over time, as a pure function of the clock.
 *
 *   holdBack
 *   1 ┤   ┌──────────┐
 *     │  ╱            ╲
 *     │ ╱              ╲___
 *   0 ┼┘ fall   hold   rebuild
 *
 * Falls over `fallSec` (about a second by default: fast enough to matter,
 * slow enough not to jolt a device), holds for the cooldown, then rebuilds
 * along a smoothstep so the return is gentle at both ends. `depth` sets how
 * far down it goes: 1 stops everything.
 */

export interface EdgeTiming {
  cooldownSec: number
  rebuildSec: number
  depth: number
  /** Seconds to fall to the hold level; EDGE_FALL_SEC when absent. */
  fallSec?: number
}

export interface EdgeSample {
  holdBack: number
  phase: 'idle' | 'falling' | 'holding' | 'rebuilding'
  /** Seconds until fully back to normal; 0 when idle. */
  remainingSec: number
}

/** Seconds to fall to the hold level, by default. */
export const EDGE_FALL_SEC = 1.2
/**
 * The quickest fall: none, the hold level the moment it is called. A device
 * told to stop that fast lurches, but some want exactly that.
 */
export const MIN_FALL_SEC = 0

/** An edge's fall time, within bounds. */
export const fallOf = (t: Pick<EdgeTiming, 'fallSec'>) => Math.max(MIN_FALL_SEC, Math.min(5, t.fallSec ?? EDGE_FALL_SEC))

/** Seconds an edge lasts from the call to back to normal. */
export const edgeTotalSec = (t: EdgeTiming) => fallOf(t) + t.cooldownSec + t.rebuildSec

export interface EdgePreset extends Required<EdgeTiming> {
  id: string
  label: string
  hint: string
}

/** Ready-made edges for Settings → Edges. The first is the default. */
export const EDGE_PRESETS: EdgePreset[] = [
  { id: 'back-off', label: 'Back off', hint: 'Down to 15% over a second, held 20 s, back up over 25 s.', fallSec: EDGE_FALL_SEC, depth: 0.85, cooldownSec: 20, rebuildSec: 25 },
  { id: 'stop', label: 'Stop', hint: 'Stops at once, held 20 s, back up over 20 s.', fallSec: 0.3, depth: 1, cooldownSec: 20, rebuildSec: 20 },
  { id: 'pause', label: 'Short pause', hint: 'Stops at once for 8 s, back up over 8 s.', fallSec: 0.3, depth: 1, cooldownSec: 8, rebuildSec: 8 },
  { id: 'slow', label: 'Slow down', hint: 'Eases down to 40% over 2 s, held 30 s, back up over 30 s.', fallSec: 2, depth: 0.6, cooldownSec: 30, rebuildSec: 30 },
]

/** The preset these settings are, or null for settings of your own. */
export function presetOf(t: EdgeTiming): EdgePreset | null {
  const near = (a: number, b: number) => Math.abs(a - b) < 0.001
  return EDGE_PRESETS.find(p => near(p.fallSec, fallOf(t)) && near(p.depth, t.depth) && near(p.cooldownSec, t.cooldownSec) && near(p.rebuildSec, t.rebuildSec)) ?? null
}

/** Settings with a preset's timing in place of their own; the rest (on or off) kept. */
export function withPreset<T extends EdgeTiming>(t: T, p: EdgePreset): T {
  return { ...t, fallSec: p.fallSec, depth: p.depth, cooldownSec: p.cooldownSec, rebuildSec: p.rebuildSec }
}

function smoothstep(x: number): number {
  const t = Math.max(0, Math.min(1, x))
  return t * t * (3 - 2 * t)
}

/**
 * An edge drawn as intensity against time, for an SVG `w` by `h`: the line
 * (down at the top, so a deeper edge dips further), where the hold starts and
 * ends, and the seconds the whole of it takes.
 */
export function edgeShape(t: EdgeTiming, w: number, h: number): { line: string, holdFrom: number, holdTo: number, total: number } {
  const total = Math.max(0.1, edgeTotalSec(t))
  const x = (s: number) => (s / total) * w
  const y = (holdBack: number) => 4 + holdBack * (h - 8)
  const f = fallOf(t)
  const d = Math.max(0, Math.min(1, t.depth))
  const pts: string[] = []
  const n = 24
  for (let i = 0; i <= n; i++)
    pts.push(`${x((f * i) / n).toFixed(1)},${y(d * smoothstep(i / n)).toFixed(1)}`)
  pts.push(`${x(f + t.cooldownSec).toFixed(1)},${y(d).toFixed(1)}`)
  for (let i = 1; i <= n; i++)
    pts.push(`${x(f + t.cooldownSec + (t.rebuildSec * i) / n).toFixed(1)},${y(d * (1 - smoothstep(i / n))).toFixed(1)}`)
  return { line: `M${pts.join(' L')}`, holdFrom: x(f), holdTo: x(f + t.cooldownSec), total }
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
    const fall = fallOf(t)
    const el = (now - startMs) / 1000
    const holdEnd = Number.isNaN(releasedMs)
      ? fall + t.cooldownSec
      : Math.max(0, (releasedMs - startMs) / 1000)
    const end = holdEnd + t.rebuildSec

    if (el < fall && el < holdEnd) {
      const h = fromLevel + (depth - fromLevel) * smoothstep(el / fall)
      return { holdBack: h, phase: 'falling', remainingSec: end - el }
    }
    if (el < holdEnd)
      return { holdBack: depth, phase: 'holding', remainingSec: end - el }
    if (el < end) {
      // Rebuild from wherever the fall had got to, if released early.
      const top = el >= fall || holdEnd >= fall
        ? depth
        : fromLevel + (depth - fromLevel) * smoothstep(holdEnd / fall)
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
    startAtDepth(now: number, t: EdgeTiming) {
      fromLevel = Math.max(0, Math.min(1, t.depth))
      startMs = now - fallOf(t) * 1000
      releasedMs = Number.NaN
    },
    reset() {
      startMs = Number.NaN
      releasedMs = Number.NaN
      fromLevel = 0
    },
    sample,
  }
}
