/**
 * Patterns for the script editor: a stretch of motion kept to be dropped in
 * again, stretched or repeated. Stored normalised, time 0–1 across one
 * repeat and position 0–100 across its own range, with that range and its
 * length kept so it can go back in as it was.
 *
 * Pure: the editor's pattern store keeps them in localStorage (and so in a
 * backup) and these make, check and draw them.
 */

import type { StrokeShape } from './motionMath'
import type { Pt } from './scriptEdit'
import type { CycleSource, PatternPoint } from './scriptFill'
import { cycleAt } from './scriptFill'

export interface Pattern {
  id: string
  name: string
  /** t ascending from 0 to 1, pos 0–100. */
  points: PatternPoint[]
  /** How long the original lasted, ms: the pattern's own speed. */
  durationMs: number
  /** Where the original sat, 0–100. */
  lo: number
  hi: number
  /** One that comes with the app: it cannot be renamed or deleted. */
  builtin?: boolean
}

export const MAX_PATTERN_POINTS = 2000
export const MAX_NAME = 60

const round = (v: number, places: number) => Math.round(v * 10 ** places) / 10 ** places

/**
 * A pattern from a run of points (positions 0–1, times ms). Needs at least
 * two points at different times. A flat run (no movement) sits at 50.
 */
export function normalisePattern(points: readonly Pt[], name: string, id: string): Pattern | null {
  const pts = [...points].filter(p => Number.isFinite(p.at) && Number.isFinite(p.pos)).sort((a, b) => a.at - b.at)
  if (pts.length < 2 || pts.length > MAX_PATTERN_POINTS)
    return null
  const t0 = pts[0].at
  const dur = pts[pts.length - 1].at - t0
  if (!(dur > 0))
    return null
  let lo = Infinity
  let hi = -Infinity
  for (const p of pts) {
    lo = Math.min(lo, p.pos)
    hi = Math.max(hi, p.pos)
  }
  const spread = hi - lo
  const out: PatternPoint[] = []
  for (const p of pts) {
    const t = round((p.at - t0) / dur, 5)
    const pos = spread > 0 ? round(((p.pos - lo) / spread) * 100, 1) : 50
    // One point per moment, the last wins (as when played).
    if (out.length && out[out.length - 1].t === t)
      out[out.length - 1] = { t, pos }
    else
      out.push({ t, pos })
  }
  return {
    id,
    name: cleanName(name) || 'Pattern',
    points: out,
    durationMs: Math.round(dur),
    lo: Math.round(lo * 100),
    hi: Math.round(hi * 100),
  }
}

export function cleanName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME)
}

/** A pattern back as script points: starting at `at`, over `durationMs`, across lo–hi (0–1). */
export function patternPoints(p: Pick<Pattern, 'points'>, at: number, durationMs: number, lo: number, hi: number): Pt[] {
  return p.points.map(q => ({ at: Math.round(at + q.t * durationMs), pos: lo + ((hi - lo) * q.pos) / 100 }))
}

/** Stored patterns, checked: anything malformed is left out rather than breaking the editor. */
export function parsePatterns(raw: unknown): Pattern[] {
  if (!Array.isArray(raw))
    return []
  const out: Pattern[] = []
  const seen = new Set<string>()
  for (const r of raw) {
    if (!r || typeof r !== 'object')
      continue
    const o = r as Record<string, unknown>
    if (typeof o.id !== 'string' || !o.id || seen.has(o.id) || !Array.isArray(o.points))
      continue
    const points: PatternPoint[] = []
    for (const q of o.points as unknown[]) {
      const t = Number((q as PatternPoint)?.t)
      const pos = Number((q as PatternPoint)?.pos)
      if (!Number.isFinite(t) || !Number.isFinite(pos) || t < 0 || t > 1)
        continue
      if (points.length && t < points[points.length - 1].t)
        continue
      points.push({ t, pos: Math.max(0, Math.min(100, pos)) })
    }
    if (points.length < 2 || points.length > MAX_PATTERN_POINTS)
      continue
    const num = (v: unknown, fallback: number) => (Number.isFinite(Number(v)) ? Number(v) : fallback)
    seen.add(o.id)
    out.push({
      id: o.id,
      name: cleanName(String(o.name ?? '')) || 'Pattern',
      points,
      durationMs: Math.max(1, Math.round(num(o.durationMs, 1000))),
      lo: Math.max(0, Math.min(100, num(o.lo, 0))),
      hi: Math.max(0, Math.min(100, num(o.hi, 100))),
    })
  }
  return out
}

/** A name not yet used: "Tease", "Tease 2", … */
export function uniqueName(name: string, taken: Iterable<string>): string {
  const base = cleanName(name) || 'Pattern'
  const used = new Set([...taken].map(n => n.toLowerCase()))
  if (!used.has(base.toLowerCase()))
    return base
  for (let i = 2; ; i++) {
    const n = `${base} ${i}`
    if (!used.has(n.toLowerCase()))
      return n
  }
}

const pts = (list: [number, number][]): PatternPoint[] => list.map(([t, pos]) => ({ t, pos }))

/** A few classics to start from. */
export const BUILTIN_PATTERNS: readonly Pattern[] = [
  {
    id: 'builtin:tease',
    name: 'Tease',
    builtin: true,
    // Three shallow dips at the top, then one long full stroke.
    points: pts([[0, 100], [0.11, 72], [0.22, 100], [0.33, 72], [0.44, 100], [0.72, 0], [1, 100]]),
    durationMs: 3200,
    lo: 10,
    hi: 90,
  },
  {
    id: 'builtin:staircase',
    name: 'Staircase',
    builtin: true,
    // Up in four steps with a short hold on each, then all the way down.
    points: pts([[0, 0], [0.1, 25], [0.2, 25], [0.3, 50], [0.4, 50], [0.5, 75], [0.6, 75], [0.7, 100], [0.78, 100], [1, 0]]),
    durationMs: 4000,
    lo: 5,
    hi: 95,
  },
  {
    id: 'builtin:flutter',
    name: 'Flutter',
    builtin: true,
    // Quick short strokes in the middle of the range.
    points: pts([[0, 0], [0.125, 100], [0.25, 0], [0.375, 100], [0.5, 0], [0.625, 100], [0.75, 0], [0.875, 100], [1, 0]]),
    durationMs: 1200,
    lo: 40,
    hi: 70,
  },
  {
    id: 'builtin:long-short',
    name: 'Long-short',
    builtin: true,
    // One slow full stroke, then two quick ones.
    points: pts([[0, 0], [0.3, 100], [0.6, 0], [0.7, 100], [0.8, 0], [0.9, 100], [1, 0]]),
    durationMs: 3000,
    lo: 5,
    hi: 95,
  },
  {
    id: 'builtin:edge-build',
    name: 'Edge build',
    builtin: true,
    // Strokes growing deeper and quicker, then a hold at the bottom.
    points: pts([
      [0, 40],
      [0.12, 60],
      [0.23, 30],
      [0.33, 72],
      [0.42, 20],
      [0.5, 84],
      [0.57, 10],
      [0.63, 94],
      [0.68, 2],
      [0.73, 100],
      [0.78, 0],
      [0.83, 100],
      [0.88, 0],
      [1, 0],
    ]),
    durationMs: 6000,
    lo: 5,
    hi: 95,
  },
]

export const SHAPE_LABELS: Record<StrokeShape, string> = {
  sine: 'Sine',
  ease: 'Ease',
  pulse: 'Pulse',
  saw: 'Saw',
  sharp: 'Sharp',
}

/**
 * An SVG path of a cycle source for a thumbnail `w` × `h` px: two cycles of
 * a shape, one repeat of a pattern. Position 1 is at the top.
 */
export function thumbPath(source: CycleSource, w: number, h: number, pad = 2): string {
  const xy = (t: number, p: number) => `${round(pad + t * (w - 2 * pad), 2)} ${round(pad + (1 - p) * (h - 2 * pad), 2)}`
  if (source.kind === 'pattern')
    return source.points.map((q, i) => `${i ? 'L' : 'M'}${xy(q.t, q.pos / 100)}`).join(' ')
  const n = 48
  const parts: string[] = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    parts.push(`${i ? 'L' : 'M'}${xy(t, cycleAt(source, (t * 2) % 1))}`)
  }
  return parts.join(' ')
}
