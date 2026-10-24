import { describe, expect, it } from 'vitest'
import {
  createBeatGrid,
  createEnergyFollower,
  createSubdivisionHold,
  phaseDelta,
  pickStrokesPerBeat,
  steerPhase,
} from '../src/lib/musicMotion'

const BAND = { lo: 35, hi: 140 }

describe('pickStrokesPerBeat', () => {
  it('takes PMV tempos down to a musical subdivision instead of the ceiling', () => {
    // The old behaviour: one stroke per beat, 166 → 166 spm, pinned at 150.
    expect(166 * pickStrokesPerBeat(166, BAND, 150)).toBeCloseTo(83)
    expect(180 * pickStrokesPerBeat(180, BAND, 150)).toBeCloseTo(90)
  })

  it('keeps different tempos at different rates', () => {
    const a = 140 * pickStrokesPerBeat(140, BAND, 150)
    const b = 180 * pickStrokesPerBeat(180, BAND, 150)
    expect(a).not.toBeCloseTo(b)
  })

  it('lets loudness pick between subdivisions that fit the band', () => {
    expect(pickStrokesPerBeat(140, BAND, 150, 0)).toBe(0.25)
    expect(pickStrokesPerBeat(140, BAND, 150, 0.5)).toBe(0.5)
    expect(pickStrokesPerBeat(140, BAND, 150, 1)).toBe(1)
  })

  it('never goes over the ceiling, at any tempo or loudness', () => {
    for (let bpm = 50; bpm <= 240; bpm += 7) {
      for (const e of [0, 0.3, 0.7, 1]) {
        const k = pickStrokesPerBeat(bpm, { lo: 20, hi: 400 }, 120, e)
        if (bpm * 0.25 <= 120)
          expect(bpm * k).toBeLessThanOrEqual(120)
      }
    }
  })

  it('doubles a slow track when that is what fits', () => {
    expect(pickStrokesPerBeat(60, { lo: 100, hi: 140 }, 150)).toBe(2)
  })
})

describe('createBeatGrid', () => {
  it('locks to a steady beat', () => {
    const g = createBeatGrid()
    g.setPeriod(500)
    for (let t = 1000; t <= 5000; t += 500)
      expect(g.onset(t)).toBe(true)
    expect(g.beatsAt(5000)).toBeCloseTo(8)
    expect(g.beatsAt(5250) % 1).toBeCloseTo(0.5)
    expect(g.confidence()).toBe(1)
  })

  it('ignores off-beat hits instead of resetting the phase on them', () => {
    const g = createBeatGrid()
    g.setPeriod(500)
    g.onset(1000)
    for (let t = 1500; t <= 6000; t += 500) {
      g.onset(t)
      // Hi-hat on the off-beat.
      expect(g.onset(t + 250)).toBe(false)
    }
    // Still on the beat, not dragged half a beat over.
    expect(Math.abs(phaseDelta(g.beatsAt(6000) % 1, 0))).toBeLessThan(0.02)
  })

  it('follows a beat that drifts, a little at a time', () => {
    const g = createBeatGrid()
    g.setPeriod(500)
    g.onset(1000)
    // Every beat lands 30ms late.
    for (let i = 1; i <= 20; i++)
      g.onset(1000 + i * 500 + 30)
    expect(Math.abs(phaseDelta(g.beatsAt(1000 + 20 * 500 + 30) % 1, 0))).toBeLessThan(0.01)
  })

  it('re-anchors when it has lost the beat completely', () => {
    const g = createBeatGrid()
    g.setPeriod(500)
    g.onset(1000)
    // The track jumps: beats now fall a quarter beat later.
    for (let i = 1; i <= 12; i++)
      g.onset(1125 + i * 500)
    expect(Math.abs(phaseDelta(g.beatsAt(1125 + 13 * 500) % 1, 0))).toBeLessThan(0.05)
  })
})

describe('createSubdivisionHold', () => {
  it('only switches on a bar line, after the new choice has held', () => {
    const h = createSubdivisionHold(4)
    expect(h.update(0.5, 0.5)).toBe(0.5)
    // Louder mid-bar: not yet.
    expect(h.update(1.5, 1)).toBe(0.5)
    expect(h.update(3.9, 1)).toBe(0.5)
    // Next bar line: switch.
    expect(h.update(4.1, 1)).toBe(1)
  })

  it('ignores a choice that flickers back before the bar line', () => {
    const h = createSubdivisionHold(4)
    h.update(0.2, 0.5)
    h.update(1.0, 1)
    h.update(2.0, 0.5)
    expect(h.update(4.2, 0.5)).toBe(0.5)
  })
})

describe('steerPhase', () => {
  it('pulls onto the target without jumping', () => {
    let phase = 0.3
    const target = (t: number) => (t * 1.5) % 1
    let t = 0
    let maxStep = 0
    for (let i = 0; i < 600; i++) {
      const dt = 1 / 60
      const next = steerPhase(phase, target(t), 1.5, dt)
      maxStep = Math.max(maxStep, Math.abs(phaseDelta(phase, next)))
      phase = next
      t += dt
    }
    expect(Math.abs(phaseDelta(phase, target(t)))).toBeLessThan(0.02)
    // At most 20% faster than the rate, per frame.
    expect(maxStep).toBeLessThanOrEqual(1.5 * 1.2 / 60 + 1e-9)
  })

  it('never exceeds the ceiling while catching up', () => {
    const dt = 1 / 60
    const next = steerPhase(0, 0.45, 2, dt, { maxRateHz: 2 })
    expect(next).toBeLessThanOrEqual(2 * dt + 1e-9)
  })
})

describe('createEnergyFollower', () => {
  it('rises fast, falls slowly, and stays within 0–1', () => {
    const f = createEnergyFollower()
    for (let i = 0; i < 120; i++)
      f.push(-60, 1 / 30)
    let e = 0
    for (let i = 0; i < 15; i++)
      e = f.push(-20, 1 / 30)
    expect(e).toBeGreaterThan(0.7)
    let after = e
    for (let i = 0; i < 10; i++)
      after = f.push(-60, 1 / 30)
    // A third of a second of quiet does not throw it to the floor.
    expect(after).toBeGreaterThan(0.4)
    expect(after).toBeLessThanOrEqual(1)
    expect(after).toBeGreaterThanOrEqual(0)
  })
})

describe('beat grid confidence', () => {
  it('counts eighth-note hits as agreeing with the beat', () => {
    const g = createBeatGrid()
    g.setPeriod(500)
    g.onset(1000)
    for (let t = 1500; t <= 9000; t += 500) {
      g.onset(t - 250)
      g.onset(t)
    }
    expect(g.confidence()).toBe(1)
  })

  it('stays low for hits with no steady relation to the beat', () => {
    const g = createBeatGrid()
    g.setPeriod(500)
    g.onset(1000)
    // Scattered between the beat and the half beat, never the same place twice running.
    const offsets = [0.13, 0.33, 0.71, 0.87, 0.21, 0.62, 0.38, 0.79]
    for (let i = 0; i < 16; i++)
      g.onset(1500 + i * 500 + offsets[i % offsets.length] * 500)
    expect(g.confidence()).toBeLessThan(0.5)
  })

  it('re-locks onto a steady beat that moved', () => {
    const g = createBeatGrid()
    g.setPeriod(500)
    g.onset(1000)
    for (let t = 1500; t <= 12000; t += 500)
      g.onset(t + 130)
    expect(g.confidence()).toBeGreaterThan(0.5)
  })
})
