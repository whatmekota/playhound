import { describe, expect, it } from 'vitest'
import { createLiveTempo } from '../src/lib/liveTempo'

/** A deterministic pseudo-random sequence, so the tests never flake. */
function rng(seed = 1) {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

/**
 * A busy bar at `bpm`, as hit times (ms) and strengths: kick on every beat,
 * snare on two and four, hats on the eighths, and two syncopated hits (on the
 * "and" of one-and-a-half, and a sixteenth before four) that fold into wrong
 * tempos when only neighbouring gaps are looked at.
 */
function busyTrack(sections: { bpm: number, seconds: number }[]) {
  const hits: { t: number, s: number }[] = []
  let t0 = 0
  for (const { bpm, seconds } of sections) {
    const beat = 60000 / bpm
    const bars = Math.floor((seconds * 1000) / (beat * 4))
    for (let bar = 0; bar < bars; bar++) {
      const b = t0 + bar * beat * 4
      for (let i = 0; i < 4; i++)
        hits.push({ t: b + i * beat, s: 1 })
      hits.push({ t: b + beat, s: 0.8 }, { t: b + 3 * beat, s: 0.8 })
      for (let i = 0; i < 8; i++)
        hits.push({ t: b + i * beat / 2, s: 0.35 })
      hits.push({ t: b + 1.5 * beat, s: 0.7 }, { t: b + 2.75 * beat, s: 0.6 })
    }
    t0 += bars * beat * 4
  }
  return { hits: hits.sort((a, b) => a.t - b.t), end: t0 }
}

/** Analyser frames (~60 a second, unevenly), each with the onset strength since the last. */
function frames(track: ReturnType<typeof busyTrack>, seed = 3) {
  const r = rng(seed)
  const out: { t: number, flux: number }[] = []
  let h = 0
  for (let t = 0; t < track.end; t += 16.7 + (r() - 0.5) * 6) {
    let flux = r() * 0.05
    while (h < track.hits.length && track.hits[h].t <= t) {
      flux += track.hits[h].s
      h++
    }
    out.push({ t, flux })
  }
  return out
}

describe('live tempo', () => {
  it('holds a busy 118 bpm track steady', () => {
    const track = busyTrack([{ bpm: 118, seconds: 60 }])
    const tempo = createLiveTempo()
    const seen: number[] = []
    for (const f of frames(track)) {
      tempo.push(f.flux, f.t)
      if (f.t > 10000 && tempo.bpm)
        seen.push(tempo.bpm)
    }
    expect(Math.min(...seen)).toBeGreaterThan(117)
    expect(Math.max(...seen)).toBeLessThan(119)
  })

  it('follows a real change of tempo within a few seconds', () => {
    const track = busyTrack([{ bpm: 118, seconds: 30 }, { bpm: 140, seconds: 30 }])
    const tempo = createLiveTempo()
    let switchedAt = 0
    // Where the second section starts: the first is whole bars of 118.
    const change = Math.floor(30000 / (60000 / 118 * 4)) * (60000 / 118 * 4)
    for (const f of frames(track)) {
      tempo.push(f.flux, f.t)
      if (!switchedAt && f.t > change && Math.abs(tempo.bpm - 140) < 3)
        switchedAt = f.t
    }
    expect(switchedAt).toBeGreaterThan(0)
    expect(switchedAt - change).toBeLessThan(7000)
    expect(Math.abs(tempo.bpm - 140)).toBeLessThan(2)
  })

  it('starts over after a long silence or a jump back in time', () => {
    const tempo = createLiveTempo()
    for (const f of frames(busyTrack([{ bpm: 128, seconds: 20 }])))
      tempo.push(f.flux, f.t)
    expect(Math.abs(tempo.bpm - 128)).toBeLessThan(2)
    tempo.push(0.1, 100)
    expect(tempo.bpm).toBe(0)
  })
})
