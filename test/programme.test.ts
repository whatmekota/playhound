import type { ProgrammePhase } from '../src/lib/programme'
import { describe, expect, it } from 'vitest'
import {
  cloneProgramme,
  EDGE_REST_SHARE,
  EDGE_WAIT_SEC,
  edgeStateAt,
  edgeTop,
  expandPhase,
  intensityAt,
  liveEdgeState,
  livePhase,
  locate,
  MAX_EDGES,
  MAX_PHASE_MINUTES,
  newPhase,
  normalisePhase,
  normaliseProgramme,
  phaseCeiling,
  phaseIntensityAt,
  phaseSeconds,
  runShape,
  sampleCurve,
  sampleShape,
  shapeAt,
  shapeBreaks,
  slew,
  switchPoint,
  TEMPLATES,
  timeline,
  totalSeconds,
} from '../src/lib/programme'

function ph(over: Partial<ProgrammePhase> = {}): ProgrammePhase {
  return newPhase('build', { minutes: 10, from: 0.2, to: 0.8, edges: 0, capSpm: null, ...over })
}

describe('timing', () => {
  const phases = [ph({ minutes: 5 }), ph({ minutes: 10 }), ph({ minutes: 3 })]

  it('lays phases end to end', () => {
    expect(timeline(phases)).toEqual([
      { start: 0, end: 300, dur: 300 },
      { start: 300, end: 900, dur: 600 },
      { start: 900, end: 1080, dur: 180 },
    ])
    expect(totalSeconds(phases)).toBe(1080)
  })

  it('extends one phase and pushes the rest back', () => {
    const b = timeline(phases, [0, 300])
    expect(b[1]).toEqual({ start: 300, end: 1200, dur: 900 })
    expect(b[2].start).toBe(1200)
    expect(totalSeconds(phases, [0, 300])).toBe(1380)
  })

  it('ignores negative extensions', () => {
    expect(totalSeconds(phases, [-1000])).toBe(1080)
  })

  it('clamps phase length to the allowed range', () => {
    expect(phaseSeconds(ph({ minutes: 0 }))).toBe(60)
    expect(phaseSeconds(ph({ minutes: 10_000 }))).toBe(MAX_PHASE_MINUTES * 60)
  })

  it('locates a time within the programme', () => {
    const b = timeline(phases)
    expect(locate(b, 0)).toMatchObject({ index: 0, inPhase: 0, phaseLeft: 300, totalLeft: 1080, done: false })
    expect(locate(b, 299.5).index).toBe(0)
    // A boundary belongs to the phase that starts there.
    expect(locate(b, 300)).toMatchObject({ index: 1, inPhase: 0, phaseLeft: 600 })
    expect(locate(b, 1000)).toMatchObject({ index: 2, inPhase: 100, phaseLeft: 80, totalLeft: 80 })
  })

  it('reports done past the end, pinned to the last phase', () => {
    const loc = locate(timeline(phases), 5000)
    expect(loc).toMatchObject({ index: 2, done: true, phaseLeft: 0, totalLeft: 0 })
    expect(loc.inPhase).toBe(180)
  })

  it('treats negative time as the start', () => {
    expect(locate(timeline(phases), -10)).toMatchObject({ index: 0, inPhase: 0 })
  })

  it('handles an empty programme', () => {
    expect(locate([], 10)).toMatchObject({ index: -1, done: true })
    expect(totalSeconds([])).toBe(0)
    expect(intensityAt([], 10)).toBe(0)
    expect(sampleCurve([], 10)).toEqual([])
  })
})

describe('plain ramps', () => {
  const p = ph({ minutes: 10, from: 0.2, to: 0.8 })

  it('starts at from and ends at to', () => {
    expect(phaseIntensityAt(p, 0)).toBeCloseTo(0.2)
    expect(phaseIntensityAt(p, 600)).toBeCloseTo(0.8)
  })

  it('passes through the midpoint halfway', () => {
    expect(phaseIntensityAt(p, 300)).toBeCloseTo(0.5)
  })

  it('eases in and out rather than moving linearly', () => {
    // Smoothstep: a tenth of the way in covers well under a tenth of the range.
    const early = phaseIntensityAt(p, 60)
    expect(early - 0.2).toBeLessThan(0.06 * 0.6 + 1e-9)
    expect(early).toBeGreaterThan(0.2)
  })

  it('is monotonic for a rising ramp', () => {
    let last = -1
    for (let t = 0; t <= 600; t += 15) {
      const v = phaseIntensityAt(p, t)
      expect(v).toBeGreaterThanOrEqual(last - 1e-12)
      last = v
    }
  })

  it('descends for a cool-down', () => {
    const c = ph({ from: 0.5, to: 0.1 })
    expect(phaseIntensityAt(c, 0)).toBeCloseTo(0.5)
    expect(phaseIntensityAt(c, 600)).toBeCloseTo(0.1)
    expect(phaseIntensityAt(c, 300)).toBeLessThan(0.5)
  })

  it('holds flat when from equals to', () => {
    const flat = ph({ from: 0.6, to: 0.6 })
    for (const t of [0, 100, 599])
      expect(phaseIntensityAt(flat, t)).toBeCloseTo(0.6)
  })

  it('clamps out-of-range intensities and times', () => {
    const wild = ph({ from: -1, to: 3 })
    expect(phaseIntensityAt(wild, -50)).toBe(0)
    expect(phaseIntensityAt(wild, 10_000)).toBe(1)
  })

  it('treats one edge as a plain ramp', () => {
    expect(expandPhase(ph({ edges: 1 }))).toHaveLength(1)
  })
})

describe('edge passes', () => {
  const p = ph({ kind: 'peak', minutes: 10, from: 0.5, to: 0.9, edges: 3 })
  const dur = 600
  const cycle = dur / 3

  it('expands into rise/hold/retreat, with the last pass holding instead of retreating', () => {
    const segs = expandPhase(p, dur)
    expect(segs.map(s => s.kind)).toEqual(['rise', 'hold', 'retreat', 'rise', 'hold', 'retreat', 'rise', 'hold'])
    expect(segs.map(s => s.pass)).toEqual([0, 0, 0, 1, 1, 1, 2, 2])
  })

  it('covers the phase without gaps or overlaps', () => {
    const segs = expandPhase(p, dur)
    expect(segs[0].t0).toBe(0)
    expect(segs[segs.length - 1].t1).toBe(dur)
    for (let i = 1; i < segs.length; i++)
      expect(segs[i].t0).toBeCloseTo(segs[i - 1].t1)
  })

  it('reaches a little higher on every pass, and the full height on the last', () => {
    const tops = [0, 1, 2].map(i => edgeTop(p, i, 3))
    expect(tops[0]).toBeLessThan(tops[1])
    expect(tops[1]).toBeLessThan(tops[2])
    expect(tops[2]).toBeCloseTo(0.9)
    expect(tops[0]).toBeGreaterThan(0.5)
  })

  it('retreats back to the starting level between passes', () => {
    // End of pass 0 (just before pass 1 starts).
    expect(phaseIntensityAt(p, cycle - 1e-6, dur)).toBeCloseTo(0.5, 3)
    // Top of pass 0 during its hold.
    expect(phaseIntensityAt(p, cycle * 0.7, dur)).toBeCloseTo(edgeTop(p, 0, 3))
  })

  it('ends the phase at the top', () => {
    expect(phaseIntensityAt(p, dur, dur)).toBeCloseTo(0.9)
    expect(phaseIntensityAt(p, dur - 1, dur)).toBeCloseTo(0.9)
  })

  it('stays continuous across segment joins', () => {
    let last = phaseIntensityAt(p, 0, dur)
    for (let t = 0.5; t <= dur; t += 0.5) {
      const v = phaseIntensityAt(p, t, dur)
      // 0.5 s steps: nothing should jump by more than a few percent.
      expect(Math.abs(v - last)).toBeLessThan(0.03)
      last = v
    }
  })

  it('reports which pass it is in', () => {
    expect(edgeStateAt(p, 10, dur)).toEqual({ pass: 0, of: 3, kind: 'rise' })
    expect(edgeStateAt(p, cycle * 0.7, dur)).toEqual({ pass: 0, of: 3, kind: 'hold' })
    expect(edgeStateAt(p, cycle * 0.9, dur)).toEqual({ pass: 0, of: 3, kind: 'retreat' })
    expect(edgeStateAt(p, cycle * 2.9, dur)).toEqual({ pass: 2, of: 3, kind: 'hold' })
    expect(edgeStateAt(ph(), 10)).toBeNull()
  })

  it('scales with an extended phase', () => {
    const segs = expandPhase(p, 900)
    expect(segs[segs.length - 1].t1).toBe(900)
    expect(segs[3].t0).toBeCloseTo(300)
  })

  it('caps the number of passes', () => {
    const many = ph({ edges: 99 })
    expect(new Set(expandPhase(many).map(s => s.pass)).size).toBe(MAX_EDGES)
  })
})

describe('programme curve', () => {
  const phases = [
    ph({ minutes: 1, from: 0.1, to: 0.3 }),
    ph({ minutes: 1, from: 0.6, to: 0.6 }),
  ]

  it('follows each phase on the shared clock', () => {
    expect(intensityAt(phases, 0)).toBeCloseTo(0.1)
    expect(intensityAt(phases, 59.999)).toBeCloseTo(0.3, 3)
    expect(intensityAt(phases, 60)).toBeCloseTo(0.6)
  })

  it('is zero outside the programme', () => {
    expect(intensityAt(phases, -1)).toBe(0)
    expect(intensityAt(phases, 120)).toBe(0)
  })

  it('honours extensions', () => {
    // Phase 1 stretched to 2 min: 90 s is still inside it, and nearer its top.
    expect(intensityAt(phases, 90, [60])).toBeGreaterThan(0.15)
    expect(intensityAt(phases, 90, [60])).toBeLessThan(0.3)
    expect(intensityAt(phases, 150, [60])).toBeCloseTo(0.6)
  })

  it('samples the whole curve, ending in the last phase', () => {
    const s = sampleCurve(phases, 5)
    expect(s).toHaveLength(5)
    expect(s[0]).toBeCloseTo(0.1)
    expect(s[4]).toBeCloseTo(0.6)
  })
})

describe('slew', () => {
  it('moves at most perSec * dt', () => {
    expect(slew(0, 1, 0.1, 1)).toBeCloseTo(0.1)
    expect(slew(1, 0, 0.1, 2)).toBeCloseTo(0.8)
  })

  it('lands exactly when within reach', () => {
    expect(slew(0.5, 0.52, 0.1, 1)).toBe(0.52)
  })

  it('never moves with zero or negative time', () => {
    expect(slew(0.3, 1, 0.1, 0)).toBe(0.3)
    expect(slew(0.3, 1, 0.1, -5)).toBe(0.3)
  })
})

describe('switch point', () => {
  it('waits for a chapter boundary that is close', () => {
    expect(switchPoint(100, [40, 130, 200], 60)).toBe(130)
  })

  it('switches now when the next boundary is too far off', () => {
    expect(switchPoint(100, [40, 300], 60)).toBe(100)
  })

  it('switches now without chapters, or past the last one', () => {
    expect(switchPoint(100, [], 60)).toBe(100)
    expect(switchPoint(100, [20, 80], 60)).toBe(100)
  })

  it('ignores a boundary it is already sitting on, and unsorted input', () => {
    expect(switchPoint(130, [180, 130.2, 150], 60)).toBe(150)
  })
})

describe('motion ceiling', () => {
  it('only ever lowers the user ceiling', () => {
    expect(phaseCeiling(150, 80)).toBe(80)
    expect(phaseCeiling(150, 400)).toBe(150)
    expect(phaseCeiling(60, 80)).toBe(60)
  })

  it('leaves the ceiling alone without a cap', () => {
    expect(phaseCeiling(150, null)).toBe(150)
    expect(phaseCeiling(150, Number.NaN)).toBe(150)
  })

  it('does not cap below a usable stroke', () => {
    expect(phaseCeiling(150, 0)).toBeGreaterThan(0)
  })
})

describe('templates', () => {
  const minutes = (id: string) => totalSeconds(TEMPLATES.find(t => t.id === id)!.phases) / 60

  it('match their advertised lengths', () => {
    expect(minutes('tpl-short')).toBe(20)
    expect(minutes('tpl-classic')).toBe(45)
    expect(minutes('tpl-edging')).toBe(60)
  })

  it('have unique ids, inside and across programmes', () => {
    const ids = TEMPLATES.flatMap(t => [t.id, ...t.phases.map(p => p.id)])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('survive normalisation unchanged', () => {
    for (const t of TEMPLATES) {
      const n = normaliseProgramme(t)!
      expect(n.phases).toEqual(t.phases)
    }
  })

  it('start gently and end low', () => {
    for (const t of TEMPLATES) {
      const total = totalSeconds(t.phases)
      expect(intensityAt(t.phases, 0)).toBeLessThanOrEqual(0.25)
      expect(intensityAt(t.phases, total - 0.01)).toBeLessThanOrEqual(0.15)
    }
  })

  it('include an edged phase in the edging template', () => {
    const edging = TEMPLATES.find(t => t.id === 'tpl-edging')!
    expect(edging.phases.some(p => p.edges > 1)).toBe(true)
  })

  it('clone into an editable copy with fresh ids', () => {
    const t = TEMPLATES[0]
    const c = cloneProgramme(t, 'Mine')
    expect(c.builtin).toBe(false)
    expect(c.name).toBe('Mine')
    expect(c.id).not.toBe(t.id)
    expect(c.phases.map(p => p.id)).not.toEqual(t.phases.map(p => p.id))
    c.phases[0].minutes = 99
    expect(t.phases[0].minutes).not.toBe(99)
  })
})

describe('normalisation', () => {
  it('drops junk', () => {
    expect(normalisePhase(null)).toBeNull()
    expect(normalisePhase({ kind: 'nope' })).toBeNull()
    expect(normaliseProgramme({ phases: [] })).toBeNull()
    expect(normaliseProgramme('x')).toBeNull()
  })

  it('fills defaults and clamps ranges', () => {
    const p = normalisePhase({ kind: 'warmup', minutes: 0, from: -2, to: 7, edges: 50, capSpm: 2 })!
    expect(p.minutes).toBe(1)
    expect(p.from).toBe(0)
    expect(p.to).toBe(1)
    expect(p.edges).toBe(MAX_EDGES)
    expect(p.capSpm).toBeGreaterThanOrEqual(10)
    expect(p.name).toBe('Warm-up')
    expect(p.id).toBeTruthy()
  })

  it('orders and bounds a beat band', () => {
    expect(normalisePhase({ kind: 'build', beat: [12, 4] })!.beat).toEqual([4, 12])
    expect(normalisePhase({ kind: 'build', beat: [0, 90] })!.beat).toEqual([0.5, 35])
    expect(normalisePhase({ kind: 'build', beat: ['a', 2] })!.beat).toBeNull()
  })

  it('keeps a null cap as no cap', () => {
    expect(normalisePhase({ kind: 'peak', capSpm: null })!.capSpm).toBeNull()
  })

  it('falls back on an unknown video mode and clamps the interval', () => {
    const p = normaliseProgramme({ name: 'x', video: 'sometimes', everyMin: 0, phases: [{ kind: 'peak' }] })!
    expect(p.video).toBe('ended')
    expect(p.everyMin).toBe(1)
    expect(p.tone).toBe(false)
    expect(p.builtin).toBe(false)
  })
})

describe('reel settings', () => {
  it('default to a reel with sane clip bounds, and keep them ordered', () => {
    const p = normaliseProgramme({ phases: [{ kind: 'peak' }] })!
    expect(p.reel).toBe(true)
    expect(p.clipSec).toEqual([20, 180])
    const q = normaliseProgramme({ reel: false, clipSec: [400, 2], phases: [{ kind: 'peak' }] })!
    expect(q.reel).toBe(false)
    expect(q.clipSec[0]).toBeLessThan(q.clipSec[1])
    expect(q.clipSec[0]).toBeGreaterThanOrEqual(10)
  })

  it('clone their clip bounds rather than share them', () => {
    const c = cloneProgramme(TEMPLATES[0])
    c.clipSec[0] = 99
    expect(TEMPLATES[0].clipSec[0]).toBe(20)
  })
})

describe('timeline overrides', () => {
  it('replaces a phase length with an override', () => {
    const phases = [ph({ minutes: 5 }), ph({ minutes: 5 })]
    expect(timeline(phases, [], [120])[0]).toEqual({ start: 0, end: 120, dur: 120 })
    expect(timeline(phases, [60], [120])[1].start).toBe(180)
  })
})

describe('live edges', () => {
  const p = ph({ kind: 'peak', minutes: 10, from: 0.5, to: 0.9, edges: 3 })
  const planned = 600
  const cycle = 200
  const rise = cycle * 0.6
  const hold = cycle * 0.2
  const rest = 30
  const calm = 0.5 * EDGE_REST_SHARE
  const value = (lp: ReturnType<typeof livePhase>, t: number) => shapeAt({ bounds: [{ start: 0, end: lp.dur, dur: lp.dur }], segs: [lp.segs], live: [lp], total: lp.dur }, t)

  it('projects the planned cadence before any edge', () => {
    const lp = livePhase(p, planned, { at: [], restSec: rest }, 0)
    expect(lp.pass).toBe(0)
    expect(lp.dueAt).toBeCloseTo(rise + hold + EDGE_WAIT_SEC)
    // Two passes that end where the plan expects an edge, then the last pass's climb and hold.
    expect(lp.dur).toBeCloseTo(2 * (rise + hold + rest) + rise + cycle * 0.4)
    expect(value(lp, rise + 1)).toBeCloseTo(edgeTop(p, 0, 3), 2)
  })

  it('ends a pass on a real edge, rests calm, and climbs again from there', () => {
    const lp = livePhase(p, planned, { at: [90], restSec: rest }, 95)
    expect(lp.pass).toBe(1)
    expect(lp.passStart).toBe(90 + rest)
    const e = liveEdgeState(lp, 95)!
    expect(e).toMatchObject({ pass: 0, kind: 'retreat' })
    // Calmer than where the phase began, once the retreat has settled.
    expect(value(lp, 90 + rest - 1)).toBeLessThan(0.5)
    expect(value(lp, 90 + rest - 0.001)).toBeCloseTo(calm, 2)
    // An edge during the climb ends it where it had got to: no jump up first.
    expect(value(lp, 90)).toBeLessThan(edgeTop(p, 0, 3))
  })

  it('holds at the top while waiting for an edge, pushing the rest back', () => {
    const early = livePhase(p, planned, { at: [], restSec: rest }, 0)
    const late = livePhase(p, planned, { at: [], restSec: rest }, rise + hold + 60)
    expect(late.dur - early.dur).toBeCloseTo(60)
    expect(liveEdgeState(late, rise + hold + 59)).toMatchObject({ pass: 0, kind: 'hold' })
    // It never waits past the deadline.
    const stuck = livePhase(p, planned, { at: [], restSec: rest }, 10_000)
    expect(stuck.dur - early.dur).toBeCloseTo(EDGE_WAIT_SEC)
  })

  it('finishes the phase after the last pass, edged or not', () => {
    const all = livePhase(p, planned, { at: [100, 300, 500], restSec: rest }, 510)
    expect(all.pass).toBe(3)
    expect(all.dur).toBeCloseTo(500 + rest)
    expect(all.dueAt).toBeNull()
    // Unedged last pass: holds for its planned time and ends.
    const two = livePhase(p, planned, { at: [100, 300], restSec: rest }, 400)
    expect(two.dueAt).toBeNull()
    expect(two.dur).toBeCloseTo(300 + rest + rise + cycle * 0.4)
    expect(value(two, two.dur - 1)).toBeCloseTo(0.9, 2)
  })

  it('freezes a closed phase at its length', () => {
    const lp = livePhase(p, planned, { at: [100], restSec: rest, closedAt: 150 }, 9999)
    expect(lp.dur).toBe(150)
    expect(lp.segs[lp.segs.length - 1].t1).toBeLessThanOrEqual(150)
    expect(lp.dueAt).toBeNull()
  })

  it('stays continuous through edges', () => {
    const lp = livePhase(p, planned, { at: [150, 330], restSec: rest }, 340)
    let last = value(lp, 0)
    for (let t = 0.5; t < lp.dur; t += 0.5) {
      const v = value(lp, t)
      expect(Math.abs(v - last)).toBeLessThan(0.05)
      last = v
    }
  })
})

describe('run shape', () => {
  const phases = [
    ph({ minutes: 2, from: 0.1, to: 0.4 }),
    ph({ kind: 'peak', minutes: 10, from: 0.5, to: 0.9, edges: 3 }),
    ph({ minutes: 2, from: 0.3, to: 0.05 }),
  ]

  it('is the planned curve without live edges', () => {
    const s = runShape(phases)
    expect(s.total).toBe(totalSeconds(phases))
    for (const t of [0, 30, 200, 500, 800])
      expect(shapeAt(s, t)).toBeCloseTo(intensityAt(phases, t), 6)
    expect(sampleShape(s, 10)).toEqual(sampleCurve(phases, 10))
  })

  it('takes an edged phase length from its edges', () => {
    const s = runShape(phases, [], [null, { at: [60], restSec: 30 }, null], 200)
    expect(s.bounds[1].start).toBe(120)
    expect(s.bounds[2].start).toBe(s.bounds[1].end)
    expect(s.bounds[1].dur).not.toBe(600)
    expect(s.live[1]?.pass).toBe(1)
    expect(s.live[0]).toBeNull()
  })

  it('lists the turning points of the arc', () => {
    const b = shapeBreaks(runShape(phases))
    expect(b).toContain(120)
    expect(b).toContain(720)
    expect(b.length).toBeGreaterThan(4)
    expect([...b].sort((x, y) => x - y)).toEqual(b)
  })
})
