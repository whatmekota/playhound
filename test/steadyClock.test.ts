import { describe, expect, it } from 'vitest'
import { createSteadyClock } from '~/lib/steadyClock'

/** A clock that is right on average but reports in uneven steps. */
function jittery(trueMs: number, i: number) {
  return trueMs + [0, -4, 2, -3, 3, -1][i % 6]
}

describe('createSteadyClock', () => {
  it('turns uneven steps into an even run at the playback rate', () => {
    const c = createSteadyClock()
    const frame = 6.9
    const out: number[] = []
    for (let i = 0; i < 400; i++) {
      const now = 1000 + i * frame
      out.push(c.read(jittery(30_000 + i * frame, i), now, 1, true))
    }
    // After settling, every frame advances by close to the frame time.
    const steps = out.slice(200).map((t, i, a) => (i ? t - a[i - 1] : frame)).slice(1)
    for (const s of steps)
      expect(Math.abs(s - frame)).toBeLessThan(0.8)
    // And it stays on the video's time.
    expect(Math.abs(out.at(-1)! - (30_000 + 399 * frame))).toBeLessThan(4)
  })

  it('never runs backwards while playing', () => {
    const c = createSteadyClock()
    let prev = -Infinity
    for (let i = 0; i < 200; i++) {
      const t = c.read(jittery(i * 16.7, i * 5), i * 16.7, 1, true)
      expect(t).toBeGreaterThanOrEqual(prev)
      prev = t
    }
  })

  it('follows a seek, a pause and the rate at once', () => {
    const c = createSteadyClock()
    c.read(10_000, 0, 1, true)
    c.read(10_016, 16, 1, true)
    expect(c.read(60_000, 32, 1, true)).toBe(60_000)
    expect(c.read(60_005, 48, 1, false)).toBe(60_005)
    // Playing again, twice as fast: picks up where it is, not a frame ahead.
    expect(c.read(60_005, 64, 2, true)).toBe(60_005)
    expect(c.read(60_037, 80, 2, true)).toBeCloseTo(60_037, 0)
  })
})
