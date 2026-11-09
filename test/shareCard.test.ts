import type { Measure } from '../src/lib/shareCard'
import { describe, expect, it } from 'vitest'
import {
  bannerSplit,
  busiestWindow,
  cardFileName,
  cardStats,
  chapterLabels,
  coverCrop,
  creatorOf,
  DEFAULT_CARD_PREFS,
  defaultMoments,
  ellipsize,
  fitText,
  fitWrapped,
  formatCount,
  formatDuration,
  heatColor,
  heatRgb,
  heatScale,
  normaliseCardPrefs,
  oklchToRgb,
  speedMix,
  speedRange,
  stackRows,
  strokeColumns,
  tileGrid,
  timeTicks,
  titleFromName,
  wrapText,
} from '../src/lib/shareCard'

/** Strokes between 0.1 and 0.9 every `periodMs`, from `t0`. Speed: 160 / period units/s. */
function strokes(count: number, periodMs: number, t0 = 0) {
  const out: { at: number, pos: number }[] = []
  for (let i = 0; i < count; i++) {
    out.push({ at: t0 + i * periodMs, pos: 0.1 })
    out.push({ at: t0 + i * periodMs + periodMs / 2, pos: 0.9 })
  }
  return out
}

/** Every character half the font size wide. */
const measure: Measure = (text, size) => Array.from(text).length * size * 0.5

describe('prefs', () => {
  it('fills in what is missing or unknown', () => {
    expect(normaliseCardPrefs(null)).toEqual({ ...DEFAULT_CARD_PREFS, v: 2 })
    expect(normaliseCardPrefs({ v: 2, style: 'poster', size: 'huge', palette: 'ofs', chapters: false, frame: false, picture: 'four' }))
      .toEqual({ v: 2, style: 'poster', size: 'banner', palette: 'ofs', fit: false, chapters: false, frame: false, picture: 'four' })
  })

  it('has the frame on, and moves saved prefs from before onto the playhound colours', () => {
    expect(DEFAULT_CARD_PREFS.frame).toBe(true)
    expect(normaliseCardPrefs({ style: 'candy', palette: 'ofs' })).toMatchObject({ style: 'candy', palette: 'playhound', frame: true })
  })
})

describe('cardStats', () => {
  it('averages speed over moving time only', () => {
    // 80 units in 500 ms = 160/s, then a 10 s hold, then the same again.
    const a = [
      { at: 0, pos: 0.1 },
      { at: 500, pos: 0.9 },
      { at: 10_500, pos: 0.9 },
      { at: 11_000, pos: 0.1 },
    ]
    const s = cardStats(a)
    expect(s.avgSpeed).toBeCloseTo(160)
    expect(s.maxSpeed).toBeCloseTo(160)
    expect(s.actions).toBe(4)
    expect(s.durationMs).toBe(11_000)
    expect(s.moving).toBeCloseTo(1 / 11)
  })

  it('leaves slips of a few milliseconds out of the top speed', () => {
    const a = [{ at: 0, pos: 0 }, { at: 500, pos: 1 }, { at: 505, pos: 0 }]
    expect(cardStats(a).maxSpeed).toBeCloseTo(200)
  })

  it('takes the video length when it is longer', () => {
    expect(cardStats(strokes(4, 1000), 60_000).durationMs).toBe(60_000)
  })

  it('counts strokes and their rate', () => {
    const s = cardStats(strokes(60, 1000))
    expect(s.strokes).toBeGreaterThanOrEqual(58)
    expect(s.strokesPerMin).toBeGreaterThan(55)
    expect(s.strokesPerMin).toBeLessThan(65)
  })

  it('is all zeros for nothing', () => {
    expect(cardStats([])).toMatchObject({ actions: 0, avgSpeed: 0, maxSpeed: 0, durationMs: 0 })
  })
})

describe('heat colours', () => {
  it('playhound: a different colour for 300, 450 and 600, still changing past 600', () => {
    const dist = (a: number, b: number) => {
      const x = heatRgb(a, 'playhound')
      const y = heatRgb(b, 'playhound')
      return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2])
    }
    expect(dist(300, 450)).toBeGreaterThan(80)
    expect(dist(450, 600)).toBeGreaterThan(80)
    expect(dist(600, 800)).toBeGreaterThan(80)
    // Nothing near black or washed out: every step is bright and has colour.
    for (const s of [20, 60, 150, 300, 450, 600, 800]) {
      const c = heatRgb(s, 'playhound')
      expect(Math.max(...c)).toBeGreaterThan(150)
      expect(Math.max(...c) - Math.min(...c)).toBeGreaterThan(90)
    }
  })

  it('fits a scale to a script: its 5th to 98th percentile spans the colours', () => {
    // 10 s at 160 units/s, then 10 s at 400.
    const a = [...strokes(10, 1000), ...strokes(25, 400, 10_000)]
    const r = speedRange(a)!
    expect(r.lo).toBeCloseTo(160, 0)
    expect(r.hi).toBeCloseTo(400, 0)
    const fit = heatScale('playhound', r)
    expect(fit.at(0)).toBeCloseTo(r.lo)
    expect(fit.at(1)).toBeCloseTo(r.hi)
    // The ends of the fitted scale are the ends of the palette.
    expect(fit.rgb(r.lo)).toEqual(heatRgb(25, 'playhound'))
    expect(fit.rgb(r.hi)).toEqual(heatRgb(1100, 'playhound'))
    // Unfitted, the palette as it is.
    expect(heatScale('ofs').rgb(160)).toEqual(heatRgb(160, 'ofs'))
  })

  it('keeps a steady script off the ends when fitting it', () => {
    const r = speedRange(strokes(30, 1000))!
    expect(r.hi / r.lo).toBeGreaterThanOrEqual(1.5)
    expect(speedRange([{ at: 0, pos: 0.5 }, { at: 1000, pos: 0.5 }])).toBeNull()
  })

  it('funscript.io: black at rest, blue at 60, green at 180, gold at 300, red at 420, indigo past 600', () => {
    expect(heatRgb(0, 'funscriptio')).toEqual([0, 0, 0])
    expect(heatRgb(60, 'funscriptio')).toEqual([30, 144, 255])
    expect(heatRgb(180, 'funscriptio')).toEqual([34, 139, 34])
    expect(heatRgb(300, 'funscriptio')).toEqual([255, 215, 0])
    expect(heatRgb(420, 'funscriptio')).toEqual([220, 20, 60])
    expect(heatRgb(700, 'funscriptio')).toEqual([37, 22, 122])
  })

  it('openFunScripter: blue for any movement, cyan at 160, red from 400', () => {
    expect(heatRgb(0, 'ofs')).toEqual([0, 0, 0])
    expect(heatRgb(1, 'ofs')[2]).toBeGreaterThan(250)
    expect(heatRgb(160, 'ofs')).toEqual([0, 255, 255])
    expect(heatRgb(400, 'ofs')).toEqual([255, 0, 0])
    expect(heatRgb(900, 'ofs')).toEqual([255, 0, 0])
  })

  it('eroScripts: blue when slow, red-ish when fast', () => {
    const slow = heatRgb(20, 'eroscripts')
    const fast = heatRgb(450, 'eroscripts')
    expect(slow[2]).toBeGreaterThan(slow[0])
    expect(fast[0]).toBeGreaterThan(fast[2])
  })

  it('makes CSS colours', () => {
    expect(heatColor(60, 'funscriptio')).toBe('rgb(30,144,255)')
    expect(heatColor(60, 'funscriptio', 0.5)).toBe('rgba(30,144,255,0.5)')
  })

  it('converts OKLCH, pulling chroma into gamut', () => {
    expect(oklchToRgb(1, 0, 0)).toEqual([255, 255, 255])
    expect(oklchToRgb(0, 0, 0)).toEqual([0, 0, 0])
    for (const v of oklchToRgb(0.8, 0.4, 120)) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(255)
    }
  })
})

describe('strokeColumns', () => {
  it('is empty before the script starts and after it ends', () => {
    const cols = strokeColumns(strokes(10, 1000, 10_000), 30, 30_000)
    expect(cols[0].speed).toBeNull()
    expect(cols[29].speed).toBeNull()
    expect(cols[15].speed).not.toBeNull()
  })

  it('follows each stroke: narrow columns go up and down with the line, not a full-height block', () => {
    // Strokes 0.1 to 0.9 every second, 160 units/s, drawn 50 columns a second.
    const cols = strokeColumns(strokes(20, 1000), 1000, 20_000)
    const mid = cols.slice(500, 550)
    // Each column covers 20 ms: a sliver of one stroke, never the whole range.
    expect(Math.max(...mid.map(c => c.hi - c.lo))).toBeLessThan(0.05)
    // Across a stroke the line reaches the bottom and the top.
    expect(Math.min(...mid.map(c => c.lo))).toBeCloseTo(0.1, 1)
    expect(Math.max(...mid.map(c => c.hi))).toBeCloseTo(0.9, 1)
    for (const c of mid)
      expect(c.speed).toBeCloseTo(160, 0)
  })

  it('takes the line from the action points themselves', () => {
    // One stroke from 0 to 1 and back over 2 s, drawn in 4 columns.
    const cols = strokeColumns([{ at: 0, pos: 0 }, { at: 1000, pos: 1 }, { at: 2000, pos: 0 }], 4, 2000)
    expect(cols.map(c => [c.lo, c.hi])).toEqual([[0, 0.5], [0.5, 1], [0.5, 1], [0, 0.5]])
  })

  it('is solid only where strokes are narrower than a column', () => {
    // Ten strokes a second in columns of half a second.
    const cols = strokeColumns(strokes(100, 100), 20, 10_000)
    expect(cols[10].hi - cols[10].lo).toBeCloseTo(0.8, 1)
  })

  it('shows a hold as no speed, at its place', () => {
    const cols = strokeColumns([{ at: 0, pos: 0.5 }, { at: 20_000, pos: 0.5 }], 10, 20_000)
    expect(cols.every(c => c.speed === 0 && c.lo === 0.5 && c.hi === 0.5)).toBe(true)
  })

  it('copes with nothing at all', () => {
    expect(strokeColumns([], 5, 1000)).toHaveLength(5)
    expect(strokeColumns([], 5, 1000).every(c => c.speed === null)).toBe(true)
  })
})

describe('speedMix', () => {
  it('splits moving time into the bands, adding up to all of it', () => {
    const a = [...strokes(10, 1000), ...strokes(10, 400, 10_000)]
    const mix = speedMix(a)
    expect(mix.map(b => b.label)).toEqual(['0–100', '100–200', '200–300', '300–400', '400+'])
    expect(mix.reduce((n, b) => n + b.share, 0)).toBeCloseTo(1)
    // 160/s for 10 s, then 400/s for 4 s.
    expect(mix[1].share).toBeCloseTo(10 / 14, 1)
    expect(mix[4].share).toBeCloseTo(4 / 14, 1)
  })
})

describe('busiestWindow', () => {
  it('finds the stretch that moves the most', () => {
    const a = [...strokes(20, 2000), ...strokes(20, 500, 40_000), ...strokes(20, 2000, 50_000)]
    const w = busiestWindow(a, 8000)!
    expect(w.start).toBeGreaterThanOrEqual(39_000)
    expect(w.end).toBeLessThanOrEqual(51_000)
    expect(w.end - w.start).toBe(8000)
  })

  it('takes the whole script when it is shorter than the window', () => {
    expect(busiestWindow(strokes(2, 1000), 20_000)).toEqual({ start: 0, end: 1500 })
  })

  it('is null when nothing moves', () => {
    expect(busiestWindow([{ at: 0, pos: 0.5 }, { at: 30_000, pos: 0.5 }, { at: 60_000, pos: 0.5 }], 10_000)).toBeNull()
  })
})

describe('words and numbers', () => {
  it('formats lengths', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(223_150)).toBe('3:43')
    expect(formatDuration(3_723_000)).toBe('1:02:03')
  })

  it('formats counts with commas', () => {
    expect(formatCount(7)).toBe('7')
    expect(formatCount(1168)).toBe('1,168')
    expect(formatCount(1_234_567)).toBe('1,234,567')
  })

  it('takes the title from a file name', () => {
    expect(titleFromName('Videos/sub/My clip.mp4')).toBe('My clip')
    expect(titleFromName('C:\\v\\clip.funscript')).toBe('clip')
    expect(titleFromName('Part 1.5 final')).toBe('Part 1.5 final')
  })

  it('reads the creator from metadata', () => {
    expect(creatorOf({ creator: ' Someone ' })).toBe('Someone')
    expect(creatorOf({ creator: '' })).toBe('')
    expect(creatorOf(null)).toBe('')
    expect(creatorOf({ creator: 5 })).toBe('')
  })

  it('names the PNG after the video', () => {
    expect(cardFileName('clip.mp4')).toBe('clip.card.png')
    expect(cardFileName('a: b?')).toBe('a_ b_.card.png')
    expect(cardFileName('')).toBe('script.card.png')
  })
})

describe('fitting text', () => {
  it('ellipsizes to the width', () => {
    expect(ellipsize(measure, 'short', 10, 100)).toBe('short')
    const cut = ellipsize(measure, 'a rather long title indeed', 10, 60)
    expect(cut.endsWith('…')).toBe(true)
    expect(measure(cut, 10)).toBeLessThanOrEqual(60)
    expect(ellipsize(measure, 'abc', 10, 2)).toBe('')
  })

  it('shrinks before it cuts', () => {
    expect(fitText(measure, 'abcdefghij', 100, 30, 10)).toEqual({ text: 'abcdefghij', size: 20 })
    const tight = fitText(measure, 'abcdefghij', 40, 30, 10)
    expect(tight.size).toBe(10)
    expect(tight.text.endsWith('…')).toBe(true)
  })

  it('wraps by words, keeping a dash with the word before it', () => {
    expect(wrapText(measure, 'one two three four', 10, 45, 3)).toEqual(['one two', 'three', 'four'])
    expect(wrapText(measure, 'Show - Heart Pie', 10, 40, 3)).toEqual(['Show -', 'Heart', 'Pie'])
  })

  it('cuts the last line when the rest does not fit', () => {
    const lines = wrapText(measure, 'one two three four five six', 10, 50, 2)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe('one two')
    expect(lines[1].endsWith('…')).toBe(true)
  })

  it('picks the biggest size at which a title wraps whole', () => {
    const r = fitWrapped(measure, 'one two three four', 100, 2, 30, 10)
    expect(r.lines.join(' ')).toBe('one two three four')
    expect(r.size).toBeLessThanOrEqual(22)
    expect(r.size).toBeGreaterThanOrEqual(16)
  })
})

describe('layout', () => {
  it('stacks the axis rows under the heatmap', () => {
    const { hero, rows } = stackRows({ x: 0, y: 100, w: 1000, h: 200 }, 3, 12, 6, 80)
    expect(rows).toHaveLength(3)
    expect(hero.h).toBe(200 - 3 * 18)
    expect(rows[0].y).toBe(hero.y + hero.h + 6)
    expect(rows[2].y + rows[2].h).toBe(300)
  })

  it('shrinks the rows rather than the heatmap below its minimum', () => {
    const { hero, rows } = stackRows({ x: 0, y: 0, w: 100, h: 100 }, 4, 20, 8, 70)
    expect(hero.h).toBeGreaterThanOrEqual(70)
    expect(rows[3].y + rows[3].h).toBeLessThanOrEqual(100)
  })

  it('puts time ticks on round steps', () => {
    expect(timeTicks(223_000, 8)).toEqual([0, 30_000, 60_000, 90_000, 120_000, 150_000, 180_000, 210_000])
    // Not one right up against the end.
    expect(timeTicks(215_000, 8).at(-1)).toBe(180_000)
    expect(timeTicks(3_600_000, 8)).toEqual([0, 600_000, 1_200_000, 1_800_000, 2_400_000, 3_000_000])
    expect(timeTicks(0, 8)).toEqual([])
  })

  it('drops chapter names that do not fit and cuts the ones that nearly do', () => {
    const chapters = [
      { name: 'Intro', start: 0, end: 10_000 },
      { name: 'A', start: 10_000, end: 11_000 },
      { name: 'Very long chapter name', start: 11_000, end: 60_000 },
      { name: 'End', start: 90_000, end: 100_000 },
    ]
    const labels = chapterLabels(chapters, 100_000, 1000, measure, 10, 8)
    expect(labels.map(l => l.text)).toContain('Intro')
    expect(labels.map(l => l.chapter.name)).toContain('End')
    for (let i = 1; i < labels.length; i++)
      expect(labels[i].x).toBeGreaterThanOrEqual(labels[i - 1].x + measure(labels[i - 1].text, 10))
  })

  it('lays pictures out in a grid that fills its box', () => {
    const tiles = tileGrid({ x: 0, y: 0, w: 1000, h: 400 }, 4, 2, 10)
    expect(tiles).toHaveLength(4)
    expect(tiles[0]).toEqual({ x: 0, y: 0, w: 495, h: 195 })
    expect(tiles[3]).toEqual({ x: 505, y: 205, w: 495, h: 195 })
    expect(tileGrid({ x: 0, y: 0, w: 1000, h: 100 }, 4, 4, 12).map(t => t.x)).toEqual([0, 253, 506, 759])
  })

  it('makes room for a banner picture only when the rest still fits', () => {
    const s = bannerSplit({ x: 32, y: 32, w: 1136, h: 276 }, 4 / 3, 30, 600)!
    expect(s.panel).toEqual({ x: 32, y: 32, w: 368, h: 276 })
    expect(s.rest.x).toBe(32 + 368 + 30)
    expect(s.rest.x + s.rest.w).toBe(32 + 1136)
    expect(bannerSplit({ x: 0, y: 0, w: 700, h: 276 }, 4 / 3, 30, 600)).toBeNull()
  })

  it('starts the pictures where the player is, the rest spread out', () => {
    expect(defaultMoments(100, 42)).toEqual([42, 12.5, 62.5, 87.5])
    expect(defaultMoments(100, null)[0]).toBe(33)
    expect(defaultMoments(100, 500)[0]).toBe(33)
  })

  it('crops a frame to cover the card', () => {
    expect(coverCrop(1920, 1080, { w: 1200, h: 340 })).toMatchObject({ x: 0, w: 1920 })
    const tall = coverCrop(1080, 1920, { w: 1200, h: 800 })
    expect(tall.w).toBe(1080)
    expect(tall.h).toBeCloseTo(720)
  })
})
