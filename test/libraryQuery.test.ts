import type { ScriptSummary } from '../src/lib/idb'
import type { VideoEntry } from '../src/stores/libraryStore'
import { describe, expect, it } from 'vitest'
import {
  bandCounts,
  filterCounts,
  filterEntries,
  matchesQuery,
  nextSort,
  queryLibrary,
  sortEntries,
  toggleBand,
  toggleFilter,
  usesSummaries,
} from '../src/lib/libraryQuery'

function entry(name: string, over: Partial<VideoEntry> = {}): VideoEntry {
  return {
    file: { size: 100, lastModified: 0 } as File,
    name: `${name}.mp4`,
    basename: name,
    hasScript: true,
    scriptCount: 1,
    altCount: 0,
    scriptFiles: [],
    scriptMatches: [],
    thumbnailUrl: null,
    duration: null,
    scriptType: 'single',
    starred: false,
    ...over,
  }
}

function summary(meanSpeed: number, peakSpeed = meanSpeed * 2): ScriptSummary {
  return { meanSpeed, peakSpeed, meanSpm: 100, durationMs: 60_000, actionCount: 100 }
}

const names = (l: VideoEntry[]) => l.map(v => v.basename)
const none = new Set<never>()

describe('nextSort', () => {
  it('flips the current key and picks a natural direction for a new one', () => {
    expect(nextSort({ key: 'name', asc: true }, 'name')).toEqual({ key: 'name', asc: false })
    expect(nextSort({ key: 'name', asc: true }, 'date')).toEqual({ key: 'date', asc: false })
    expect(nextSort({ key: 'date', asc: false }, 'name')).toEqual({ key: 'name', asc: true })
    expect(nextSort({ key: 'date', asc: false }, 'intensity', true)).toEqual({ key: 'intensity', asc: true })
  })
})

describe('toggleFilter', () => {
  it('drops contradicting chips', () => {
    let f = toggleFilter(new Set(), 'scripted')
    f = toggleFilter(f, 'unscripted')
    expect([...f]).toEqual(['unscripted'])
    f = toggleFilter(f, 'multi')
    expect([...f]).toEqual(['multi'])
    f = toggleFilter(f, 'starred')
    f = toggleFilter(f, 'multi')
    expect([...f]).toEqual(['starred'])
  })

  it('does not mutate its input', () => {
    const f = new Set(['starred'] as const)
    toggleFilter(f, 'starred')
    expect(f.has('starred')).toBe(true)
  })

  it('bands toggle independently', () => {
    const b = toggleBand(toggleBand(new Set(), 'gentle'), 'intense')
    expect([...b].sort()).toEqual(['gentle', 'intense'])
    expect([...toggleBand(b, 'gentle')]).toEqual(['intense'])
  })
})

describe('matching and filtering', () => {
  const vids = [
    entry('Alpha', { starred: true }),
    entry('Beta', { hasScript: false, scriptCount: 0, scriptType: 'none' }),
    entry('Gamma', { scriptCount: 3, scriptType: 'multi', scriptMeta: { creator: 'Zed', tags: ['pmv'] } }),
    entry('Delta', { scriptType: 'merged', userMeta: { tags: ['hmv'] } }),
  ]
  const sums: Record<string, ScriptSummary> = {
    'Alpha.mp4': summary(1.5),
    'Gamma.mp4': summary(2.5),
    'Delta.mp4': summary(4),
  }
  const of = (n: string) => sums[n]

  it('searches names, creators and tags', () => {
    expect(matchesQuery(vids[0], 'alp')).toBe(true)
    expect(matchesQuery(vids[2], 'zed')).toBe(true)
    expect(matchesQuery(vids[3], 'hmv')).toBe(true)
    expect(matchesQuery(vids[1], 'zed')).toBe(false)
  })

  it('applies chips', () => {
    const q = (filters: string[]) => names(filterEntries(vids, { query: '', filters: new Set(filters as any), bands: none }, of))
    expect(q(['scripted'])).toEqual(['Alpha', 'Gamma', 'Delta'])
    expect(q(['unscripted'])).toEqual(['Beta'])
    expect(q(['multi'])).toEqual(['Gamma', 'Delta'])
    expect(q(['starred'])).toEqual(['Alpha'])
  })

  it('filters by intensity band and leaves out unanalysed videos', () => {
    const q = (bands: string[]) => names(filterEntries(vids, { query: '', filters: none, bands: new Set(bands as any) }, of))
    expect(q(['gentle'])).toEqual(['Alpha'])
    expect(q(['medium', 'intense'])).toEqual(['Gamma', 'Delta'])
    expect(bandCounts(vids, of)).toEqual({ gentle: 1, medium: 1, intense: 1 })
  })

  it('counts chips', () => {
    expect(filterCounts(vids)).toEqual({ scripted: 3, multi: 2, starred: 1, unscripted: 1 })
  })
})

describe('sortEntries', () => {
  it('sorts names naturally', () => {
    const l = [entry('clip 10'), entry('Clip 2'), entry('clip 1')]
    expect(names(sortEntries(l, { key: 'name', asc: true }, () => undefined))).toEqual(['clip 1', 'Clip 2', 'clip 10'])
    expect(names(sortEntries(l, { key: 'name', asc: false }, () => undefined))).toEqual(['clip 10', 'Clip 2', 'clip 1'])
  })

  it('breaks ties by name', () => {
    const l = [entry('b', { duration: 5 }), entry('a', { duration: 5 }), entry('c', { duration: 1 })]
    expect(names(sortEntries(l, { key: 'duration', asc: false }, () => undefined))).toEqual(['a', 'b', 'c'])
  })

  it('puts unanalysed videos last in both directions', () => {
    const sums: Record<string, ScriptSummary> = { 'a.mp4': summary(1, 5), 'b.mp4': summary(3, 4) }
    const of = (n: string) => sums[n]
    const l = () => [entry('z'), entry('a'), entry('b'), entry('y')]
    expect(names(sortEntries(l(), { key: 'intensity', asc: false }, of))).toEqual(['b', 'a', 'y', 'z'])
    expect(names(sortEntries(l(), { key: 'intensity', asc: true }, of))).toEqual(['a', 'b', 'y', 'z'])
    expect(names(sortEntries(l(), { key: 'peak', asc: false }, of))).toEqual(['a', 'b', 'y', 'z'])
  })

  it('queryLibrary leaves the source alone', () => {
    const src = [entry('b'), entry('a')]
    const out = queryLibrary(src, { query: '', filters: none, bands: none, sort: { key: 'name', asc: true } }, () => undefined)
    expect(names(out)).toEqual(['a', 'b'])
    expect(names(src)).toEqual(['b', 'a'])
  })

  it('knows when analyses matter', () => {
    expect(usesSummaries({ bands: none, sort: { key: 'name', asc: true } })).toBe(false)
    expect(usesSummaries({ bands: none, sort: { key: 'peak', asc: true } })).toBe(true)
    expect(usesSummaries({ bands: new Set(['gentle'] as const), sort: { key: 'name', asc: true } })).toBe(true)
  })
})
