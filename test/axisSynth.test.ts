import { describe, expect, it } from 'vitest'
import {
  advanceTwistPhase,
  DEFAULT_SYNTH,
  estimateVelocity,
  synthAxes,
  synthTargets,
} from '../src/lib/axisSynth'

describe('estimateVelocity', () => {
  it('is zero when still, and signed by direction', () => {
    expect(estimateVelocity(0.5, 0.5, 0.016)).toBe(0)
    expect(estimateVelocity(0.2, 0.6, 0.016)).toBeGreaterThan(0)
    expect(estimateVelocity(0.6, 0.2, 0.016)).toBeLessThan(0)
  })

  it('clamps to -1..1 however fast the jump', () => {
    expect(estimateVelocity(0, 1, 0.001)).toBe(1)
    expect(estimateVelocity(1, 0, 0.001)).toBe(-1)
  })

  it('does not divide by a zero timestep', () => {
    expect(estimateVelocity(0, 1, 0)).toBe(0)
  })
})

describe('advanceTwistPhase', () => {
  it('turns at the configured fraction of the stroke rate', () => {
    // 1 stroke/sec at ratio 0.5 -> half a turn after one second
    let p = 0
    for (let i = 0; i < 100; i++)
      p = advanceTwistPhase(p, 1, 0.01, 0.5)
    expect(p).toBeCloseTo(0.5, 2)
  })

  it('stays within 0..1 and never runs backwards', () => {
    let p = 0
    for (let i = 0; i < 500; i++) {
      p = advanceTwistPhase(p, 2, 0.01)
      expect(p).toBeGreaterThanOrEqual(0)
      expect(p).toBeLessThan(1)
    }
    expect(advanceTwistPhase(0.4, -5, 0.1)).toBe(0.4)
  })
})

describe('synthAxes', () => {
  const base = { pos: 0.5, velocity: 0, twistPhase: 0 }

  it('centres every axis when there is no motion', () => {
    const a = synthAxes(base, { ...DEFAULT_SYNTH, surge: true })
    expect(a.R0).toBeCloseTo(0.5, 6)
    expect(a.R1).toBeCloseTo(0.5, 6)
    expect(a.L1).toBeCloseTo(0.5, 6)
  })

  it('rolls with the direction of travel, not with position', () => {
    const up = synthAxes({ ...base, velocity: 1 })
    const down = synthAxes({ ...base, velocity: -1 })
    expect(up.R1).toBeGreaterThan(0.5)
    expect(down.R1).toBeLessThan(0.5)

    // Same position, opposite direction -> opposite roll.
    const a = synthAxes({ pos: 0.7, velocity: 0.8, twistPhase: 0 })
    const b = synthAxes({ pos: 0.7, velocity: -0.8, twistPhase: 0 })
    expect(a.R1).toBeGreaterThan(0.5)
    expect(b.R1).toBeLessThan(0.5)
  })

  it('stays inside the axis range at full depth and full input', () => {
    for (const velocity of [-1, 0, 1]) {
      for (const pos of [0, 0.5, 1]) {
        for (let tp = 0; tp < 1; tp += 0.1) {
          const a = synthAxes({ pos, velocity, twistPhase: tp }, { depth: 1, twist: true, roll: true, surge: true })
          for (const v of Object.values(a)) {
            expect(v).toBeGreaterThanOrEqual(0)
            expect(v).toBeLessThanOrEqual(1)
          }
        }
      }
    }
  })

  it('emits nothing for axes that are switched off', () => {
    const a = synthAxes(base, { depth: 0.5, twist: false, roll: false, surge: false })
    expect(Object.keys(a)).toHaveLength(0)
  })

  it('collapses to centre at zero depth', () => {
    const a = synthAxes({ pos: 1, velocity: 1, twistPhase: 0.25 }, { depth: 0, twist: true, roll: true, surge: true })
    for (const v of Object.values(a))
      expect(v).toBeCloseTo(0.5, 6)
  })
})

describe('synthTargets', () => {
  it('never touches a channel the script already drives', () => {
    expect(synthTargets(['L0'], DEFAULT_SYNTH)).toEqual(['R0', 'R1'])
    expect(synthTargets(['L0', 'R0'], DEFAULT_SYNTH)).toEqual(['R1'])
    expect(synthTargets(['L0', 'R0', 'R1'], DEFAULT_SYNTH)).toEqual([])
  })

  it('respects which axes are enabled', () => {
    expect(synthTargets(['L0'], { depth: 1, twist: false, roll: true, surge: true }))
      .toEqual(['R1', 'L1'])
  })
})
