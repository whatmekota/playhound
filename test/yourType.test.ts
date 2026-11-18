import type { VideoEntry } from '../src/stores/libraryStore'
import { describe, expect, it } from 'vitest'
import { hottestMoment } from '../src/lib/hotMoment'
import { sortEntries } from '../src/lib/libraryQuery'
import { readPad } from '../src/lib/strokePad'
import { tasteFeatures, tasteProfile, tasteReasons, tasteScore } from '../src/lib/yourType'

function entry(name: string, tags: string[], over: Partial<VideoEntry> = {}): VideoEntry {
  return {
    file: { size: 100, lastModified: 0 } as File,
    name: `${name}.mp4`,
    basename: name,
    path: `${name}.mp4`,
    folder: '',
    hasScript: false,
    scriptCount: 0,
    altCount: 0,
    scriptFiles: [],
    scriptMatches: [],
    thumbnailUrl: null,
    duration: null,
    scriptType: 'none',
    starred: false,
    userMeta: { tags },
    ...over,
  }
}

describe('your type', () => {
  const library = [
    entry('a', ['pov', 'blonde']),
    entry('b', ['pov', 'redhead']),
    entry('c', ['pov', 'blonde'], { starred: true }),
    entry('d', ['outdoor']),
    entry('e', ['pov']),
    entry('f', ['outdoor', 'redhead']),
  ]
  const finishes: Record<string, number> = { 'a.mp4': 2, 'b.mp4': 1 }
  const rows = library.map(v => ({ v, features: tasteFeatures(v, null), signal: { finishes: finishes[v.name] ?? 0, plays: 1, starred: v.starred } }))

  it('says nothing until a few videos were finished to or starred', () => {
    expect(tasteProfile(rows.slice(0, 2).map(r => ({ ...r, signal: { ...r.signal, starred: false } })))).toBeNull()
  })

  it('ranks what your finishes share first, and says why', () => {
    const p = tasteProfile(rows)!
    expect(p.basis).toBe(3)
    const score = new Map(rows.map(r => [r.v.name, tasteScore(p, r.features)]))
    expect(score.get('e.mp4')!).toBeGreaterThan(score.get('d.mp4')!)
    expect(score.get('d.mp4')).toBe(0)
    const sorted = sortEntries([...library], { key: 'type', asc: false }, () => undefined, v => score.get(v.name))
    // pov and blonde first, then the ones with pov alone.
    expect(sorted.slice(0, 4).map(v => v.name)).toEqual(['a.mp4', 'c.mp4', 'b.mp4', 'e.mp4'])
    expect(sorted.slice(-2).map(v => v.name)).toEqual(['d.mp4', 'f.mp4'])
    expect(tasteReasons(p, rows[4].features)).toEqual(['pov'])
  })
})

describe('hottest moment', () => {
  it('finds the busiest stretch, and nothing in a short or still script', () => {
    // Slow strokes for two minutes, then a fast stretch from 120 s to 150 s.
    const actions: { at: number, pos: number }[] = []
    for (let t = 0; t < 120_000; t += 2000)
      actions.push({ at: t, pos: (t / 2000) % 2 ? 80 : 20 })
    for (let t = 120_000; t <= 150_000; t += 250)
      actions.push({ at: t, pos: (t / 250) % 2 ? 100 : 0 })
    const at = hottestMoment(actions)!
    expect(at).toBeGreaterThanOrEqual(125_000)
    expect(at).toBeLessThanOrEqual(145_000)
    expect(hottestMoment(actions.slice(0, 5))).toBeNull()
    expect(hottestMoment(Array.from({ length: 50 }, (_, i) => ({ at: i * 2000, pos: 50 })))).toBeNull()
  })
})

describe('stroke pad messages', () => {
  it('reads a finger, a lift, and nothing else', () => {
    expect(readPad({ type: 'pad', pos: 0.25 })).toBe(0.25)
    expect(readPad({ type: 'pad', pos: 7 })).toBe(1)
    expect(readPad({ type: 'pad', up: true })).toBe('up')
    expect(readPad({ type: 'pad', pos: 'x' })).toBeNull()
    expect(readPad({ type: 'cmd', action: 'panic' })).toBeNull()
  })
})
