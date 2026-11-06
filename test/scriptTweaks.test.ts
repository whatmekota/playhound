import type { ScaleAction } from '../src/lib/scriptScale'
import { describe, expect, it } from 'vitest'
import { segmentSpeed } from '../src/lib/scriptEdit'
import {
  applyTweaks,
  bakeOffset,
  DEFAULT_TWEAKS,
  describeTweaks,
  isDefaultTweaks,
  normaliseTweaks,
  shapeIsIdentity,
  smoothActions,
} from '../src/lib/scriptTweaks'

const tw = (p: Partial<typeof DEFAULT_TWEAKS>) => ({ ...DEFAULT_TWEAKS, ...p })
/** Full strokes every `ms`. */
const strokes = (n: number, ms: number): ScaleAction[] => Array.from({ length: n }, (_, i) => ({ at: i * ms, pos: i % 2 ? 1 : 0 }))

describe('normaliseTweaks', () => {
  it('fills defaults and clamps nonsense', () => {
    expect(normaliseTweaks(undefined)).toEqual(DEFAULT_TWEAKS)
    expect(normaliseTweaks({ min: 120, max: -5, invert: 'yes', speedCap: 10, smooth: 'heavy', offsetMs: 1e9 }))
      .toEqual({ min: 0, max: 100, invert: false, speedCap: 50, smooth: 'off', offsetMs: 9999 })
    expect(normaliseTweaks({ min: 80, max: 20 })).toMatchObject({ min: 20, max: 80 })
  })

  it('tells shape tweaks from the offset', () => {
    expect(shapeIsIdentity(tw({ offsetMs: 100 }))).toBe(true)
    expect(isDefaultTweaks(tw({ offsetMs: 100 }))).toBe(false)
    expect(shapeIsIdentity(tw({ invert: true }))).toBe(false)
    expect(describeTweaks(tw({ min: 10, max: 90, invert: true, speedCap: 300, smooth: 'light', offsetMs: -50 })))
      .toEqual(['Range 10–90', 'Inverted', 'Max 300/s', 'Light smoothing', '-50 ms'])
  })
})

describe('applyTweaks', () => {
  it('is a copy when nothing is set', () => {
    const a = strokes(4, 500)
    const out = applyTweaks(a, DEFAULT_TWEAKS)
    expect(out).toEqual(a)
    expect(out[0]).not.toBe(a[0])
  })

  it('remaps the range and inverts', () => {
    const a = [{ at: 0, pos: 0 }, { at: 500, pos: 1 }, { at: 1000, pos: 0.5 }]
    expect(applyTweaks(a, tw({ min: 20, max: 80 })).map(x => x.pos)).toEqual([0.2, 0.8, 0.5])
    expect(applyTweaks(a, tw({ invert: true })).map(x => x.pos)).toEqual([1, 0, 0.5])
    // Inverting within a range keeps the range.
    const both = applyTweaks(a, tw({ min: 20, max: 80, invert: true })).map(x => x.pos)
    expect(both[0]).toBeCloseTo(0.8)
    expect(both[1]).toBeCloseTo(0.2)
  })

  it('caps speed by shortening travel, never moving points in time', () => {
    const a = strokes(20, 100) // 1000 units/s
    const out = applyTweaks(a, tw({ speedCap: 400 }))
    expect(out.map(x => x.at)).toEqual(a.map(x => x.at))
    for (let i = 1; i < out.length; i++)
      expect(segmentSpeed(out[i - 1], out[i])).toBeLessThanOrEqual(400 + 1e-6)
    // Slow strokes are left alone.
    const slow = strokes(6, 1000)
    expect(applyTweaks(slow, tw({ speedCap: 400 }))).toEqual(slow)
  })

  it('applies the cap after the range, so the cap holds on the output', () => {
    const a = strokes(10, 200) // 500 units/s at full range
    const out = applyTweaks(a, tw({ min: 0, max: 50, speedCap: 200 }))
    for (let i = 1; i < out.length; i++)
      expect(segmentSpeed(out[i - 1], out[i])).toBeLessThanOrEqual(200 + 1e-6)
  })

  it('smooths without moving points in time or adding any', () => {
    const jitter: ScaleAction[] = Array.from({ length: 60 }, (_, i) => ({ at: i * 33, pos: 0.5 + (i % 2 ? 0.05 : -0.05) }))
    const out = smoothActions(jitter, 50)
    expect(out).toHaveLength(jitter.length)
    expect(out.map(x => x.at)).toEqual(jitter.map(x => x.at))
    // The jitter is mostly gone in the middle.
    for (let i = 5; i < 55; i++)
      expect(Math.abs(out[i].pos - 0.5)).toBeLessThan(0.03)
    // Ends stay put.
    expect(out[0].pos).toBe(jitter[0].pos)
  })

  it('smoothing softens a hand-made stroke only a little, medium more than light', () => {
    const a = strokes(10, 500)
    const light = applyTweaks(a, tw({ smooth: 'light' }))
    const medium = applyTweaks(a, tw({ smooth: 'medium' }))
    const peak = 3 // a top
    expect(light[peak].pos).toBeLessThan(1)
    expect(light[peak].pos).toBeGreaterThan(0.85)
    expect(medium[peak].pos).toBeLessThan(light[peak].pos)
    // A hold stays a hold.
    const hold = [{ at: 0, pos: 0.3 }, { at: 400, pos: 0.3 }, { at: 800, pos: 0.3 }]
    expect(smoothActions(hold, 100).map(x => x.pos)).toEqual([0.3, 0.3, 0.3])
  })
})

describe('bakeOffset', () => {
  it('moves points earlier for a positive offset, keeping the start', () => {
    const a = [{ at: 0, pos: 0 }, { at: 1000, pos: 1 }, { at: 2000, pos: 0 }]
    const out = bakeOffset(a, 500)
    expect(out[0]).toEqual({ at: 0, pos: 0.5 })
    expect(out.slice(1)).toEqual([{ at: 500, pos: 1 }, { at: 1500, pos: 0 }])
    expect(bakeOffset(a, -250).map(x => x.at)).toEqual([250, 1250, 2250])
    expect(bakeOffset(a, 5000)).toEqual([])
    expect(bakeOffset(a, 0)).toEqual(a)
  })
})
