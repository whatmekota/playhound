import { describe, expect, it } from 'vitest'
import { paceStrokesPerBeat, strokeVariation } from '../src/lib/musicMotion'

describe('music pace', () => {
  it('strokes on the beat when asked, under the ceiling', () => {
    expect(paceStrokesPerBeat('beat', 150, 150)).toBe(1)
    expect(paceStrokesPerBeat('half', 150, 150)).toBe(0.5)
    expect(paceStrokesPerBeat('double', 60, 150)).toBe(2)
  })

  it('lets the ceiling win: 180 bpm on the beat is half time under a 150 ceiling', () => {
    expect(paceStrokesPerBeat('beat', 180, 150)).toBe(0.5)
    expect(paceStrokesPerBeat('beat', 180, 200)).toBe(1)
    expect(paceStrokesPerBeat('double', 150, 200)).toBe(1)
  })
})

describe('stroke variation', () => {
  it('is plain with no variation', () => {
    for (let n = 0; n < 50; n++)
      expect(strokeVariation(n, 0, true)).toEqual({ times: 1, depth: 1 })
  })

  it('doubles in pairs, the same answer every time, and never past the ceiling', () => {
    const doubles: number[] = []
    for (let n = 0; n < 400; n++) {
      const v = strokeVariation(n, 1, true)
      expect(strokeVariation(n, 1, true)).toEqual(v)
      if (v.times === 2)
        doubles.push(n)
      expect(strokeVariation(n, 1, false).times).toBe(1)
    }
    // Some, not most.
    expect(doubles.length).toBeGreaterThan(40)
    expect(doubles.length).toBeLessThan(200)
    // Always both strokes of a pair.
    for (const n of doubles)
      expect(doubles).toContain(n % 2 ? n - 1 : n + 1)
  })

  it('makes some strokes shorter, more of them with more variation', () => {
    const shortCount = (a: number) => Array.from({ length: 400 }, (_, n) => strokeVariation(n, a, false)).filter(v => v.depth < 1).length
    expect(shortCount(0.3)).toBeLessThan(shortCount(1))
    for (let n = 0; n < 400; n++)
      expect(strokeVariation(n, 1, false).depth).toBeGreaterThanOrEqual(0.4)
  })
})
