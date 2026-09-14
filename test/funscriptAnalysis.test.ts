import { describe, expect, it } from 'vitest'
import {
  buildEnvelope,
  detectPeaks,
  phaseError,
  sampleEnvelope,
  speedToIntensity,
  strokePhaseAt,
} from '../src/lib/funscriptAnalysis'

/** A clean square-ish stroke pattern: one peak every `periodMs`. */
function strokes(count: number, periodMs: number, lo = 0.1, hi = 0.9) {
  const out: { at: number, pos: number }[] = []
  for (let i = 0; i < count; i++) {
    out.push({ at: i * periodMs, pos: lo })
    out.push({ at: i * periodMs + periodMs / 2, pos: hi })
  }
  out.push({ at: count * periodMs, pos: lo })
  return out
}

describe('detectPeaks', () => {
  it('finds one peak per stroke cycle', () => {
    const peaks = detectPeaks(strokes(6, 1000))
    expect(peaks).toHaveLength(6)
    expect(peaks[0].at).toBeCloseTo(500, 0)
    expect(peaks[1].at).toBeCloseTo(1500, 0)
  })

  it('ignores wobble below the prominence floor', () => {
    const noisy = [
      { at: 0, pos: 0.5 },
      { at: 100, pos: 0.52 }, // tiny bump, not a stroke
      { at: 200, pos: 0.5 },
      { at: 300, pos: 0.95 }, // real peak
      { at: 400, pos: 0.1 },
    ]
    const peaks = detectPeaks(noisy)
    expect(peaks).toHaveLength(1)
    expect(peaks[0].at).toBe(300)
  })

  it('collapses a flat top to a single peak', () => {
    const plateau = [
      { at: 0, pos: 0.1 },
      { at: 100, pos: 0.9 },
      { at: 200, pos: 0.9 },
      { at: 300, pos: 0.9 },
      { at: 400, pos: 0.1 },
    ]
    const peaks = detectPeaks(plateau)
    expect(peaks).toHaveLength(1)
    expect(peaks[0].at).toBe(200) // midpoint of the plateau
  })

  it('returns nothing for degenerate input', () => {
    expect(detectPeaks([])).toEqual([])
    expect(detectPeaks([{ at: 0, pos: 0 }])).toEqual([])
    expect(detectPeaks([{ at: 0, pos: 0.5 }, { at: 10, pos: 0.5 }])).toEqual([])
  })
})

describe('strokePhaseAt', () => {
  const peaks = detectPeaks(strokes(6, 1000))

  it('reads 0 at a peak and 0.5 midway between peaks', () => {
    expect(strokePhaseAt(peaks, 500)!.phase).toBeCloseTo(0, 3)
    expect(strokePhaseAt(peaks, 1000)!.phase).toBeCloseTo(0.5, 3)
    expect(strokePhaseAt(peaks, 1500)!.phase).toBeCloseTo(0, 3)
  })

  it('reports the cycle rate in Hz', () => {
    // one peak per second -> 1 Hz
    expect(strokePhaseAt(peaks, 900)!.rateHz).toBeCloseTo(1, 3)
  })

  it('advances monotonically within a cycle', () => {
    let prev = -1
    for (let t = 500; t < 1500; t += 50) {
      const p = strokePhaseAt(peaks, t)!.phase
      expect(p).toBeGreaterThanOrEqual(prev)
      prev = p
    }
  })

  it('returns null outside the scripted range or without enough peaks', () => {
    expect(strokePhaseAt(peaks, 0)).toBeNull()
    expect(strokePhaseAt(peaks, 999999)).toBeNull()
    expect(strokePhaseAt([], 100)).toBeNull()
  })
})

describe('buildEnvelope', () => {
  it('reports a faster rate for a faster script', () => {
    const slow = sampleEnvelope(buildEnvelope(strokes(20, 2000)), 20000)!
    const fast = sampleEnvelope(buildEnvelope(strokes(80, 500)), 20000)!
    expect(fast.spm).toBeGreaterThan(slow.spm)
    expect(fast.speed).toBeGreaterThan(slow.speed)
  })

  it('recovers a known stroke rate', () => {
    // one peak per second -> 60 cycles per minute
    const env = buildEnvelope(strokes(30, 1000))
    expect(sampleEnvelope(env, 20000)!.spm).toBeCloseTo(60, 0)
  })

  it('reports shallower depth for a shallower script', () => {
    const deep = sampleEnvelope(buildEnvelope(strokes(20, 1000, 0.05, 0.95)), 10000)!
    const shallow = sampleEnvelope(buildEnvelope(strokes(20, 1000, 0.4, 0.6)), 10000)!
    expect(shallow.depth).toBeLessThan(deep.depth)
  })

  it('handles degenerate input', () => {
    expect(buildEnvelope([])).toEqual([])
    expect(sampleEnvelope([], 0)).toBeNull()
  })
})

describe('speedToIntensity', () => {
  it('clamps to 0-1', () => {
    expect(speedToIntensity(0)).toBe(0)
    expect(speedToIntensity(-5)).toBe(0)
    expect(speedToIntensity(999)).toBe(1)
  })

  it('is monotonic', () => {
    expect(speedToIntensity(0.9)).toBeLessThan(speedToIntensity(1.5))
  })
})

describe('phaseError', () => {
  it('takes the short way round the circle', () => {
    expect(phaseError(0.9, 0.1)).toBeCloseTo(0.2, 6)
    expect(phaseError(0.1, 0.9)).toBeCloseTo(-0.2, 6)
    expect(phaseError(0.5, 0.5)).toBeCloseTo(0, 6)
  })

  it('stays within [-0.5, 0.5)', () => {
    for (let a = 0; a < 1; a += 0.05) {
      for (let b = 0; b < 1; b += 0.05) {
        const e = phaseError(a, b)
        expect(e).toBeGreaterThanOrEqual(-0.5)
        expect(e).toBeLessThan(0.5)
      }
    }
  })
})
