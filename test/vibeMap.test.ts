import { describe, expect, it } from 'vitest'
import {
  applyCurve,
  localSpeed,
  mapVibe,
  musicLevel,
  quantize,
  shouldSend,
  smoothLevel,
  speedToLevel,
} from '../src/lib/vibeMap'

describe('curves and mapping', () => {
  it('keeps the ends fixed for every curve', () => {
    for (const c of ['linear', 'gentle', 'punchy'] as const) {
      expect(applyCurve(0, c)).toBe(0)
      expect(applyCurve(1, c)).toBe(1)
    }
    expect(applyCurve(0.5, 'gentle')).toBeLessThan(0.5)
    expect(applyCurve(0.5, 'punchy')).toBeGreaterThan(0.5)
  })

  it('goes fully quiet inside the dead zone instead of sitting at the floor', () => {
    expect(mapVibe(0, { min: 0.2, max: 1, curve: 'linear' })).toBe(0)
    expect(mapVibe(0.01, { min: 0.2, max: 1, curve: 'linear' })).toBe(0)
    expect(mapVibe(Number.NaN, { min: 0.2, max: 1, curve: 'linear' })).toBe(0)
  })

  it('maps into the range', () => {
    const s = { min: 0.2, max: 0.8, curve: 'linear' as const }
    expect(mapVibe(1, s)).toBeCloseTo(0.8)
    expect(mapVibe(0.5, s)).toBeCloseTo(0.5)
    expect(mapVibe(0.05, s)).toBeCloseTo(0.23)
  })

  it('tolerates min and max given the wrong way round', () => {
    expect(mapVibe(1, { min: 0.9, max: 0.3, curve: 'linear' })).toBeCloseTo(0.9)
  })

  it('scales by effective intensity last, so an edge goes below the floor', () => {
    const s = { min: 0.4, max: 1, curve: 'linear' as const }
    expect(mapVibe(1, s, 0.5)).toBeCloseTo(0.5)
    expect(mapVibe(0.5, s, 0.15)).toBeCloseTo(0.7 * 0.15)
    expect(mapVibe(1, s, 0)).toBe(0)
  })
})

describe('script speed', () => {
  const strokes = Array.from({ length: 21 }, (_, i) => ({ at: i * 500, pos: i % 2 ? 1 : 0 }))

  it('measures distance per second around the playhead', () => {
    // Full range every 500 ms: 2 units a second.
    expect(localSpeed(strokes, 5000)).toBeCloseTo(2)
    expect(localSpeed(strokes, 5000, 250)).toBeCloseTo(2)
  })

  it('is zero on a still stretch and before the script starts', () => {
    const still = [{ at: 0, pos: 0.5 }, { at: 10_000, pos: 0.5 }]
    expect(localSpeed(still, 5000)).toBe(0)
    expect(localSpeed(strokes, -5000)).toBe(0)
    expect(localSpeed([], 0)).toBe(0)
  })

  it('counts only the part of a segment inside the window', () => {
    const slow = [{ at: 0, pos: 0 }, { at: 10_000, pos: 1 }]
    // 0.1 units/s everywhere along the segment.
    expect(localSpeed(slow, 5000, 1000)).toBeCloseTo(0.1)
    // Half the window hangs past the end of the script.
    expect(localSpeed(slow, 10_000, 1000)).toBeCloseTo(0.05)
  })

  it('saturates without pinning', () => {
    expect(speedToLevel(0)).toBe(0)
    expect(speedToLevel(1.2)).toBeCloseTo(1 - Math.exp(-1))
    expect(speedToLevel(3)).toBeLessThan(1)
    expect(speedToLevel(3)).toBeGreaterThan(speedToLevel(2))
  })
})

describe('music', () => {
  it('lifts on the beat and sits a little lower between', () => {
    expect(musicLevel(0.5, null)).toBe(0.5)
    expect(musicLevel(0.5, 0)).toBeGreaterThan(0.5)
    expect(musicLevel(0.5, 0.9)).toBeLessThan(0.5)
    expect(musicLevel(1, 0)).toBe(1)
  })
})

describe('smoothing and sending', () => {
  it('rises faster than it falls', () => {
    const up = smoothLevel(0, 1, 50, 80, 250)
    const down = 1 - smoothLevel(1, 0, 50, 80, 250)
    expect(up).toBeGreaterThan(down)
    expect(smoothLevel(0.3, 0.9, 0)).toBe(0.3)
  })

  it('rate-limits and ignores tiny changes', () => {
    const g = { value: 0.5, at: 1000 }
    expect(shouldSend({ value: null, at: 0 }, 0.5, 0)).toBe(true)
    expect(shouldSend(g, 0.9, 1050)).toBe(false)
    expect(shouldSend(g, 0.51, 1200)).toBe(false)
    expect(shouldSend(g, 0.6, 1200)).toBe(true)
    expect(shouldSend(g, 0.5, 5000)).toBe(false)
  })

  it('always lets a stop or a full-on through once the interval allows', () => {
    expect(shouldSend({ value: 0.01, at: 0 }, 0, 200)).toBe(true)
    expect(shouldSend({ value: 0.99, at: 0 }, 1, 200)).toBe(true)
    expect(shouldSend({ value: 0.01, at: 0 }, 0, 50)).toBe(false)
  })

  it('quantizes and clamps', () => {
    expect(quantize(0.503)).toBe(0.5)
    expect(quantize(-1)).toBe(0)
    expect(quantize(2)).toBe(1)
  })
})
