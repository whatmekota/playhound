import type { SoundtrackAnalysis } from '../src/lib/beatTrack'
import type { MusicScriptOptions } from '../src/lib/musicScript'
import { describe, expect, it } from 'vitest'
import { limitSpeed, musicFunscript, musicScript, planStrokes, speedLimit } from '../src/lib/musicScript'

const OPTS: MusicScriptOptions = { bandLo: 35, bandHi: 140, maxSpm: 150, minDepth: 0.35, maxDepth: 0.95 }

/** An analysis of a steady track, without the audio. */
function steady(bpm: number, seconds: number, opts: { jitter?: number, energy?: (t: number) => number, gaps?: [number, number][], start?: number } = {}): SoundtrackAnalysis {
  const p = 60 / bpm
  const beats: number[] = []
  let seed = 1
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  for (let t = opts.start ?? 0.5; t < seconds; t += p)
    beats.push(t + (opts.jitter ? (rand() - 0.5) * opts.jitter : 0))
  return {
    version: 1,
    duration: seconds,
    bpm,
    beats,
    energy: beats.map(t => opts.energy?.(t) ?? -15),
    centroid: beats.map((_, i) => 10 + Math.sin(i / 7)),
    strength: beats.map(() => 1),
    barPos: beats.map((_, i) => i % 4),
    confidence: 0.9,
    gaps: (opts.gaps ?? []).map(([start, end]) => ({ start, end })),
  }
}

function maxSpeed(actions: { at: number, pos: number }[]): number {
  let m = 0
  for (let i = 1; i < actions.length; i++)
    m = Math.max(m, Math.abs(actions[i].pos - actions[i - 1].pos) / (actions[i].at - actions[i - 1].at))
  return m
}

function posAt(actions: { at: number, pos: number }[], t: number): number {
  const i = actions.findIndex(a => a.at > t)
  if (i <= 0)
    return actions[Math.max(0, i === -1 ? actions.length - 1 : 0)].pos
  const a = actions[i - 1]
  const b = actions[i]
  return a.pos + ((b.pos - a.pos) * (t - a.at)) / (b.at - a.at)
}

/** Strokes per minute over the steady middle of a script, from its bottoms. */
function spm(actions: { at: number, pos: number }[]): number {
  const bottoms = actions.filter((a, i) => i > 0 && i < actions.length - 1 && a.pos < actions[i - 1].pos && a.pos <= actions[i + 1].pos)
  const mid = bottoms.slice(Math.floor(bottoms.length / 4), Math.floor((bottoms.length * 3) / 4))
  return ((mid.length - 1) / (mid[mid.length - 1].at - mid[0].at)) * 60000
}

describe('musicScript', () => {
  it('never exceeds the speed of a full stroke at the ceiling', () => {
    for (const maxSpm of [90, 120, 150, 200]) {
      for (const bpm of [96, 128, 140, 174, 200]) {
        const a = steady(bpm, 60, { jitter: 0.06, energy: t => -30 + 25 * Math.abs(Math.sin(t / 5)) })
        const actions = musicScript(a, { ...OPTS, maxSpm, minDepth: 0.6, maxDepth: 1 })
        expect(maxSpeed(actions)).toBeLessThanOrEqual(speedLimit(maxSpm) + 1e-9)
      }
    }
  })

  it('shrinks strokes rather than moving them when they would be too fast', () => {
    // Full-depth strokes 400 ms apart; a full stroke at 75 spm takes 800 ms,
    // so only half the travel fits.
    const pts = Array.from({ length: 10 }, (_, i) => ({ t: i * 200, pos: i % 2 ? 100 : 0, c: 50 }))
    const out = limitSpeed(pts, speedLimit(75))
    expect(out.map(a => a.at)).toEqual(pts.map(p => p.t))
    expect(maxSpeed(out)).toBeLessThanOrEqual(speedLimit(75) + 1e-9)
    expect(out[5].pos - out[4].pos).toBeGreaterThanOrEqual(49)
    expect(Math.abs(out[5].pos + out[4].pos - 100)).toBeLessThanOrEqual(1)
  })

  it('keeps every stroke on its beat even on a ragged grid', () => {
    const a = steady(150, 40, { jitter: 0.12 })
    const actions = musicScript(a, { ...OPTS, maxSpm: 100 })
    expect(maxSpeed(actions)).toBeLessThanOrEqual(speedLimit(100) + 1e-9)
    const times = new Set(actions.map(x => x.at))
    for (const s of planStrokes(a, { ...OPTS, maxSpm: 100 }))
      expect(times.has(Math.round(s.start * 1000))).toBe(true)
  })

  it('puts the bottom of each stroke on a beat and the top halfway', () => {
    const a = steady(140, 40)
    const actions = musicScript(a, OPTS)
    const beatsMs = a.beats.map(t => Math.round(t * 1000))
    const plan = planStrokes(a, OPTS).filter(s => !s.rest)
    for (const s of plan.slice(1, -1)) {
      const at = Math.round(s.start * 1000)
      expect(beatsMs).toContain(at)
      const bottom = actions.find(x => x.at === at)!
      const top = actions.find(x => x.at === Math.round(((s.start + s.end) / 2) * 1000))!
      expect(top.pos).toBeGreaterThan(bottom.pos)
    }
  })

  it('strokes 140 and 180 bpm tracks at different rates, both in band', () => {
    const r140 = spm(musicScript(steady(140, 60), OPTS))
    const r180 = spm(musicScript(steady(180, 60), OPTS))
    expect(Math.abs(r140 - r180)).toBeGreaterThan(10)
    for (const r of [r140, r180]) {
      expect(r).toBeGreaterThanOrEqual(OPTS.bandLo - 1)
      expect(r).toBeLessThanOrEqual(OPTS.bandHi + 1)
    }
  })

  it('changes subdivision only on bar lines, and only for a whole section', () => {
    // Quiet then loud: the loud half should stroke faster.
    const a = steady(140, 60, { energy: t => (t < 30 ? -35 : -5) })
    const plan = planStrokes(a, OPTS)
    const changes = plan.filter((s, i) => i > 0 && s.perBeat !== plan[i - 1].perBeat)
    expect(changes.length).toBeGreaterThan(0)
    for (const c of changes) {
      const i = a.beats.findIndex(t => Math.abs(t - c.start) < 1e-9)
      expect(i).toBeGreaterThanOrEqual(0)
      expect(a.barPos[i]).toBe(0)
    }
    expect(plan.at(-1)!.perBeat).toBeGreaterThan(plan[0].perBeat)
  })

  it('rests at the centre through a gap, and strokes through it when asked not to', () => {
    const a = steady(140, 60, { gaps: [[20, 30]] })
    const actions = musicScript(a, OPTS)
    // Bars mostly inside the gap rest; the ones straddling its edges still stroke.
    for (const t of [22000, 24000, 26000, 28000])
      expect(posAt(actions, t)).toBe(50)
    // A plateau is just its ends.
    expect(actions.filter(x => x.at > 21500 && x.at < 28500)).toHaveLength(0)

    const busy = musicScript(a, { ...OPTS, restInGaps: false })
    expect(busy.filter(x => x.at > 21500 && x.at < 28500).length).toBeGreaterThan(10)
  })

  it('follows brightness with the centre, within the range given', () => {
    const plan = planStrokes(steady(120, 60), { ...OPTS, minDepth: 0.2, maxDepth: 0.2, centreRange: 0.5 })
    const centres = plan.map(s => s.centre)
    expect(Math.min(...centres)).toBeGreaterThanOrEqual(0.25 - 1e-9)
    expect(Math.max(...centres)).toBeLessThanOrEqual(0.75 + 1e-9)
    expect(Math.max(...centres) - Math.min(...centres)).toBeGreaterThan(0.2)
  })

  it('keeps times strictly increasing and positions in range', () => {
    const actions = musicScript(steady(175, 30, { jitter: 0.1 }), { ...OPTS, bandHi: 300, maxSpm: 400 })
    for (let i = 1; i < actions.length; i++)
      expect(actions[i].at).toBeGreaterThan(actions[i - 1].at)
    expect(actions.every(x => x.pos >= 0 && x.pos <= 100 && Number.isInteger(x.pos))).toBe(true)
  })

  it('returns nothing for an analysis without beats', () => {
    expect(musicScript({ ...steady(120, 10), beats: [], energy: [], centroid: [], strength: [], barPos: [] }, OPTS)).toEqual([])
  })

  it('wraps actions as a funscript labelled as generated', () => {
    const f = musicFunscript([{ at: 0, pos: 50 }], { title: 'x', bpm: 140.4, duration: 12 })
    expect(f.metadata.description).toMatch(/generated/i)
    expect(f.actions).toHaveLength(1)
  })
})

describe('limitSpeed', () => {
  it('clamps even when centres alone move too fast', () => {
    const out = limitSpeed([{ t: 0, pos: 0, c: 0 }, { t: 10, pos: 100, c: 100 }], 1)
    expect(out[1].pos).toBe(10)
  })
})
