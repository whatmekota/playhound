import type { EnvelopeSample } from '../src/lib/funscriptAnalysis'
import { describe, expect, it } from 'vitest'
import {
  busiestStretch,
  intensityBand,
  intensityLevel,
  momentIntensity,
  scriptProfile,
  speedCurve,
  speedDistribution,
  speedRank,
  speedUnits,
} from '../src/lib/scriptIntensity'

/** Envelope at 250 ms with the given speed per sample. */
function env(speeds: number[]): EnvelopeSample[] {
  return speeds.map((speed, i) => ({ at: i * 250, speed, spm: 0, depth: 0 }))
}

function strokes(count: number, periodMs: number, t0 = 0) {
  const out: { at: number, pos: number }[] = []
  for (let i = 0; i < count; i++) {
    out.push({ at: t0 + i * periodMs, pos: 0.1 })
    out.push({ at: t0 + i * periodMs + periodMs / 2, pos: 0.9 })
  }
  return out
}

describe('levels and bands', () => {
  it('steps through five levels', () => {
    expect([0, 1.4, 2.2, 3, 3.5, 9].map(intensityLevel)).toEqual([1, 2, 3, 4, 5, 5])
  })

  it('bands split at 2 and 3.2', () => {
    expect(intensityBand(0)).toBe('gentle')
    expect(intensityBand(1.99)).toBe('gentle')
    expect(intensityBand(2)).toBe('medium')
    expect(intensityBand(3.19)).toBe('medium')
    expect(intensityBand(3.2)).toBe('intense')
  })

  it('reports speed in funscript units', () => {
    expect(speedUnits(2.774)).toBe(277)
  })
})

describe('busiestStretch', () => {
  it('finds the longest hot run', () => {
    const s = busiestStretch(env([0, 5, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 0]), { threshold: 4, minMs: 0 })
    expect(s).toEqual({ startMs: 24 * 250, endMs: 34 * 250, speed: 6 })
  })

  it('bridges short dips', () => {
    const speeds = [...Array.from({ length: 10 }, () => 5), 1, 1, ...Array.from({ length: 10 }, () => 5)]
    const s = busiestStretch(env(speeds), { threshold: 4, bridgeMs: 1000 })!
    expect(s.startMs).toBe(0)
    expect(s.endMs).toBe(22 * 250)
    const split = busiestStretch(env(speeds), { threshold: 4, bridgeMs: 0 })!
    expect(split.endMs - split.startMs).toBe(10 * 250)
  })

  it('ignores runs shorter than minMs and still scripts', () => {
    expect(busiestStretch(env([0, 5, 0]), { threshold: 4 })).toBeNull()
    expect(busiestStretch(env([0, 0, 0, 0]))).toBeNull()
  })
})

describe('speedCurve', () => {
  it('averages slices', () => {
    expect(speedCurve(env([1, 3, 5, 7]), 2)).toEqual([2, 6])
    expect(speedCurve(env([1, 2]), 8)).toEqual([1, 2])
    expect(speedCurve([], 8)).toEqual([])
  })
})

describe('scriptProfile', () => {
  it('describes a slow start and a fast finish', () => {
    // 60 s of slow strokes (2 s each), then 30 s of fast ones (0.4 s each).
    const actions = [...strokes(30, 2000), ...strokes(75, 400, 60_000)]
    const p = scriptProfile(actions, 16)
    expect(p.strokes).toBeGreaterThan(95)
    expect(p.durationMs).toBe(actions[actions.length - 1].at)
    expect(p.peakSpeed).toBeGreaterThan(p.meanSpeed)
    expect(p.curve).toHaveLength(16)
    expect(p.curve[15]).toBeGreaterThan(p.curve[0] * 3)
    // The busy part is the fast tail.
    expect(p.busiest).not.toBeNull()
    expect(p.busiest!.startMs).toBeGreaterThanOrEqual(58_000)
    expect(p.busiest!.endMs - p.busiest!.startMs).toBeGreaterThan(20_000)
  })
})

describe('meanSpeedToIntensity', () => {
  it('spreads a typical library across the range instead of pinning it at 1', async () => {
    const { meanSpeedToIntensity } = await import('../src/lib/scriptIntensity')
    expect(meanSpeedToIntensity(0.5)).toBe(0)
    expect(meanSpeedToIntensity(2.8)).toBeGreaterThan(0.45)
    expect(meanSpeedToIntensity(2.8)).toBeLessThan(0.7)
    expect(meanSpeedToIntensity(2)).toBeLessThan(meanSpeedToIntensity(3.5))
    expect(meanSpeedToIntensity(10)).toBe(1)
    expect(meanSpeedToIntensity(Number.NaN)).toBe(0)
  })
})

describe('moment intensity', () => {
  // A hard script: long steady stretches around 2.8 with short bursts to 5.
  const hard = env([...Array.from({ length: 80 }, () => 2.8), ...Array.from({ length: 12 }, () => 5), ...Array.from({ length: 8 }, () => 0)])
  const hardSorted = speedDistribution(hard)

  it('ranks a speed within its own script, ignoring pauses', () => {
    expect(hardSorted.length).toBe(92)
    expect(speedRank(0.5, hardSorted)).toBe(0)
    expect(speedRank(2.8, hardSorted)).toBe(0)
    expect(speedRank(5, hardSorted)).toBeCloseTo(80 / 92)
    expect(speedRank(9, hardSorted)).toBe(1)
    expect(speedRank(3, new Float64Array())).toBe(0)
  })

  it('keeps a steady stretch of a hard script out of the top mood', () => {
    // flustered needs 0.82, excited 0.6 (src/lib/faceState.ts)
    expect(momentIntensity(2.8, hardSorted)).toBeLessThan(0.6)
    expect(momentIntensity(5, hardSorted)).toBeGreaterThan(0.82)
  })

  it('does not let the busiest part of a gentle script pass for a hard one', () => {
    const gentle = speedDistribution(env([...Array.from({ length: 80 }, () => 1.2), ...Array.from({ length: 20 }, () => 1.8)]))
    const top = momentIntensity(1.8, gentle)
    expect(top).toBeGreaterThan(momentIntensity(1.2, gentle))
    expect(top).toBeLessThan(0.82)
  })

  it('is zero while the script pauses', () => {
    expect(momentIntensity(0, hardSorted)).toBe(0)
    expect(momentIntensity(Number.NaN, hardSorted)).toBe(0)
  })
})
