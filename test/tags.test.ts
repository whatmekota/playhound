import type { ScriptSummary } from '../src/lib/idb'
import type { VideoEntry } from '../src/stores/libraryStore'
import type { SmartPlaylist } from '../src/stores/playlistStore'
import { describe, expect, it } from 'vitest'
import { countTagged } from '../src/lib/backup'
import { filterEntries, usesSummaries } from '../src/lib/libraryQuery'
import {
  AUTO_TAGS,
  autoTags,
  editTagList,
  looksVr,
  manualTags,
  needsSummary,
  normalizeTag,
  normalizeTags,
  parseSearch,
  shownTags,
  splitTagInput,
  tagCounts,
  tagToken,
} from '../src/lib/tags'
import { evaluateSmartPlaylist, smartUsesSummaries } from '../src/stores/playlistStore'

function entry(name: string, over: Partial<VideoEntry> = {}): VideoEntry {
  return {
    file: { size: 100, lastModified: 0 } as File,
    name: `${name}.mp4`,
    basename: name,
    path: `${name}.mp4`,
    folder: '',
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

function summary(meanSpeed: number, meanSpm: number, minutes = 10): ScriptSummary {
  return { meanSpeed, peakSpeed: meanSpeed * 2, meanSpm, durationMs: minutes * 60_000, actionCount: 100 }
}

const tagged = (name: string, tags: string[], over: Partial<VideoEntry> = {}) => entry(name, { userMeta: { tags }, ...over })
const names = (l: VideoEntry[]) => l.map(v => v.basename)
const none = new Set<never>()

describe('normalizeTag', () => {
  it('trims, lower-cases and tidies', () => {
    expect(normalizeTag('  VR ')).toBe('vr')
    expect(normalizeTag('#Cock  Hero')).toBe('cock hero')
    expect(normalizeTag('a,b')).toBe('a b')
    expect(normalizeTag('"quoted"')).toBe('quoted')
    expect(normalizeTag('   ')).toBe('')
    expect(normalizeTag('x'.repeat(80))).toHaveLength(40)
  })

  it('deduplicates case-insensitively, first spelling first', () => {
    expect(normalizeTags(['PMV', 'pmv', ' Pmv ', 'hentai', '', 3 as unknown as string])).toEqual(['pmv', 'hentai'])
    expect(splitTagInput('PMV, Hentai,,pmv')).toEqual(['pmv', 'hentai'])
  })

  it('edits a list: adds, removes, never duplicates', () => {
    expect(editTagList(['a', 'B'], ['b', 'C'], ['A'])).toEqual(['b', 'c'])
    expect(editTagList(undefined, ['x'])).toEqual(['x'])
  })
})

describe('manualTags', () => {
  it('prefers saved info over the script\'s metadata, normalised', () => {
    expect(manualTags(entry('a', { scriptMeta: { tags: ['From Script'] } }))).toEqual(['from script'])
    expect(manualTags(entry('a', { scriptMeta: { tags: ['x'] }, userMeta: { tags: ['Mine', 'mine'] } }))).toEqual(['mine'])
    // Saved info with every tag removed means none, not "fall back to the script's".
    expect(manualTags(entry('a', { scriptMeta: { tags: ['x'] }, userMeta: { tags: [] } }))).toEqual([])
  })
})

describe('autoTags', () => {
  it('names intensity and pace from the analysis', () => {
    expect(autoTags(entry('a'), summary(1.5, 60))).toEqual(['gentle', 'slow'])
    expect(autoTags(entry('a'), summary(2.5, 130))).toEqual(['medium'])
    expect(autoTags(entry('a'), summary(4, 200))).toEqual(['intense', 'fast'])
  })

  it('leaves out what is not known yet rather than guessing', () => {
    expect(autoTags(entry('a'))).toEqual([])
  })

  it('pace edges: under 100 slow, 180 and up fast', () => {
    expect(autoTags(entry('a'), summary(2.5, 99.9))).toContain('slow')
    expect(autoTags(entry('a'), summary(2.5, 100))).not.toContain('slow')
    expect(autoTags(entry('a'), summary(2.5, 179.9))).not.toContain('fast')
    expect(autoTags(entry('a'), summary(2.5, 180))).toContain('fast')
  })

  it('length from the video, falling back to the script', () => {
    expect(autoTags(entry('a', { duration: 4 * 60 }))).toEqual(['short'])
    expect(autoTags(entry('a', { duration: 5 * 60 }))).toEqual([])
    expect(autoTags(entry('a', { duration: 20 * 60 }))).toEqual(['long'])
    expect(autoTags(entry('a'), summary(2.5, 130, 3))).toContain('short')
    // The video's own length wins over the script's.
    expect(autoTags(entry('a', { duration: 30 * 60 }), summary(2.5, 130, 3))).toContain('long')
  })

  it('multi-axis, unscripted and VR', () => {
    expect(autoTags(entry('a', { scriptCount: 2, scriptType: 'multi' }))).toEqual(['multi-axis'])
    expect(autoTags(entry('a', { scriptCount: 4, scriptType: 'merged' }))).toEqual(['multi-axis'])
    expect(autoTags(entry('a', { hasScript: false, scriptCount: 0, scriptType: 'none' }))).toEqual(['unscripted'])
    expect(autoTags(entry('scene_180_LR'))).toEqual(['vr'])
    expect(autoTags(entry('clip', { path: 'VR/clip.mp4' }))).toEqual(['vr'])
  })

  it('ignores a stale analysis on a video without a script', () => {
    expect(autoTags(entry('a', { hasScript: false, scriptType: 'none' }), summary(4, 200))).toEqual(['unscripted'])
  })

  it('vR only as a word, not inside one', () => {
    expect(looksVr({ name: 'My VR scene.mp4', path: 'My VR scene.mp4' })).toBe(true)
    expect(looksVr({ name: 'clip_MKX200.mp4', path: 'clip_MKX200.mp4' })).toBe(true)
    expect(looksVr({ name: 'overdrive.mp4', path: 'overdrive.mp4' })).toBe(false)
    expect(looksVr({ name: 'vrchat dance.mp4', path: 'vrchat dance.mp4' })).toBe(false)
  })

  it('every automatic tag is defined once, and only analysis-based ones need a summary', () => {
    expect(new Set(AUTO_TAGS.map(d => d.tag)).size).toBe(AUTO_TAGS.length)
    expect(AUTO_TAGS.filter(d => needsSummary(d.tag)).map(d => d.tag)).toEqual(['gentle', 'medium', 'intense', 'slow', 'fast'])
    expect(needsSummary('pmv')).toBe(false)
  })
})

describe('shownTags', () => {
  const v = tagged('scene_180_LR', ['pmv', 'vr'], { duration: 60, scriptCount: 2, scriptType: 'multi' })
  it('manual first, then automatic ones not already given by hand', () => {
    expect(shownTags(v, summary(4, 200), { auto: true })).toEqual([
      { tag: 'pmv', auto: false },
      { tag: 'vr', auto: false },
      { tag: 'intense', auto: true },
      { tag: 'fast', auto: true },
      { tag: 'short', auto: true },
      { tag: 'multi-axis', auto: true },
    ])
  })
  it('cards skip what they already show another way', () => {
    expect(shownTags(v, summary(4, 200), { auto: true, onCardOnly: true }).map(t => t.tag)).toEqual(['pmv', 'vr', 'fast', 'short'])
  })
  it('hidden automatic tags leave only the manual ones', () => {
    expect(shownTags(v, summary(4, 200), { auto: false })).toEqual([{ tag: 'pmv', auto: false }, { tag: 'vr', auto: false }])
  })
})

describe('tagCounts', () => {
  const lib = [
    tagged('a', ['pmv', 'hentai'], { duration: 60 }),
    tagged('b', ['PMV'], { duration: 60 }),
    tagged('c', ['short']),
    entry('d', { duration: 60 * 60 }),
  ]
  it('manual by count, then automatic in their fixed order', () => {
    expect(tagCounts(lib, { auto: true })).toEqual([
      // Given by hand once and worked out twice: one tag, counted once per video.
      { tag: 'short', count: 3, auto: false },
      { tag: 'pmv', count: 2, auto: false },
      { tag: 'hentai', count: 1, auto: false },
      { tag: 'long', count: 1, auto: true },
    ])
  })
  it('manual only when automatic tags are hidden', () => {
    expect(tagCounts(lib, { auto: false }).map(t => t.tag)).toEqual(['pmv', 'hentai', 'short'])
  })
})

describe('parseSearch', () => {
  it('pulls tag: and -tag: out of the text', () => {
    expect(parseSearch('Miku tag:PMV -tag:vr')).toEqual({ text: 'miku', include: ['pmv'], exclude: ['vr'] })
  })
  it('takes quoted names with spaces, even before the quote is closed', () => {
    expect(parseSearch('tag:"cock hero" x')).toEqual({ text: 'x', include: ['cock hero'], exclude: [] })
    expect(parseSearch('tag:"cock he')).toEqual({ text: '', include: ['cock he'], exclude: [] })
  })
  it('only at a word start, and an empty tag: is ignored while typing', () => {
    expect(parseSearch('mytag:x')).toEqual({ text: 'mytag:x', include: [], exclude: [] })
    expect(parseSearch('tag:')).toEqual({ text: '', include: [], exclude: [] })
  })
  it('round-trips through tagToken', () => {
    expect(parseSearch(`${tagToken('cock hero')} ${tagToken('vr', true)}`)).toEqual({ text: '', include: ['cock hero'], exclude: ['vr'] })
  })
})

describe('filtering by tag', () => {
  const lib = [
    tagged('alpha', ['pmv'], { duration: 60 }),
    tagged('beta', ['pmv', 'hentai'], { duration: 30 * 60 }),
    entry('gamma_180_LR'),
    entry('delta'),
  ]
  const fast = new Map([['delta.mp4', summary(4, 200)]])
  const peek = (n: string) => fast.get(n)
  const q = (query: string, tags: string[] = []) => names(filterEntries(lib, { query, filters: none, bands: none, tags: new Set(tags) }, peek))

  it('tag chips need every tag, manual or automatic', () => {
    expect(q('', ['pmv'])).toEqual(['alpha', 'beta'])
    expect(q('', ['pmv', 'long'])).toEqual(['beta'])
    expect(q('', ['vr'])).toEqual(['gamma_180_LR'])
    expect(q('', ['fast'])).toEqual(['delta'])
  })

  it('tag: and -tag: in the search, combined with plain text', () => {
    expect(q('tag:pmv -tag:hentai')).toEqual(['alpha'])
    expect(q('-tag:pmv')).toEqual(['gamma_180_LR', 'delta'])
    expect(q('be tag:PMV')).toEqual(['beta'])
    expect(q('tag:nothing')).toEqual([])
  })

  it('plain text still finds manual tags, but not automatic ones', () => {
    expect(q('hentai')).toEqual(['beta'])
    expect(q('fast')).toEqual([])
  })

  it('knows when the result waits on analyses', () => {
    const base = { bands: none, sort: { key: 'name' as const, asc: true } }
    expect(usesSummaries({ ...base, tags: new Set(['pmv']) })).toBe(false)
    expect(usesSummaries({ ...base, tags: new Set(['fast']) })).toBe(true)
    expect(usesSummaries({ ...base, query: '-tag:gentle' })).toBe(true)
    expect(usesSummaries({ ...base, query: 'tag:vr' })).toBe(false)
  })
})

describe('smart playlist tag rules', () => {
  const lib = [
    tagged('alpha', ['PMV']),
    tagged('beta', ['hentai']),
    entry('gamma', { duration: 25 * 60 }),
  ]
  const pl = (rules: SmartPlaylist['rules']): SmartPlaylist => ({ id: 'x', name: 'x', rules, createdAt: 0 })
  const fast = new Map([['beta.mp4', summary(4, 200)]])

  it('matches manual tags case-insensitively', () => {
    expect(names(evaluateSmartPlaylist(pl([{ type: 'has_tag', tag: 'pmv' }]), lib))).toEqual(['alpha'])
    expect(names(evaluateSmartPlaylist(pl([{ type: 'has_tag', tag: ' PMV ' }]), lib))).toEqual(['alpha'])
  })

  it('matches automatic tags, with analyses when given', () => {
    expect(names(evaluateSmartPlaylist(pl([{ type: 'has_tag', tag: 'long' }]), lib))).toEqual(['gamma'])
    expect(names(evaluateSmartPlaylist(pl([{ type: 'has_tag', tag: 'fast' }]), lib))).toEqual([])
    expect(names(evaluateSmartPlaylist(pl([{ type: 'has_tag', tag: 'fast' }]), lib, n => fast.get(n)))).toEqual(['beta'])
  })

  it('lacks_tag excludes, and an unfinished rule changes nothing', () => {
    expect(names(evaluateSmartPlaylist(pl([{ type: 'lacks_tag', tag: 'pmv' }]), lib))).toEqual(['beta', 'gamma'])
    expect(names(evaluateSmartPlaylist(pl([{ type: 'has_tag', tag: '' }]), lib))).toEqual(['alpha', 'beta', 'gamma'])
    expect(names(evaluateSmartPlaylist(pl([{ type: 'has_script' }, { type: 'lacks_tag', tag: 'hentai' }]), lib))).toEqual(['alpha', 'gamma'])
  })

  it('knows which rules wait on analyses', () => {
    expect(smartUsesSummaries(pl([{ type: 'has_tag', tag: 'Gentle' }]))).toBe(true)
    expect(smartUsesSummaries(pl([{ type: 'has_tag', tag: 'pmv' }, { type: 'starred' }]))).toBe(false)
  })
})

describe('backup', () => {
  it('counts the videos whose saved info carries tags', () => {
    expect(countTagged([['a.mp4', { tags: ['x'] }], ['b.mp4', { tags: [] }], ['c.mp4', { notes: 'hi' }], ['d.mp4', null]])).toBe(1)
    expect(countTagged(undefined)).toBe(0)
  })
})
