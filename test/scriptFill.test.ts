import type { Pt } from '../src/lib/scriptEdit'
import { describe, expect, it } from 'vitest'
import { strokePosition } from '../src/lib/motionMath'
import { segmentSpeed } from '../src/lib/scriptEdit'
import {
  beatMap,
  countFast,
  cycleFractions,
  fitCycles,
  generateFill,
  knotMap,
  meetPhase,
  patternAt,
  peakSpeed,
  pickTarget,
  planFill,
  rampMap,
  replaceSpan,
  STROKE_SHAPES,
  topPhase,
} from '../src/lib/scriptFill'

const sine = { kind: 'shape', shape: 'sine' } as const
const sharp = { kind: 'shape', shape: 'sharp' } as const

/** Turning points: where the direction changes. */
function turns(pts: Pt[]): Pt[] {
  const out: Pt[] = []
  for (let i = 1; i + 1 < pts.length; i++) {
    const a = pts[i].pos - pts[i - 1].pos
    const b = pts[i + 1].pos - pts[i].pos
    if (a * b < 0)
      out.push(pts[i])
  }
  return out
}

function ordered(pts: Pt[]) {
  for (let i = 1; i < pts.length; i++)
    expect(pts[i].at).toBeGreaterThan(pts[i - 1].at)
}

describe('fitCycles', () => {
  it('rounds to whole cycles plus the offset that meets the end point', () => {
    expect(fitCycles(7.3, 0)).toBe(7)
    expect(fitCycles(7.7, 0)).toBe(8)
    expect(fitCycles(7.3, 0.5)).toBe(7.5)
    expect(fitCycles(6.9, 0.5)).toBe(6.5)
  })
  it('never gives nothing', () => {
    expect(fitCycles(0.1, 0)).toBe(1)
    expect(fitCycles(0, 0)).toBe(1)
    expect(fitCycles(0.1, 0.5)).toBe(0.5)
  })
})

describe('phase maps', () => {
  it('a steady rate is linear and inverts', () => {
    const m = rampMap(10_000, 0.002, 0.002)
    expect(m.total).toBeCloseTo(20)
    expect(m.cyclesAt(5000)).toBeCloseTo(10)
    expect(m.timeAt(10)).toBeCloseTo(5000)
    expect(m.rateAt(1234)).toBeCloseTo(0.002)
  })

  it('a ramp speeds up across the span and still inverts', () => {
    const m = rampMap(60_000, 60 / 60000, 120 / 60000)
    expect(m.total).toBeCloseTo(90)
    expect(m.rateAt(0) * 60000).toBeCloseTo(60)
    expect(m.rateAt(60_000) * 60000).toBeCloseTo(120)
    for (const c of [0, 1, 17.5, 45, 89.9])
      expect(m.cyclesAt(m.timeAt(c))).toBeCloseTo(c, 6)
    // Slower first: the first half of the time holds fewer than half the cycles.
    expect(m.cyclesAt(30_000)).toBeLessThan(45)
  })

  it('a ramp down inverts too, and from a standstill', () => {
    const down = rampMap(10_000, 0.003, 0.001)
    for (const c of [0.5, 5, 19.9])
      expect(down.cyclesAt(down.timeAt(c))).toBeCloseTo(c, 6)
    const up = rampMap(10_000, 0, 0.002)
    expect(up.timeAt(10)).toBeCloseTo(10_000)
  })

  it('knots interpolate both ways', () => {
    const m = knotMap([0, 100, 300], [0, 1, 2])
    expect(m.cyclesAt(50)).toBeCloseTo(0.5)
    expect(m.cyclesAt(200)).toBeCloseTo(1.5)
    expect(m.timeAt(1.5)).toBeCloseTo(200)
    expect(m.rateAt(250)).toBeCloseTo(1 / 200)
  })

  it('beats: every beat starts a cycle, the spacing carries on past the ends', () => {
    const beats = [0, 500, 1000, 1500, 2000, 2500]
    const m = beatMap(250, 2250, beats, 1)!
    expect(m).not.toBeNull()
    expect(m.span).toBe(2000)
    // 250 ms before the first beat inside is half a beat.
    expect(m.cyclesAt(250)).toBeCloseTo(0.5)
    expect(m.phase0).toBeCloseTo(0.5)
    expect(m.total).toBeCloseTo(4)
    // Each beat lands on a whole cycle of the global phase.
    for (const b of [500, 1000, 1500, 2000])
      expect(((m.phase0! + m.cyclesAt(b - 250)) % 1 + 1) % 1).toBeCloseTo(0)
  })

  it('beats: half a stroke per beat, and no beat inside', () => {
    const beats = [0, 400, 800, 1200]
    expect(beatMap(400, 1200, beats, 0.5)!.total).toBeCloseTo(1)
    expect(beatMap(410, 790, beats, 1)).toBeNull()
  })
})

describe('one cycle', () => {
  it('turns at the bottom and the top of every shape', () => {
    for (const shape of STROKE_SHAPES) {
      const src = { kind: 'shape', shape } as const
      const f = cycleFractions(src, 1000)
      expect(f[0]).toBe(0)
      expect(f).toContain(topPhase(shape))
      expect(Math.max(...f)).toBeLessThan(1)
      expect(strokePosition(topPhase(shape) * Math.PI * 2, shape)).toBeGreaterThan(0.99)
    }
  })

  it('straight shapes need only their turns; curves get more when slow', () => {
    expect(cycleFractions(sharp, 5000)).toEqual([0, 0.5])
    expect(cycleFractions(sine, 200)).toEqual([0, 0.5])
    expect(cycleFractions(sine, 1000).length).toBeGreaterThan(cycleFractions(sine, 400).length)
    expect(cycleFractions(sine, 60_000).length).toBeLessThanOrEqual(16)
  })

  it('meets an end point at the bottom or the top', () => {
    expect(meetPhase(sine, 0.1, 0, 1)).toBe(0)
    expect(meetPhase(sine, 0.9, 0, 1)).toBe(0.5)
    // Upside down: high positions are where the cycle starts.
    expect(meetPhase(sine, 0.9, 1, 0)).toBe(0)
    expect(meetPhase({ kind: 'pattern', points: [{ t: 0, pos: 0 }, { t: 1, pos: 100 }] }, 0.9, 0, 1)).toBe(0)
  })

  it('patterns are straight lines between their points', () => {
    const p = [{ t: 0, pos: 0 }, { t: 0.5, pos: 100 }, { t: 1, pos: 50 }]
    expect(patternAt(p, 0.25)).toBeCloseTo(0.5)
    expect(patternAt(p, 0.75)).toBeCloseTo(0.75)
    expect(patternAt(p, 2)).toBeCloseTo(0.5)
  })
})

describe('generateFill', () => {
  const from = { at: 1000, pos: 0.05 }
  const to = { at: 11_000, pos: 0.05 }

  it('fills strictly between the ends, in order, one point per ms', () => {
    const r = generateFill({ from, to, source: sine, lo: 0.05, hi: 0.95, rate: { kind: 'spm', spm: 90 } })
    expect(r.error).toBeUndefined()
    expect(r.points.length).toBeGreaterThan(20)
    expect(r.points[0].at).toBeGreaterThan(from.at)
    expect(r.points.at(-1)!.at).toBeLessThan(to.at)
    ordered(r.points)
    for (const p of r.points) {
      expect(p.pos).toBeGreaterThanOrEqual(0.05)
      expect(p.pos).toBeLessThanOrEqual(0.95)
      expect(Math.round(p.pos * 100)).toBeCloseTo(p.pos * 100, 9)
    }
  })

  it('whole strokes: 90/min over 10 s is 15 strokes, ending on the end point', () => {
    const r = generateFill({ from, to, source: sharp, lo: 0.05, hi: 0.95, rate: { kind: 'spm', spm: 90 } })
    expect(r.cycles).toBe(15)
    expect(r.spm).toBeCloseTo(90)
    expect(turns([from, ...r.points, to]).filter(p => p.pos > 0.9)).toHaveLength(15)
  })

  it('nudges the rate to fit and says what it became', () => {
    const r = generateFill({ from, to, source: sharp, lo: 0.05, hi: 0.95, rate: { kind: 'spm', spm: 92 } })
    expect(r.cycles).toBeCloseTo(15)
    expect(r.spm).toBeCloseTo(90)
    const exact = generateFill({ from, to, source: sharp, lo: 0.05, hi: 0.95, rate: { kind: 'spm', spm: 92 }, fit: false })
    expect(exact.cycles).toBeCloseTo(15.333)
    expect(exact.spm).toBeCloseTo(92)
  })

  it('ends at the top half a stroke on when the end point is high', () => {
    const r = generateFill({ from, to: { at: 11_000, pos: 0.9 }, source: sharp, lo: 0.05, hi: 0.95, rate: { kind: 'spm', spm: 90 } })
    expect(r.cycles % 1).toBeCloseTo(0.5)
    // The last generated point is the bottom before the final rise into the end point.
    expect(r.points.at(-1)!.pos).toBeCloseTo(0.05)
  })

  it('starts by moving away from a high start point', () => {
    const r = generateFill({ from: { at: 0, pos: 0.95 }, to: { at: 4000, pos: 0.95 }, source: sharp, lo: 0.05, hi: 0.95, rate: { kind: 'count', count: 4 } })
    expect(r.cycles).toBe(4)
    expect(r.points[0].pos).toBeCloseTo(0.05)
    expect(r.points[0].at).toBe(500)
  })

  it('a number of strokes spreads them across the span', () => {
    const r = generateFill({ from, to, source: sharp, lo: 0, hi: 1, rate: { kind: 'count', count: 5 } })
    expect(r.cycles).toBe(5)
    expect(r.spm).toBeCloseTo(30)
    expect(r.points.map(p => p.at)).toEqual([2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10_000])
  })

  it('ramps: strokes get closer together toward the end', () => {
    const r = generateFill({ from, to, source: sharp, lo: 0, hi: 1, rate: { kind: 'spm', spm: 60, to: 180 } })
    const tops = r.points.filter(p => p.pos === 1).map(p => p.at)
    const gaps = tops.slice(1).map((t, i) => t - tops[i])
    expect(gaps[0]).toBeGreaterThan(gaps.at(-1)! * 2)
    expect(r.spmFrom).toBeLessThan(r.spmTo)
    expect(r.cycles % 1).toBeCloseTo(0)
    // The average fits whole strokes around (60 + 180) / 2.
    expect(r.spm).toBeCloseTo(120, 0)
  })

  it('follows the beats: a stroke starts on every beat', () => {
    const beats = Array.from({ length: 40 }, (_, i) => 1000 + i * 500)
    const r = generateFill({ from: { at: 1250, pos: 0.5 }, to: { at: 9250, pos: 0.5 }, source: sharp, lo: 0, hi: 1, rate: { kind: 'beats', beats, perBeat: 1 } })
    const bottoms = r.points.filter(p => p.pos === 0).map(p => p.at)
    expect(bottoms).toEqual(beats.filter(b => b > 1250 && b < 9250))
    expect(r.spm).toBeCloseTo(120)
  })

  it('says so when no beat falls in the span, or the span is too short', () => {
    expect(generateFill({ from: { at: 0, pos: 0 }, to: { at: 300, pos: 0 }, source: sine, lo: 0, hi: 1, rate: { kind: 'beats', beats: [1000, 1500], perBeat: 1 } }).error).toBe('beats')
    expect(generateFill({ from: { at: 0, pos: 0 }, to: { at: 1, pos: 0 }, source: sine, lo: 0, hi: 1, rate: { kind: 'spm', spm: 90 } }).error).toBe('span')
  })

  it('sine matches the generator exactly at every point', () => {
    const r = generateFill({ from: { at: 0, pos: 0 }, to: { at: 10_000, pos: 0 }, source: sine, lo: 0, hi: 1, rate: { kind: 'spm', spm: 30 } })
    for (const p of r.points) {
      const phase = (p.at / 2000) * Math.PI * 2
      expect(p.pos).toBeCloseTo(Math.round(strokePosition(phase, 'sine') * 100) / 100, 1)
    }
  })

  it('patterns repeat whole, each repeat starting with its first point', () => {
    const points = [{ t: 0, pos: 0 }, { t: 0.25, pos: 100 }, { t: 0.5, pos: 0 }, { t: 0.75, pos: 50 }, { t: 1, pos: 20 }]
    const r = generateFill({ from: { at: 0, pos: 0 }, to: { at: 4000, pos: 0 }, source: { kind: 'pattern', points }, lo: 0, hi: 1, rate: { kind: 'count', count: 2 } })
    expect(r.cycles).toBe(2)
    // Strictly between the ends: the shared moment at 2000 is the second repeat's start.
    expect(r.points).toEqual([
      { at: 500, pos: 1 },
      { at: 1000, pos: 0 },
      { at: 1500, pos: 0.5 },
      { at: 2000, pos: 0 },
      { at: 2500, pos: 1 },
      { at: 3000, pos: 0 },
      { at: 3500, pos: 0.5 },
    ])
  })

  it('with its ends, a pattern starts and finishes on its own first and last points', () => {
    const points = [{ t: 0, pos: 0 }, { t: 0.5, pos: 100 }, { t: 1, pos: 20 }]
    const r = generateFill({ from: { at: 100, pos: 0 }, to: { at: 1100, pos: 0 }, source: { kind: 'pattern', points }, lo: 0.1, hi: 0.9, rate: { kind: 'count', count: 1 }, ends: true })
    expect(r.points).toEqual([{ at: 100, pos: 0.1 }, { at: 600, pos: 0.9 }, { at: 1100, pos: 0.26 }])
  })

  it('upside down when low is above high', () => {
    const r = generateFill({ from: { at: 0, pos: 0.9 }, to: { at: 2000, pos: 0.9 }, source: sharp, lo: 0.9, hi: 0.1, rate: { kind: 'count', count: 2 } })
    expect(r.points.map(p => p.pos)).toEqual([0.1, 0.9, 0.1])
  })

  it('never runs away on an absurd rate', () => {
    const r = generateFill({ from: { at: 0, pos: 0 }, to: { at: 3_600_000, pos: 0 }, source: sine, lo: 0, hi: 1, rate: { kind: 'spm', spm: 1e9 } })
    expect(r.spm).toBeLessThanOrEqual(600)
    expect(r.points.length).toBeLessThanOrEqual(50_000 + 16)
  })
})

describe('into the script', () => {
  const script: Pt[] = [
    { at: 0, pos: 0.5 },
    { at: 1000, pos: 0.1 },
    { at: 1500, pos: 0.9 },
    { at: 2000, pos: 0.1 },
    { at: 3000, pos: 0.9 },
    { at: 4000, pos: 0.2 },
  ]

  it('replaceSpan keeps the ends unless asked', () => {
    const ins = [{ at: 1200, pos: 0.4 }]
    expect(replaceSpan(script, 1000, 3000, ins, false).points.map(p => p.at)).toEqual([0, 1000, 1200, 3000, 4000])
    const r = replaceSpan(script, 1000, 3000, [{ at: 1000, pos: 0 }, { at: 3000, pos: 1 }], true)
    expect(r.points.map(p => p.at)).toEqual([0, 1000, 3000, 4000])
    expect(r.start).toBe(1)
    expect(r.points[1].pos).toBe(0)
  })

  it('picks between the selection ends, then a marked stretch, then the playhead', () => {
    expect(pickTarget(script, [1, 2, 4], null, 0)).toEqual({ kind: 'between', i0: 1, i1: 4 })
    expect(pickTarget(script, [1], { t0: 100, t1: 900 }, 0)).toEqual({ kind: 'range', t0: 100, t1: 900 })
    expect(pickTarget(script, [], null, 2500.4)).toEqual({ kind: 'at', t: 2500 })
  })

  it('a fill between two points replaces only what is between, and selects it with its ends', () => {
    const plan = planFill(script, { kind: 'between', i0: 1, i1: 4 }, { source: sharp, lo: 0.1, hi: 0.9, rate: { kind: 'count', count: 2 } })!
    expect(plan.points[0]).toBe(script[0])
    expect(plan.points[1]).toBe(script[1])
    expect(plan.points.at(-2)).toBe(script[4])
    expect(plan.points.at(-1)).toBe(script[5])
    // 1000 (0.1) → 3000 (0.9): two asked for, so two and a half, ending on the top.
    expect(plan.result.cycles).toBeCloseTo(2.5)
    expect(plan.selection[0]).toBe(1)
    expect(plan.points[plan.selection.at(-1)!]).toBe(script[4])
    expect(plan.inserted[0]).toBe(script[1])
    expect(plan.inserted.at(-1)).toBe(script[4])
  })

  it('a stretch of time gets ends at the script position there', () => {
    const plan = planFill(script, { kind: 'range', t0: 2500, t1: 3500 }, { source: sharp, lo: 0, hi: 1, rate: { kind: 'count', count: 1 } })!
    expect(plan.inserted[0]).toEqual({ at: 2500, pos: 0.5 })
    expect(plan.inserted.at(-1)).toEqual({ at: 3500, pos: 0.55 })
    expect(plan.points.filter(p => p.at > 2500 && p.at < 3500).every(p => plan.inserted.includes(p))).toBe(true)
    // The point at 3000 is gone.
    expect(plan.points.some(p => p.at === 3000)).toBe(false)
  })

  it('or the fill\'s own motion at its ends', () => {
    const plan = planFill(script, { kind: 'range', t0: 2500, t1: 3500 }, { source: sharp, lo: 0, hi: 1, rate: { kind: 'count', count: 1 }, edges: 'fill' })!
    expect(plan.inserted[0].at).toBe(2500)
    expect(plan.inserted.at(-1)!.at).toBe(3500)
  })

  it('an insert at the playhead runs for its length and replaces what was there', () => {
    const plan = planFill(script, { kind: 'at', t: 1000 }, { source: sharp, lo: 0, hi: 1, rate: { kind: 'count', count: 2 }, length: 2000 })!
    expect(plan.from).toBe(1000)
    expect(plan.to).toBe(3000)
    expect(plan.inserted.map(p => p.at)).toEqual([1000, 1500, 2000, 2500, 3000])
    expect(plan.points.map(p => p.at)).toEqual([0, 1000, 1500, 2000, 2500, 3000, 4000])
    expect(plan.selection).toEqual([1, 2, 3, 4, 5])
  })

  it('counts the joins to its neighbours when checking speed', () => {
    const plan = planFill(script, { kind: 'at', t: 1000 }, { source: sharp, lo: 0, hi: 1, rate: { kind: 'count', count: 2 }, length: 400 })!
    const pts = plan.points
    expect(plan.peak).toBe(peakSpeed(pts, plan.first, plan.last))
    expect(plan.peak).toBeCloseTo(segmentSpeed(pts[1], pts[2]))
    // Four in the insert, and the jump from its end up to the next point.
    expect(countFast(pts, 500, plan.first, plan.last)).toBe(5)
  })

  it('reports an error without touching the script', () => {
    const plan = planFill(script, { kind: 'range', t0: 2500, t1: 2700 }, { source: sine, lo: 0, hi: 1, rate: { kind: 'beats', beats: [0, 5000], perBeat: 1 } })!
    expect(plan.result.error).toBe('beats')
    expect(plan.points).toEqual(script)
    expect(plan.inserted).toEqual([])
  })
})
