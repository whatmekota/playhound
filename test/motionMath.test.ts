import { describe, expect, it } from 'vitest'
import {
  advancePhase,
  applyDepth,
  clamp,
  depthFromIntensity,
  pickBeatDivisor,
  rampToward,
  spmFromIntensity,
  strokePosition,
} from '../src/lib/motionMath'

describe('strokePosition', () => {
  it('starts retracted and peaks mid-cycle for every shape', () => {
    for (const shape of ['sine', 'ease', 'pulse'] as const) {
      expect(strokePosition(0, shape)).toBeCloseTo(0, 5)
      const peak = Math.max(
        ...Array.from({ length: 200 }, (_, i) => strokePosition((i / 200) * Math.PI * 2, shape)),
      )
      expect(peak).toBeGreaterThan(0.98)
    }
  })

  it('stays within 0-1 across the whole cycle', () => {
    for (const shape of ['sine', 'ease', 'pulse'] as const) {
      for (let i = 0; i < 500; i++) {
        const v = strokePosition((i / 500) * Math.PI * 4 - Math.PI, shape)
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(1)
      }
    }
  })

  it('is continuous — no jumps between adjacent samples', () => {
    for (const shape of ['sine', 'ease', 'pulse'] as const) {
      let prev = strokePosition(0, shape)
      for (let i = 1; i <= 1000; i++) {
        const v = strokePosition((i / 1000) * Math.PI * 2, shape)
        expect(Math.abs(v - prev)).toBeLessThan(0.05)
        prev = v
      }
    }
  })
})

describe('advancePhase', () => {
  it('completes one stroke per 60/spm seconds', () => {
    let p = 0
    const spm = 60 // one stroke per second
    for (let i = 0; i < 100; i++)
      p = advancePhase(p, spm, 0.01)
    // After exactly one second the phase is a full turn from where it started.
    // Float accumulation can leave it just shy of TAU rather than wrapped to 0,
    // so compare the distance around the circle, which is what position uses.
    const TAU = Math.PI * 2
    const dist = Math.min(p % TAU, TAU - (p % TAU))
    expect(dist).toBeLessThan(1e-6)
    expect(strokePosition(p)).toBeCloseTo(0, 6)
  })

  it('never jumps position when the rate changes', () => {
    let p = 0
    p = advancePhase(p, 40, 0.016)
    const before = strokePosition(p)
    // A large rate change must only affect how fast phase moves next tick.
    p = advancePhase(p, 140, 0)
    expect(strokePosition(p)).toBeCloseTo(before, 10)
  })

  it('ignores negative rates rather than running backwards', () => {
    const p = advancePhase(1, -50, 0.1)
    expect(p).toBe(1)
  })
})

describe('rampToward', () => {
  it('limits the step to perSec * dt', () => {
    expect(rampToward(0, 100, 25, 1)).toBe(25)
    expect(rampToward(0, 100, 25, 0.5)).toBe(12.5)
  })

  it('snaps once within reach and does not overshoot', () => {
    expect(rampToward(99, 100, 25, 1)).toBe(100)
    expect(rampToward(100, 100, 25, 1)).toBe(100)
  })

  it('ramps downward too', () => {
    expect(rampToward(100, 0, 25, 1)).toBe(75)
  })

  it('takes the expected time to cross a realistic phase change', () => {
    // entry (35 spm) -> peak (120 spm) at the default 25 spm/s should take ~3.4s
    let v = 35
    let t = 0
    while (v < 120 && t < 10) {
      v = rampToward(v, 120, 25, 1 / 60)
      t += 1 / 60
    }
    expect(t).toBeGreaterThan(3)
    expect(t).toBeLessThan(4)
  })
})

describe('pickBeatDivisor', () => {
  it('brings typical beat frequencies into the safe band', () => {
    for (const beat of [1.5, 3, 6, 10, 13, 20, 40]) {
      const d = pickBeatDivisor(beat, 35, 140)
      const spm = (beat * 60) / d
      expect(spm).toBeGreaterThanOrEqual(35)
      expect(spm).toBeLessThanOrEqual(140)
    }
  })

  it('returns a power of two', () => {
    for (const beat of [1.5, 3, 6, 10, 13, 20, 40]) {
      const d = pickBeatDivisor(beat, 35, 140)
      expect(Number.isInteger(Math.log2(d))).toBe(true)
    }
  })

  it('falls back to the closest divisor when nothing lands in band', () => {
    // 0.1 Hz is 6 spm raw; no divisor can raise it into the band.
    expect(pickBeatDivisor(0.1, 35, 140)).toBe(1)
  })
})

describe('applyDepth', () => {
  it('centres the stroke and respects the depth fraction', () => {
    expect(applyDepth(0, 0.5, 1)).toBeCloseTo(0)
    expect(applyDepth(1, 0.5, 1)).toBeCloseTo(1)
    expect(applyDepth(0, 0.5, 0.5)).toBeCloseTo(0.25)
    expect(applyDepth(1, 0.5, 0.5)).toBeCloseTo(0.75)
  })

  it('collapses to the centre at zero depth', () => {
    expect(applyDepth(0, 0.4, 0)).toBeCloseTo(0.4)
    expect(applyDepth(1, 0.4, 0)).toBeCloseTo(0.4)
  })

  it('never leaves 0-1 even with an off-centre midpoint', () => {
    for (const center of [0, 0.1, 0.5, 0.9, 1]) {
      for (const depth of [0, 0.5, 1]) {
        for (const u of [0, 0.5, 1]) {
          const v = applyDepth(u, center, depth)
          expect(v).toBeGreaterThanOrEqual(0)
          expect(v).toBeLessThanOrEqual(1)
        }
      }
    }
  })
})

describe('intensity mapping', () => {
  it('maps the session phase intensities onto sane rates', () => {
    // entry / build / peak / descent intensities from useSessionEngine
    expect(spmFromIntensity(0.35, 20, 130)).toBeCloseTo(58.5)
    expect(spmFromIntensity(0.85, 20, 130)).toBeCloseTo(113.5)
    expect(depthFromIntensity(0.28, 0.35, 0.95)).toBeCloseTo(0.518)
  })

  it('clamps out-of-range intensity', () => {
    expect(spmFromIntensity(-1, 20, 130)).toBe(20)
    expect(spmFromIntensity(2, 20, 130)).toBe(130)
  })
})

describe('clamp', () => {
  it('bounds values', () => {
    expect(clamp(5, 0, 1)).toBe(1)
    expect(clamp(-5, 0, 1)).toBe(0)
    expect(clamp(0.5, 0, 1)).toBe(0.5)
  })
})
