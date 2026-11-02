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
    // A 2x size gap put linear (~2x) and the noise floor uncomfortably close on
    // a busy machine, so this compares 1x against 4x: linear lands near 4x and
    // quadratic near 16x, which survives scheduler jitter. Timings take the
    // best of several runs for the same reason, and each run repeats the call
    // for at least 20 ms: the quarter takes about a millisecond, and one
    // scheduler hiccup on a CI runner was enough to read 9x for linear code.
    const base = longScript()
    const quarter = base.slice(0, Math.floor(base.length / 4))

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
    best(quarter)
    best(base)

    // Linear is ~4x, quadratic ~16x.
    const ratio = best(base) / best(quarter)
    expect(ratio).toBeLessThan(10)
  })

  it('stays fast for repeated phase lookups during playback', () => {
    const peaks = detectPeaks(longScript())
    const t0 = performance.now()
    for (let i = 0; i < 10000; i++)
      strokePhaseAt(peaks, (i * 360) % (60 * 60 * 1000))
    expect(performance.now() - t0).toBeLessThan(120)
  })
})
