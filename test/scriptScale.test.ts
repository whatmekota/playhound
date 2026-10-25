import type { Chapter } from '../src/lib/chapters'
import type { ScaleAction } from '../src/lib/scriptScale'
import { describe, expect, it } from 'vitest'
import { finishChapter, nextPeak } from '../src/lib/peakJump'
import { backOff, intensityParams, sampleScaled, scaleScript, turningPoints } from '../src/lib/scriptScale'

/** Deterministic pseudo-random, so failures reproduce. */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

/** Alternating strokes of varying length and speed, pos 0–1. */
function strokes(n: number, seed = 1): ScaleAction[] {
  const r = rng(seed)
  const out: ScaleAction[] = []
  let at = 0
  for (let i = 0; i < n; i++) {
    const mid = 0.3 + r() * 0.4
    const half = 0.05 + r() * 0.3
    out.push({ at, pos: i % 2 ? mid + half : mid - half })
    at += 60 + Math.round(r() * 700)
  }
  return out
}

/** Arbitrary script: holds, runs in one direction, duplicate positions. */
function messy(n: number, seed = 7): ScaleAction[] {
  const r = rng(seed)
  const out: ScaleAction[] = []
  let at = 0
  let pos = 0.5
  for (let i = 0; i < n; i++) {
    const roll = r()
    if (roll < 0.15) { /* hold */ }
    else {
      pos = Math.round(r() * 100) / 100
    }
    out.push({ at, pos })
    at += 30 + Math.round(r() * 900)
  }
  return out
}

/** Fastest segment, funscript units (0–100) per second. */
function maxSpeed(actions: ScaleAction[]): number {
  let max = 0
  for (let i = 1; i < actions.length; i++) {
    const dt = actions[i].at - actions[i - 1].at
    if (dt > 0)
      max = Math.max(max, (Math.abs(actions[i].pos - actions[i - 1].pos) * 100 * 1000) / dt)
  }
  return max
}

describe('intensityParams', () => {
  it('is untouched at full and gets gentler as it turns down', () => {
    expect(intensityParams(1)).toEqual({ amplitude: 1, speedCap: Number.POSITIVE_INFINITY })
    let prev = intensityParams(1)
    for (const i of [0.9, 0.7, 0.5, 0.3, 0.1]) {
      const p = intensityParams(i)
      expect(p.amplitude).toBeLessThan(prev.amplitude)
      expect(p.speedCap).toBeLessThan(prev.speedCap)
      prev = p
    }
  })

  it('clamps out-of-range knobs', () => {
    expect(intensityParams(0)).toEqual(intensityParams(0.1))
    expect(intensityParams(5)).toEqual(intensityParams(1))
  })
})

describe('turningPoints', () => {
  it('finds direction changes, including into and out of holds', () => {
    const a = [0, 1, 1, 0, 0.5, 0.8].map((pos, i) => ({ at: i * 100, pos }))
    expect(turningPoints(a)).toEqual([0, 1, 2, 3, 5])
  })
})

describe('scaleScript', () => {
  it('is the identity at intensity 1', () => {
    const a = messy(300)
    const s = scaleScript(a, intensityParams(1))
    expect(s.identity).toBe(true)
    expect(s.actions).toEqual(a)
  })

  it('never moves an action in time', () => {
    for (const i of [0.9, 0.5, 0.1]) {
      for (const a of [strokes(400), messy(400)]) {
        const s = scaleScript(a, intensityParams(i))
        expect(s.actions.map(x => x.at)).toEqual(a.map(x => x.at))
        expect(s.centres).toHaveLength(a.length)
      }
    }
  })

  it('shortens every stroke and keeps it around the same middle', () => {
    const a = strokes(400, 3)
    for (const i of [0.8, 0.5, 0.2]) {
      const s = scaleScript(a, intensityParams(i)).actions
      for (let k = 1; k < a.length; k++) {
        const before = Math.abs(a[k].pos - a[k - 1].pos)
        const after = Math.abs(s[k].pos - s[k - 1].pos)
        expect(after).toBeLessThanOrEqual(before + 1e-9)
      }
    }
  })

  it('stays inside the original range', () => {
    const a = messy(500, 11)
    const lo = Math.min(...a.map(x => x.pos))
    const hi = Math.max(...a.map(x => x.pos))
    const s = scaleScript(a, intensityParams(0.3)).actions
    for (const x of s) {
      expect(x.pos).toBeGreaterThanOrEqual(lo - 1e-9)
      expect(x.pos).toBeLessThanOrEqual(hi + 1e-9)
    }
  })

  it('respects the speed cap everywhere', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      for (const a of [strokes(300, seed), messy(300, seed)]) {
        for (const i of [0.8, 0.5, 0.2, 0.1]) {
          const p = intensityParams(i)
          const s = scaleScript(a, p).actions
          expect(maxSpeed(s)).toBeLessThanOrEqual(p.speedCap + 1e-6)
        }
      }
    }
  })

  it('keeps curved strokes curved: interior points stay in order', () => {
    const a = [0, 0.2, 0.7, 1, 0.6, 0].map((pos, i) => ({ at: i * 50, pos }))
    const s = scaleScript(a, intensityParams(0.4)).actions
    expect(s[0].pos).toBeLessThan(s[1].pos)
    expect(s[1].pos).toBeLessThan(s[2].pos)
    expect(s[2].pos).toBeLessThan(s[3].pos)
    expect(s[3].pos).toBeGreaterThan(s[4].pos)
    expect(s[4].pos).toBeGreaterThan(s[5].pos)
  })

  it('works on raw 0–100 scripts with range', () => {
    const a = strokes(200, 9).map(x => ({ at: x.at, pos: x.pos * 100 }))
    const p = intensityParams(0.3)
    const s = scaleScript(a, p, { range: 100 }).actions
    const norm = s.map(x => ({ at: x.at, pos: x.pos / 100 }))
    expect(maxSpeed(norm)).toBeLessThanOrEqual(p.speedCap + 1e-6)
  })
})

describe('sampleScaled and backOff', () => {
  it('samples like the player interpolates', () => {
    const a = [{ at: 0, pos: 0 }, { at: 1000, pos: 1 }]
    const s = scaleScript(a, intensityParams(1))
    expect(sampleScaled(s, 500).pos).toBeCloseTo(0.5)
    expect(sampleScaled(s, -10).pos).toBe(0)
    expect(sampleScaled(s, 5000).pos).toBe(1)
  })

  it('backs off toward the centre, fully at 1 and not at all at 0', () => {
    expect(backOff(0.9, 0.5, 0)).toBeCloseTo(0.9)
    expect(backOff(0.9, 0.5, 1)).toBeCloseTo(0.5)
    expect(backOff(0.9, 0.5, 0.5)).toBeCloseTo(0.7)
  })
})

function ch(index: number, start: number, end: number, kind: Chapter['kind'], avgSpeed: number): Chapter {
  return { index, start, end, kind, name: kind, avgSpeed, avgSpm: 0, source: 'auto' }
}

describe('peak jumps', () => {
  const chapters = [
    ch(0, 0, 10_000, 'slow', 0.3),
    ch(1, 10_000, 20_000, 'fast', 1.2),
    ch(2, 20_000, 30_000, 'medium', 0.8),
    ch(3, 30_000, 40_000, 'peak', 2),
    ch(4, 40_000, 50_000, 'slow', 0.4),
  ]

  it('goes to the next fast or peak chapter', () => {
    expect(nextPeak(chapters, 0)?.chapter.index).toBe(1)
    expect(nextPeak(chapters, 15_000)?.chapter.index).toBe(3)
  })

  it('wraps to the first peak after the last one', () => {
    const j = nextPeak(chapters, 45_000)
    expect(j?.chapter.index).toBe(1)
    expect(j?.wrapped).toBe(true)
  })

  it('falls back to the most intense chapter ahead when none is marked hot', () => {
    const calm = [ch(0, 0, 10_000, 'slow', 0.2), ch(1, 10_000, 20_000, 'medium', 0.9), ch(2, 20_000, 30_000, 'slow', 0.5)]
    expect(nextPeak(calm, 0)?.chapter.index).toBe(1)
    expect(nextPeak(calm, 15_000)).toBeNull()
  })

  it('finishes in the most intense chapter', () => {
    expect(finishChapter(chapters)?.index).toBe(3)
    expect(finishChapter([])).toBeNull()
  })
})
