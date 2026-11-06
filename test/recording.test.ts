import type { FunscriptAction } from '~/lib/funscriptParser'
import { describe, expect, it } from 'vitest'
import { extractSuffix } from '~/lib/axisMap'
import { interpolatePosition, parseFunscriptContent } from '~/lib/funscriptParser'
import {
  cleanBase,
  createAxisModel,
  createTake,
  defaultBase,
  fileNameFor,
  funscriptText,
  mergeSegments,
  roundActions,
  sessionBase,
  simplify,
} from '~/lib/recording'

/** A stroke as the generator makes it: sine, `spm`, between 0.15 and 0.85. */
function sine(t: number, spm = 90) {
  return 0.5 - 0.35 * Math.cos((t / 60_000) * spm * Math.PI * 2)
}

/** Samples at `hz` for `ms`. */
function sampled(fn: (t: number) => number, ms: number, hz = 60): FunscriptAction[] {
  const out: FunscriptAction[] = []
  for (let t = 0; t <= ms; t += 1000 / hz)
    out.push({ at: t, pos: fn(t) })
  return out
}

/** Worst position error of `actions` (0–1 positions) against `fn`. */
function worstError(actions: FunscriptAction[], fn: (t: number) => number, ms: number) {
  let worst = 0
  for (let t = 0; t <= ms; t += 5)
    worst = Math.max(worst, Math.abs(interpolatePosition(actions, t) - fn(t)))
  return worst
}

describe('createAxisModel', () => {
  it('takes a streamed position as where the axis is now', () => {
    const m = createAxisModel()
    m.command(0.2, 40, 1000)
    expect(m.at(1000)).toBe(0.2)
    m.command(0.8, 0, 1016)
    expect(m.at(1016)).toBe(0.8)
  })

  it('records a slow command as the travel it asks for', () => {
    const m = createAxisModel()
    m.command(1, 0, 0)
    m.command(0.5, 500, 100)
    expect(m.at(100)).toBe(1)
    expect(m.at(350)).toBeCloseTo(0.75)
    expect(m.at(600)).toBe(0.5)
    expect(m.at(5000)).toBe(0.5)
  })

  it('a slow first command has nothing to travel from', () => {
    const m = createAxisModel()
    m.command(0.5, 600, 0)
    expect(m.at(0)).toBe(0.5)
  })
})

describe('simplify', () => {
  it('keeps a stroke round with a handful of points per stroke', () => {
    const ms = 20_000
    const raw = sampled(t => sine(t), ms)
    const out = simplify(raw)
    const strokes = (ms / 60_000) * 90
    // Fifty-odd samples a stroke down to a few, and still the same motion.
    expect(out.length / strokes).toBeLessThan(10)
    expect(out.length / strokes).toBeGreaterThanOrEqual(2)
    expect(worstError(out, t => sine(t), ms)).toBeLessThan(0.03)
  })

  it('keeps every turn at its full depth', () => {
    const raw = sampled(t => sine(t, 60), 10_000)
    const out = simplify(raw, 0.2)
    // Ten strokes: ten tops near 0.85, ten bottoms near 0.15, even with a loose tolerance.
    const tops = out.filter(p => p.pos > 0.84).length
    const bottoms = out.filter(p => p.pos < 0.16).length
    expect(tops).toBeGreaterThanOrEqual(10)
    expect(bottoms).toBeGreaterThanOrEqual(10)
  })

  it('drops a still stretch down to its ends', () => {
    const raw = sampled(t => (t < 2000 ? 0.5 : t < 2500 ? 0.5 + (t - 2000) / 1000 : 1), 6000)
    const out = simplify(raw)
    expect(out.length).toBeLessThanOrEqual(4)
    expect(out[0].pos).toBe(0.5)
    expect(out.at(-1)!.pos).toBe(1)
    expect(worstError(out, t => (t < 2000 ? 0.5 : t < 2500 ? 0.5 + (t - 2000) / 1000 : 1), 6000)).toBeLessThan(0.03)
  })

  it('ignores wobble smaller than a turn', () => {
    const raw = sampled(t => 0.5 + 0.004 * Math.sin(t / 30), 5000)
    expect(simplify(raw).length).toBe(2)
  })
})

describe('roundActions', () => {
  it('writes whole ms and 0–100, one point per ms, no middle of a flat run', () => {
    const out = roundActions([
      { at: 0.2, pos: 0.501 },
      { at: 0.4, pos: 0.6 },
      { at: 100, pos: 0.6 },
      { at: 200, pos: 0.6 },
      { at: 300.6, pos: 0.6 },
      { at: 400, pos: 1.2 },
    ])
    expect(out).toEqual([
      { at: 0, pos: 60 },
      { at: 301, pos: 60 },
      { at: 400, pos: 100 },
    ])
  })
})

describe('mergeSegments', () => {
  it('lets a later segment replace the time it covers', () => {
    const out = mergeSegments([
      { start: 0, end: 3000, points: [0, 0.1, 1000, 0.2, 2000, 0.3, 3000, 0.4] },
      { start: 1500, end: 2500, points: [1500, 0.9, 2500, 0.9] },
    ])
    expect(out).toEqual([
      { at: 0, pos: 0.1 },
      { at: 1000, pos: 0.2 },
      { at: 1500, pos: 0.9 },
      { at: 2500, pos: 0.9 },
      { at: 3000, pos: 0.4 },
    ])
  })
})

describe('createTake', () => {
  it('follows the clock it is given, and leaves out what did not move', () => {
    const take = createTake()
    for (let t = 0; t <= 4000; t += 20)
      take.add(t, [['L0', sine(t)], ['R0', 0.5]])
    const axes = take.finish()
    expect(axes.map(a => a.channel)).toEqual(['L0'])
    expect(take.recordedMs).toBe(4000)
    const a = axes[0].actions
    expect(a[0].at).toBe(0)
    expect(a.at(-1)!.at).toBe(4000)
    expect(a.every(p => Number.isInteger(p.at) && Number.isInteger(p.pos) && p.pos >= 0 && p.pos <= 100)).toBe(true)
  })

  it('a pause leaves no gap: video time stands still, so the stroke carries on', () => {
    const take = createTake({ gapMs: 1000 })
    // 0–2 s of video, a long pause (nothing sampled), then 2–4 s.
    for (let t = 0; t <= 2000; t += 20)
      take.add(t, [['L0', sine(t)]])
    for (let t = 2020; t <= 4000; t += 20)
      take.add(t, [['L0', sine(t)]])
    expect(take.recordedMs).toBe(4000)
  })

  it('a seek back records over that part again', () => {
    const take = createTake({ gapMs: 1000 })
    for (let t = 0; t <= 6000; t += 20)
      take.add(t, [['L0', sine(t)]])
    // Back to 2 s, and this time the stroke is held at the top.
    for (let t = 2000; t <= 3000; t += 20)
      take.add(t, [['L0', 0.9]])
    const a = take.finish()[0].actions
    const inside = a.filter(p => p.at >= 2000 && p.at <= 3000)
    expect(inside.every(p => p.pos === 90)).toBe(true)
    // Outside it, the first pass is still there.
    expect(a.some(p => p.at > 3000 && p.pos < 20)).toBe(true)
    expect(take.recordedMs).toBe(7000)
  })

  it('a seek forward starts a new stretch, without recording the skipped time', () => {
    const take = createTake({ gapMs: 1000 })
    for (let t = 0; t <= 2000; t += 20)
      take.add(t, [['L0', sine(t)]])
    for (let t = 30_000; t <= 32_000; t += 20)
      take.add(t, [['L0', sine(t)]])
    expect(take.recordedMs).toBe(4000)
    const a = take.finish()[0].actions
    expect(a.some(p => p.at > 2000 && p.at < 30_000)).toBe(false)
  })

  it('an axis that joins later starts where it joined', () => {
    const take = createTake()
    for (let t = 0; t <= 4000; t += 20)
      take.add(t, t < 2000 ? [['L0', sine(t)]] : [['L0', sine(t)], ['R0', sine(t, 30)]])
    const axes = take.finish()
    expect(axes.map(a => a.channel)).toEqual(['L0', 'R0'])
    expect(axes[1].actions[0].at).toBe(2000)
  })
})

describe('file names', () => {
  it('names each axis the way the library pairs them', () => {
    expect(fileNameFor('clip', 'L0')).toBe('clip.funscript')
    expect(fileNameFor('clip', 'R0')).toBe('clip.twist.funscript')
    expect(fileNameFor('clip.recorded', 'V0')).toBe('clip.recorded.vib.funscript')
  })

  it('suggests the video\'s own name when it would replace nothing', () => {
    const now = new Date(2026, 10, 6, 21, 5)
    expect(defaultBase({ video: 'clip.mp4', channels: ['L0'], existing: new Set(['clip.mp4']), now })).toBe('clip')
    expect(defaultBase({ video: 'clip.mp4', channels: ['L0'], existing: new Set(['clip.funscript']), now })).toBe('clip.recorded')
    // A twist script there already: the stroke alone could take the bare name, both together cannot.
    expect(defaultBase({ video: 'clip.mp4', channels: ['L0', 'R0'], existing: new Set(['clip.twist.funscript']), now })).toBe('clip.recorded')
    expect(defaultBase({ video: 'clip.mp4', channels: ['L0'], existing: new Set(['clip.funscript', 'clip.recorded.funscript']), now })).toBe('clip.recorded-2')
  })

  it('names a take without a video after when it was made', () => {
    const now = new Date(2026, 10, 6, 21, 5)
    expect(sessionBase(now)).toBe('session-2026-11-06-2105')
    expect(defaultBase({ video: null, channels: ['L0'], existing: new Set(), now })).toBe('session-2026-11-06-2105')
    expect(defaultBase({ video: null, channels: ['L0'], existing: new Set(['session-2026-11-06-2105.funscript']), now })).toBe('session-2026-11-06-2105-2')
  })

  it('cleans a typed name', () => {
    expect(cleanBase('  my take.funscript ')).toBe('my take')
    expect(cleanBase('a/b:c?.')).toBe('abc')
    expect(cleanBase('   ')).toBe('')
  })

  it('reads a recorded axis file as that axis', () => {
    expect(extractSuffix('clip.mp4', 'clip.recorded.twist.funscript')).toBe('twist')
    expect(extractSuffix('clip.mp4', 'clip.recorded.funscript')).toBe('recorded')
    expect(extractSuffix('clip.mp4', 'clip.twist.funscript')).toBe('twist')
    expect(extractSuffix('clip.mp4', 'clip.funscript')).toBe('default')
    expect(extractSuffix('clip.mp4', 'clip (alt 2).roll.funscript')).toBe('roll')
  })
})

describe('funscriptText', () => {
  it('writes a funscript that reads back as the same points', () => {
    const actions = [{ at: 0, pos: 10 }, { at: 500, pos: 90 }, { at: 1000, pos: 10 }]
    const text = funscriptText(actions, { title: 'clip', durationMs: 61_400 })
    const raw = JSON.parse(text)
    expect(raw.version).toBe('1.0')
    expect(raw.metadata.duration).toBe(61)
    expect(raw.actions).toEqual(actions)
    const parsed = parseFunscriptContent(text, 'clip.funscript', 'clip.mp4')
    expect(parsed.axes[0].channel).toBe('L0')
    expect(parsed.axes[0].actions.map(a => a.pos)).toEqual([0.1, 0.9, 0.1])
  })
})
