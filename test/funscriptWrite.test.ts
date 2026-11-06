import { describe, expect, it } from 'vitest'
import { parseFunscriptContent } from '../src/lib/funscriptParser'
import { newFunscript, stringifyFunscript, toFileActions, writeAxes } from '../src/lib/funscriptWrite'

const pts = (...p: [number, number][]) => p.map(([at, pos]) => ({ at, pos }))

/** Parse, write `axes` back by axis key, parse again: what the app would load next time. */
function roundTrip(raw: unknown, edits: Record<string, { at: number, pos: number }[]>, name = 'clip.funscript') {
  const written = writeAxes(raw, new Map(Object.entries(edits)))
  return { written, parsed: parseFunscriptContent(stringifyFunscript(written), name, 'clip.mp4') }
}

describe('toFileActions', () => {
  it('rounds to whole ms and positions, sorts and keeps one per millisecond', () => {
    // -5 clamps onto 0, and 10.2 and 10.4 share 10: in time order, the later one wins.
    expect(toFileActions(pts([10.4, 0.123], [0, 1], [10.2, 0.5], [-5, 0]))).toEqual([
      { at: 0, pos: 100 },
      { at: 10, pos: 12 },
    ])
  })
})

describe('newFunscript', () => {
  it('writes a plain single-axis file', () => {
    expect(newFunscript(pts([0, 0], [500, 1]), { creator: 'me' })).toEqual({
      version: '1.0',
      inverted: false,
      range: 100,
      actions: [{ at: 0, pos: 0 }, { at: 500, pos: 100 }],
      metadata: { creator: 'me' },
    })
    expect(newFunscript([])).not.toHaveProperty('metadata')
  })
})

describe('writeAxes', () => {
  it('replaces a single-axis file\'s actions and keeps everything else', () => {
    const raw = { version: '1.0', inverted: false, range: 90, actions: [{ at: 0, pos: 10 }], metadata: { title: 'x', chapters: [{ name: 'a' }] } }
    const { written, parsed } = roundTrip(raw, { default: pts([0, 0.2], [400, 0.9]) })
    expect(written.metadata).toEqual(raw.metadata)
    expect(written.range).toBe(90)
    expect(parsed.axes[0].actions).toEqual(pts([0, 0.2], [400, 0.9]))
    // The input is not touched.
    expect(raw.actions).toEqual([{ at: 0, pos: 10 }])
  })

  it('writes a single-axis file named for another axis into its top-level list', () => {
    const raw = { actions: [{ at: 0, pos: 10 }] }
    const written = writeAxes(raw, new Map([['twist', pts([0, 0.5])]]))
    expect(written.actions).toEqual([{ at: 0, pos: 50 }])
  })

  it('writes one axis of a metadata.axes file', () => {
    const raw = {
      actions: [{ at: 0, pos: 0 }, { at: 100, pos: 100 }],
      metadata: { title: 't', axes: [{ id: 'R0', actions: [{ at: 0, pos: 50 }] }, { id: 'L1', actions: [{ at: 0, pos: 20 }] }] },
    }
    const { written, parsed } = roundTrip(raw, { R0: pts([0, 0.1], [200, 0.9]) })
    expect((written.metadata as any).title).toBe('t')
    const r0 = parsed.axes.find(a => a.axisKey === 'R0')!
    expect(r0.actions).toEqual(pts([0, 0.1], [200, 0.9]))
    expect(parsed.axes.find(a => a.axisKey === 'L1')!.actions).toEqual(pts([0, 0.2]))
    // The stroke, from the top-level list.
    const again = roundTrip(raw, { default: pts([0, 0.3]) })
    expect(again.parsed.axes.find(a => a.channel === 'L0')!.actions).toEqual(pts([0, 0.3]))
  })

  it('writes one axis of a top-level axes file', () => {
    const raw = { actions: [{ at: 0, pos: 0 }], axes: [{ id: 'R1', actions: [{ at: 0, pos: 30 }] }] }
    const { parsed } = roundTrip(raw, { r1: pts([0, 0.7]), default: pts([0, 0.4]) })
    expect(parsed.axes.find(a => a.channel === 'R1')!.actions).toEqual(pts([0, 0.7]))
    expect(parsed.axes.find(a => a.channel === 'L0')!.actions).toEqual(pts([0, 0.4]))
  })

  it('writes Funscript 2.0 channels, keeping the top-level stroke in step', () => {
    const raw = {
      version: '2.0',
      actions: [{ at: 0, pos: 0 }],
      channels: { stroke: { actions: [{ at: 0, pos: 0 }] }, roll: { actions: [{ at: 0, pos: 50 }] } },
    }
    const { written, parsed } = roundTrip(raw, { stroke: pts([0, 0.6]), roll: pts([0, 0.1]) })
    expect(written.actions).toEqual([{ at: 0, pos: 60 }])
    expect(parsed.axes.find(a => a.channel === 'L0')!.actions).toEqual(pts([0, 0.6]))
    expect(parsed.axes.find(a => a.channel === 'R1')!.actions).toEqual(pts([0, 0.1]))
  })

  it('round-trips exactly what the parser read when nothing changed', () => {
    const raw = { actions: [{ at: 0, pos: 0 }, { at: 333, pos: 67 }, { at: 1000, pos: 100 }] }
    const parsed = parseFunscriptContent(JSON.stringify(raw), 'clip.funscript', 'clip.mp4')
    const written = writeAxes(raw, new Map([['default', parsed.axes[0].actions]]))
    expect(written).toEqual(raw)
  })
})
