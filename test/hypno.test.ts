import { describe, expect, it } from 'vitest'
import { breathRadius, flashOpacity, parseWords, spiralAngle, wordIndex } from '../src/lib/hypno'

describe('wordIndex', () => {
  it('advances every N pulses and wraps', () => {
    expect(wordIndex(0, 4, 3)).toBe(0)
    expect(wordIndex(3, 4, 3)).toBe(0)
    expect(wordIndex(4, 4, 3)).toBe(1)
    expect(wordIndex(8, 4, 3)).toBe(2)
    expect(wordIndex(12, 4, 3)).toBe(0)
  })

  it('copes with a silly step and an empty list', () => {
    expect(wordIndex(5, 0, 3)).toBe(2)
    expect(wordIndex(5, 4, 0)).toBe(-1)
  })
})

describe('flashOpacity', () => {
  it('starts and ends dark, peaks in the middle', () => {
    expect(flashOpacity(0)).toBeCloseTo(0, 5)
    expect(flashOpacity(0.5)).toBeCloseTo(1, 5)
    expect(flashOpacity(0.999)).toBeLessThan(0.05)
  })

  it('stays within 0..1 all the way round', () => {
    for (let p = -1; p < 2; p += 0.013) {
      const v = flashOpacity(p)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })

  it('holds longer when asked to', () => {
    const brief = flashOpacity(0.25, 0.1)
    const long = flashOpacity(0.25, 0.8)
    expect(long).toBeGreaterThan(brief)
  })
})

describe('spiralAngle', () => {
  it('is one turn per elapsed turn, and reverses', () => {
    expect(spiralAngle(1)).toBeCloseTo(Math.PI * 2)
    expect(spiralAngle(1, -1)).toBeCloseTo(-Math.PI * 2)
    expect(spiralAngle(0)).toBe(0)
  })
})

describe('breathRadius', () => {
  it('is smallest at the turn and largest at the top of the inhale', () => {
    expect(breathRadius(0)).toBeCloseTo(0.35, 5)
    expect(breathRadius(0.4)).toBeCloseTo(1, 5)
  })

  it('spends longer contracting than expanding', () => {
    // With a 0.4 inhale, the quarter after the peak is still high, and the
    // matching quarter before it has already climbed.
    const expandMid = breathRadius(0.2)
    const contractMid = breathRadius(0.7)
    expect(expandMid).toBeGreaterThan(0.35)
    expect(contractMid).toBeGreaterThan(0.35)
    expect(breathRadius(0.99)).toBeLessThan(0.5)
  })

  it('stays within its bounds', () => {
    for (let p = 0; p < 1; p += 0.01) {
      const r = breathRadius(p)
      expect(r).toBeGreaterThanOrEqual(0.35)
      expect(r).toBeLessThanOrEqual(1)
    }
  })
})

describe('parseWords', () => {
  it('splits on newlines and commas, trimming blanks', () => {
    expect(parseWords('deeper,\n  relax ,,\nfocus\n')).toEqual(['deeper', 'relax', 'focus'])
  })

  it('returns nothing for empty input', () => {
    expect(parseWords('   \n , ')).toEqual([])
  })

  it('caps the list', () => {
    expect(parseWords(Array.from({ length: 500 }, (_, i) => `w${i}`).join(','))).toHaveLength(200)
  })
})
