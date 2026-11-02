import { describe, expect, it } from 'vitest'
import { roundTrip } from '../src/lib/handy'
import { createMovePlanner, createPhaseUnwrapper, DIRECT_INTERVAL_MS, oscillatorMove, scriptMove } from '../src/lib/strokePlan'

function osc(phase: number, over: Partial<Parameters<typeof oscillatorMove>[0]> = {}) {
  return { phase, spm: 60, depth: 1, center: 0.5, shape: 'sine' as const, ...over }
}

describe('oscillatorMove', () => {
  it('aims at the top on the way up and the bottom on the way down', () => {
    // 60 spm: one stroke a second, so half a stroke is 500 ms.
    const up = oscillatorMove(osc(0), 0)!
    expect(up.move.pos).toBeCloseTo(1)
    expect(up.move.ms).toBeCloseTo(500)
    const down = oscillatorMove(osc(Math.PI + 0.01), 0)!
    expect(down.move.pos).toBeCloseTo(0)
    expect(down.key).toBe(up.key + 1)
  })

  it('looks ahead by the lead: the move that will be under way when it lands', () => {
    const late = oscillatorMove(osc(0), 400)!
    expect(late.move.pos).toBeCloseTo(1)
    expect(late.move.ms).toBeCloseTo(100)
    const past = oscillatorMove(osc(0), 600)!
    expect(past.move.pos).toBeCloseTo(0)
    expect(past.move.ms).toBeCloseTo(400)
  })

  it('follows depth and centre, and pulse tops out a third of the way round', () => {
    const shallow = oscillatorMove(osc(0, { depth: 0.4, center: 0.3 }), 0)!
    expect(shallow.move.pos).toBeCloseTo(0.5)
    const pulse = oscillatorMove(osc(0, { shape: 'pulse' }), 0)!
    expect(pulse.move.ms).toBeCloseTo(1000 / 3)
  })

  it('has nothing to say when stopped or flat', () => {
    expect(oscillatorMove(osc(0, { spm: 0 }), 0)).toBeNull()
    expect(oscillatorMove(osc(0, { depth: 0 }), 0)).toBeNull()
  })

  it('keys stay put across the 2π wrap once unwrapped', () => {
    const u = createPhaseUnwrapper()
    const before = oscillatorMove(osc(u.next(Math.PI * 2 - 0.1)), 0)!
    const after = oscillatorMove(osc(u.next(0.05)), 0)!
    expect(after.key).toBe(before.key + 1)
  })
})

describe('scriptMove', () => {
  const actions = [{ at: 0, pos: 0 }, { at: 500, pos: 100 }, { at: 1000, pos: 20 }]

  it('aims at the next action in the time left, at the playback rate', () => {
    expect(scriptMove(actions, 100, 1)).toEqual({ key: 500, move: { pos: 1, ms: 400 } })
    expect(scriptMove(actions, 500, 2)).toEqual({ key: 1000, move: { pos: 0.2, ms: 250 } })
    expect(scriptMove(actions, 1000, 1)).toBeNull()
  })
})

describe('createMovePlanner', () => {
  it('sends a turning point once, and again only if it moved', () => {
    const p = createMovePlanner()
    const m = { key: 3, move: { pos: 1, ms: 300 } }
    expect(p.planned(m)).toEqual(m.move)
    expect(p.planned({ key: 3, move: { pos: 0.98, ms: 250 } })).toBeNull()
    expect(p.planned({ key: 3, move: { pos: 0.8, ms: 200 } })).toEqual({ pos: 0.8, ms: 200 })
    expect(p.planned({ key: 4, move: { pos: 0, ms: 500 } })).toEqual({ pos: 0, ms: 500 })
  })

  it('skips moves too short to matter', () => {
    expect(createMovePlanner().planned({ key: 1, move: { pos: 1, ms: 10 } })).toBeNull()
  })

  it('paces direct control and ignores a resting hand', () => {
    const p = createMovePlanner()
    expect(p.direct(0.5, 0)).not.toBeNull()
    expect(p.direct(0.9, DIRECT_INTERVAL_MS / 2)).toBeNull()
    expect(p.direct(0.505, DIRECT_INTERVAL_MS * 2)).toBeNull()
    expect(p.direct(0.9, DIRECT_INTERVAL_MS * 3)?.pos).toBe(0.9)
  })
})

describe('roundTrip', () => {
  it('is the mean round trip with the extremes set aside', () => {
    const samples = Array.from({ length: 30 }, (_, i) => ({ sent: i * 1000, received: i * 1000 + (i === 0 ? 5 : i === 29 ? 900 : 100), server: 0 }))
    expect(roundTrip(samples)).toBeCloseTo(100)
    expect(roundTrip([])).toBe(0)
  })
})
