import { describe, expect, it } from 'vitest'
import { looksMerged, parseAxisChannels, sniffMergedMarker, sniffScript } from '../src/lib/scriptSniff'

function actions(n: number) {
  return Array.from({ length: n }, (_, i) => ({ at: i * 100, pos: i % 2 ? 90 : 10 }))
}

const singleAxis = JSON.stringify({ actions: actions(2000) })

const mergedTopLevel = JSON.stringify({
  actions: actions(2000),
  axes: [
    { id: 'twist', actions: actions(800) },
    { id: 'roll', actions: actions(800) },
    { id: 'surge', actions: actions(400) },
  ],
})

const mergedMetadata = JSON.stringify({
  metadata: { axes: [{ id: 'L0', actions: actions(500) }, { id: 'R0', actions: actions(500) }] },
})

function asFile(text: string, name = 'clip.funscript') {
  return new File([text], name, { type: 'application/json' })
}

describe('looksMerged', () => {
  it('is false for a plain single-axis script', () => {
    expect(looksMerged(singleAxis)).toBe(false)
  })

  it('is true for both merged layouts', () => {
    expect(looksMerged(mergedTopLevel)).toBe(true)
    expect(looksMerged(mergedMetadata)).toBe(true)
  })
})

describe('parseAxisChannels', () => {
  it('maps named axes onto TCode channels, including the stroke axis', () => {
    const ch = parseAxisChannels(mergedTopLevel)
    expect(ch).toContain('L0') // top-level actions
    expect(ch).toContain('R0') // twist
    expect(ch).toContain('R1') // roll
    expect(ch).toContain('L1') // surge
    expect(ch).toHaveLength(4)
  })

  it('handles the metadata.axes layout', () => {
    expect(parseAxisChannels(mergedMetadata).sort()).toEqual(['L0', 'R0'])
  })

  it('reports a single axis for a plain script', () => {
    expect(parseAxisChannels(singleAxis)).toEqual(['L0'])
  })

  it('ignores unknown axis names rather than folding them into L0', () => {
    const odd = JSON.stringify({ axes: [{ id: 'not-an-axis', actions: [] }] })
    expect(parseAxisChannels(odd)).toEqual([])
  })

  it('survives malformed JSON', () => {
    expect(parseAxisChannels('{ not json')).toEqual([])
  })
})

describe('sniffMergedMarker', () => {
  it('finds the axes key far past the first kilobyte', async () => {
    // The old check read only the first and last 1 KB, where this key never is.
    const idx = mergedTopLevel.indexOf('"axes"')
    expect(idx).toBeGreaterThan(1024)
    expect(mergedTopLevel.length - idx).toBeGreaterThan(1024)

    expect(await sniffMergedMarker(asFile(mergedTopLevel))).toBe(true)
  })

  it('does not flag a single-axis script', async () => {
    expect(await sniffMergedMarker(asFile(singleAxis))).toBe(false)
  })

  it('finds a key straddling a chunk boundary', async () => {
    // 512 KB chunks; place the key right on the seam.
    const pad = 'x'.repeat(512 * 1024 - 3)
    const text = `{"pad":"${pad}","axes":[{"id":"roll","actions":[]}]}`
    expect(await sniffMergedMarker(asFile(text))).toBe(true)
  })
})

describe('sniffScript', () => {
  it('describes a merged script', async () => {
    const info = await sniffScript(asFile(mergedTopLevel))
    expect(info.merged).toBe(true)
    expect(info.channels.length).toBe(4)
  })

  it('describes a single-axis script', async () => {
    const info = await sniffScript(asFile(singleAxis))
    expect(info.merged).toBe(false)
    expect(info.channels).toEqual(['L0'])
  })

  it('does not call a one-axis merged file multi-axis', async () => {
    const oneAxis = JSON.stringify({ axes: [{ id: 'L0', actions: actions(10) }] })
    const info = await sniffScript(asFile(oneAxis))
    expect(info.merged).toBe(false)
    expect(info.channels).toEqual(['L0'])
  })
})
