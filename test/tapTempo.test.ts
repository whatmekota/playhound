import { describe, expect, it } from 'vitest'
import { createTapper, fitTaps, scaleTempo, TAP_RESET_SEC, tappedBeats, tappedBpm } from '../src/lib/tapTempo'

const taps = (bpm: number, n: number, from = 10) => Array.from({ length: n }, (_, i) => from + (i * 60) / bpm)

describe('fitTaps', () => {
  it('needs three taps', () => {
    expect(fitTaps(taps(120, 2))).toBeNull()
    expect(tappedBpm(fitTaps(taps(120, 3))!)).toBeCloseTo(120)
  })

  it('puts a beat on the last tap', () => {
    const t = fitTaps(taps(100, 4, 5))!
    expect(t.anchorSec).toBeCloseTo(5 + 3 * 0.6)
    expect(tappedBeats(t, 5 + 5 * 0.6)).toBeCloseTo(2)
  })

  it('evens out a sloppy tap rather than following it', () => {
    const t = taps(120, 6)
    t[3] += 0.04
    const bpm = tappedBpm(fitTaps(t)!)
    expect(Math.abs(bpm - 120)).toBeLessThan(2)
  })

  it('refuses tempos no one taps', () => {
    expect(fitTaps(taps(300, 4))).toBeNull()
  })
})

describe('createTapper', () => {
  it('sets a tempo on the third tap and refines it after', () => {
    const tapper = createTapper()
    let tempo = null
    const run = taps(128, 6)
    run.forEach((s, i) => {
      tempo = tapper.tap(s, tempo)
      if (i < 2)
        expect(tempo).toBeNull()
    })
    expect(tappedBpm(tempo!)).toBeCloseTo(128)
    expect(tapper.count).toBe(6)
  })

  it('starts a new count after a pause or a seek back', () => {
    const tapper = createTapper()
    let tempo = null
    for (const s of taps(120, 4))
      tempo = tapper.tap(s, tempo)
    tapper.tap(11.5 + TAP_RESET_SEC + 1, tempo)
    expect(tapper.count).toBe(1)
    tapper.tap(1, tempo)
    expect(tapper.count).toBe(1)
  })

  it('re-aligns an existing tempo on a lone tap', () => {
    const tapper = createTapper()
    let tempo = null
    for (const s of taps(120, 4))
      tempo = tapper.tap(s, tempo)
    const moved = tapper.tap(30.2, tempo)!
    expect(moved.periodSec).toBeCloseTo(0.5)
    expect(moved.anchorSec).toBe(30.2)
  })

  it('counts again from a tap far off the running interval', () => {
    const tapper = createTapper()
    let tempo = null
    for (const s of taps(120, 4))
      tempo = tapper.tap(s, tempo)
    // A doubled tap a quarter beat later.
    tapper.tap(10 + 1.5 + 0.12, tempo)
    expect(tapper.count).toBe(2)
  })
})

describe('scaleTempo', () => {
  it('doubles and halves, keeping the beat in place', () => {
    const t = fitTaps(taps(100, 4))!
    const d = scaleTempo(t, 2)!
    expect(tappedBpm(d)).toBeCloseTo(200)
    expect(d.anchorSec).toBe(t.anchorSec)
    expect(tappedBpm(scaleTempo(t, 0.5)!)).toBeCloseTo(50)
  })

  it('will not leave the tappable range', () => {
    const t = fitTaps(taps(200, 4))!
    expect(scaleTempo(t, 2)).toBeNull()
  })
})
