import type { ScaleAction } from '../src/lib/scriptScale'
import { describe, expect, it } from 'vitest'
import { segmentSpeed } from '../src/lib/scriptEdit'
import {
  applyTweaks,
  bakeOffset,
  DEFAULT_TWEAKS,
  describeTweaks,
  humanise,
  isDefaultTweaks,
  normaliseTweaks,
  repeatStretch,
  restroke,
  shapeIsIdentity,
  smoothActions,
} from '../src/lib/scriptTweaks'

const tw = (p: Partial<typeof DEFAULT_TWEAKS>) => ({ ...DEFAULT_TWEAKS, ...p })
/** Full strokes every `ms`. */
const strokes = (n: number, ms: number): ScaleAction[] => Array.from({ length: n }, (_, i) => ({ at: i * ms, pos: i % 2 ? 1 : 0 }))

describe('normaliseTweaks', () => {
  it('fills defaults and clamps nonsense', () => {
    expect(normaliseTweaks(undefined)).toEqual(DEFAULT_TWEAKS)
    expect(normaliseTweaks({ min: 120, max: -5, invert: 'yes', speedCap: 10, smooth: 'heavy', offsetMs: 1e9 }))
      .toEqual({ ...DEFAULT_TWEAKS, speedCap: 50, offsetMs: 9999 })
    expect(normaliseTweaks({ min: 80, max: 20 })).toMatchObject({ min: 20, max: 80 })
  })

  it('loads a record saved before the newer tweaks as it was, and keeps the new ones sane', () => {
    expect(normaliseTweaks({ min: 10, max: 90, invert: true, speedCap: 0, smooth: 'light', strokes: 'double', offsetMs: 40 }))
      .toEqual({ ...DEFAULT_TWEAKS, min: 10, max: 90, invert: true, smooth: 'light', strokes: 'double', offsetMs: 40 })
    // Smoothing off takes its speed with it; a stretch too short, or the wrong way round.
    expect(normaliseTweaks({ smooth: 'off', smoothAbove: 300 }).smoothAbove).toBe(0)
    expect(normaliseTweaks({ smooth: 'light', smoothAbove: 5 }).smoothAbove).toBe(50)
    expect(normaliseTweaks({ repeatFromMs: 1000, repeatToMs: 1200 })).toMatchObject({ repeatFromMs: 0, repeatToMs: 0 })
    expect(normaliseTweaks({ repeatFromMs: 9000, repeatToMs: 4000 })).toMatchObject({ repeatFromMs: 4000, repeatToMs: 9000 })
    expect(normaliseTweaks({ humanise: 'heavy' }).humanise).toBe('off')
    // Playing its own script is playing nothing else.
    expect(normaliseTweaks({ plays: 'R1' }, 'R2').plays).toBe('R1')
    expect(normaliseTweaks({ plays: 'R1' }, 'R1').plays).toBe('')
    expect(normaliseTweaks({ plays: '../x' }).plays).toBe('')
  })

  it('tells shape tweaks from the offset', () => {
    expect(shapeIsIdentity(tw({ offsetMs: 100 }))).toBe(true)
    expect(isDefaultTweaks(tw({ offsetMs: 100 }))).toBe(false)
    expect(shapeIsIdentity(tw({ invert: true }))).toBe(false)
    expect(describeTweaks(tw({ min: 10, max: 90, invert: true, speedCap: 300, smooth: 'light', offsetMs: -50 })))
      .toEqual(['Range 10–90', 'Inverted', 'Max 300/s', 'Light smoothing', '-50 ms'])
  })
})

describe('applyTweaks', () => {
  it('is a copy when nothing is set', () => {
    const a = strokes(4, 500)
    const out = applyTweaks(a, DEFAULT_TWEAKS)
    expect(out).toEqual(a)
    expect(out[0]).not.toBe(a[0])
  })

  it('remaps the range and inverts', () => {
    const a = [{ at: 0, pos: 0 }, { at: 500, pos: 1 }, { at: 1000, pos: 0.5 }]
    expect(applyTweaks(a, tw({ min: 20, max: 80 })).map(x => x.pos)).toEqual([0.2, 0.8, 0.5])
    expect(applyTweaks(a, tw({ invert: true })).map(x => x.pos)).toEqual([1, 0, 0.5])
    // Inverting within a range keeps the range.
    const both = applyTweaks(a, tw({ min: 20, max: 80, invert: true })).map(x => x.pos)
    expect(both[0]).toBeCloseTo(0.8)
    expect(both[1]).toBeCloseTo(0.2)
  })

  it('caps speed by shortening travel, never moving points in time', () => {
    const a = strokes(20, 100) // 1000 units/s
    const out = applyTweaks(a, tw({ speedCap: 400 }))
    expect(out.map(x => x.at)).toEqual(a.map(x => x.at))
    for (let i = 1; i < out.length; i++)
      expect(segmentSpeed(out[i - 1], out[i])).toBeLessThanOrEqual(400 + 1e-6)
    // Slow strokes are left alone.
    const slow = strokes(6, 1000)
    expect(applyTweaks(slow, tw({ speedCap: 400 }))).toEqual(slow)
  })

  it('applies the cap after the range, so the cap holds on the output', () => {
    const a = strokes(10, 200) // 500 units/s at full range
    const out = applyTweaks(a, tw({ min: 0, max: 50, speedCap: 200 }))
    for (let i = 1; i < out.length; i++)
      expect(segmentSpeed(out[i - 1], out[i])).toBeLessThanOrEqual(200 + 1e-6)
  })

  it('smooths without moving points in time or adding any', () => {
    const jitter: ScaleAction[] = Array.from({ length: 60 }, (_, i) => ({ at: i * 33, pos: 0.5 + (i % 2 ? 0.05 : -0.05) }))
    const out = smoothActions(jitter, 50)
    expect(out).toHaveLength(jitter.length)
    expect(out.map(x => x.at)).toEqual(jitter.map(x => x.at))
    // The jitter is mostly gone in the middle.
    for (let i = 5; i < 55; i++)
      expect(Math.abs(out[i].pos - 0.5)).toBeLessThan(0.03)
    // Ends stay put.
    expect(out[0].pos).toBe(jitter[0].pos)
  })

  it('smoothing softens a hand-made stroke only a little, medium more than light', () => {
    const a = strokes(10, 500)
    const light = applyTweaks(a, tw({ smooth: 'light' }))
    const medium = applyTweaks(a, tw({ smooth: 'medium' }))
    const peak = 3 // a top
    expect(light[peak].pos).toBeLessThan(1)
    expect(light[peak].pos).toBeGreaterThan(0.85)
    expect(medium[peak].pos).toBeLessThan(light[peak].pos)
    // A hold stays a hold.
    const hold = [{ at: 0, pos: 0.3 }, { at: 400, pos: 0.3 }, { at: 800, pos: 0.3 }]
    expect(smoothActions(hold, 100).map(x => x.pos)).toEqual([0.3, 0.3, 0.3])
  })
})

describe('double and half strokes', () => {
  // Bottom, top, bottom, top, bottom: two strokes of 1 s.
  const two = [{ at: 0, pos: 0.1 }, { at: 500, pos: 0.9 }, { at: 1000, pos: 0.2 }, { at: 1500, pos: 0.8 }, { at: 2000, pos: 0.1 }]

  it('doubles: every turning point a bottom, a top halfway to the next', () => {
    const d = restroke(two, 'double')
    expect(d.map(a => a.at)).toEqual([0, 250, 500, 750, 1000, 1250, 1500, 1750, 2000])
    // The script's tops become bottoms (the lower of their neighbours), with the stroke's top between.
    expect(d.map(a => a.pos)).toEqual([0.1, 0.9, 0.1, 0.9, 0.2, 0.8, 0.1, 0.8, 0.1])
  })

  it('halves: one stroke where there were two, on the same bottoms, with the higher top', () => {
    const h = restroke(two, 'half')
    expect(h).toEqual([{ at: 0, pos: 0.1 }, { at: 1000, pos: 0.9 }, { at: 2000, pos: 0.1 }])
    // An odd stroke at the end is left as it is.
    const three = [...two, { at: 2500, pos: 0.7 }, { at: 3000, pos: 0 }]
    expect(restroke(three, 'half').map(a => a.at)).toEqual([0, 1000, 2000, 2500, 3000])
  })

  it('keeps a hold a hold, and is a tweak like the others', () => {
    const held = [{ at: 0, pos: 0 }, { at: 500, pos: 1 }, { at: 1500, pos: 1 }, { at: 2000, pos: 0 }]
    const d = restroke(held, 'double')
    expect(d.filter(a => a.at >= 500 && a.at <= 1500).map(a => a.pos)).toEqual([1, 1])
    expect(shapeIsIdentity(tw({ strokes: 'double' }))).toBe(false)
    expect(normaliseTweaks({ strokes: 'triple' }).strokes).toBe('as-is')
    expect(describeTweaks(tw({ strokes: 'half' }))).toContain('Half strokes')
    expect(applyTweaks(two, tw({ strokes: 'half', invert: true })).map(a => a.pos)).toEqual([0.9, 0.1, 0.9].map(v => expect.closeTo(v, 9)))
  })
})

describe('repeat a stretch', () => {
  // Strokes every 500 ms for 4 s, then a bad tail: a slow drift to the top.
  const early = [...strokes(9, 500), { at: 6000, pos: 1 }]

  it('repeats the stretch from its end to the end of the video, in place of the tail', () => {
    const out = repeatStretch(early, 1000, 2000, 7000)
    expect(out.slice(0, 4)).toEqual(early.slice(0, 4))
    // 2000 on: the stretch (0 at 1000, 1 at 1500) again and again.
    expect(out.filter(a => a.at >= 2000).map(a => a.pos)).toEqual(Array.from({ length: 11 }, (_, i) => i % 2 ? 1 : 0))
    expect(out.at(-1)).toEqual({ at: 7000, pos: 0 })
    const times = out.map(a => a.at)
    expect(times).toEqual([...times].sort((x, y) => x - y))
    // The video's end mid-stroke: where the curve is then.
    expect(repeatStretch(early, 1000, 2000, 6250).at(-1)).toEqual({ at: 6250, pos: 0.5 })
  })

  it('snaps the ends to the strokes so the seam is a stroke like the others', () => {
    // Asked a little off the beat; it starts on a bottom and ends on a bottom.
    expect(repeatStretch(early, 1080, 1940, 7000)).toEqual(repeatStretch(early, 1000, 2000, 7000))
  })

  it('without the video\'s length, fills up to the script\'s end; a stretch with nothing in it does nothing', () => {
    const out = applyTweaks(early, tw({ repeatFromMs: 1000, repeatToMs: 2000 }))
    expect(out.at(-1)!.at).toBe(6000)
    expect(out.filter(a => a.at > 4000).every(a => a.pos === 0 || a.pos === 1)).toBe(true)
    expect(applyTweaks(early, tw({ repeatFromMs: 8000, repeatToMs: 9000 }), { videoMs: 20000 })).toEqual(early)
    // With the length known it fills up to it, the stretch read in video time.
    expect(applyTweaks(early, tw({ repeatFromMs: 1000, repeatToMs: 2000 }), { videoMs: 10000 }).at(-1)!.at).toBe(10000)
  })

  it('is a tweak like the others, applied before the stroke count', () => {
    const t = tw({ repeatFromMs: 1000, repeatToMs: 2000 })
    expect(shapeIsIdentity(t)).toBe(false)
    expect(describeTweaks(t)).toEqual(['Repeats 0:01–0:02'])
    const doubled = applyTweaks(early, { ...t, strokes: 'double' }, { videoMs: 4000 })
    // Four repeated strokes doubled: a turn every 250 ms after 2 s.
    expect(doubled.filter(a => a.at >= 2000).map(a => a.at)).toEqual([2000, 2250, 2500, 2750, 3000, 3250, 3500, 3750, 4000])
  })
})

describe('humanise', () => {
  const a = strokes(40, 400)

  it('varies each turn a little, the same way every time for the same seed', () => {
    const one = humanise(a, 'medium', 'clip.mp4:L0')
    expect(humanise(a, 'medium', 'clip.mp4:L0')).toEqual(one)
    expect(humanise(a, 'medium', 'clip.mp4:R1')).not.toEqual(one)
    expect(one.filter((p, i) => p.at !== a[i].at).length).toBeGreaterThan(20)
    for (let i = 0; i < a.length; i++) {
      expect(Math.abs(one[i].at - a[i].at)).toBeLessThanOrEqual(35)
      expect(Math.abs(one[i].pos - a[i].pos)).toBeLessThanOrEqual(0.08 + 1e-9)
      expect(one[i].pos).toBeGreaterThanOrEqual(0)
      expect(one[i].pos).toBeLessThanOrEqual(1)
    }
    // Light varies less than medium; the ends stay put.
    const light = humanise(a, 'light', 'clip.mp4:L0')
    expect(Math.max(...light.map((p, i) => Math.abs(p.at - a[i].at)))).toBeLessThanOrEqual(15)
    expect([one[0], one.at(-1)]).toEqual([a[0], a.at(-1)])
  })

  it('never reorders points, keeps holds, and leaves a dense script\'s timing nearly alone', () => {
    const tight = [{ at: 0, pos: 0 }, { at: 20, pos: 1 }, { at: 40, pos: 1 }, { at: 60, pos: 0 }, { at: 400, pos: 1 }, { at: 405, pos: 0 }, { at: 800, pos: 1 }]
    for (const seed of ['a', 'b', 'c', 'd', 'e']) {
      const out = humanise(tight, 'medium', seed)
      for (let i = 1; i < out.length; i++)
        expect(out[i].at).toBeGreaterThan(out[i - 1].at)
      // The hold at 20–40 stays level.
      expect(out[1].pos).toBe(out[2].pos)
    }
    // Points between two turns follow them, in order.
    const ramp = [{ at: 0, pos: 0 }, { at: 100, pos: 0.25 }, { at: 200, pos: 0.5 }, { at: 400, pos: 1 }, { at: 800, pos: 0 }, { at: 1200, pos: 1 }]
    const out = humanise(ramp, 'medium', 'x')
    expect(out[1].pos).toBeLessThan(out[2].pos)
    expect(out[2].pos).toBeLessThan(out[3].pos)
    expect(out.slice(1, 3).map(p => p.at)).toEqual([100, 200])
  })

  it('is a tweak like the others, seeded by the context', () => {
    const t = tw({ humanise: 'light' })
    expect(shapeIsIdentity(t)).toBe(false)
    expect(describeTweaks(t)).toEqual(['Light humanise'])
    expect(applyTweaks(a, t, { seed: 's' })).toEqual(humanise(a, 'light', 's'))
  })
})

describe('smoothing only above a speed', () => {
  // A slow stroke (100 units/s), then jitter around the middle (about 300 units/s).
  const slow = [{ at: 0, pos: 0 }, { at: 1000, pos: 1 }, { at: 2000, pos: 0.5 }]
  const jitter = Array.from({ length: 30 }, (_, i) => ({ at: 2033 + i * 33, pos: 0.5 + (i % 2 ? 0.05 : -0.05) }))
  const a = [...slow, ...jitter, { at: 4000, pos: 0.5 }, { at: 5000, pos: 0 }]

  it('smooths the fast parts and leaves the slow ones exactly as written', () => {
    const out = applyTweaks(a, tw({ smooth: 'medium', smoothAbove: 200 }))
    expect(out.slice(0, 2)).toEqual(slow.slice(0, 2))
    expect(out.at(-1)).toEqual(a.at(-1))
    for (let i = 6; i < 28; i++)
      expect(Math.abs(out[i].pos - 0.5)).toBeLessThan(0.03)
    // Everywhere, the slow stroke's top is softened too.
    expect(applyTweaks(a, tw({ smooth: 'medium' }))[1].pos).toBeLessThan(1)
    expect(describeTweaks(tw({ smooth: 'medium', smoothAbove: 200 }))).toEqual(['Medium smoothing over 200/s'])
  })
})

describe('bakeOffset', () => {
  it('moves points earlier for a positive offset, keeping the start', () => {
    const a = [{ at: 0, pos: 0 }, { at: 1000, pos: 1 }, { at: 2000, pos: 0 }]
    const out = bakeOffset(a, 500)
    expect(out[0]).toEqual({ at: 0, pos: 0.5 })
    expect(out.slice(1)).toEqual([{ at: 500, pos: 1 }, { at: 1500, pos: 0 }])
    expect(bakeOffset(a, -250).map(x => x.at)).toEqual([250, 1250, 2250])
    expect(bakeOffset(a, 5000)).toEqual([])
    expect(bakeOffset(a, 0)).toEqual(a)
  })
})
