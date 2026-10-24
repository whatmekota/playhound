import { describe, expect, it } from 'vitest'
import { clampLatency, estimateLatency, LATENCY_LIMIT_MS, matchTaps, median, rateConfidence, robustOffset } from '../src/lib/latency'

/** Turns every `gap` ms from `start`. */
function turns(n: number, gap = 667, start = 1000) {
  return Array.from({ length: n }, (_, i) => start + i * gap)
}

/** Deterministic jitter in [-amp, amp], so tests never flake. */
function jitter(i: number, amp: number) {
  return Math.round(Math.sin(i * 12.9898) * amp)
}

describe('median', () => {
  it('handles odd, even and empty input', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(median([])).toBeNaN()
  })
})

describe('clampLatency', () => {
  it('rounds, clamps and survives garbage', () => {
    expect(clampLatency(80.4)).toBe(80)
    expect(clampLatency(5000)).toBe(LATENCY_LIMIT_MS)
    expect(clampLatency(-5000)).toBe(-LATENCY_LIMIT_MS)
    expect(clampLatency(Number.NaN)).toBe(0)
  })
})

describe('matchTaps', () => {
  it('pairs each tap with its nearest turn', () => {
    expect(matchTaps([1000, 2000, 3000], [1080, 2070, 2950], 500)).toEqual([80, 70, -50])
  })

  it('drops taps that are nowhere near a turn', () => {
    expect(matchTaps([1000, 2000], [100, 1050, 4000], 400)).toEqual([50])
  })

  it('does not care about input order', () => {
    expect(matchTaps([3000, 1000, 2000], [2950, 1080, 2070], 500)).toEqual([80, 70, -50])
  })

  it('returns nothing without turns', () => {
    expect(matchTaps([], [1, 2, 3], 500)).toEqual([])
  })
})

describe('robustOffset', () => {
  it('needs a minimum number of taps', () => {
    expect(robustOffset([80, 82, 79])).toBeNull()
  })

  it('rejects fumbled taps instead of averaging them in', () => {
    const offsets = [78, 82, 80, 81, 79, 83, 77, 80, 300, -250]
    const r = robustOffset(offsets)!
    expect(r.offsetMs).toBe(80)
    expect(r.kept).toBe(8)
    expect(r.total).toBe(10)
    expect(r.samples.filter(s => !s.kept).map(s => s.offsetMs).sort((a, b) => a - b)).toEqual([-250, 300])
  })

  it('does not reject everything when the taps are suspiciously identical', () => {
    const r = robustOffset([50, 50, 50, 50, 50, 50, 58])!
    expect(r.kept).toBe(7)
    expect(r.offsetMs).toBe(50)
  })
})

describe('rateConfidence', () => {
  it('grades by count, spread and how many were kept', () => {
    expect(rateConfidence({ spreadMs: 20, kept: 16, total: 18 })).toBe('high')
    expect(rateConfidence({ spreadMs: 50, kept: 10, total: 14 })).toBe('medium')
    expect(rateConfidence({ spreadMs: 120, kept: 16, total: 16 })).toBe('low')
    expect(rateConfidence({ spreadMs: 20, kept: 8, total: 20 })).toBe('low')
  })
})

describe('estimateLatency', () => {
  it('recovers a steady device lag through human jitter', () => {
    const t = turns(24)
    const taps = t.map((x, i) => x + 120 + jitter(i, 25))
    const r = estimateLatency(t, taps, { turnGapMs: 667 })!
    expect(Math.abs(r.offsetMs - 120)).toBeLessThanOrEqual(8)
    expect(r.confidence).toBe('high')
  })

  it('finds a negative offset when the user taps early', () => {
    const t = turns(20)
    const taps = t.map((x, i) => x - 40 + jitter(i, 10))
    expect(estimateLatency(t, taps, { turnGapMs: 667 })!.offsetMs).toBeCloseTo(-40, -1)
  })

  it('shrugs off missed turns, double taps and a stray press', () => {
    const t = turns(24)
    const taps: number[] = []
    t.forEach((x, i) => {
      if (i % 7 === 3)
        return // missed
      taps.push(x + 90 + jitter(i, 15))
      if (i % 9 === 0)
        taps.push(x + 90 + 260) // nervous double tap
    })
    taps.push(t[5] + 333) // halfway between turns
    const r = estimateLatency(t, taps, { turnGapMs: 667 })!
    expect(Math.abs(r.offsetMs - 90)).toBeLessThanOrEqual(8)
    expect(r.kept).toBeLessThan(r.total)
  })

  it('skips the warm-up taps', () => {
    const t = turns(16)
    // The first three are wildly late while the user finds the beat.
    const taps = t.map((x, i) => x + (i < 3 ? 280 : 60))
    const r = estimateLatency(t, taps, { turnGapMs: 667, skipFirst: 3 })!
    expect(r.offsetMs).toBe(60)
    expect(r.total).toBe(13)
  })

  it('returns null when there is too little to go on', () => {
    expect(estimateLatency(turns(10), [1100, 1767], { turnGapMs: 667 })).toBeNull()
  })

  it('reports low confidence for taps all over the place', () => {
    const t = turns(20)
    const taps = t.map((x, i) => x + jitter(i, 200))
    const r = estimateLatency(t, taps, { turnGapMs: 667 })
    expect(r === null || r.confidence === 'low').toBe(true)
  })
})
