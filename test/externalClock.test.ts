import { describe, expect, it } from 'vitest'
import { createExternalClock } from '~/lib/externalClock'

/** A repeatable 0–1 sequence. */
function rand(seed = 7) {
  let s = seed
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648
    return s / 2147483648
  }
}

describe('external clock', () => {
  it('follows late, uneven reports smoothly and never steps back', () => {
    const r = rand()
    const clock = createExternalClock()
    // The headset plays from 10 s; it reports every 150–350 ms, each report
    // arriving 20–160 ms after it was sent.
    const trueAt = (now: number) => 10_000 + now
    const reports: { arrive: number, time: number }[] = []
    for (let sent = 0; sent < 20_000; sent += 150 + r() * 200)
      reports.push({ arrive: sent + 20 + r() * 140, time: trueAt(sent) / 1000 })
    reports.sort((a, b) => a.arrive - b.arrive)

    let next = 0
    let last = -Infinity
    const steps: number[] = []
    for (let now = 0; now < 20_000; now += 16) {
      while (next < reports.length && reports[next].arrive <= now) {
        clock.update({ time: reports[next].time, playing: true }, reports[next].arrive)
        next++
      }
      if (!clock.started)
        continue
      const { timeMs, playing } = clock.read(now)
      expect(playing).toBe(true)
      expect(timeMs).toBeGreaterThanOrEqual(last)
      if (now > 2000) {
        // Behind by about the reports' delay, never far off.
        expect(Math.abs(timeMs - trueAt(now))).toBeLessThan(220)
        steps.push(timeMs - last)
      }
      last = timeMs
    }
    // Frame to frame it moves at the video's pace, within the ±10% it may bend.
    expect(Math.min(...steps)).toBeGreaterThanOrEqual(16 * 0.9 - 1e-6)
    expect(Math.max(...steps)).toBeLessThanOrEqual(16 * 1.1 + 1e-6)
  })

  it('jumps on a seek and says so', () => {
    const clock = createExternalClock()
    expect(clock.update({ time: 5, playing: true }, 0)).toEqual(['play'])
    expect(clock.update({ time: 5.25, playing: true }, 250)).toEqual([])
    expect(clock.update({ time: 60, playing: true }, 500)).toEqual(['seek'])
    expect(clock.read(500).timeMs).toBe(60_000)
    expect(clock.read(600).timeMs).toBeCloseTo(60_100)
  })

  it('stops on pause, and follows a scrub while paused', () => {
    const clock = createExternalClock()
    clock.update({ time: 1, playing: true }, 0)
    expect(clock.update({ time: 2, playing: false }, 1000)).toEqual(['pause'])
    expect(clock.read(5000)).toMatchObject({ timeMs: 2000, playing: false })
    expect(clock.update({ time: 2, playing: false }, 1250)).toEqual([])
    expect(clock.update({ time: 30, playing: false }, 1500)).toEqual(['seek'])
    expect(clock.read(1600).timeMs).toBe(30_000)
    expect(clock.update({ time: 30, playing: true }, 2000)).toEqual(['play'])
    expect(clock.read(2500).timeMs).toBeCloseTo(30_500)
  })

  it('runs at the reported speed', () => {
    const clock = createExternalClock()
    clock.update({ time: 0, playing: true, rate: 2 }, 0)
    expect(clock.read(1000)).toMatchObject({ timeMs: 2000, rate: 2 })
    // Nonsense speeds are taken as normal.
    clock.update({ time: 2, playing: true, rate: Number.NaN }, 1000)
    expect(clock.read(2000).timeMs).toBeCloseTo(3000)
  })

  it('stops by itself when the other app goes quiet', () => {
    const clock = createExternalClock({ staleMs: 2000 })
    clock.update({ time: 0, playing: true }, 0)
    expect(clock.read(1500)).toMatchObject({ playing: true, stale: false })
    const quiet = clock.read(5000)
    expect(quiet).toMatchObject({ playing: false, stale: true })
    // Frozen where the silence started to count.
    expect(quiet.timeMs).toBeCloseTo(2000)
    // A report brings it back.
    expect(clock.update({ time: 5, playing: true }, 5000)).toContain('play')
    expect(clock.read(5100)).toMatchObject({ playing: true, stale: false })
  })
})
