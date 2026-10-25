import { beforeEach, describe, expect, it, vi } from 'vitest'

// The index persists to IndexedDB, which jsdom does not have; a Map stands in.
const disk = new Map<string, unknown>()
vi.mock('~/lib/idb', () => ({
  chapterIndexDb: {
    set: async (k: string, v: unknown) => { disk.set(k, v) },
    all: async () => [...disk.entries()],
    clear: async () => { disk.clear() },
  },
}))
vi.mock('~/lib/thumbs', () => ({ whenIdle: () => Promise.resolve() }))

const {
  buildIndex,
  cancelIndex,
  clearIndex,
  CURVE_MS,
  cutPoints,
  indexKey,
  indexRecord,
  indexScript,
  indexState,
  metaCredits,
  speedCurve,
} = await import('../src/lib/chapterIndex')

/** Strokes 0 ↔ 1 every `periodMs` from `from` to `to`. */
function strokes(from: number, to: number, periodMs: number) {
  const out: { at: number, pos: number }[] = []
  for (let t = from, i = 0; t <= to; t += periodMs / 2, i++)
    out.push({ at: t, pos: i % 2 ? 1 : 0 })
  return out
}

describe('indexScript', () => {
  // Slow for two minutes, a pause, then fast for two.
  const actions = [...strokes(0, 120_000, 2000), ...strokes(140_000, 260_000, 500)]

  it('cuts a script into rated chapters', () => {
    const rec = indexScript(actions)
    const moving = rec.chapters.filter(c => c.kind !== 'break')
    expect(moving.length).toBeGreaterThanOrEqual(2)
    const first = moving[0]
    const last = moving[moving.length - 1]
    expect(last.intensity).toBeGreaterThan(first.intensity)
    expect(first.source).toBe('auto')
    for (const c of rec.chapters) {
      expect(c.intensity).toBeGreaterThanOrEqual(0)
      expect(c.intensity).toBeLessThanOrEqual(1)
    }
  })

  it('prefers the author\'s chapters', () => {
    const rec = indexScript(actions, {
      chapters: [
        { name: 'Tease', startTime: '00:00:00.000', endTime: '00:02:00.000' },
        { name: 'Finale', startTime: '00:02:20.000', endTime: '00:04:20.000' },
      ],
    })
    expect(rec.chapters.map(c => c.name)).toContain('Finale')
    expect(rec.chapters.every(c => c.source === 'author')).toBe(true)
  })

  it('keeps a speed curve at its resolution, rated in units per second', () => {
    const rec = indexScript(actions)
    expect(rec.curve.length).toBe(Math.ceil(260_000 / CURVE_MS))
    // Slow part: one unit per second (a full stroke each way per 2 s); fast: four.
    expect(rec.curve[5]).toBeCloseTo(1, 1)
    expect(rec.curve[40]).toBeCloseTo(4, 1)
    // The pause is still.
    expect(rec.curve[26]).toBeLessThan(0.1)
  })

  it('reads creator and tags from either spelling', () => {
    expect(metaCredits({ creator: 'Ann', tags: ['A', 'b', 'a'] })).toEqual({ creator: 'Ann', tags: ['a', 'b'] })
    expect(metaCredits({ topic_creator: 'Bo', topic_tags: ['x'] })).toEqual({ creator: 'Bo', tags: ['x'] })
    expect(metaCredits(null)).toEqual({ creator: null, tags: [] })
  })
})

describe('cut points', () => {
  it('lands on stroke bottoms and pause starts', () => {
    const a = [...strokes(0, 10_000, 1000), { at: 15_000, pos: 0.5 }, ...strokes(16_000, 20_000, 1000)]
    const cuts = cutPoints(a)
    // Bottoms are where pos is 0: every whole second in the first run.
    for (const t of [1000, 2000, 3000])
      expect(cuts).toContain(t)
    // Tops are not.
    expect(cuts).not.toContain(1500)
    // The pause from 10 s on.
    expect(cuts).toContain(10_000)
    expect([...cuts].sort((x, y) => x - y)).toEqual(cuts)
  })

  it('measures movement per slice', () => {
    expect(speedCurve(strokes(0, 10_000, 1000), 5000, 10_000)).toEqual([2, 2])
  })
})

describe('background index', () => {
  const file = (name: string, actions: { at: number, pos: number }[] | null) =>
    new File([actions ? JSON.stringify({ actions: actions.map(a => ({ at: a.at, pos: a.pos * 100 })) }) : 'not json'], name, { lastModified: 1 })

  beforeEach(async () => {
    await clearIndex()
  })

  it('indexes what is missing, counts progress, and caches by file identity', async () => {
    const good = file('a.funscript', strokes(0, 120_000, 1000))
    const bad = file('b.funscript', null)
    await buildIndex([{ name: 'a.mp4', script: good }, { name: 'b.mp4', script: bad }])
    expect(indexState.done).toBe(2)
    expect(indexState.total).toBe(2)
    expect(indexState.failed).toBe(1)
    expect(indexState.running).toBe(false)
    expect(indexRecord(good)?.video).toBe('a.mp4')
    expect(indexRecord(bad)).toBeNull()
    expect(disk.has(indexKey(good))).toBe(true)

    // A second build has nothing to do.
    await buildIndex([{ name: 'a.mp4', script: good }, { name: 'b.mp4', script: bad }])
    expect(indexState.done).toBe(2)
  })

  it('stops when cancelled', async () => {
    const files = Array.from({ length: 5 }, (_, i) => ({ name: `${i}.mp4`, script: file(`${i}.funscript`, strokes(0, 60_000, 1000)) }))
    let calls = 0
    const run = buildIndex(files, () => {
      if (++calls === 2)
        cancelIndex()
      return false
    })
    await run
    expect(indexState.done).toBeLessThan(5)
    expect(indexState.running).toBe(false)
  })
})
