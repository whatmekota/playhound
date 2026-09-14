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
    const base = longScript()
    const half = base.slice(0, Math.floor(base.length / 2))

    const timeIt = (a: typeof base) => {
      const t0 = performance.now()
      buildEnvelope(a)
      return performance.now() - t0
    }

    // Warm up so JIT differences do not dominate the comparison.
    timeIt(half)
    timeIt(base)

    const tHalf = Math.max(0.5, timeIt(half))
    const tFull = timeIt(base)

    // Linear would be ~2x; quadratic ~4x. Allow generous headroom for noise.
    expect(tFull / tHalf).toBeLessThan(3)
  })

  it('stays fast for repeated phase lookups during playback', () => {
    const peaks = detectPeaks(longScript())
    const t0 = performance.now()
    for (let i = 0; i < 10000; i++)
      strokePhaseAt(peaks, (i * 360) % (60 * 60 * 1000))
    expect(performance.now() - t0).toBeLessThan(120)
  })
})
