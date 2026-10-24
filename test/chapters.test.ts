import type { Chapter } from '../src/lib/chapters'
import type { Action } from '../src/lib/funscriptAnalysis'
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { authorChapters, buildChapters, chapterAt, chaptersForScript, GAP_NAME, nextChapter, parseTimespan, prevChapter } from '../src/lib/chapters'

/**
 * Strokes from `fromMs` for `forMs`, one full up-down cycle every `periodMs`
 * across `amp` of the range. Speed is 2·amp per period: 400 ms at 0.8 is
 * 4 units/s (fast), 2000 ms at 0.6 is 0.6 units/s (slow).
 */
function strokes(fromMs: number, forMs: number, periodMs: number, amp = 0.8): Action[] {
  const out: Action[] = []
  const lo = 0.5 - amp / 2
  for (let t = 0; t < forMs; t += periodMs) {
    out.push({ at: fromMs + t, pos: lo })
    out.push({ at: fromMs + t + periodMs / 2, pos: lo + amp })
  }
  return out
}

const SLOW = 2000
const MEDIUM = 800
const FAST = 400

function joined(...parts: Action[][]): Action[] {
  return parts.flat().sort((a, b) => a.at - b.at)
}

function expectContiguous(chapters: Chapter[], durationMs: number) {
  expect(chapters[0].start).toBe(0)
  for (let i = 1; i < chapters.length; i++)
    expect(chapters[i].start).toBe(chapters[i - 1].end)
  expect(chapters[chapters.length - 1].end).toBeCloseTo(durationMs, -3)
  chapters.forEach((c, i) => expect(c.index).toBe(i))
}

describe('buildChapters', () => {
  it('returns nothing for a script with no shape', () => {
    expect(buildChapters([])).toEqual([])
    expect(buildChapters([{ at: 0, pos: 0 }])).toEqual([])
    expect(buildChapters([{ at: 0, pos: 0 }, { at: 1000, pos: 1 }])).toEqual([])
  })

  it('finds a slow build, a peak and a cool-down', () => {
    const a = joined(strokes(0, 60_000, SLOW), strokes(60_000, 60_000, FAST), strokes(120_000, 60_000, SLOW))
    const ch = buildChapters(a)
    expect(ch.map(c => c.kind)).toEqual(['slow', 'peak', 'slow'])
    expect(ch.map(c => c.name)).toEqual(['Slow build', 'Peak', 'Cool-down'])
    expect(Math.abs(ch[1].start - 60_000)).toBeLessThanOrEqual(3000)
    expect(Math.abs(ch[2].start - 120_000)).toBeLessThanOrEqual(3000)
    expect(ch[1].avgSpeed).toBeGreaterThan(3)
    expect(ch[0].avgSpeed).toBeLessThan(1)
    // One stroke every 400 ms is 150 a minute.
    expect(ch[1].avgSpm).toBeCloseTo(150, -1)
    expectContiguous(ch, a[a.length - 1].at)
  })

  it('marks a hold in the middle as a break', () => {
    const a = joined(strokes(0, 60_000, MEDIUM), [{ at: 60_000, pos: 0.1 }, { at: 80_000, pos: 0.1 }], strokes(80_000, 60_000, MEDIUM))
    const ch = buildChapters(a)
    const brk = ch.find(c => c.kind === 'break')
    expect(brk?.name).toBe('Break')
    expect(Math.abs(brk!.start - 60_000)).toBeLessThanOrEqual(2000)
    expect(Math.abs(brk!.end - 80_000)).toBeLessThanOrEqual(2000)
    expect(ch).toHaveLength(3)
  })

  it('names leading silence and time past the script', () => {
    const a = joined([{ at: 0, pos: 0.5 }], strokes(30_000, 90_000, MEDIUM))
    const ch = buildChapters(a, { durationMs: 150_000 })
    expect(ch[0].name).toBe('Intro')
    expect(ch[ch.length - 1].name).toBe('Outro')
    expectContiguous(ch, 150_000)
  })

  it('does not flicker on jittery speed', () => {
    // Alternating medium and slightly faster every few seconds: one section, not dozens.
    const parts: Action[][] = []
    for (let t = 0; t < 300_000; t += 6000)
      parts.push(strokes(t, 3000, MEDIUM), strokes(t + 3000, 3000, 700))
    const ch = buildChapters(joined(...parts))
    expect(ch.length).toBeLessThanOrEqual(2)
  })

  it('caps the count on a busy script', () => {
    const parts: Action[][] = []
    // Twenty minutes of minute-long sections, each well past the minimum length.
    for (let i = 0; i < 20; i++)
      parts.push(strokes(i * 60_000, 60_000, i % 2 ? FAST : SLOW))
    const a = joined(...parts)
    const ch = buildChapters(a)
    expect(ch.length).toBeLessThanOrEqual(15)
    expect(ch.length).toBeGreaterThanOrEqual(3)
    expectContiguous(ch, a[a.length - 1].at)
    expect(buildChapters(a, { maxChapters: 5 }).length).toBeLessThanOrEqual(5)
  })

  it('handles a long script quickly', () => {
    const parts: Action[][] = []
    for (let i = 0; i < 12; i++)
      parts.push(strokes(i * 300_000, 300_000, [SLOW, MEDIUM, FAST][i % 3]))
    const a = joined(...parts)
    const t0 = performance.now()
    const ch = buildChapters(a)
    expect(performance.now() - t0).toBeLessThan(500)
    expect(ch.length).toBeGreaterThanOrEqual(3)
    expect(ch.length).toBeLessThanOrEqual(15)
  })
})

describe('chapter lookup', () => {
  const a = joined(strokes(0, 60_000, SLOW), strokes(60_000, 60_000, FAST), strokes(120_000, 60_000, SLOW))
  const ch = buildChapters(a)

  it('finds the chapter at a time', () => {
    expect(chapterAt(ch, 10_000)?.index).toBe(0)
    expect(chapterAt(ch, 90_000)?.index).toBe(1)
    expect(chapterAt(ch, 10_000_000)?.index).toBe(2)
    expect(chapterAt([], 0)).toBeNull()
  })

  it('skips forward and back like a track list', () => {
    expect(nextChapter(ch, 10_000)?.index).toBe(1)
    expect(nextChapter(ch, 170_000)).toBeNull()
    // Well into a chapter: back to its start.
    expect(prevChapter(ch, ch[1].start + 20_000)?.index).toBe(1)
    // Just past its start: the one before.
    expect(prevChapter(ch, ch[1].start + 1000)?.index).toBe(0)
    expect(prevChapter(ch, 500)?.index).toBe(0)
  })
})

describe('real script', () => {
  const file = 'X:/the/funscripts/Sanae & Reimu After School Show - Heart Pie Dancehall.funscript'

  it.skipIf(!existsSync(file))('cuts a dance script into a few plain sections', () => {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { actions: { at: number, pos: number }[] }
    const a = raw.actions.map(x => ({ at: x.at, pos: x.pos / 100 })).sort((p, q) => p.at - q.at)
    const ch = buildChapters(a)
    expect(ch.length).toBeGreaterThanOrEqual(2)
    expect(ch.length).toBeLessThanOrEqual(15)
    expectContiguous(ch, a[a.length - 1].at)
    // It eases in, then dances, then stops for the last few seconds.
    expect(ch[0].avgSpeed).toBeLessThan(ch[1].avgSpeed)
    expect(ch[ch.length - 1].kind).toBe('break')
    for (const c of ch) {
      expect(c.name).toBeTruthy()
      expect(c.end - c.start).toBeGreaterThanOrEqual(4000)
    }
  })
})

describe('parseTimespan', () => {
  it('reads the schema format and its hand-written cousins', () => {
    expect(parseTimespan('00:01:02.500')).toBe(62_500)
    expect(parseTimespan('01:00:00.000')).toBe(3_600_000)
    expect(parseTimespan('1:02:03')).toBe(3_723_000)
    expect(parseTimespan('02:03')).toBe(123_000)
    expect(parseTimespan('2:03.5')).toBe(123_500)
    expect(parseTimespan('90')).toBe(90_000)
    expect(parseTimespan('125:00')).toBe(7_500_000)
    expect(parseTimespan('00:00:01,25')).toBe(1250)
    expect(parseTimespan(1500)).toBe(1500)
  })

  it('rejects what is not a time', () => {
    for (const v of ['', 'soon', '1:xx', '-5', null, undefined, {}, Number.NaN])
      expect(parseTimespan(v)).toBeNull()
  })
})

describe('author chapters', () => {
  const a = joined(strokes(0, 60_000, SLOW), strokes(60_000, 60_000, FAST), strokes(120_000, 60_000, SLOW))

  it('keep their names exactly and cover the whole length', () => {
    const ch = authorChapters(a, {
      chapters: [
        { name: 'Teasing  ✨', startTime: '00:00:00.000', endTime: '00:01:00.000' },
        { name: 'The drop', startTime: '00:01:00.000', endTime: '00:02:00.000' },
        { name: 'after', startTime: '00:02:00.000', endTime: '00:03:00.000' },
      ],
    }, { durationMs: 180_000 })
    expect(ch.map(c => c.name)).toEqual(['Teasing  ✨', 'The drop', 'after'])
    expect(ch.every(c => c.source === 'author')).toBe(true)
    expect(ch[1].kind).toBe('peak')
    expect(ch[0].kind).toBe('slow')
    expectContiguous(ch, 180_000)
  })

  it('sorts, clips overlaps and runs open ends to the next start', () => {
    const ch = authorChapters(a, {
      chapters: [
        { name: 'B', startTime: '1:00' },
        { name: 'A', startTime: '0:00', endTime: '1:30' },
        { name: 'broken', startTime: 'later' },
      ],
    }, { durationMs: 180_000 })
    expect(ch.map(c => c.name)).toEqual(['A', 'B'])
    expect(ch[0].end).toBe(60_000)
    expect(ch[1].start).toBe(60_000)
    expect(ch[1].end).toBe(180_000)
  })

  it('absorbs short gaps and names long ones', () => {
    const ch = authorChapters(a, {
      chapters: [
        { name: 'One', startTime: '00:00:03', endTime: '00:00:40' },
        { name: 'Two', startTime: '00:00:45', endTime: '00:01:10' },
        { name: 'Three', startTime: '00:02:20', endTime: '00:02:50' },
      ],
    }, { durationMs: 180_000 })
    expect(ch.map(c => c.name)).toEqual(['One', 'Two', GAP_NAME, 'Three', GAP_NAME])
    // A 3 s lead-in and a 5 s gap are not worth a section.
    expect(ch[0].start).toBe(0)
    expect(ch[0].end).toBe(45_000)
    expect(ch[2].start).toBe(70_000)
    expect(ch[2].end).toBe(140_000)
    expectContiguous(ch, 180_000)
  })

  it('win over detection, which stays the fallback', () => {
    const script = { filename: 'x.funscript', channel: 'L0', parsed: { actions: a } }
    const auto = chaptersForScript(script, 180)
    expect(auto.every(c => c.source === 'auto')).toBe(true)
    const meta = { chapters: [{ name: 'All of it', startTime: '00:00:00.000', endTime: '00:03:00.000' }] }
    const author = chaptersForScript(script, 180, undefined, meta)
    expect(author.map(c => c.name)).toEqual(['All of it'])
    expect(author[0].source).toBe('author')
    // Nothing usable written: detection again.
    expect(chaptersForScript(script, 180, undefined, { chapters: [{ name: 'x' }] })[0].source).toBe('auto')
    expect(chaptersForScript(script, 180, undefined, { chapters: [] })[0].source).toBe('auto')
  })
})
