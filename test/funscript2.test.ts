import { describe, expect, it } from 'vitest'
import { parseFunscriptContent } from '../src/lib/funscriptParser'
import { looksMerged, parseAxisChannels } from '../src/lib/scriptSniff'

// Funscript 2.0 names channels as object keys — the layout funlib's `merge`
// writes for multi-axis scripts, and the one the 1.x-only parser used to
// read as stroke-only without complaint.
const v2 = {
  version: '2.0',
  actions: [{ at: 0, pos: 0 }, { at: 500, pos: 100 }],
  channels: {
    roll: { actions: [{ at: 0, pos: 50 }, { at: 400, pos: 80 }] },
    pitch: { actions: [{ at: 0, pos: 50 }, { at: 300, pos: 20 }] },
  },
  metadata: { title: 't', chapters: [{ name: 'Intro', startTime: '00:00:00.000', endTime: '00:00:30.000' }] },
}

describe('funscript 2.0', () => {
  it('parses each named channel onto its TCode axis', () => {
    const parsed = parseFunscriptContent(JSON.stringify(v2), 'clip.funscript', 'clip')
    expect(parsed.isMerged).toBe(true)
    expect(parsed.axes.map(a => a.channel).sort()).toEqual(['L0', 'R1', 'R2'])
    const roll = parsed.axes.find(a => a.channel === 'R1')!
    expect(roll.actions.at(-1)).toEqual({ at: 400, pos: 0.8 })
  })

  it('prefers channels.stroke over actions, as the spec asks of multi-axis devices', () => {
    const both = {
      ...v2,
      channels: { ...v2.channels, stroke: { actions: [{ at: 0, pos: 10 }, { at: 900, pos: 90 }] } },
    }
    const parsed = parseFunscriptContent(JSON.stringify(both), 'clip.funscript', 'clip')
    const stroke = parsed.axes.filter(a => a.channel === 'L0')
    expect(stroke).toHaveLength(1)
    expect(stroke[0].duration).toBe(900)
  })

  it('keeps the metadata, including chapters, for later use', () => {
    const parsed = parseFunscriptContent(JSON.stringify(v2), 'clip.funscript', 'clip')
    expect((parsed.rawMetadata as any).chapters[0].name).toBe('Intro')
  })

  it('treats a 2.0 file with only top-level actions as single-axis', () => {
    const single = { version: '2.0', actions: [{ at: 0, pos: 0 }, { at: 100, pos: 100 }], channels: {} }
    const parsed = parseFunscriptContent(JSON.stringify(single), 'clip.funscript', 'clip')
    expect(parsed.isMerged).toBe(false)
    expect(parsed.axes.map(a => a.channel)).toEqual(['L0'])
  })

  it('is spotted by the library scan', () => {
    const text = JSON.stringify(v2)
    expect(looksMerged(text)).toBe(true)
    expect(parseAxisChannels(text).sort()).toEqual(['L0', 'R1', 'R2'])
  })

  it('does not mistake the singular "channel" hint for a merged file', () => {
    expect(looksMerged(JSON.stringify({ version: '2.0', channel: 'roll', actions: [] }))).toBe(false)
  })
})
