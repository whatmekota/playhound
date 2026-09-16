import { describe, expect, it } from 'vitest'
import {
  beatPhaseAt,
  createOnsetDetector,
  estimatePeriod,
  periodToBpm,
  spectralFlux,
} from '../src/lib/beatDetect'

describe('spectralFlux', () => {
  it('counts rises and ignores falls', () => {
    const a = new Float32Array([0, 0, 0, 0])
    const up = new Float32Array([1, 1, 1, 1])
    expect(spectralFlux(a, up)).toBeCloseTo(1)
    expect(spectralFlux(up, a)).toBe(0)
  })

  it('is zero for an unchanged spectrum', () => {
    const a = new Float32Array([3, -2, 7, 0])
    expect(spectralFlux(a, a)).toBe(0)
  })

  it('handles mismatched lengths without reading past the end', () => {
    expect(() => spectralFlux(new Float32Array(4), new Float32Array(8))).not.toThrow()
    expect(spectralFlux(new Float32Array(0), new Float32Array(0))).toBe(0)
  })
})

describe('createOnsetDetector', () => {
  /** Quiet background with a spike every `periodMs`. */
  function run(periodMs: number, frames = 400, frameMs = 23) {
    const det = createOnsetDetector()
    const onsets: number[] = []
    for (let i = 0; i < frames; i++) {
      const t = i * frameMs
      const onBeat = Math.abs((t % periodMs)) < frameMs
      const flux = onBeat ? 1 : 0.05 + Math.random() * 0.02
      if (det.push(flux, t))
        onsets.push(t)
    }
    return onsets
  }

  it('finds spikes and ignores the noise floor', () => {
    const onsets = run(500)
    // ~400 frames * 23ms = 9.2s at 2 beats/sec, minus warm-up
    expect(onsets.length).toBeGreaterThan(10)
    expect(onsets.length).toBeLessThan(25)
  })

  it('never reports two onsets closer than the minimum gap', () => {
    const det = createOnsetDetector({ minGapMs: 200 })
    const fired: number[] = []
    for (let i = 0; i < 200; i++) {
      // Every frame is a huge spike; the gap must still be respected.
      if (det.push(i < 10 ? 0.05 : 10, i * 20))
        fired.push(i * 20)
    }
    for (let i = 1; i < fired.length; i++)
      expect(fired[i] - fired[i - 1]).toBeGreaterThanOrEqual(200)
  })

  it('reports nothing for a flat signal', () => {
    const det = createOnsetDetector()
    let count = 0
    for (let i = 0; i < 300; i++) {
      if (det.push(0.5, i * 23))
        count++
    }
    expect(count).toBe(0)
  })

  it('can be reset', () => {
    const det = createOnsetDetector()
    for (let i = 0; i < 50; i++) det.push(0.1, i * 23)
    det.reset()
    expect(det.push(0.1, 0)).toBe(false)
  })
})

describe('estimatePeriod', () => {
  function beats(periodMs: number, n: number, jitter = 0) {
    return Array.from({ length: n }, (_, i) =>
      i * periodMs + (jitter ? (Math.random() * 2 - 1) * jitter : 0))
  }

  it('recovers a steady tempo', () => {
    expect(estimatePeriod(beats(500, 20))!).toBeCloseTo(500, 0)
    expect(periodToBpm(estimatePeriod(beats(500, 20))!)).toBeCloseTo(120, 0)
  })

  it('survives jitter', () => {
    const p = estimatePeriod(beats(462, 30, 12))!
    expect(p).toBeGreaterThan(430)
    expect(p).toBeLessThan(495)
  })

  it('folds octaves into the musical range', () => {
    // Onsets on every eighth note of a 120bpm track -> 250ms apart.
    const p = estimatePeriod(beats(250, 20))!
    expect(p).toBeCloseTo(500, 0)
    // Onsets every two beats -> 1000ms apart, still the same grid.
    expect(estimatePeriod(beats(1600, 20))!).toBeCloseTo(800, 0)
  })

  it('ignores a few spurious onsets', () => {
    const b = beats(500, 20)
    b.splice(5, 0, b[5] + 90) // an extra hit between beats
    b.splice(12, 1) // and a missed one
    expect(estimatePeriod(b)!).toBeCloseTo(500, -1)
  })

  it('returns null without enough evidence', () => {
    expect(estimatePeriod([])).toBeNull()
    expect(estimatePeriod([0, 500, 1000])).toBeNull()
  })
})

describe('beatPhaseAt', () => {
  it('is 0 on the beat and 0.5 halfway between', () => {
    expect(beatPhaseAt(1000, 500, 1000)).toBeCloseTo(0)
    expect(beatPhaseAt(1000, 500, 1250)).toBeCloseTo(0.5)
    expect(beatPhaseAt(1000, 500, 1500)).toBeCloseTo(0)
  })

  it('keeps extrapolating well past the last onset', () => {
    expect(beatPhaseAt(0, 500, 10250)).toBeCloseTo(0.5)
  })

  it('stays in 0..1 before the last onset', () => {
    const p = beatPhaseAt(1000, 500, 700)
    expect(p).toBeGreaterThanOrEqual(0)
    expect(p).toBeLessThan(1)
  })
})
