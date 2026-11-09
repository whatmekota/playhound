import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generateFill } from '../src/lib/scriptFill'
import {
  BUILTIN_PATTERNS,
  normalisePattern,
  parsePatterns,
  patternPoints,
  thumbPath,
  uniqueName,
} from '../src/lib/scriptPatterns'

vi.mock('~/lib/idb', () => ({
  BACKUP_STORES: ['meta'],
  exportStore: vi.fn(async () => []),
  importStore: vi.fn(async () => {}),
}))

const run = [
  { at: 2000, pos: 0.2 },
  { at: 2500, pos: 0.8 },
  { at: 3000, pos: 0.2 },
  { at: 3200, pos: 0.5 },
  { at: 4000, pos: 0.2 },
]

describe('normalisePattern', () => {
  it('stores time 0–1 and position 0–100 across its own range, keeping both', () => {
    const p = normalisePattern(run, '  Two  bumps ', 'x')!
    expect(p.name).toBe('Two bumps')
    expect(p.durationMs).toBe(2000)
    expect(p.lo).toBe(20)
    expect(p.hi).toBe(80)
    expect(p.points).toEqual([
      { t: 0, pos: 0 },
      { t: 0.25, pos: 100 },
      { t: 0.5, pos: 0 },
      { t: 0.6, pos: 50 },
      { t: 1, pos: 0 },
    ])
  })

  it('round-trips: back at its own length and range it is the original', () => {
    const p = normalisePattern(run, 'p', 'x')!
    const back = patternPoints(p, 2000, p.durationMs, p.lo / 100, p.hi / 100)
    back.forEach((q, i) => {
      expect(q.at).toBe(run[i].at)
      expect(q.pos).toBeCloseTo(run[i].pos)
    })
  })

  it('stretches and scales', () => {
    const p = normalisePattern(run, 'p', 'x')!
    const back = patternPoints(p, 0, 4000, 0, 1)
    expect(back.map(q => q.at)).toEqual([0, 1000, 2000, 2400, 4000])
    expect(back.map(q => q.pos)).toEqual([0, 1, 0, 0.5, 0])
  })

  it('sorts, and needs two moments', () => {
    expect(normalisePattern([{ at: 5, pos: 0 }], 'p', 'x')).toBeNull()
    expect(normalisePattern([{ at: 5, pos: 0 }, { at: 5, pos: 1 }], 'p', 'x')).toBeNull()
    const p = normalisePattern([{ at: 10, pos: 1 }, { at: 0, pos: 0 }], 'p', 'x')!
    expect(p.points).toEqual([{ t: 0, pos: 0 }, { t: 1, pos: 100 }])
  })

  it('a flat run sits in the middle', () => {
    const p = normalisePattern([{ at: 0, pos: 0.4 }, { at: 100, pos: 0.4 }], '', 'x')!
    expect(p.name).toBe('Pattern')
    expect(p.points.map(q => q.pos)).toEqual([50, 50])
    expect(p.lo).toBe(40)
    expect(p.hi).toBe(40)
  })
})

describe('parsePatterns', () => {
  it('keeps good ones and drops the rest', () => {
    const good = normalisePattern(run, 'Good', 'a')!
    const list = parsePatterns([
      good,
      { ...good, id: 'a' },
      { id: 'b', name: 'few', points: [{ t: 0, pos: 0 }] },
      { id: 'c', name: 'bad t', points: [{ t: -1, pos: 0 }, { t: 0.5, pos: 10 }, { t: 1, pos: 400 }] },
      null,
      'junk',
      { name: 'no id', points: good.points },
    ])
    expect(list.map(p => p.id)).toEqual(['a', 'c'])
    expect(list[1].points).toEqual([{ t: 0.5, pos: 10 }, { t: 1, pos: 100 }])
    expect(parsePatterns({})).toEqual([])
  })
})

describe('built-in patterns', () => {
  it('are well formed and fill a span', () => {
    expect(parsePatterns(BUILTIN_PATTERNS)).toHaveLength(BUILTIN_PATTERNS.length)
    for (const p of BUILTIN_PATTERNS) {
      expect(p.points[0].t).toBe(0)
      expect(p.points.at(-1)!.t).toBe(1)
      const r = generateFill({ from: { at: 0, pos: 0 }, to: { at: 10_000, pos: 0 }, source: { kind: 'pattern', points: p.points }, lo: p.lo / 100, hi: p.hi / 100, rate: { kind: 'count', count: 2 } })
      expect(r.points.length).toBeGreaterThan(p.points.length)
    }
  })
})

describe('helpers', () => {
  it('uniqueName counts up', () => {
    expect(uniqueName('Tease', ['Staircase'])).toBe('Tease')
    expect(uniqueName('Tease', ['tease', 'Tease 2'])).toBe('Tease 3')
  })

  it('thumbPath draws inside the box', () => {
    const d = thumbPath({ kind: 'shape', shape: 'sine' }, 40, 20)
    const nums = d.match(/-?\d+(\.\d+)?/g)!.map(Number)
    expect(d.startsWith('M')).toBe(true)
    expect(Math.min(...nums)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...nums)).toBeLessThanOrEqual(40)
    expect(thumbPath({ kind: 'pattern', points: [{ t: 0, pos: 0 }, { t: 1, pos: 100 }] }, 40, 20, 0)).toBe('M0 20 L40 0')
  })
})

describe('pattern store', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('saves, renames and deletes, and keeps them in localStorage', async () => {
    const { useScriptPatternStore } = await import('../src/stores/scriptPatternStore')
    const store = useScriptPatternStore()
    const p = store.add(run, 'Tease')!
    // A built-in already has the name.
    expect(p.name).toBe('Tease 2')
    expect(store.all.at(-1)!.id).toBe(p.id)
    store.rename(p.id, 'Mine')
    expect(store.get(p.id)!.name).toBe('Mine')
    await new Promise(r => setTimeout(r, 0))
    expect(JSON.parse(localStorage.getItem('ph:editor.patterns')!)[0].name).toBe('Mine')
    const undo = store.remove(p.id)!
    expect(store.saved).toEqual([])
    undo()
    expect(store.saved.map(q => q.name)).toEqual(['Mine'])
    store.remove(p.id)
    // Built-ins cannot be removed.
    store.remove(BUILTIN_PATTERNS[0].id)
    expect(store.all).toHaveLength(BUILTIN_PATTERNS.length)
  })

  it('travel in a backup and come back from one', async () => {
    const { useScriptPatternStore } = await import('../src/stores/scriptPatternStore')
    const { collectLocal, restoreBackup } = await import('../src/lib/backup')
    useScriptPatternStore().add(run, 'Mine')
    await new Promise(r => setTimeout(r, 0))
    const local = collectLocal()
    expect(local['ph:editor.patterns']).toContain('Mine')
    localStorage.clear()
    await restoreBackup({ _app: 'playhound', _version: 1, _exportedAt: '', _origin: 'x', local, idb: {} }, 'merge')
    setActivePinia(createPinia())
    expect(useScriptPatternStore().saved.map(p => p.name)).toEqual(['Mine'])
  })
})
