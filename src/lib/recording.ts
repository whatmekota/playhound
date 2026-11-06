/**
 * Session recording: what the device was told, turned back into funscripts.
 *
 * Everything that moves the device ends in useTCode's sendPosition (the
 * script, every generator, plugins driving the generator, derived axes,
 * homing), so that is where positions are tapped, in script terms: before the
 * Device panel's range and inversion, so a recording played back through the
 * same settings moves the device the same way.
 *
 * This file is the pure part: a model of where each axis is, takes made of
 * segments, simplification, and file names and contents. The store
 * (recordingStore) runs the clock and the UI.
 */

import type { FunscriptAction } from './funscriptParser'
import { sanitizeFilename } from './fsRename'

// ─── Where an axis is ─────────────────────────────────────────────────────────

/**
 * A command this quick is the position now, not a move: the script and the
 * generators stream a position every frame with an interval of a few frames,
 * which is the device's smoothing, not travel.
 */
export const IMMEDIATE_MS = 100

export interface AxisModel {
  /** A command: go to `pos` (0–1) over `intervalMs`, sent at `now`. */
  command: (pos: number, intervalMs: number, now: number) => void
  /** Where the axis is at `now`. */
  at: (now: number) => number
}

/**
 * One axis, as a straight move from where it was to where it was last sent.
 * A slow command (homing over half a second, a test sweep) is recorded as the
 * travel it asks for rather than as a jump.
 */
export function createAxisModel(): AxisModel {
  let from = Number.NaN
  let to = Number.NaN
  let t0 = 0
  let t1 = 0
  function at(now: number) {
    if (Number.isNaN(to))
      return 0.5
    if (now >= t1 || t1 <= t0)
      return to
    return from + (to - from) * Math.max(0, now - t0) / (t1 - t0)
  }
  return {
    at,
    command(pos, intervalMs, now) {
      const p = Math.min(1, Math.max(0, pos))
      // The first command has nothing to travel from.
      from = intervalMs <= IMMEDIATE_MS || Number.isNaN(to) ? p : at(now)
      to = p
      t0 = now
      t1 = intervalMs <= IMMEDIATE_MS ? now : now + intervalMs
    },
  }
}

// ─── Takes ────────────────────────────────────────────────────────────────────

/**
 * A run of samples with time going forward evenly. A video take breaks into
 * a new segment at every seek; a free take is one segment.
 */
interface Segment {
  start: number
  end: number
  /** Per channel, interleaved [t, pos, t, pos…]. */
  axes: Map<string, number[]>
}

export interface TakeOptions {
  /**
   * Time moving forward further than this between two samples is a seek, not
   * playback. Paused time does not count: the clock does not move then.
   */
  gapMs?: number
}

/** A recorded axis, ready to write: positions 0–100, times in whole ms. */
export interface RecordedAxis {
  channel: string
  actions: FunscriptAction[]
}

export interface Take {
  /** One sample: time in ms on the take's clock, each axis's position 0–1. */
  add: (t: number, values: Iterable<[string, number]>) => void
  readonly samples: number
  /** Time recorded, ms: each segment's length, added up (a part recorded twice counts twice). */
  readonly recordedMs: number
  /** Merge, simplify and round: the axes that moved. */
  finish: (tolerance?: number) => RecordedAxis[]
}

/**
 * How far (of the full range) the file may stray from what was recorded.
 * 2.5% keeps a sine stroke round with three or four points each way, from
 * 30 to 200 strokes a minute, instead of the sixty-odd samples a second.
 */
export const SIMPLIFY_TOLERANCE = 0.025

/** Moving back by less than this is jitter in the clock, not a seek. */
const BACK_SLACK_MS = 30

export function createTake(opts: TakeOptions = {}): Take {
  const gapMs = opts.gapMs ?? Infinity
  const segments: Segment[] = []
  let seg: Segment | null = null
  let samples = 0

  return {
    add(t, values) {
      if (seg && (t < seg.end - BACK_SLACK_MS || t - seg.end > gapMs))
        seg = null
      if (!seg) {
        seg = { start: t, end: t, axes: new Map() }
        segments.push(seg)
      }
      // Never backwards within a segment, so its points stay in order.
      const at = Math.max(t, seg.end)
      seg.end = at
      for (const [ch, pos] of values) {
        let list = seg.axes.get(ch)
        if (!list)
          seg.axes.set(ch, list = [])
        list.push(at, pos)
      }
      samples++
    },
    get samples() {
      return samples
    },
    get recordedMs() {
      return segments.reduce((n, s) => n + s.end - s.start, 0)
    },
    finish(tolerance = SIMPLIFY_TOLERANCE) {
      const channels = new Set(segments.flatMap(s => [...s.axes.keys()]))
      const out: RecordedAxis[] = []
      for (const ch of channels) {
        const points = mergeSegments(segments.map(s => ({ start: s.start, end: s.end, points: s.axes.get(ch) ?? [] })))
        if (!moved(points))
          continue
        out.push({ channel: ch, actions: roundActions(simplify(points, tolerance)) })
      }
      return out.sort((a, b) => axisOrder(a.channel) - axisOrder(b.channel))
    },
  }
}

const ORDER = ['L0', 'L1', 'L2', 'R0', 'R1', 'R2', 'V0', 'V1', 'A0', 'A1']
function axisOrder(ch: string) {
  const i = ORDER.indexOf(ch)
  return i < 0 ? ORDER.length : i
}

/**
 * Overlapping segments: the later one wins over its own time span. Seeking
 * back and recording over a part replaces it, as a second take of that part.
 * Between segments that do not touch, the file simply goes from one to the
 * next, as any funscript does between two points.
 */
export function mergeSegments(segments: { start: number, end: number, points: number[] }[]): FunscriptAction[] {
  let merged: FunscriptAction[] = []
  for (const s of segments) {
    if (!s.points.length)
      continue
    const own: FunscriptAction[] = []
    for (let i = 0; i < s.points.length; i += 2)
      own.push({ at: s.points[i], pos: s.points[i + 1] })
    merged = merged.filter(p => p.at < s.start || p.at > s.end).concat(own)
    merged.sort((a, b) => a.at - b.at)
  }
  return merged
}

/** Less than this much travel in the whole take is an axis that sat still. */
const MOVED_MIN = 0.02

function moved(points: FunscriptAction[]): boolean {
  let lo = Infinity
  let hi = -Infinity
  for (const p of points) {
    lo = Math.min(lo, p.pos)
    hi = Math.max(hi, p.pos)
  }
  return hi - lo >= MOVED_MIN
}

// ─── Simplification ───────────────────────────────────────────────────────────

/** A turn smaller than this is wobble, not a stroke changing direction. */
const TURN_MIN = 0.01

/**
 * Fewer points, same motion. Every turn (top and bottom of a stroke) is kept
 * exactly, so strokes keep their full depth; between turns, Ramer–Douglas–
 * Peucker on the position error drops whatever a straight line already
 * covers, which is all of a still stretch but its two ends.
 */
export function simplify(points: FunscriptAction[], tolerance = SIMPLIFY_TOLERANCE): FunscriptAction[] {
  if (points.length <= 2)
    return points.slice()
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  for (const i of turns(points))
    keep[i] = 1
  let a = 0
  for (let i = 1; i < points.length; i++) {
    if (!keep[i])
      continue
    rdp(points, a, i, tolerance, keep)
    a = i
  }
  return points.filter((_, i) => keep[i])
}

/** Indices of the extremes where travel changes direction, ignoring wobble under TURN_MIN. */
function turns(points: FunscriptAction[]): number[] {
  const out: number[] = []
  let dir = 0
  let ext = 0
  for (let i = 1; i < points.length; i++) {
    const d = points[i].pos - points[ext].pos
    if (dir === 0) {
      // Not moving yet: the first real move sets the direction.
      if (Math.abs(d) >= TURN_MIN) {
        dir = Math.sign(d)
        ext = i
      }
      continue
    }
    // Further the same way: the extreme moves on. Level with it does not, so
    // a flat top keeps its first point (and RDP its last).
    if (d * dir > 0) {
      ext = i
      continue
    }
    if (-d * dir >= TURN_MIN) {
      out.push(ext)
      dir = -dir
      ext = i
    }
  }
  return out
}

/** Vertical distance: how wrong the position would be at that time. */
function rdp(points: FunscriptAction[], a: number, b: number, tol: number, keep: Uint8Array) {
  // Iterative, so an hour of samples between two turns cannot overflow the stack.
  const stack: [number, number][] = [[a, b]]
  while (stack.length) {
    const [i, j] = stack.pop()!
    if (j - i < 2)
      continue
    const p = points[i]
    const q = points[j]
    const span = q.at - p.at
    let worst = -1
    let worstD = tol
    for (let k = i + 1; k < j; k++) {
      const r = points[k]
      const line = span > 0 ? p.pos + (q.pos - p.pos) * (r.at - p.at) / span : p.pos
      const d = Math.abs(r.pos - line)
      if (d > worstD) {
        worstD = d
        worst = k
      }
    }
    if (worst >= 0) {
      keep[worst] = 1
      stack.push([i, worst], [worst, j])
    }
  }
}

/**
 * Whole milliseconds and 0–100, as funscripts are written. Points that land
 * on the same millisecond keep the last; the middle of three equal positions
 * goes, since a straight line already says it.
 */
export function roundActions(points: FunscriptAction[]): FunscriptAction[] {
  const out: FunscriptAction[] = []
  for (const p of points) {
    const at = Math.max(0, Math.round(p.at))
    const pos = Math.round(Math.min(1, Math.max(0, p.pos)) * 100)
    const last = out[out.length - 1]
    if (last && last.at === at) {
      last.pos = pos
      continue
    }
    const prev = out[out.length - 2]
    if (last && prev && prev.pos === pos && last.pos === pos)
      last.at = at
    else
      out.push({ at, pos })
  }
  return out
}

// ─── Files ────────────────────────────────────────────────────────────────────

/** Axis file suffixes, as the library and other players name them. */
const SUFFIX: Record<string, string> = {
  L0: '',
  L1: 'surge',
  L2: 'sway',
  R0: 'twist',
  R1: 'roll',
  R2: 'pitch',
  V0: 'vib',
  A0: 'suck',
  A1: 'pump',
}

/** `base.funscript` for the stroke, `base.twist.funscript` and so on for the rest. */
export function fileNameFor(base: string, channel: string): string {
  const suffix = SUFFIX[channel] ?? channel.toLowerCase()
  return suffix ? `${base}.${suffix}.funscript` : `${base}.funscript`
}

export function fileNamesFor(base: string, channels: string[]): string[] {
  return channels.map(ch => fileNameFor(base, ch))
}

/** A base name the user typed: no `.funscript`, nothing a file system rejects. */
export function cleanBase(name: string): string {
  return sanitizeFilename(name.trim().replace(/\.funscript$/i, '')).replace(/[. ]+$/, '').trim()
}

/** `session-2026-11-06-2130`, in local time. */
export function sessionBase(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `session-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

/**
 * The name to suggest. Next to a video: the video's own name when that would
 * not replace anything, so the library pairs it straight away; else
 * `<video>.recorded`, which the library lists as another take. Without a
 * video: `session-YYYY-MM-DD-HHMM`. A number goes on when the name is taken.
 */
export function defaultBase(opts: { video: string | null, channels: string[], existing: Set<string>, now: Date }): string {
  const free = (base: string) => fileNamesFor(base, opts.channels).every(n => !opts.existing.has(n.toLowerCase()))
  const first = opts.video ? opts.video.replace(/\.[^.]+$/, '') : sessionBase(opts.now)
  const tries = opts.video ? [first, `${first}.recorded`] : [first]
  for (const t of tries) {
    if (free(t))
      return t
  }
  const stem = tries[tries.length - 1]
  for (let n = 2; ; n++) {
    if (free(`${stem}-${n}`))
      return `${stem}-${n}`
  }
}

/** A funscript file's text. */
export function funscriptText(actions: FunscriptAction[], meta: { title: string, durationMs: number }): string {
  return `${JSON.stringify({
    version: '1.0',
    inverted: false,
    range: 100,
    metadata: {
      title: meta.title,
      description: 'Recorded in playhound',
      duration: Math.round(meta.durationMs / 1000),
    },
    actions,
  })}\n`
}
