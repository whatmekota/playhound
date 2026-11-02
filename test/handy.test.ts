import { describe, expect, it } from 'vitest'
import { clockOffset, HANDY_DRIFT_MS, HANDY_SYNC_EARLY_MS, HANDY_SYNC_LATE_MS, handyError, handyScript, scriptKey, stepHandy } from '../src/lib/handy'

const FULL = { knob: 1, min: 0, max: 1, invert: false }
const strokes = [{ at: 0, pos: 0 }, { at: 400, pos: 1 }, { at: 800, pos: 0 }, { at: 1200, pos: 1 }]

describe('handyScript', () => {
  it('is the script in whole percent at full range and knob', () => {
    expect(handyScript(strokes, FULL)).toEqual([{ at: 0, pos: 0 }, { at: 400, pos: 100 }, { at: 800, pos: 0 }, { at: 1200, pos: 100 }])
  })

  it('bakes in the stroke range and direction', () => {
    expect(handyScript(strokes, { ...FULL, min: 0.2, max: 0.8 }).map(a => a.pos)).toEqual([20, 80, 20, 80])
    expect(handyScript(strokes, { ...FULL, min: 0.2, max: 0.8, invert: true }).map(a => a.pos)).toEqual([80, 20, 80, 20])
  })

  it('takes the knob: a turned-down knob gives shorter strokes on the same beats', () => {
    const low = handyScript(strokes, { ...FULL, knob: 0.3 })
    expect(low.map(a => a.at)).toEqual([0, 400, 800, 1200])
    const travel = Math.max(...low.map(a => a.pos)) - Math.min(...low.map(a => a.pos))
    expect(travel).toBeLessThan(100)
  })

  it('keeps one action per millisecond, and copes with nothing', () => {
    expect(handyScript([{ at: 0, pos: 0 }, { at: 100.2, pos: 0.5 }, { at: 99.8, pos: 1 }].sort((a, b) => a.at - b.at), FULL))
      .toEqual([{ at: 0, pos: 0 }, { at: 100, pos: 50 }])
    expect(handyScript([], FULL)).toEqual([])
  })
})

describe('scriptKey', () => {
  it('differs for different scripts and matches for the same', () => {
    expect(scriptKey('a')).toBe(scriptKey('a'))
    expect(scriptKey('a')).not.toBe(scriptKey('b'))
  })
})

describe('clockOffset', () => {
  it('takes each answer as half a round trip old', () => {
    // Server is 1000 ms ahead; every round trip is 100 ms.
    const samples = [0, 200, 400].map(t => ({ sent: t, received: t + 100, server: t + 50 + 1000 }))
    expect(clockOffset(samples)).toBeCloseTo(1000)
  })

  it('drops the slowest round trips', () => {
    const fast = Array.from({ length: 8 }, (_, i) => ({ sent: i * 100, received: i * 100 + 40, server: i * 100 + 20 + 500 }))
    // A request that sat in a queue: answered late, and its server time is not mid-trip.
    const slow = [{ sent: 900, received: 2900, server: 950 + 500 }, { sent: 3000, received: 5000, server: 3050 + 500 }]
    expect(clockOffset([...fast, ...slow])).toBeCloseTo(500)
  })

  it('is zero with nothing to go on', () => {
    expect(clockOffset([])).toBe(0)
  })
})

describe('handyError', () => {
  it('reads both answer shapes', () => {
    expect(handyError({ error: { connected: false, name: 'DeviceNotConnected', message: 'Device not connected', code: 1001 } }, 200))
      .toEqual({ message: 'Device not connected', offline: true })
    expect(handyError({ name: 'Bad request', message: 'Invalid connection key or channel reference' }, 400))
      .toEqual({ message: 'Invalid connection key or channel reference', offline: false })
    expect(handyError({ error: { name: '', message: 'Unauthenticated' } }, 401))
      .toEqual({ message: 'Unauthenticated', offline: false })
  })

  it('is null for a good answer', () => {
    expect(handyError({ result: { connected: true } }, 200)).toBeNull()
    expect(handyError(null, 200)).toBeNull()
  })
})

describe('stepHandy', () => {
  const want = (at: number, rate = 1, playing = true) => ({ playing, at, rate })

  it('plays on start, then stays quiet while the video runs in step', () => {
    const first = stepHandy(null, want(5000), 100_000)
    expect(first.cmd).toEqual({ kind: 'play', at: 5000, rate: 1 })
    const later = stepHandy(first.run, want(5500), 100_500)
    expect(later.cmd).toBeNull()
  })

  it('plays again after a seek, and when the speed changes', () => {
    const { run } = stepHandy(null, want(5000), 100_000)
    expect(stepHandy(run, want(60_000), 100_100).cmd).toEqual({ kind: 'play', at: 60_000, rate: 1 })
    expect(stepHandy(run, want(5100, 1.5), 100_100).cmd).toEqual({ kind: 'play', at: 5100, rate: 1.5 })
  })

  it('lets small jitter through without a new play', () => {
    const { run } = stepHandy(null, want(5000), 100_000)
    expect(stepHandy(run, want(5100 + HANDY_DRIFT_MS - 10), 100_100).cmd).toBeNull()
  })

  it('tracks a faster video as running faster', () => {
    const { run } = stepHandy(null, want(5000, 2), 100_000)
    expect(stepHandy(run, want(6000, 2), 100_500).cmd).toBeNull()
  })

  it('stops when play is no longer wanted, once', () => {
    const { run } = stepHandy(null, want(5000), 100_000)
    const stopped = stepHandy(run, want(5100, 1, false), 100_100)
    expect(stopped.cmd).toEqual({ kind: 'stop' })
    expect(stepHandy(stopped.run, want(5100, 1, false), 100_200).cmd).toBeNull()
  })

  it('nudges the clock every 2 s at first, then every 10 s', () => {
    let { run } = stepHandy(null, want(0), 0)
    const syncs: number[] = []
    for (let t = 0; t <= 40_000; t += 100) {
      const step = stepHandy(run, want(t), t)
      run = step.run
      if (step.cmd?.kind === 'synctime')
        syncs.push(t)
    }
    const early = HANDY_SYNC_EARLY_MS
    expect(syncs.slice(0, 5)).toEqual([early, 2 * early, 3 * early, 4 * early, 5 * early])
    expect(syncs[5] - syncs[4]).toBe(HANDY_SYNC_LATE_MS)
  })

  it('never asks for a negative start', () => {
    expect(stepHandy(null, want(-300), 0).cmd).toEqual({ kind: 'play', at: 0, rate: 1 })
  })
})
