import { describe, expect, it } from 'vitest'
import {
  applyCurve,
  axisOfSource,
  knownSource,
  localSpeed,
  mapVibe,
  musicLevel,
  quantize,
  scriptFastSpeed,
  scriptSpeedLevel,
  shouldSend,
  smoothLevel,
  speedToLevel,
  strokePulse,
  vibeScriptFrom,
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

describe('script speed scaled to the script itself', () => {
  /** Strokes between 0 and `depth` at `perSec` half-strokes a second, from `from` ms for `ms`. */
  function strokes(from: number, ms: number, perSec: number, depth = 0.9) {
    const out: { at: number, pos: number }[] = []
    const step = 1000 / perSec
    for (let t = 0, i = 0; t <= ms; t += step, i++)
      out.push({ at: from + t, pos: i % 2 ? depth : 0 })
    return out
  }

  it('keeps a brisk script from pinning the toy: calm parts sit well below the peaks', async () => {
    const { scriptFastSpeed, scriptSpeedLevel } = await import('~/lib/vibeMap')
    // 30 s at ~140 strokes a minute, then 30 s at ~70.
    const actions = [...strokes(0, 30000, 4.7), ...strokes(30200, 30000, 2.35)]
    const fast = scriptFastSpeed(actions)
    const hi = scriptSpeedLevel(localSpeed(actions, 15000), fast)
    const calm = scriptSpeedLevel(localSpeed(actions, 45000), fast)
    expect(hi).toBeGreaterThan(0.8)
    expect(hi).toBeLessThanOrEqual(1)
    expect(calm).toBeLessThan(0.55)
    expect(calm).toBeGreaterThan(0.3)
    // The fixed scale pins the calm part near the top too.
    expect(speedToLevel(localSpeed(actions, 45000))).toBeGreaterThan(0.8)
  })

  it('falls back to the fixed scale for scripts too short to measure', async () => {
    const { scriptFastSpeed, scriptSpeedLevel } = await import('~/lib/vibeMap')
    expect(scriptFastSpeed([{ at: 0, pos: 0 }, { at: 500, pos: 1 }])).toBeNull()
    expect(scriptSpeedLevel(1.2, null)).toBeCloseTo(speedToLevel(1.2))
  })
})

describe('feeling each stroke', () => {
  it('dips toward the top of a stroke by the pulse amount', () => {
    expect(strokePulse(0.8, 0, 0.5)).toBeCloseTo(0.8)
    expect(strokePulse(0.8, 1, 0.5)).toBeCloseTo(0.4)
    expect(strokePulse(0.8, 1, 0)).toBeCloseTo(0.8)
  })

  it('pulses through the smoothing on a steady 143 spm triangle, and is flat without it', () => {
    const half = 60000 / 143 / 2
    const actions = Array.from({ length: 200 }, (_, i) => ({ at: Math.round(i * half), pos: i % 2 ? 94 : 6 }))
    const fast = scriptFastSpeed(actions)
    const range = { min: 0.1, max: 1, curve: 'linear' as const }
    const swing = (pulse: number) => {
      let smooth = 0
      const seen: number[] = []
      for (let t = 0; t < 20000; t += 50) {
        let level = scriptSpeedLevel(localSpeed(actions, t), fast)
        if (pulse > 0) {
          const i = Math.min(actions.length - 2, Math.floor(t / half))
          const f = (t - actions[i].at) / (actions[i + 1].at - actions[i].at)
          level = strokePulse(level, (actions[i].pos + (actions[i + 1].pos - actions[i].pos) * f) / 100, pulse)
        }
        smooth = pulse > 0 ? smoothLevel(smooth, mapVibe(level, range), 50, 30, 60) : smoothLevel(smooth, mapVibe(level, range), 50)
        if (t > 5000)
          seen.push(smooth)
      }
      return Math.max(...seen) - Math.min(...seen)
    }
    expect(swing(0)).toBeLessThan(0.02)
    expect(swing(0.5)).toBeGreaterThan(0.25)
  })
})

describe('sources', () => {
  it('reads the axis a source follows, and drops sources it does not know', () => {
    expect(axisOfSource('axis-R0')).toBe('R0')
    expect(axisOfSource('script-speed')).toBeNull()
    expect(knownSource('axis-R2')).toBe('axis-R2')
    expect(knownSource('from-the-future')).toBeNull()
  })
})

describe('a vibe track from a stroke script', () => {
  it('swells at the bottom of each stroke and goes quiet through a hold', () => {
    const strokes = Array.from({ length: 40 }, (_, i) => ({ at: i * 300, pos: i % 2 ? 0.9 : 0.1 }))
    const hold = [...strokes, { at: 39 * 300 + 6000, pos: 0.9 }]
    const out = vibeScriptFrom(hold, { min: 0.1, max: 1, curve: 'linear', pulse: 0.6 })
    const mid = out.filter(a => a.at > 3000 && a.at < 9000)
    const bottoms = mid.filter(a => strokes.find(s => s.at === a.at)?.pos === 0.1).map(a => a.pos)
    const tops = mid.filter(a => strokes.find(s => s.at === a.at)?.pos === 0.9).map(a => a.pos)
    expect(Math.min(...bottoms)).toBeGreaterThan(Math.max(...tops))
    expect(out.filter(a => a.at > 39 * 300 + 1500 && a.at < 39 * 300 + 4500).every(a => a.pos === 0)).toBe(true)
    expect(out.every(a => a.pos >= 0 && a.pos <= 100)).toBe(true)
  })
})
