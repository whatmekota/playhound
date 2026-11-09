import type { LevelInput, LevelState } from '~/lib/estim'
import { describe, expect, it } from 'vitest'
import {
  amplitude,
  balanceMix,
  clampCarrier,
  FALL_PER_SEC,
  isLive,
  LIVE_MS,
  MAX_RISE_PER_SEC,
  mixFor,
  outputProblem,
  SILENCE,
  START_SEC,
  startDuration,
  stepLevel,
  targetLevel,
  threePhaseMix,
} from '~/lib/estim'

const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps

describe('threePhaseMix (restim continuous)', () => {
  it('is even on all three electrodes at the centre', () => {
    const m = threePhaseMix(0, 0)
    expect(amplitude(m.left)).toBeCloseTo(1, 9)
    expect(amplitude(m.right)).toBeCloseTo(1, 9)
    // L = cos(θ+30°), R = cos(θ−30°): 60° apart, so L−R (the third pair) is as strong.
    const diff = { c: m.left.c - m.right.c, s: m.left.s - m.right.s }
    expect(amplitude(diff)).toBeCloseTo(1, 9)
  })

  it('puts it all on the common electrode at alpha 1', () => {
    const m = threePhaseMix(1, 0)
    // L and R identical: no current between them.
    expect(close(m.left.c, m.right.c) && close(m.left.s, m.right.s)).toBe(true)
    expect(amplitude(m.left)).toBeCloseTo(Math.sqrt(3) / 2, 9)
  })

  it('runs it between left and right at alpha −1', () => {
    const m = threePhaseMix(-1, 0)
    // Opposite phase, equal size: the common electrode carries nothing.
    expect(m.left.c + m.right.c).toBeCloseTo(0, 9)
    expect(m.left.s + m.right.s).toBeCloseTo(0, 9)
    expect(amplitude(m.left)).toBeCloseTo(0.5, 9)
  })

  it('never asks a channel for more than full scale, anywhere in the circle or outside it', () => {
    for (let a = -1.5; a <= 1.5; a += 0.05) {
      for (let b = -1.5; b <= 1.5; b += 0.05) {
        const m = threePhaseMix(a, b)
        expect(amplitude(m.left)).toBeLessThanOrEqual(1 + 1e-9)
        expect(amplitude(m.right)).toBeLessThanOrEqual(1 + 1e-9)
      }
    }
  })

  it('survives nonsense', () => {
    const m = threePhaseMix(Number.NaN, Number.POSITIVE_INFINITY)
    expect(Number.isFinite(m.left.c + m.left.s + m.right.c + m.right.s)).toBe(true)
  })
})

describe('mixFor', () => {
  it('maps the stroke onto alpha for three-phase: bottom is left–right, top the common electrode', () => {
    expect(mixFor('threephase', 0)).toEqual(threePhaseMix(-1, 0))
    expect(mixFor('threephase', 0.5)).toEqual(threePhaseMix(0, 0))
    expect(mixFor('threephase', 1)).toEqual(threePhaseMix(1, 0))
  })

  it('pans at constant power for two channels', () => {
    expect(amplitude(balanceMix(0).left)).toBeCloseTo(1, 9)
    expect(amplitude(balanceMix(0).right)).toBeCloseTo(0, 9)
    expect(amplitude(balanceMix(1).right)).toBeCloseTo(1, 9)
    for (let p = 0; p <= 1; p += 0.1) {
      const m = mixFor('balance', p)
      expect(amplitude(m.left) ** 2 + amplitude(m.right) ** 2).toBeCloseTo(1, 9)
    }
  })

  it('clamps positions outside 0–1', () => {
    expect(mixFor('balance', -3)).toEqual(mixFor('balance', 0))
    expect(mixFor('threephase', 7)).toEqual(mixFor('threephase', 1))
  })
})

describe('clampCarrier', () => {
  it('keeps the carrier in 300–1500 Hz', () => {
    expect(clampCarrier(100)).toBe(300)
    expect(clampCarrier(5000)).toBe(1500)
    expect(clampCarrier(700.4)).toBe(700)
    expect(clampCarrier(Number.NaN)).toBe(700)
  })
})

const on: LevelInput = { armed: true, panicked: false, live: true, volume: 0.2, ceiling: 0.5, intensity: 1 }

/** Step at 25 ms for `sec` seconds, recording every level. */
function run(state: LevelState, input: LevelInput, sec: number, dt = 0.025) {
  const levels: number[] = []
  let s = state
  for (let t = 0; t < sec - 1e-9; t += dt) {
    s = stepLevel(s, input, dt)
    levels.push(s.level)
  }
  return { state: s, levels }
}

describe('targetLevel', () => {
  it('is silent unless armed, live and not panicked', () => {
    expect(targetLevel(on)).toBeCloseTo(0.2)
    expect(targetLevel({ ...on, armed: false })).toBe(0)
    expect(targetLevel({ ...on, live: false })).toBe(0)
    expect(targetLevel({ ...on, panicked: true })).toBe(0)
  })

  it('never goes over the ceiling', () => {
    expect(targetLevel({ ...on, volume: 0.9, ceiling: 0.3 })).toBeCloseTo(0.3)
    expect(targetLevel({ ...on, volume: 0.9, ceiling: 7 })).toBeLessThanOrEqual(1)
  })

  it('is scaled by the intensity knob and edges', () => {
    expect(targetLevel({ ...on, intensity: 0.5 })).toBeCloseTo(0.1)
    expect(targetLevel({ ...on, intensity: 0 })).toBe(0)
  })
})

describe('stepLevel', () => {
  it('starts from silence and takes at least START_SEC to get there', () => {
    const { levels } = run(SILENCE, on, START_SEC + 1)
    expect(levels[0]).toBeGreaterThan(0)
    expect(levels[0]).toBeLessThan(0.002)
    const reachedAt = levels.findIndex(l => l >= 0.2 - 1e-9) * 0.025
    expect(reachedAt).toBeGreaterThanOrEqual(START_SEC - 0.05)
    expect(reachedAt).toBeLessThan(START_SEC + 0.1)
    // An even rise: no step bigger than the average.
    for (let i = 1; i < levels.length; i++)
      expect(levels[i] - levels[i - 1]).toBeLessThanOrEqual(0.2 / START_SEC * 0.025 + 1e-9)
  })

  it('takes longer than START_SEC for a loud start, never rising faster than MAX_RISE_PER_SEC', () => {
    const loud = { ...on, volume: 0.9, ceiling: 1 }
    const { levels } = run(SILENCE, loud, 12)
    for (let i = 1; i < levels.length; i++)
      expect(levels[i] - levels[i - 1]).toBeLessThanOrEqual(MAX_RISE_PER_SEC * 0.025 + 1e-9)
    expect(startDuration(0.9)).toBeCloseTo(9)
    expect(startDuration(0.2)).toBeCloseTo(START_SEC)
  })

  it('never jumps up, even with a huge or broken time step', () => {
    for (const dt of [5, 1000, Number.POSITIVE_INFINITY, Number.NaN, -1]) {
      const s = stepLevel(SILENCE, { ...on, volume: 1, ceiling: 1 }, dt)
      expect(s.level).toBeLessThanOrEqual(MAX_RISE_PER_SEC * 0.25 + 1e-9)
    }
  })

  it('rises at MAX_RISE_PER_SEC when the volume goes up while running', () => {
    const running = run(SILENCE, on, 6).state
    expect(running.level).toBeCloseTo(0.2)
    const next = stepLevel(running, { ...on, volume: 0.4 }, 0.1)
    expect(next.level - running.level).toBeCloseTo(MAX_RISE_PER_SEC * 0.1)
  })

  it('fades out fast on pause or stop, and is then silent', () => {
    const running = run(SILENCE, on, 6).state
    const paused = run(running, { ...on, live: false }, 0.2)
    expect(paused.state.level).toBe(0)
    for (let i = 1; i < paused.levels.length; i++)
      expect(paused.levels[i - 1] - paused.levels[i]).toBeLessThanOrEqual(FALL_PER_SEC * 0.025 + 1e-9)
    expect(run(running, { ...on, armed: false }, 0.2).state.level).toBe(0)
  })

  it('starts again from silence after a pause', () => {
    const running = run(SILENCE, on, 6).state
    const paused = run(running, { ...on, live: false }, 1).state
    const back = run(paused, on, 1)
    // A second in, a fresh start is a fifth of the way there, not back at full.
    expect(back.state.level).toBeCloseTo(0.2 / START_SEC, 3)
  })

  it('panic is silence at once, with no ramp, from any level', () => {
    const running = run(SILENCE, { ...on, volume: 1, ceiling: 1 }, 20).state
    expect(running.level).toBeCloseTo(1)
    const s = stepLevel(running, { ...on, panicked: true }, 0.001)
    expect(s.level).toBe(0)
    expect(s.starting).toBe(false)
    // Panic holds it there whatever else says go.
    expect(run(s, { ...on, panicked: true, volume: 1, ceiling: 1 }, 2).state.level).toBe(0)
  })

  it('a lowered ceiling clamps at once', () => {
    const running = run(SILENCE, { ...on, volume: 0.5 }, 10).state
    expect(running.level).toBeCloseTo(0.5)
    const s = stepLevel(running, { ...on, volume: 0.5, ceiling: 0.1 }, 0.001)
    expect(s.level).toBeLessThanOrEqual(0.1)
  })

  it('is disarmed and silent by default', () => {
    expect(SILENCE).toEqual({ level: 0, starting: false })
    expect(stepLevel(SILENCE, { ...on, armed: false }, 1).level).toBe(0)
  })
})

describe('isLive', () => {
  it('is live only while commands keep coming', () => {
    expect(isLive(1000, 1000 + LIVE_MS)).toBe(true)
    expect(isLive(1000, 1000 + LIVE_MS + 1)).toBe(false)
    expect(isLive(Number.NEGATIVE_INFINITY, 0)).toBe(false)
  })
})

describe('outputProblem', () => {
  const devices = [
    { deviceId: 'default', label: 'Default - Speakers', groupId: 'g-speakers' },
    { deviceId: 'communications', label: 'Communications - Speakers', groupId: 'g-speakers' },
    { deviceId: 'spk', label: 'Speakers', groupId: 'g-speakers' },
    { deviceId: 'usb', label: 'USB Audio', groupId: 'g-usb' },
  ]

  it('accepts a named output that is not the default', () => {
    expect(outputProblem('usb', devices)).toBeNull()
  })

  it('refuses no choice, the default by name, and the default under its own name', () => {
    expect(outputProblem('', devices)).toMatch(/Pick/)
    expect(outputProblem('default', devices)).toMatch(/default/)
    expect(outputProblem('communications', devices)).toMatch(/default/)
    expect(outputProblem('spk', devices)).toMatch(/default/)
  })

  it('refuses an output that is gone', () => {
    expect(outputProblem('usb', devices.filter(d => d.deviceId !== 'usb'))).toMatch(/not there/)
  })
})
