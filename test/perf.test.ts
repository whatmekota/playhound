import { describe, expect, it } from 'vitest'
import { buildEnvelope, detectPeaks, strokePhaseAt } from '../src/lib/funscriptAnalysis'

/** A long, dense script: one hour at roughly 8 actions per second. */
function longScript() {
  const DURATION_MS = 60 * 60 * 1000
  const actions: { at: number, pos: number }[] = []
  let t = 0
  let up = true
  while (t < DURATION_MS) {
    actions.push({ at: t, pos: up ? 0.9 : 0.1 })
    up = !up
    t += 125
  }
  return actions
}

describe('analysis performance', () => {
  it('analyses an hour-long dense script fast enough to not block loading', () => {
    const actions = longScript()
    expect(actions.length).toBeGreaterThan(25000)

    const t0 = performance.now()
    const peaks = detectPeaks(actions)
    const env = buildEnvelope(actions)
    const ms = performance.now() - t0

    expect(peaks.length).toBeGreaterThan(10000)
    expect(env.length).toBeGreaterThan(14000)

    // The quadratic version took seconds here and froze the UI on video change.
    expect(ms).toBeLessThan(400)
  })

  it('scales roughly linearly, not quadratically, with script length', () => {
    // Linear code does not time as linear: allocation and garbage collection
    // grow with the input too, and a 4x size gap read 9-10x on a busy runner.
    // So this compares 1x against 8x, where linear lands around 8-20x and
    // quadratic at 64x. Timings take the best of several runs, and each run
    // repeats the call for at least 20 ms, since the small one takes well
    // under a millisecond.
    const base = longScript()
    const eighth = base.slice(0, Math.floor(base.length / 8))

    const perCall = (a: typeof base) => {
      let calls = 0
      const t0 = performance.now()
      do {
        buildEnvelope(a)
        calls++
      } while (performance.now() - t0 < 20)
      return (performance.now() - t0) / calls
    }
    const best = (a: typeof base) => {
      let min = Number.POSITIVE_INFINITY
      for (let i = 0; i < 5; i++)
        min = Math.min(min, perCall(a))
      return min
    }

    // Warm up so JIT compilation does not land inside a measured run.
    best(eighth)
    best(base)

    const ratio = best(base) / best(eighth)
    expect(ratio).toBeLessThan(32)
  })

  it('stays fast for repeated phase lookups during playback', () => {
    const peaks = detectPeaks(longScript())
    const t0 = performance.now()
    for (let i = 0; i < 10000; i++)
      strokePhaseAt(peaks, (i * 360) % (60 * 60 * 1000))
    expect(performance.now() - t0).toBeLessThan(120)
  })
})
