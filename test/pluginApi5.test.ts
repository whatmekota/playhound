import type { SoundtrackAnalysis } from '~/lib/beatTrack'
import { describe, expect, it } from 'vitest'
import { musicSections } from '~/lib/musicSections'
import { strokeProfile } from '~/lib/strokeProfile'
import { musicPlan } from '~/plugins/api5'

/** A 128 bpm song from per-phrase loudness (dBFS), sixteen beats a phrase; `null` is a gap. */
function song(phrases: (number | null)[]): SoundtrackAnalysis {
  const beatS = 60 / 128
  const beats: number[] = []
  const energy: number[] = []
  const gaps: { start: number, end: number }[] = []
  phrases.forEach((db, p) => {
    for (let k = 0; k < 16; k++) {
      beats.push((p * 16 + k) * beatS)
      energy.push(db ?? -40)
    }
    if (db === null)
      gaps.push({ start: p * 16 * beatS, end: (p + 1) * 16 * beatS })
  })
  return {
    version: 1,
    duration: phrases.length * 16 * beatS,
    bpm: 128,
    beats,
    energy,
    centroid: beats.map(() => 10),
    strength: beats.map((_, i) => (i % 4 === 0 ? 2 : 1)),
    barPos: beats.map((_, i) => i % 4),
    confidence: 0.9,
    gaps,
  }
}

describe('musicSections', () => {
  it('finds the intro, build, drops, breakdown and outro', () => {
    const a = song([-24, -24, -18, -8, -8, null, -18, -8, -8, -24])
    const kinds = musicSections(a).map(s => s.kind)
    expect(kinds).toEqual(['intro', 'build', 'drop', 'breakdown', 'build', 'drop', 'outro'])
    const sections = musicSections(a)
    // Covers the song, each starting on a phrase's first beat.
    expect(sections[0].start).toBe(0)
    expect(sections.at(-1)!.end).toBeCloseTo(a.duration)
    const drop = sections[2]
    expect(drop.start).toBeCloseTo(a.beats[48])
    expect(drop.beat).toBe(48)
    expect(drop.level).toBe(1)
  })

  it('calls an even song one verse', () => {
    expect(musicSections(song([-10, -10.5, -10, -11])).map(s => s.kind)).toEqual(['verse'])
  })
})

describe('strokeProfile', () => {
  it('finds bottoms and tops, ignoring wobble', () => {
    const actions = []
    for (let i = 0; i < 20; i++) {
      actions.push({ at: i * 500, pos: 10 }, { at: i * 500 + 200, pos: 85 }, { at: i * 500 + 230, pos: 82 }, { at: i * 500 + 260, pos: 90 })
    }
    actions.push({ at: 10_000, pos: 10 })
    const p = strokeProfile(actions)
    expect(p.strokes).toHaveLength(20)
    expect(p.spm).toBe(120)
    expect(p.strokes[3]).toEqual({ at: 1500, top: 1760, end: 2000, depth: 80 })
    expect(p.tempo).toEqual([120, 120])
  })
})

describe('musicPlan', () => {
  it('gives the strokes its script is made of, bottoms on beats', () => {
    const a = song([-10, -10, -10, -10])
    const { actions, strokes } = musicPlan(a, { bandLo: 100, bandHi: 140, maxSpm: 400, minDepth: 1, maxDepth: 1, centre: 0.5 })
    expect(strokes.length).toBeGreaterThan(40)
    const at = new Map(actions.map(x => [x.at, x.pos]))
    for (const s of strokes.slice(0, 8)) {
      expect(at.get(s.at)).toBe(0)
      expect(at.get(s.top)).toBe(100)
      expect(s.beat).toBeGreaterThanOrEqual(0)
    }
  })
})
