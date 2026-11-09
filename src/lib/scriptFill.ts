/**
 * Filling a stretch of a script with motion: the editor's Fill and Insert
 * pattern. Pure maths over the editor's points (times in whole ms,
 * positions 0–1).
 *
 * One cycle of motion is either one of the generator's own stroke shapes
 * (motionMath, so a filled section moves the way generated motion does) or a
 * pattern's points. A phase map says how many cycles have gone by at each
 * moment of the span: a steady rate, a ramp from one rate to another, or the
 * soundtrack's beats. Points are laid where the cycle turns, with a few
 * between on the curved parts.
 */

import type { StrokeShape } from './motionMath'
import type { Pt } from './scriptEdit'
import { SAW_TOP, strokePosition } from './motionMath'
import { lowerBound, MIN_GAP_MS, positionAt, segmentSpeed } from './scriptEdit'

export const STROKE_SHAPES: readonly StrokeShape[] = ['sine', 'ease', 'pulse', 'saw', 'sharp']

/** A point of a pattern: t 0–1 across one repeat, pos 0–100 across its range. */
export interface PatternPoint {
  t: number
  pos: number
}

/** What one cycle looks like. */
export type CycleSource
  = | { kind: 'shape', shape: StrokeShape }
    | { kind: 'pattern', points: readonly PatternPoint[] }

/** How fast the cycles go. */
export type RateSpec
  /** Strokes per minute; with `to`, ramping from `spm` to `to` across the span. */
  = | { kind: 'spm', spm: number, to?: number }
  /** This many cycles across the span. */
    | { kind: 'count', count: number }
  /** On the soundtrack's beats (script ms): `perBeat` cycles per beat, the cycle starting on the beat. */
    | { kind: 'beats', beats: readonly number[], perBeat: number }

/** Curved parts of a cycle get a point at least this often. */
const SAMPLE_MS = 70
/** And never more than this many per curved part. */
const MAX_SUB = 8
/** A fill never makes more points than this. */
export const MAX_FILL_POINTS = 50_000
export const MIN_SPM = 1
export const MAX_SPM = 600

const TAU = Math.PI * 2
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const mod1 = (v: number) => ((v % 1) + 1) % 1
const snap = (p: number) => clamp(Math.round(p * 100) / 100, 0, 1)

// ─── One cycle ────────────────────────────────────────────────────────────────

/** Where a shape's stroke is at the top, as a share of the cycle. */
export function topPhase(shape: StrokeShape): number {
  return shape === 'saw' ? SAW_TOP : shape === 'pulse' ? 1 / 3 : 0.5
}

/** Which halves of a shape's cycle (rise, fall) are curves rather than straight lines. */
function curved(shape: StrokeShape): [boolean, boolean] {
  if (shape === 'sharp')
    return [false, false]
  if (shape === 'saw')
    return [false, true]
  return [true, true]
}

/** A pattern's position (0–1) at `t` (0–1), straight lines between its points. */
export function patternAt(points: readonly PatternPoint[], t: number): number {
  const n = points.length
  if (!n)
    return 0.5
  if (t <= points[0].t)
    return points[0].pos / 100
  if (t >= points[n - 1].t)
    return points[n - 1].pos / 100
  let i = 1
  while (i < n && points[i].t < t)
    i++
  const a = points[i - 1]
  const b = points[i]
  const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1
  return (a.pos + (b.pos - a.pos) * f) / 100
}

/** A cycle's position (0–1) at phase `f` (0–1). */
export function cycleAt(source: CycleSource, f: number): number {
  return source.kind === 'shape' ? strokePosition(f * TAU, source.shape) : patternAt(source.points, f)
}

/**
 * Where in one cycle (0–1) points go, for a cycle lasting `cycleMs`: a
 * shape's turns plus enough between them on its curves to follow them, or
 * a pattern's own points. Shapes give [0, 1) (the next cycle's 0 is this
 * one's end); patterns give their points, 0 and 1 included.
 */
export function cycleFractions(source: CycleSource, cycleMs: number): number[] {
  if (source.kind === 'pattern')
    return source.points.map(p => p.t)
  const top = topPhase(source.shape)
  const [rise, fall] = curved(source.shape)
  const out: number[] = []
  const part = (a: number, b: number, curve: boolean) => {
    const n = curve ? clamp(Math.round(((b - a) * cycleMs) / SAMPLE_MS), 1, MAX_SUB) : 1
    for (let i = 0; i < n; i++)
      out.push(a + ((b - a) * i) / n)
  }
  part(0, top, rise)
  part(top, 1, fall)
  return out
}

/**
 * Where a cycle should start or end to meet a point at `pos` within the
 * range lo–hi: at the bottom when the point is in the lower half, at the
 * top when it is in the upper half. Patterns always start at their start.
 */
export function meetPhase(source: CycleSource, pos: number, lo: number, hi: number): number {
  if (source.kind === 'pattern')
    return 0
  const flip = hi < lo
  const upper = pos > (lo + hi) / 2
  return upper !== flip ? topPhase(source.shape) : 0
}

// ─── Phase maps ──────────────────────────────────────────────────────────────

/** How many cycles have gone by at each moment of a span (`dt` ms from its start). */
export interface PhaseMap {
  span: number
  /** Cycles across the whole span. */
  total: number
  cyclesAt: (dt: number) => number
  /** The inverse: when `c` cycles have gone by. */
  timeAt: (c: number) => number
  /** Cycles per ms at `dt`. */
  rateAt: (dt: number) => number
  /** Where the first cycle starts (0–1); set when something outside the fill decides it, as beats do. */
  phase0?: number
}

/** A rate going steadily from `r0` to `r1` cycles per ms across `span` ms (equal for a steady rate). */
export function rampMap(span: number, r0: number, r1: number): PhaseMap {
  const a = (r1 - r0) / (2 * span)
  return {
    span,
    total: ((r0 + r1) / 2) * span,
    cyclesAt: x => r0 * x + a * x * x,
    timeAt: (c) => {
      if (c <= 0)
        return 0
      if (Math.abs(a) < 1e-15)
        return r0 > 0 ? c / r0 : span
      // The root of a·x² + r0·x − c in a form that does not cancel when a is small.
      const d = r0 * r0 + 4 * a * c
      return d <= 0 ? span : (2 * c) / (r0 + Math.sqrt(d))
    },
    rateAt: x => r0 + 2 * a * x,
  }
}

/** Straight lines through knots: times `xs` (from 0 to the span) and the cycles gone by at each. */
export function knotMap(xs: readonly number[], cs: readonly number[]): PhaseMap {
  const n = xs.length
  const seg = (arr: readonly number[], v: number) => {
    let i = 1
    while (i < n - 1 && arr[i] < v)
      i++
    return i
  }
  return {
    span: xs[n - 1],
    total: cs[n - 1],
    cyclesAt: (x) => {
      const i = seg(xs, x)
      const f = xs[i] > xs[i - 1] ? (x - xs[i - 1]) / (xs[i] - xs[i - 1]) : 0
      return cs[i - 1] + (cs[i] - cs[i - 1]) * f
    },
    timeAt: (c) => {
      const i = seg(cs, c)
      const f = cs[i] > cs[i - 1] ? (c - cs[i - 1]) / (cs[i] - cs[i - 1]) : 0
      return xs[i - 1] + (xs[i] - xs[i - 1]) * f
    },
    rateAt: (x) => {
      const i = seg(xs, x)
      return xs[i] > xs[i - 1] ? (cs[i] - cs[i - 1]) / (xs[i] - xs[i - 1]) : 0
    },
  }
}

/**
 * Cycles on the beats from `from` to `to` (script ms): every beat starts
 * `perBeat` cycles' worth, so with one per beat each stroke starts on a beat.
 * Before the first beat and after the last, the nearest beat spacing carries
 * on. Null when no beat falls inside the span.
 */
export function beatMap(from: number, to: number, beats: readonly number[], perBeat: number): PhaseMap | null {
  const n = beats.length
  let i0 = 0
  while (i0 < n && beats[i0] <= from)
    i0++
  let i1 = i0
  while (i1 + 1 < n && beats[i1 + 1] < to)
    i1++
  if (i0 >= n || beats[i0] >= to || n < 2 || !(perBeat > 0))
    return null
  const period = (i: number) => (i + 1 < n ? beats[i + 1] - beats[i] : beats[i] - beats[i - 1])
  const startPeriod = period(i0)
  const endPeriod = i1 > i0 ? beats[i1] - beats[i1 - 1] : period(i1)
  const raw0 = -((beats[i0] - from) / startPeriod) * perBeat
  const xs = [0]
  const cs = [0]
  for (let i = i0; i <= i1; i++) {
    xs.push(beats[i] - from)
    cs.push((i - i0) * perBeat - raw0)
  }
  xs.push(to - from)
  cs.push((i1 - i0) * perBeat + ((to - beats[i1]) / endPeriod) * perBeat - raw0)
  return { ...knotMap(xs, cs), phase0: mod1(raw0) }
}

/**
 * Whole strokes: the count nearest `requested` that ends `delta` (0–1) of a
 * cycle past a whole number, so the motion finishes where the end point is.
 * Never less than `delta`, nor zero.
 */
export function fitCycles(requested: number, delta: number): number {
  let k = Math.max(0, Math.round(requested - delta))
  if (k + delta <= 0)
    k = 1
  return k + delta
}

// ─── Making the points ───────────────────────────────────────────────────────

export interface FillSpec {
  /** The span, with the positions on either end (for meeting them). */
  from: Pt
  to: Pt
  source: CycleSource
  /** The range the motion uses, 0–1. Low above high turns it upside down. */
  lo: number
  hi: number
  rate: RateSpec
  /** Whole strokes, ending where the end point is (the rate is nudged). Default true. Beats are never nudged. */
  fit?: boolean
  /** Points on the span's ends too (a fill with no fixed ends). Default false: strictly between. */
  ends?: boolean
}

export interface FillResult {
  points: Pt[]
  /** Cycles across the span. */
  cycles: number
  /** The rate it ended up at, strokes/min: on average, at the start and at the end. */
  spm: number
  spmFrom: number
  spmTo: number
  /** Nothing could be made: the span is too short, or no beat falls in it. */
  error?: 'span' | 'beats'
}

function empty(error?: FillResult['error']): FillResult {
  return { points: [], cycles: 0, spm: 0, spmFrom: 0, spmTo: 0, error }
}

/** The points of a fill, in time order, one per ms. */
export function generateFill(spec: FillSpec): FillResult {
  const { from, to, source } = spec
  const span = to.at - from.at
  const ends = spec.ends ?? false
  if (!(span >= 2 * MIN_GAP_MS) || (source.kind === 'pattern' && source.points.length < 2))
    return empty('span')
  const fit = spec.fit ?? true
  const lo = clamp(spec.lo, 0, 1)
  const hi = clamp(spec.hi, 0, 1)

  let phase0 = meetPhase(source, from.pos, lo, hi)
  const delta = mod1(meetPhase(source, to.pos, lo, hi) - phase0)
  const r = spec.rate
  let map: PhaseMap
  if (r.kind === 'beats') {
    const m = beatMap(from.at, to.at, r.beats, r.perBeat)
    if (!m)
      return empty('beats')
    map = m
    phase0 = m.phase0 ?? 0
  }
  else if (r.kind === 'count') {
    const want = Math.max(0, r.count)
    const total = fit ? fitCycles(want, delta) : want
    map = rampMap(span, total / span, total / span)
  }
  else {
    const r0 = clamp(r.spm, MIN_SPM, MAX_SPM) / 60000
    const r1 = clamp(r.to ?? r.spm, MIN_SPM, MAX_SPM) / 60000
    const want = ((r0 + r1) / 2) * span
    const total = fit ? fitCycles(want, delta) : want
    const k = total / want
    map = rampMap(span, r0 * k, r1 * k)
  }
  const total = map.total
  if (!(total > 0))
    return empty('span')

  const out: Pt[] = []
  const push = (at: number, pos: number) => {
    const last = out[out.length - 1]
    if (last && last.at === at)
      out[out.length - 1] = { at, pos }
    else if (!last || at > last.at)
      out.push({ at, pos })
  }
  const end = phase0 + total
  const eps = 1e-9
  for (let k = Math.floor(phase0); k <= Math.ceil(end) && out.length < MAX_FILL_POINTS; k++) {
    const start = Math.max(0, map.timeAt(k - phase0))
    const rate = map.rateAt(Math.min(span, start))
    const fractions = cycleFractions(source, rate > 0 ? 1 / rate : span)
    for (const f of fractions) {
      const g = k + f
      if (g < phase0 - eps || g > end + eps)
        continue
      // A pattern's next repeat starts where the last one ends; at the very
      // end there is no next repeat, so the last one's own end stands.
      if (source.kind === 'pattern' && f === 0 && g > end - eps && g > phase0 + eps)
        continue
      const dt = map.timeAt(g - phase0)
      let at = Math.round(from.at + dt)
      if (ends) {
        at = clamp(at, from.at, to.at)
      }
      else if (at <= from.at || at >= to.at) {
        continue
      }
      push(at, snap(lo + (hi - lo) * cycleAt(source, f)))
    }
  }
  const minutes = span / 60000
  return {
    points: out,
    cycles: total,
    spm: total / minutes,
    spmFrom: map.rateAt(0) * 60000,
    spmTo: map.rateAt(span) * 60000,
  }
}

// ─── Into the script ─────────────────────────────────────────────────────────

/** Index of the first point after `t` (points.length when none). */
function upperBound(points: readonly Pt[], t: number): number {
  let lo = 0
  let hi = points.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (points[mid].at <= t)
      lo = mid + 1
    else
      hi = mid
  }
  return lo
}

/**
 * The script with what lies in t0–t1 replaced by `inserted`: points strictly
 * between, or with `inclusive` the ones on t0 and t1 as well. Returns the
 * new points and where the inserted ones start.
 */
export function replaceSpan(points: readonly Pt[], t0: number, t1: number, inserted: readonly Pt[], inclusive: boolean): { points: Pt[], start: number } {
  const a = inclusive ? lowerBound(points, t0) : upperBound(points, t0)
  const b = inclusive ? upperBound(points, t1) : lowerBound(points, t1)
  const out = points.slice(0, a).concat(inserted, points.slice(Math.max(a, b)))
  return { points: out, start: a }
}

/** Fastest segment among points [from, to], units/s. */
export function peakSpeed(points: readonly Pt[], from = 0, to = points.length - 1): number {
  let peak = 0
  for (let i = Math.max(0, from); i < Math.min(points.length - 1, to); i++)
    peak = Math.max(peak, segmentSpeed(points[i], points[i + 1]))
  return peak
}

/** Segments faster than `limit` units/s among points [from, to]. */
export function countFast(points: readonly Pt[], limit: number, from = 0, to = points.length - 1): number {
  let n = 0
  for (let i = Math.max(0, from); i < Math.min(points.length - 1, to); i++) {
    if (segmentSpeed(points[i], points[i + 1]) > limit)
      n++
  }
  return n
}

/** What a fill goes into. */
export type FillTarget
  /** Between two points (the ends of a selection), which stay. */
  = | { kind: 'between', i0: number, i1: number }
  /** A stretch of time with no points chosen; its ends take the script's position there, or the fill's own. */
    | { kind: 'range', t0: number, t1: number }
  /** Starting at a moment (the playhead), running as long as it needs. */
    | { kind: 'at', t: number }

/**
 * Two or more selected points: between the first and the last. Otherwise a
 * marked stretch of time, when there is one. Otherwise the playhead.
 */
export function pickTarget(
  points: readonly Pt[],
  sel: readonly number[],
  range: { t0: number, t1: number } | null,
  playhead: number,
): FillTarget {
  if (sel.length >= 2) {
    const i0 = sel[0]
    const i1 = sel[sel.length - 1]
    if (points[i0] && points[i1] && points[i1].at - points[i0].at >= 2 * MIN_GAP_MS)
      return { kind: 'between', i0, i1 }
  }
  if (range && range.t1 - range.t0 >= 2 * MIN_GAP_MS)
    return { kind: 'range', t0: Math.max(0, Math.round(range.t0)), t1: Math.round(range.t1) }
  return { kind: 'at', t: Math.max(0, Math.round(playhead)) }
}

export interface FillPlanOptions {
  source: CycleSource
  lo: number
  hi: number
  rate: RateSpec
  fit?: boolean
  /** A range's ends: at the script's position there, or wherever the fill's own motion is. Default 'script'. */
  edges?: 'script' | 'fill'
  /** How long an insert at a moment runs, ms. */
  length?: number
}

export interface FillPlan {
  /** The whole script after the fill. */
  points: Pt[]
  /** The fill and its ends, selected after it is applied (so filling again refills the same stretch). */
  selection: number[]
  /** The stretch it covers, script ms. */
  from: number
  to: number
  /** What is drawn as the preview: the new points from end to end. */
  inserted: Pt[]
  result: FillResult
  /** Fastest segment in it, joins to the neighbours included, units/s. */
  peak: number
  /** Its segments faster than a limit, counted by the caller with countFast over [first, last]. */
  first: number
  last: number
}

/** A fill of `target`, ready to preview or apply. Null when there is nothing to fill. */
export function planFill(points: readonly Pt[], target: FillTarget, o: FillPlanOptions): FillPlan | null {
  const base = { source: o.source, lo: o.lo, hi: o.hi, rate: o.rate, fit: o.fit }
  let result: FillResult
  let inserted: Pt[]
  let from: number
  let to: number
  let inclusive: boolean
  let bounds: [boolean, boolean] = [false, false]

  if (target.kind === 'between') {
    const a = points[target.i0]
    const b = points[target.i1]
    if (!a || !b)
      return null
    result = generateFill({ ...base, from: a, to: b })
    inserted = [a, ...result.points, b]
    from = a.at
    to = b.at
    inclusive = false
  }
  else {
    from = target.kind === 'range' ? target.t0 : target.t
    to = target.kind === 'range' ? target.t1 : target.t + Math.round(o.length ?? 0)
    const a = { at: from, pos: snap(positionAt(points, from)) }
    const b = { at: to, pos: target.kind === 'range' ? snap(positionAt(points, to)) : a.pos }
    const own = target.kind === 'at' || o.edges === 'fill'
    result = generateFill({ ...base, from: a, to: b, ends: own, fit: target.kind === 'at' ? false : o.fit })
    inserted = own ? result.points : [a, ...result.points, b]
    bounds = own ? [false, false] : [true, true]
    inclusive = true
  }
  // Nothing to make: the script stays as it is, and the result says why.
  if (result.error || !inserted.length)
    return { points: points.slice(), selection: [], from, to, inserted: [], result, peak: 0, first: 0, last: 0 }

  const r = replaceSpan(points, from, to, target.kind === 'between' ? result.points : inserted, inclusive)
  const start = target.kind === 'between' ? r.start - 1 : r.start
  const count = target.kind === 'between' ? result.points.length + 2 : inserted.length
  const selection = Array.from({ length: count }, (_, i) => start + i)
  // The joins to the points either side count too: that is where a fill
  // dropped into a busy script tends to be fast.
  const first = Math.max(0, start - (bounds[0] || target.kind === 'between' ? 0 : 1))
  const last = Math.min(r.points.length - 1, start + count - 1 + (bounds[1] || target.kind === 'between' ? 0 : 1))
  return {
    points: r.points,
    selection,
    from,
    to,
    inserted,
    result,
    peak: peakSpeed(r.points, first, last),
    first,
    last,
  }
}
