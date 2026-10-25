import { describe, expect, it } from 'vitest'
import {
  arousalFrom,
  createGuardState,
  createHeartRateProcessor,
  DEFAULT_GUARD,
  parseHeartRateMeasurement,
  percentile,
  stepGuard,
} from '../src/lib/heartRate'

function view(bytes: number[]) {
  return new DataView(new Uint8Array(bytes).buffer)
}

describe('parseHeartRateMeasurement', () => {
  it('reads a uint8 bpm with no extras', () => {
    expect(parseHeartRateMeasurement(view([0x00, 72]))).toEqual({ bpm: 72, contact: null, energyKj: null, rrMs: [] })
  })

  it('reads a uint16 bpm, little-endian', () => {
    expect(parseHeartRateMeasurement(view([0x01, 0x2C, 0x01]))?.bpm).toBe(300)
  })

  it('reports contact only when the sensor supports detecting it', () => {
    expect(parseHeartRateMeasurement(view([0x06, 60]))?.contact).toBe(true)
    expect(parseHeartRateMeasurement(view([0x04, 60]))?.contact).toBe(false)
    expect(parseHeartRateMeasurement(view([0x02, 60]))?.contact).toBe(null)
  })

  it('reads energy and RR intervals after the bpm', () => {
    // uint8 bpm, energy 0x0102 kJ, two RR intervals of 1024 and 512 (1/1024 s)
    const p = parseHeartRateMeasurement(view([0x18, 80, 0x02, 0x01, 0x00, 0x04, 0x00, 0x02]))
    expect(p).toEqual({ bpm: 80, contact: null, energyKj: 258, rrMs: [1000, 500] })
  })

  it('reads RR intervals without energy, with a uint16 bpm', () => {
    const p = parseHeartRateMeasurement(view([0x11, 90, 0x00, 0x00, 0x03]))
    expect(p?.bpm).toBe(90)
    expect(p?.rrMs).toEqual([750])
  })

  it('rejects packets shorter than their flags promise', () => {
    expect(parseHeartRateMeasurement(view([0x00]))).toBeNull()
    expect(parseHeartRateMeasurement(view([0x01, 0x50]))).toBeNull()
    expect(parseHeartRateMeasurement(view([0x08, 70, 0x01]))).toBeNull()
  })
})

describe('percentile and arousal', () => {
  it('interpolates between ranks', () => {
    expect(percentile([1, 2, 3, 4, 5], 0)).toBe(1)
    expect(percentile([5, 1, 3], 0.5)).toBe(3)
    expect(percentile([0, 10], 0.25)).toBe(2.5)
  })

  it('is 0 without a baseline and saturates at the span', () => {
    expect(arousalFrom(120, null, 40)).toBe(0)
    expect(arousalFrom(60, 60, 40)).toBe(0)
    expect(arousalFrom(100, 60, 40)).toBe(1)
    expect(arousalFrom(80, 60, 40)).toBeCloseTo(0.5)
  })
})

describe('heart rate processor', () => {
  it('ignores impossible readings', () => {
    const p = createHeartRateProcessor()
    expect(p.push(0, 0)).toBeNull()
    expect(p.push(400, 0)).toBeNull()
  })

  it('smooths a jump rather than following it', () => {
    const p = createHeartRateProcessor({ smoothSec: 4 })
    p.push(60, 0)
    const r = p.push(100, 1000)!
    expect(r.bpm).toBeGreaterThan(60)
    expect(r.bpm).toBeLessThan(75)
  })

  it('learns a resting baseline that one spike cannot drag', () => {
    const p = createHeartRateProcessor({ baselineMinSec: 30 })
    let r = null
    for (let s = 0; s <= 120; s++)
      r = p.push(s === 60 ? 45 : 62, s * 1000)
    expect(r!.baseline).not.toBeNull()
    expect(r!.baseline!).toBeGreaterThan(58)
    expect(r!.baseline!).toBeLessThan(63)
  })

  it('has no baseline until enough time has passed', () => {
    const p = createHeartRateProcessor({ baselineMinSec: 45 })
    expect(p.push(70, 0)!.baseline).toBeNull()
    expect(p.push(70, 30_000)!.baseline).toBeNull()
  })

  it('measures a climb as rise and arousal', () => {
    const p = createHeartRateProcessor({ baselineMinSec: 30, riseWindowSec: 15 })
    for (let s = 0; s < 120; s++)
      p.push(65, s * 1000)
    let r = null
    for (let s = 120; s < 128; s++)
      r = p.push(110, s * 1000)
    expect(r!.rise).toBeGreaterThan(15)
    expect(r!.arousal).toBeGreaterThan(0.5)
  })

  it('starts over after a long gap', () => {
    const p = createHeartRateProcessor({ baselineMinSec: 10 })
    for (let s = 0; s < 30; s++)
      p.push(60, s * 1000)
    const r = p.push(90, 120_000)!
    expect(r.bpm).toBe(90)
    expect(r.baseline).toBeNull()
  })
})

describe('guard', () => {
  const S = { ...DEFAULT_GUARD, enabled: true, aboveRestBpm: 20, riseBpm: 10, hysteresisBpm: 5, refractorySec: 30 }
  const at = (s: number) => s * 1000

  it('does nothing when off or without a baseline', () => {
    const g = createGuardState()
    expect(stepGuard(g, { at: 0, bpm: 150, baseline: 60, rise: 30 }, { ...S, enabled: false }).fire).toBe(false)
    expect(stepGuard(g, { at: 0, bpm: 150, baseline: null, rise: 30 }, S).fire).toBe(false)
  })

  it('needs both high and climbing', () => {
    const g = createGuardState()
    expect(stepGuard(g, { at: 0, bpm: 95, baseline: 60, rise: 2 }, S).fire).toBe(false)
    expect(stepGuard(g, { at: 0, bpm: 75, baseline: 60, rise: 15 }, S).fire).toBe(false)
    expect(stepGuard(g, { at: 0, bpm: 85, baseline: 60, rise: 12 }, S).fire).toBe(true)
  })

  it('will not fire again until it has dropped back and the refractory period passed', () => {
    let g = createGuardState()
    let step = stepGuard(g, { at: at(0), bpm: 90, baseline: 60, rise: 15 }, S)
    expect(step.fire).toBe(true)
    g = step.state
    // Still high and climbing, refractory over, but never came back down.
    step = stepGuard(g, { at: at(40), bpm: 95, baseline: 60, rise: 12 }, S)
    expect(step.fire).toBe(false)
    g = step.state
    // Dips just under the threshold: inside the hysteresis band, still disarmed.
    g = stepGuard(g, { at: at(45), bpm: 78, baseline: 60, rise: -5 }, S).state
    expect(g.armed).toBe(false)
    g = stepGuard(g, { at: at(50), bpm: 70, baseline: 60, rise: -10 }, S).state
    expect(g.armed).toBe(true)
    expect(stepGuard(g, { at: at(55), bpm: 90, baseline: 60, rise: 15 }, S).fire).toBe(true)
  })

  it('respects the refractory period even when re-armed', () => {
    let g = stepGuard(createGuardState(), { at: at(0), bpm: 90, baseline: 60, rise: 15 }, S).state
    g = stepGuard(g, { at: at(5), bpm: 65, baseline: 60, rise: -20 }, S).state
    expect(g.armed).toBe(true)
    expect(stepGuard(g, { at: at(10), bpm: 90, baseline: 60, rise: 20 }, S).fire).toBe(false)
    expect(stepGuard(g, { at: at(31), bpm: 90, baseline: 60, rise: 20 }, S).fire).toBe(true)
  })
})
