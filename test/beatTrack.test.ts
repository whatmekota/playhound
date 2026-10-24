import { describe, expect, it } from 'vitest'
import {
  analyseBeats,
  beatNumbers,
  createAnalysedGrid,
  createFFT,
  normalisePerBeat,
} from '../src/lib/beatTrack'

const SR = 22050

function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Kind = 'kick' | 'hat' | 'snare'

/** Mix a percussive hit into `out` at `t` seconds. */
function hit(out: Float32Array, t: number, amp: number, kind: Kind, rand: () => number) {
  const start = Math.round(t * SR)
  const len = Math.round(SR * (kind === 'hat' ? 0.04 : 0.15))
  let prev = 0
  for (let i = 0; i < len && start + i < out.length; i++) {
    const s = i / SR
    let v = 0
    if (kind === 'kick') {
      v = Math.sin(2 * Math.PI * (55 + 80 * Math.exp(-s * 30)) * s) * Math.exp(-s * 18)
      v += (rand() * 2 - 1) * Math.exp(-s * 300) * 0.5
    }
    else if (kind === 'snare') {
      v = (rand() * 2 - 1) * Math.exp(-s * 25) * 0.7 + Math.sin(2 * Math.PI * 190 * s) * Math.exp(-s * 30) * 0.5
    }
    else {
      const w = rand() * 2 - 1
      v = (w - prev) * Math.exp(-s * 90) * 0.6
      prev = w
    }
    if (start + i >= 0)
      out[start + i] += v * amp
  }
}

interface Section {
  bpm: number
  seconds: number
  /** Offset of the first beat from the section start, seconds. */
  offset?: number
  /** Beat index (within the section) of the first downbeat. */
  downbeatAt?: number
  /** Off-beat hats at this fraction of the beat (0.5 straight, 2/3 swung). */
  offbeat?: number
  silent?: boolean
}

/** A synthetic track and the true beat times. */
function track(sections: Section[], seed = 1) {
  const rand = rng(seed)
  const total = sections.reduce((a, s) => a + s.seconds, 0)
  const out = new Float32Array(Math.round(total * SR))
  const beats: number[] = []
  const downbeats: number[] = []
  let t0 = 0
  for (const s of sections) {
    if (!s.silent) {
      const p = 60 / s.bpm
      for (let k = 0, t = t0 + (s.offset ?? 0.25); t < t0 + s.seconds - 0.2; k++, t += p) {
        const down = (k - (s.downbeatAt ?? 0)) % 4 === 0
        hit(out, t, down ? 1 : 0.55, 'kick', rand)
        if ((k - (s.downbeatAt ?? 0)) % 2 === 1)
          hit(out, t, 0.35, 'snare', rand)
        if (s.offbeat)
          hit(out, t + p * s.offbeat, 0.3, 'hat', rand)
        beats.push(t)
        if (down)
          downbeats.push(t)
      }
    }
    t0 += s.seconds
  }
  // A faint noise floor, as any real recording has.
  for (let i = 0; i < out.length; i++)
    out[i] += (rand() * 2 - 1) * 1e-4
  return { samples: out, beats, downbeats }
}

/** For each true beat, the distance to the nearest detected one (s). */
function errors(truth: number[], found: number[]): number[] {
  return truth.map(t => Math.min(...found.map(f => Math.abs(f - t))))
}

describe('createFFT', () => {
  it('matches a direct DFT', () => {
    const n = 64
    const fft = createFFT(n)
    const re = new Float64Array(n)
    const im = new Float64Array(n)
    const x = Array.from({ length: n }, (_, i) => Math.sin(i * 0.7) + 0.3 * Math.cos(i * 2.1) + (i % 5) * 0.1)
    x.forEach((v, i) => (re[i] = v))
    fft(re, im)
    for (const k of [0, 1, 5, 17, 31, 40]) {
      let r = 0
      let m = 0
      for (let i = 0; i < n; i++) {
        r += x[i] * Math.cos((2 * Math.PI * k * i) / n)
        m -= x[i] * Math.sin((2 * Math.PI * k * i) / n)
      }
      expect(re[k]).toBeCloseTo(r, 9)
      expect(im[k]).toBeCloseTo(m, 9)
    }
  })

  it('refuses sizes that are not powers of two', () => {
    expect(() => createFFT(100)).toThrow()
  })
})

describe('analyseBeats', () => {
  for (const bpm of [100, 120, 140, 180]) {
    it(`finds ${bpm} bpm and lands on the beats`, () => {
      const { samples, beats } = track([{ bpm, seconds: 30 }], bpm)
      const a = analyseBeats(samples, SR)
      expect(a.bpm).toBeGreaterThan(bpm - 1)
      expect(a.bpm).toBeLessThan(bpm + 1)
      // Every true beat after the first couple has a detected one within 15 ms.
      const err = errors(beats.slice(2, -2), a.beats)
      expect(Math.max(...err)).toBeLessThan(0.015)
      expect(a.beats.length).toBeGreaterThanOrEqual(beats.length - 3)
      expect(a.beats.length).toBeLessThanOrEqual(beats.length + 1)
      expect(a.confidence).toBeGreaterThan(0.7)
    })
  }

  it('keeps to the beat with swung off-beat hats', () => {
    const { samples, beats } = track([{ bpm: 120, seconds: 30, offbeat: 2 / 3 }], 7)
    const a = analyseBeats(samples, SR)
    expect(a.bpm).toBeCloseTo(120, 0)
    expect(Math.max(...errors(beats.slice(2, -2), a.beats))).toBeLessThan(0.015)
  })

  it('stays on the beat, not the off-beat, with straight eighth hats', () => {
    const { samples, beats } = track([{ bpm: 128, seconds: 30, offbeat: 0.5 }], 9)
    const a = analyseBeats(samples, SR)
    expect(a.bpm).toBeCloseTo(128, 0)
    expect(Math.max(...errors(beats.slice(2, -2), a.beats))).toBeLessThan(0.015)
  })

  it('follows a tempo change', () => {
    const { samples, beats } = track([{ bpm: 120, seconds: 24 }, { bpm: 150, seconds: 24, offset: 0 }], 3)
    const a = analyseBeats(samples, SR)
    // Away from the switch itself, every beat is found.
    const steady = beats.filter(t => t > 1 && (t < 21 || t > 27) && t < 47)
    expect(Math.max(...errors(steady, a.beats))).toBeLessThan(0.02)
  })

  it('marks a silent break as a gap and picks the beat up after it', () => {
    const { samples, beats } = track([
      { bpm: 140, seconds: 20 },
      { bpm: 140, seconds: 8, silent: true },
      // Re-enters out of phase with where the old grid would have been.
      { bpm: 140, seconds: 20, offset: 0.13 },
    ], 5)
    const a = analyseBeats(samples, SR)
    const gap = a.gaps.find(g => g.start < 24 && g.end > 24)
    expect(gap).toBeDefined()
    expect(gap!.start).toBeLessThan(21)
    expect(gap!.end).toBeGreaterThan(27.5)
    const after = beats.filter(t => t > 29.5 && t < 47)
    expect(Math.max(...errors(after, a.beats))).toBeLessThan(0.015)
  })

  it('finds the downbeat from where the kick is strongest', () => {
    const { samples, downbeats } = track([{ bpm: 124, seconds: 30, downbeatAt: 2 }], 11)
    const a = analyseBeats(samples, SR)
    const db = a.beats.filter((_, i) => a.barPos[i] === 0)
    expect(Math.max(...errors(downbeats.slice(1, -1), db))).toBeLessThan(0.015)
  })

  it('returns nothing, without failing, for silence or a blip', () => {
    const silent = analyseBeats(new Float32Array(SR * 5), SR)
    expect(silent.beats).toEqual([])
    expect(silent.confidence).toBe(0)
    expect(silent.gaps).toEqual([{ start: 0, end: 5 }])
    expect(analyseBeats(new Float32Array(100), SR).beats).toEqual([])
  })

  it('is not confident about noise', () => {
    const rand = rng(42)
    const x = new Float32Array(SR * 20)
    for (let i = 0; i < x.length; i++)
      x[i] = (rand() * 2 - 1) * 0.3
    expect(analyseBeats(x, SR).confidence).toBeLessThan(0.4)
  })

  it('analyses five minutes well within two seconds', () => {
    const { samples } = track([{ bpm: 140, seconds: 300, offbeat: 0.5 }], 2)
    let calls = 0
    const t = performance.now()
    const a = analyseBeats(samples, SR, { onProgress: () => calls++ })
    const ms = performance.now() - t
    expect(a.beats.length).toBeGreaterThan(650)
    expect(calls).toBeGreaterThan(10)
    expect(ms).toBeLessThan(2000)
  }, 20000)
})

describe('reading an analysis', () => {
  it('numbers beats so downbeats fall on multiples of four, skipping at a re-entry', () => {
    expect(beatNumbers({ barPos: [2, 3, 0, 1, 2, 3, 0] })).toEqual([2, 3, 4, 5, 6, 7, 8])
    // A new section comes in on its downbeat after beat 2 of a bar.
    expect(beatNumbers({ barPos: [0, 1, 0, 1] })).toEqual([0, 1, 4, 5])
  })

  it('normalises to 0–1 against the track itself', () => {
    const v = normalisePerBeat([-40, -30, -20, -10, -20, -30, -40], 0)
    expect(Math.min(...v)).toBe(0)
    expect(Math.max(...v)).toBe(1)
  })

  it('gives a continuous count with bar lines on the downbeats', () => {
    const beats = Array.from({ length: 40 }, (_, i) => 1 + i * 0.5)
    const grid = createAnalysedGrid({
      version: 1,
      duration: 22,
      bpm: 120,
      beats,
      energy: beats.map(() => -20),
      centroid: beats.map(() => 10),
      strength: beats.map(() => 1),
      barPos: beats.map((_, i) => (i + 3) % 4),
      confidence: 0.9,
      gaps: [],
    })!
    // Beat 1 is the downbeat (barPos 0), so it reads 4.
    expect(grid.at(1.5).beats).toBeCloseTo(4)
    expect(grid.at(1.75).beats).toBeCloseTo(4.5)
    expect(grid.at(1.75).bpm).toBeCloseTo(120)
    expect(grid.at(0.5).beats).toBeCloseTo(2)
    // Seeking backwards still finds the right beat.
    expect(grid.at(10.25).beats).toBeCloseTo(3 + 18.5)
    expect(grid.at(2.25).beats).toBeCloseTo(5.5)
  })
})
