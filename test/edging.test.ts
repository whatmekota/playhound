import { describe, expect, it } from 'vitest'
import { createEdgeEnvelope, EDGE_FALL_SEC } from '../src/lib/edging'

const T = { cooldownSec: 10, rebuildSec: 10, depth: 0.8 }
const at = (s: number) => s * 1000

describe('edge envelope', () => {
  it('is idle until called', () => {
    const e = createEdgeEnvelope()
    expect(e.sample(0, T)).toEqual({ holdBack: 0, phase: 'idle', remainingSec: 0 })
  })

  it('falls, holds at depth, rebuilds, then goes idle', () => {
    const e = createEdgeEnvelope()
    e.trigger(at(0), T)
    expect(e.sample(at(0.5), T).phase).toBe('falling')
    const hold = e.sample(at(EDGE_FALL_SEC + 5), T)
    expect(hold.phase).toBe('holding')
    expect(hold.holdBack).toBeCloseTo(0.8)
    const mid = e.sample(at(EDGE_FALL_SEC + 10 + 5), T)
    expect(mid.phase).toBe('rebuilding')
    expect(mid.holdBack).toBeGreaterThan(0.2)
    expect(mid.holdBack).toBeLessThan(0.6)
    expect(e.sample(at(EDGE_FALL_SEC + 21), T).phase).toBe('idle')
  })

  it('never jumps: consecutive samples stay close', () => {
    const e = createEdgeEnvelope()
    e.trigger(0, T)
    let prev = 0
    for (let ms = 0; ms < at(EDGE_FALL_SEC + 21); ms += 16) {
      const h = e.sample(ms, T).holdBack
      expect(Math.abs(h - prev)).toBeLessThan(0.03)
      prev = h
    }
  })

  it('a second press restarts the hold without dipping first', () => {
    const e = createEdgeEnvelope()
    e.trigger(0, T)
    const before = e.sample(at(EDGE_FALL_SEC + 12), T).holdBack // rebuilding
    e.trigger(at(EDGE_FALL_SEC + 12), T)
    const after = e.sample(at(EDGE_FALL_SEC + 12) + 16, T).holdBack
    expect(after).toBeGreaterThanOrEqual(before - 0.001)
    expect(e.sample(at(EDGE_FALL_SEC + 12 + EDGE_FALL_SEC + 3), T).phase).toBe('holding')
  })

  it('release ends the hold early and rebuilds from there', () => {
    const e = createEdgeEnvelope()
    e.trigger(0, T)
    e.release(at(4), T)
    expect(e.sample(at(5), T).phase).toBe('rebuilding')
    expect(e.sample(at(15), T).phase).toBe('idle')
  })
})
