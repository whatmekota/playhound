import type { IndexedChapter } from '../src/lib/chapterIndex'
import type { ReelClip, ReelSource } from '../src/lib/reel'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CURVE_MS, indexScript } from '../src/lib/chapterIndex'
import { parseFunscriptContent } from '../src/lib/funscriptParser'
import { runShape, shapeAt, shapeBreaks, TEMPLATES } from '../src/lib/programme'
import {
  chooseWindow,
  clipSeconds,
  cutSoon,
  guessCreator,
  lengthen,
  planReel,
  poolSize,
  retime,
  rng,
  snapCut,
  windowIntensity,
} from '../src/lib/reel'
import { meanSpeedToIntensity, SCRIPT_SPEED_CEIL, SCRIPT_SPEED_FLOOR } from '../src/lib/scriptIntensity'

/** The speed that rates as `v` on the library calibration. */
const speedFor = (v: number) => SCRIPT_SPEED_FLOOR + v * (SCRIPT_SPEED_CEIL - SCRIPT_SPEED_FLOOR)

/**
 * A synthetic video: chapters of the given (seconds, intensity), a flat speed
 * curve inside each, and a stroke bottom every `strokeMs`.
 */
function video(name: string, parts: [number, number][], opts: { creator?: string | null, tags?: string[], strokeMs?: number } = {}): ReelSource {
  const chapters: IndexedChapter[] = []
  const curve: number[] = []
  let t = 0
  for (const [sec, v] of parts) {
    const start = t
    t += sec * 1000
    chapters.push({ start, end: t, intensity: v, speed: speedFor(v), spm: 60, kind: v < 0.02 ? 'break' : 'medium', name: `ch${chapters.length}`, source: 'auto' })
  }
  for (let k = 0; k < Math.ceil(t / CURVE_MS); k++) {
    const mid = k * CURVE_MS + CURVE_MS / 2
    const ch = chapters.find(c => mid < c.end) ?? chapters[chapters.length - 1]
    curve.push(speedFor(ch.intensity))
  }
  const step = opts.strokeMs ?? 700
  const cuts: number[] = []
  for (let c = 350; c < t; c += step)
    cuts.push(c)
  return { video: name, durationMs: t, chapters, cuts, curve, creator: opts.creator ?? null, tags: opts.tags ?? [] }
}

/** A library with chapters spread across the range, from several creators. */
function library(n = 30): ReelSource[] {
  const r = rng(99)
  return Array.from({ length: n }, (_, i) => video(
    `v${i}.mp4`,
    Array.from({ length: 5 }, () => [30 + Math.round(r() * 120), Math.round(r() * 100) / 100] as [number, number]),
    { creator: `c${i % 5}`, tags: [`t${i % 3}`] },
  ))
}

const ramp = (from: number, to: number, total: number) => (t: number) => from + (to - from) * Math.min(1, Math.max(0, t / total))

describe('helpers', () => {
  it('is deterministic per seed', () => {
    const a = rng(5)
    const b = rng(5)
    const c = rng(6)
    const xs = [a(), a(), a()]
    expect([b(), b(), b()]).toEqual(xs)
    expect(c()).not.toBe(xs[0])
    for (const x of xs) {
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThan(1)
    }
  })

  it('guesses a creator from the usual file naming', () => {
    expect(guessCreator('(AZNYAN07) Across the Renamon-Verse')).toBe('aznyan07')
    expect(guessCreator('[Bastati] Blobber')).toBe('bastati')
    expect(guessCreator('Just a title')).toBeNull()
  })

  it('snaps to the nearest cut point in reach, preferring forward on a tie', () => {
    const cuts = [1000, 5000, 9000]
    expect(snapCut(cuts, 4800)).toBe(5000)
    expect(snapCut(cuts, 7000)).toBe(9000) // 2 s back is 5000 (out of reach), 2 s forward is 9000
    expect(snapCut(cuts, 3000)).toBe(5000)
    expect(snapCut([], 1234)).toBe(1234)
    expect(snapCut([100_000], 1234)).toBe(1234)
  })

  it('rates a window from the speed curve', () => {
    const v = video('a', [[60, 0.2], [60, 0.8]])
    expect(windowIntensity(v, 0, 60_000)).toBeCloseTo(0.2, 2)
    expect(windowIntensity(v, 60_000, 120_000)).toBeCloseTo(0.8, 2)
    expect(windowIntensity(v, 30_000, 90_000)).toBeCloseTo(0.5, 2)
  })

  it('cuts soon at the next stroke bottom', () => {
    const v = video('a', [[60, 0.5]], { strokeMs: 1000 })
    expect(cutSoon(v, 10)).toBeCloseTo(10.35)
    // Nothing within reach: now.
    expect(cutSoon({ cuts: [] }, 10)).toBe(10)
  })

  it('counts the usable pool, leaving out breaks and stubs', () => {
    const pool = [video('a', [[60, 0.5], [5, 0.5], [30, 0]]), video('b', [[40, 0.3]])]
    expect(poolSize(pool, 20)).toEqual({ chapters: 2, videos: 2 })
  })
})

describe('windows', () => {
  const v = video('a', [[40, 0.3], [300, 0.5], [10, 0.6]])
  v.curve = v.curve.map((s, k) => (k >= 30 && k < 42 ? speedFor(0.95) : s)) // a dense stretch at 150–210 s

  it('plays a chapter whole when it fits, with its ends on cut points', () => {
    const w = chooseWindow(v, v.chapters[0], 120_000, 20_000, 0.3)!
    expect(w.startMs).toBeLessThanOrEqual(1500)
    expect(w.endMs).toBeGreaterThanOrEqual(39_000)
    expect(v.cuts).toContain(w.startMs)
    expect(v.cuts).toContain(w.endMs)
  })

  it('trims a long chapter to its densest stretch for a high target', () => {
    const w = chooseWindow(v, v.chapters[1], 60_000, 20_000, 0.95)!
    expect(w.endMs - w.startMs).toBeGreaterThan(55_000)
    expect(w.endMs - w.startMs).toBeLessThan(66_000)
    expect(w.startMs).toBeGreaterThanOrEqual(145_000)
    expect(w.endMs).toBeLessThanOrEqual(216_000)
    expect(w.intensity).toBeGreaterThan(0.9)
  })

  it('trims to the calm part for a low target', () => {
    const w = chooseWindow(v, v.chapters[1], 60_000, 20_000, 0.5)!
    expect(w.intensity).toBeCloseTo(0.5, 1)
  })

  it('stretches a short chapter to the minimum, inside the video', () => {
    const w = chooseWindow(v, v.chapters[2], 120_000, 20_000, 0.6)!
    expect(w.endMs - w.startMs).toBeGreaterThanOrEqual(15_000)
    expect(w.endMs).toBeLessThanOrEqual(v.durationMs - 1500)
  })
})

describe('planning', () => {
  const pool = library()
  const total = 30 * 60
  const req = { from: 0, to: total, target: ramp(0.1, 0.9, total) }

  function check(clips: ReelClip[], minSec = 20, maxSec = 180) {
    for (const c of clips) {
      // Snapping can move each end a few seconds either way.
      expect(clipSeconds(c)).toBeGreaterThanOrEqual(minSec * 0.75 - 1)
      expect(clipSeconds(c)).toBeLessThanOrEqual(maxSec + 9)
    }
  }

  it('fills the programme back to back', () => {
    const { clips, shortfall } = planReel(pool, req, { seed: 1 })
    expect(shortfall).toBe(false)
    expect(clips[0].at).toBe(0)
    for (let i = 1; i < clips.length; i++)
      expect(clips[i].at).toBeCloseTo(clips[i - 1].at + clipSeconds(clips[i - 1]))
    const end = clips[clips.length - 1].at + clipSeconds(clips[clips.length - 1])
    expect(end).toBeGreaterThan(total - 15)
    check(clips)
  })

  it('follows the arc: gentle first, hardest last', () => {
    const { clips } = planReel(pool, req, { seed: 1 })
    const err = clips.reduce((n, c) => n + Math.abs(c.intensity - c.target), 0) / clips.length
    expect(err).toBeLessThan(0.08)
    const firstThird = clips.filter(c => c.at < total / 3)
    const lastThird = clips.filter(c => c.at >= (total * 2) / 3)
    const mean = (cs: ReelClip[]) => cs.reduce((n, c) => n + c.intensity, 0) / cs.length
    expect(mean(lastThird)).toBeGreaterThan(mean(firstThird) + 0.3)
  })

  it('is deterministic for a seed, and different for another', () => {
    const a = planReel(pool, req, { seed: 42 }).clips.map(c => c.key)
    const b = planReel(pool, req, { seed: 42 }).clips.map(c => c.key)
    const c = planReel(pool, req, { seed: 43 }).clips.map(c => c.key)
    expect(b).toEqual(a)
    expect(c).not.toEqual(a)
  })

  it('never plays a chapter twice, nor a video again too soon', () => {
    const { clips } = planReel(pool, req, { seed: 3, spacing: 6 })
    expect(new Set(clips.map(c => c.key)).size).toBe(clips.length)
    for (let i = 0; i < clips.length; i++) {
      for (let j = Math.max(0, i - 6); j < i; j++)
        expect(clips[j].video).not.toBe(clips[i].video)
    }
  })

  it('spreads across creators', () => {
    const { clips } = planReel(pool, req, { seed: 3 })
    let same = 0
    for (let i = 1; i < clips.length; i++) {
      if (clips[i].creator === clips[i - 1].creator)
        same++
    }
    // Five creators, a fifth by chance; the nudge should keep well under that.
    expect(same / (clips.length - 1)).toBeLessThan(0.2)
  })

  it('keeps clip lengths within bounds', () => {
    check(planReel(pool, req, { seed: 2, minSec: 30, maxSec: 60 }).clips, 30, 60)
  })

  it('does not straddle a change in the arc when it can help it', () => {
    const step = (t: number) => (t < 600 ? 0.2 : 0.8)
    const { clips } = planReel(pool, { from: 0, to: 1200, target: step, breaks: [600] }, { seed: 4 })
    const straddling = clips.filter(c => c.at < 590 && c.at + clipSeconds(c) > 610)
    expect(straddling.length).toBeLessThanOrEqual(1)
    const after = clips.filter(c => c.at >= 600)
    expect(after.every(c => c.target > 0.6)).toBe(true)
  })

  it('leaves out excluded chapters and what already played', () => {
    const first = planReel(pool, req, { seed: 5 }).clips
    const banned = new Set(first.slice(0, 5).map(c => c.key))
    const again = planReel(pool, req, { seed: 5, exclude: banned }).clips
    expect(again.some(c => banned.has(c.key))).toBe(false)
    const after = planReel(pool, { ...req, from: 600 }, { seed: 5, history: first.slice(0, 3) }).clips
    expect(after.some(c => first.slice(0, 3).some(h => h.key === c.key))).toBe(false)
  })

  it('keeps locked clips, in order, re-timed into the new plan', () => {
    const first = planReel(pool, req, { seed: 6 }).clips
    const locked = [first[4], first[9]].map(c => ({ ...c, locked: true }))
    const next = planReel(pool, req, { seed: 7, fixed: locked }).clips
    const at = locked.map(l => next.findIndex(c => c.id === l.id))
    expect(at[0]).toBeGreaterThanOrEqual(0)
    expect(at[1]).toBeGreaterThan(at[0])
    // Roughly where it was: the plan works around it rather than pushing it to the end.
    expect(Math.abs(next[at[0]].at - locked[0].at)).toBeLessThan(200)
  })

  it('reports a shortfall and repeats rather than stopping when the pool is tiny', () => {
    const tiny = [video('a', [[60, 0.3], [60, 0.6]]), video('b', [[60, 0.5]])]
    const { clips, shortfall } = planReel(tiny, { from: 0, to: 900, target: () => 0.5 }, { seed: 1 })
    expect(shortfall).toBe(true)
    expect(clips.length).toBeGreaterThan(3)
    for (let i = 1; i < clips.length; i++)
      expect(clips[i].key).not.toBe(clips[i - 1].key)
  })

  it('returns nothing from an empty pool', () => {
    expect(planReel([], req, { seed: 1 }).clips).toEqual([])
  })

  it('cuts on stroke bottoms', () => {
    const { clips } = planReel(pool, req, { seed: 8 })
    const byVideo = new Map(pool.map(p => [p.video, p]))
    for (const c of clips) {
      const cuts = byVideo.get(c.video)!.cuts
      expect(cuts).toContain(Math.round(c.start * 1000))
      expect(cuts).toContain(Math.round(c.end * 1000))
    }
  })
})

describe('changing a plan', () => {
  const pool = library()

  it('retimes from a clip on, keeping gaps', () => {
    const { clips } = planReel(pool, { from: 0, to: 600, target: () => 0.5 }, { seed: 1 })
    const moved = retime(clips, 2, clips[2].at + 7)
    expect(moved[1].at).toBe(clips[1].at)
    expect(moved[2].at).toBeCloseTo(clips[2].at + 7)
    expect(moved[3].at).toBeCloseTo(clips[3].at + 7)
  })

  it('lengthens a clip inside its video, on a cut point', () => {
    const v = video('a', [[60, 0.5], [120, 0.5]])
    const clip = planReel([v], { from: 0, to: 40, target: () => 0.5 }, { seed: 1, minSec: 20, maxSec: 40 }).clips[0]
    const longer = lengthen(clip, v, 60)
    expect(longer.end - clip.end).toBeGreaterThan(55)
    expect(v.cuts).toContain(Math.round(longer.end * 1000))
    // At the end of the video there is nothing more to give.
    const atEnd = { ...clip, end: (v.durationMs - 1500) / 1000 }
    expect(lengthen(atEnd, v, 60)).toBe(atEnd)
  })
})

describe('with the run shape of a template', () => {
  const pool = library(60)

  it('takes calmer clips in the retreats of an edged phase', () => {
    const tpl = TEMPLATES.find(t => t.id === 'tpl-edging')!
    const shape = runShape(tpl.phases, [], tpl.phases.map(p => (p.edges > 1 ? { at: [], restSec: 35 } : null)), 0)
    const { clips } = planReel(pool, { from: 0, to: shape.total, target: t => shapeAt(shape, t), breaks: shapeBreaks(shape) }, { seed: 11 })
    const b = shape.bounds[2]
    const inEdge = clips.filter(c => c.at >= b.start && c.at < b.end)
    const retreats = inEdge.filter(c => shape.segs[2].some(s => s.kind === 'retreat' && c.at >= b.start + s.t0 - 1 && c.at < b.start + s.t1))
    const holds = inEdge.filter(c => shape.segs[2].some(s => s.kind === 'hold' && c.at >= b.start + s.t0 - 1 && c.at < b.start + s.t1))
    expect(retreats.length).toBeGreaterThan(0)
    expect(holds.length).toBeGreaterThan(0)
    const mean = (cs: ReelClip[]) => cs.reduce((n, c) => n + c.intensity, 0) / cs.length
    expect(mean(retreats)).toBeLessThan(mean(holds) - 0.15)
  })
})

// The owner's library, read-only, when this machine has it.
const DIR = 'X:/the/funscripts'
describe.skipIf(!existsSync(DIR))('on real scripts', () => {
  it('indexes and plans a sensible reel', () => {
    const files = readdirSync(DIR)
      .filter(f => /\.funscript$/i.test(f) && !/\.(?:pitch|roll|twist|surge|sway|vib|pump|suck|valve)\.funscript$/i.test(f))
      .slice(0, 80)
    const pool: ReelSource[] = []
    for (const f of files) {
      const p = parseFunscriptContent(readFileSync(`${DIR}/${f}`, 'utf8'), f, f)
      const axis = p.axes.find(a => a.channel === 'L0') ?? p.axes[0]
      if (!axis || axis.actions.length < 8)
        continue
      const rec = indexScript(axis.actions, p.rawMetadata ?? null)
      for (const c of rec.chapters) {
        expect(c.end).toBeGreaterThan(c.start)
        expect(c.intensity).toBeGreaterThanOrEqual(0)
        expect(c.intensity).toBeLessThanOrEqual(1)
      }
      pool.push({ video: f, ...rec, creator: rec.creator ?? guessCreator(f) })
    }
    expect(pool.length).toBeGreaterThan(40)
    const tpl = TEMPLATES[1]
    const shape = runShape(tpl.phases)
    const { clips } = planReel(pool, { from: 0, to: shape.total, target: t => shapeAt(shape, t), breaks: shapeBreaks(shape) }, { seed: 1 })
    expect(clips.length).toBeGreaterThan(10)
    const err = clips.reduce((n, c) => n + Math.abs(c.intensity - c.target), 0) / clips.length
    expect(err).toBeLessThan(0.1)
    // The chapter's own rating and the curve's agree on the same scale.
    const sample = pool[0]
    const ch = sample.chapters.find(c => c.kind !== 'break')!
    expect(Math.abs(windowIntensity(sample, ch.start, ch.end) - meanSpeedToIntensity(ch.speed))).toBeLessThan(0.1)
  }, 60_000)
})
