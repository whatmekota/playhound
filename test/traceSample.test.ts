import { describe, expect, it } from 'vitest'
import { TRACE_IDLE_MS, traceSampleTime } from '~/lib/traceSample'

/** A straight stroke: where the device loop puts the axis at `t`. */
const stroke = (t: number) => t / 1000

describe('traceSampleTime', () => {
  it('plots an output at the time it was worked out, not the frame that read it', () => {
    expect(traceSampleTime(1000, 990, 1006)).toBe(1000)
  })

  it('plots nothing for an output already plotted, until the axis has been left alone', () => {
    expect(traceSampleTime(1000, 1000, 1007)).toBeNull()
    expect(traceSampleTime(1000, 1000, 1000 + TRACE_IDLE_MS - 1)).toBeNull()
    expect(traceSampleTime(1000, 1000, 1000 + TRACE_IDLE_MS)).toBe(1000 + TRACE_IDLE_MS)
  })

  it('plots a stand-in value (nothing sent yet) at the frame', () => {
    expect(traceSampleTime(undefined, undefined, 500)).toBe(500)
  })

  it('keeps a straight stroke straight through missed frames and timer ticks', () => {
    // The device loop: every 7 ms on a frame, then no frame for a while and
    // one tick off its timer, 24 ms on. The trace reads at each frame, 5 ms
    // after the loop ran when all is well.
    const loopAt = [0, 7, 14, 21, 28, 52, 58, 65, 72]
    const frames = [5, 12, 19, 26, 33, 40, 56, 63, 70, 77]
    const drawn: { t: number, p: number }[] = []
    const naive: { t: number, p: number }[] = []
    let plotted: number | undefined
    for (const now of frames) {
      const stamp = loopAt.filter(t => t <= now).at(-1)!
      naive.push({ t: now, p: stroke(stamp) })
      const t = traceSampleTime(stamp, plotted, now)
      if (t !== null) {
        drawn.push({ t, p: stroke(stamp) })
        plotted = stamp
      }
    }
    // Every point drawn is on the stroke.
    for (const s of drawn)
      expect(s.p).toBeCloseTo(stroke(s.t), 9)
    // Read at the frame, the same values are 5, then 12, then 4 ms behind it: the kink.
    const off = naive.map(s => stroke(s.t) - s.p)
    expect(Math.max(...off) - Math.min(...off)).toBeGreaterThan(0.005)
  })
})
