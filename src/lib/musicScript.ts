/**
 * A funscript written from a soundtrack analysis.
 *
 * The idea is FunscriptDancer's: a stroke on the beat, as deep as the music
 * is loud, centred higher when it is brighter. What it lacked, and what a
 * device needs, is a speed limit — and PMVs at 140–180 bpm stroked once per
 * beat run straight into it. So, as the live Music source does, the stroke
 * rate is a musical subdivision of the tempo picked to sit in the user's band
 * under the ceiling, and it changes only on bar lines and only for a section
 * that lasts, so it reads as the music changing gear rather than flicker.
 *
 * The result obeys a hard speed limit: no segment moves faster than a
 * full-depth stroke at the ceiling would. Where it would, the stroke gets
 * shallower; its timing never moves, since timing is what makes it musical.
 *
 * Pure: an analysis in, actions out.
 */

import type { SoundtrackAnalysis } from './beatTrack'
import type { FunscriptAction } from './funscriptParser'
import { beatNumbers, beatsInGaps, normalisePerBeat } from './beatTrack'
import { pickStrokesPerBeat } from './musicMotion'

export interface MusicScriptOptions {
  /** The band the stroke rate should sit in, strokes/min. */
  bandLo: number
  bandHi: number
  /** Speed ceiling, strokes/min of a full-depth stroke. */
  maxSpm: number
  /** Stroke depth for the quietest and loudest passages, 0–1 of the range. */
  minDepth: number
  maxDepth: number
  /** Where strokes centre, 0–1. Default 0.5. */
  centre?: number
  /**
   * How far brightness may move the centre, 0–1 of the range
   * (FunscriptDancer's pitch range / 100). Default 0.5: centres in 25–75.
   */
  centreRange?: number
  /** Hold still at the centre through gaps with no rhythm. Default true. */
  restInGaps?: boolean
}

/** A section must hold a subdivision this many bars before it counts as one. */
const MIN_RUN_BARS = 2
/** Loudness and brightness are smoothed over this many beats each side. */
const SMOOTH_BEATS = 4

/** Fastest allowed travel, position units (0–100) per ms: a full stroke at `maxSpm`. */
export function speedLimit(maxSpm: number): number {
  return (100 * Math.max(1, maxSpm)) / 30000
}

export interface PlannedStroke {
  /** Seconds. The bottom of the stroke. */
  start: number
  /** Seconds. Where the next stroke starts. */
  end: number
  /** Strokes per beat in force. */
  perBeat: number
  /** 0–1 of the range. */
  depth: number
  /** 0–1. */
  centre: number
  /** A gap: hold still instead. */
  rest: boolean
}

interface Bar {
  beats: number[]
  rest: boolean
  perBeat: number
}

/** Collapse runs too short to be a section into the run before them (or after, at the start). */
function holdSections(bars: Bar[]) {
  let i = 0
  while (i < bars.length) {
    if (bars[i].rest) {
      i++
      continue
    }
    let j = i
    while (j < bars.length && !bars[j].rest && bars[j].perBeat === bars[i].perBeat)
      j++
    if (j - i < MIN_RUN_BARS) {
      const prev = i > 0 && !bars[i - 1].rest ? bars[i - 1].perBeat : 0
      const next = j < bars.length && !bars[j].rest ? bars[j].perBeat : 0
      const take = prev || next
      if (take) {
        for (let k = i; k < j; k++)
          bars[k].perBeat = take
      }
    }
    i = j
  }
}

/** Lay out the strokes: when each starts, how deep, where centred. */
export function planStrokes(a: SoundtrackAnalysis, o: MusicScriptOptions): PlannedStroke[] {
  const b = a.beats
  const n = b.length
  if (n < 2)
    return []
  const restInGaps = o.restInGaps ?? true
  const centreBase = o.centre ?? 0.5
  const centreRange = o.centreRange ?? 0.5
  const num = beatNumbers(a)
  const gapBeat = beatsInGaps(a)
  const energy = normalisePerBeat(a.energy, SMOOTH_BEATS, gapBeat)
  const bright = normalisePerBeat(a.centroid, SMOOTH_BEATS, gapBeat)
  const band = { lo: o.bandLo, hi: o.bandHi }

  // Group beats into bars by their beat number.
  const bars: Bar[] = []
  for (let i = 0; i < n; i++) {
    const bar = Math.floor(num[i] / 4)
    const last = bars[bars.length - 1]
    if (last && Math.floor(num[last.beats[0]] / 4) === bar)
      last.beats.push(i)
    else
      bars.push({ beats: [i], rest: false, perBeat: 1 })
  }
  for (let k = 0; k < bars.length; k++) {
    const idx = bars[k].beats
    const first = idx[0]
    const nextFirst = k + 1 < bars.length ? bars[k + 1].beats[0] : idx[idx.length - 1]
    const span = nextFirst > first ? (b[nextFirst] - b[first]) / (num[nextFirst] - num[first]) : (b[n - 1] - b[0]) / (num[n - 1] - num[0])
    const bpm = span > 0 ? 60 / span : a.bpm
    const e = idx.reduce((s, i) => s + energy[i], 0) / idx.length
    bars[k].rest = restInGaps && idx.filter(i => gapBeat[i]).length * 2 > idx.length
    bars[k].perBeat = pickStrokesPerBeat(bpm, band, o.maxSpm, e)
  }
  holdSections(bars)

  // Stroke boundaries: every beat split k ways, or every 1/k beats counted
  // from the bar line. The first beat of a bar always starts a stroke, so a
  // bar entered part-way (a section's pickup) still lines up.
  const starts: { t: number, beat: number, bar: Bar }[] = []
  for (const bar of bars) {
    const k = bar.perBeat
    for (const i of bar.beats) {
      if (k >= 1) {
        if (i + 1 >= n) {
          starts.push({ t: b[i], beat: i, bar })
          continue
        }
        for (let j = 0; j < k; j++)
          starts.push({ t: b[i] + ((b[i + 1] - b[i]) * j) / k, beat: i, bar })
      }
      else if (i === bar.beats[0] || num[i] % Math.round(1 / k) === 0) {
        starts.push({ t: b[i], beat: i, bar })
      }
    }
  }

  const strokes: PlannedStroke[] = []
  for (let s = 0; s + 1 < starts.length; s++) {
    const { t, beat, bar } = starts[s]
    const depth = Math.max(0, Math.min(1, o.minDepth + (o.maxDepth - o.minDepth) * energy[beat]))
    const raw = centreBase + (bright[beat] - 0.5) * centreRange
    const centre = Math.max(depth / 2, Math.min(1 - depth / 2, raw))
    strokes.push({ start: t, end: starts[s + 1].t, perBeat: bar.perBeat, depth, centre, rest: bar.rest })
  }
  return strokes
}

/**
 * Funscript actions (pos 0–100, at in ms) for an analysis.
 *
 * Bottom on the stroke's start (the beat), top halfway to the next, rest at
 * the centre in gaps, then the hard speed limit.
 */
export function musicScript(a: SoundtrackAnalysis, o: MusicScriptOptions): FunscriptAction[] {
  const strokes = planStrokes(a, o)
  if (!strokes.length)
    return []
  const rest = (o.centre ?? 0.5) * 100

  // Positions carry their stroke's centre so the limiter can shrink them
  // toward it rather than shift the whole stroke.
  const pts: { t: number, pos: number, c: number }[] = []
  const push = (tS: number, pos: number, c: number) => {
    const t = Math.round(tS * 1000)
    const last = pts[pts.length - 1]
    if (last && t <= last.t)
      return
    pts.push({ t, pos, c })
  }

  if (strokes[0].start > 0.5)
    push(0, rest, rest)
  for (const s of strokes) {
    if (s.rest) {
      // A plateau needs only its ends.
      const last = pts[pts.length - 1]
      const prev = pts[pts.length - 2]
      if (last && prev && last.pos === rest && prev.pos === rest)
        pts.pop()
      push(s.start, rest, rest)
      continue
    }
    const c = s.centre * 100
    const half = (s.depth * 100) / 2
    push(s.start, c - half, c)
    push((s.start + s.end) / 2, c + half, c)
  }
  push(strokes[strokes.length - 1].end, rest, rest)

  return limitSpeed(pts, speedLimit(o.maxSpm))
}

/**
 * Enforce the speed limit by shrinking strokes toward their centres, then
 * guarantee it outright while rounding to whole positions.
 */
export function limitSpeed(pts: { t: number, pos: number, c: number }[], vmax: number): FunscriptAction[] {
  if (!pts.length)
    return []
  const off = pts.map(p => p.pos - p.c)

  // Each pass works out, per segment, how much its two ends must shrink, and
  // shrinks every point by the most either of its segments asks for — all at
  // once, so a point between two fast segments is not shrunk twice over.
  const scale = new Float64Array(pts.length)
  for (let pass = 0; pass < 12; pass++) {
    scale.fill(1)
    let changed = false
    for (let i = 0; i + 1 < pts.length; i++) {
      const L = vmax * (pts[i + 1].t - pts[i].t)
      const dc = pts[i + 1].c - pts[i].c
      const dOff = off[i + 1] - off[i]
      if (Math.abs(dc + dOff) <= L + 1e-9)
        continue
      // Largest s in [0, 1] with |dc + s·dOff| ≤ L.
      let k = 0
      if (Math.abs(dc) < L && dOff !== 0)
        k = dOff > 0 ? (L - dc) / dOff : (L + dc) / -dOff
      k = Math.max(0, Math.min(1, k))
      scale[i] = Math.min(scale[i], k)
      scale[i + 1] = Math.min(scale[i + 1], k)
      changed = true
    }
    if (!changed)
      break
    for (let i = 0; i < pts.length; i++)
      off[i] *= scale[i]
  }

  // Whatever is left (centres that themselves move too fast) is clamped
  // step by step, in whole units so rounding cannot break the limit either.
  const out: FunscriptAction[] = []
  for (let i = 0; i < pts.length; i++) {
    let p = Math.round(Math.max(0, Math.min(100, pts[i].c + off[i])))
    if (i > 0) {
      const prev = out[i - 1]
      const lim = Math.floor(vmax * (pts[i].t - prev.at) + 1e-9)
      p = Math.max(prev.pos - lim, Math.min(prev.pos + lim, p))
    }
    out.push({ at: pts[i].t, pos: p })
  }
  return out
}

/** The funscript file itself, labelled as generated. */
export function musicFunscript(actions: FunscriptAction[], info: { title: string, bpm: number, duration: number }) {
  return {
    version: '1.0',
    inverted: false,
    range: 100,
    metadata: {
      title: info.title,
      creator: 'playhound',
      description: `Generated from the soundtrack (${Math.round(info.bpm)} bpm), not scripted by hand.`,
      tags: ['generated', 'music'],
      type: 'basic',
      duration: Math.round(info.duration),
    },
    actions,
  }
}
