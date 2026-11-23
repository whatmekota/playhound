import { describe, expect, it } from 'vitest'
import { activeLinks, BUILTIN_LINK_PRESETS, createStrokeHistory, defaultLinks, linkedActions, linkedPosition, resolveLinked, sameLinks, sanitizeLinkPresets, sanitizeLinks } from '~/lib/axisLink'

describe('axis links', () => {
  it('maps the stroke: inverted, turned down around the middle', () => {
    expect(linkedPosition(1, { invert: false, amount: 1 })).toBe(1)
    expect(linkedPosition(1, { invert: true, amount: 1 })).toBe(0)
    expect(linkedPosition(1, { invert: false, amount: 0.5 })).toBe(0.75)
    expect(linkedPosition(0.2, { invert: true, amount: 0.5 })).toBeCloseTo(0.65)
  })

  it('shifts the script by the delay and keeps the same array per setting', () => {
    // Positions as the parser keeps them: 0-1.
    const actions = [{ at: 0, pos: 0 }, { at: 500, pos: 1 }]
    const link = { delayMs: 80, invert: true, amount: 1 }
    const out = linkedActions(actions, link)
    expect(out).toEqual([{ at: 80, pos: 1 }, { at: 580, pos: 0 }])
    expect(linkedActions(actions, { ...link })).toBe(out)
  })

  it('turns a parsed script down around the middle, not into the top (amount under 100 %)', () => {
    const actions = [{ at: 0, pos: 0 }, { at: 500, pos: 1 }, { at: 1000, pos: 0.5 }]
    const out = linkedActions(actions, { delayMs: 0, invert: false, amount: 0.6 })
    expect(out.map(a => a.pos)).toEqual([0.2, 0.8, 0.5].map(v => expect.closeTo(v, 5)))
  })

  it('never drives a scripted axis, and loads saved links safely', () => {
    const links = sanitizeLinks([{ channel: 'L1', on: true, delayMs: 9999, amount: 2 }, { channel: 'R2', on: true }, { channel: 'L0', on: true }])
    expect(links).toHaveLength(defaultLinks().length)
    expect(links.find(l => l.channel === 'L1')).toMatchObject({ on: true, delayMs: 500, amount: 1 })
    expect(activeLinks(links, ['R2']).map(l => l.channel)).toEqual(['L1'])
  })

  it('plays generated motion back after the delay', () => {
    const h = createStrokeHistory()
    for (let t = 0; t <= 1000; t += 10)
      h.push(t, t / 1000)
    expect(h.at(1000, 100)).toBeCloseTo(0.9)
    expect(h.at(1000, -50)).toBeCloseTo(1)
  })

  it('knows a preset when the links match it, whatever an off axis is set to', () => {
    const sr6 = BUILTIN_LINK_PRESETS[0].links
    const mine = sr6.map(l => (l.on ? { ...l } : { ...l, delayMs: 300, invert: true }))
    expect(sameLinks(mine, sr6)).toBe(true)
    expect(sameLinks(mine.map(l => (l.channel === 'L1' ? { ...l, delayMs: 65 } : l)), sr6)).toBe(false)
    expect(sanitizeLinkPresets([{ id: 'a', name: '  Mine ', links: mine }, { id: 'b', name: '' }, null])).toEqual([{ id: 'a', name: 'Mine', links: sanitizeLinks(mine) }])
  })

  it('follows another axis, through a chain of links, and not round a loop', () => {
    const links = sanitizeLinks([
      { channel: 'R1', on: true, source: 'R0', delayMs: 50 },
      { channel: 'R2', on: true, source: 'R1', invert: true },
      { channel: 'L1', on: true, source: 'L1' },
      { channel: 'L2', on: true, source: 'R2' },
    ])
    expect(links.find(l => l.channel === 'L1')!.source).toBe('L0')
    const twist = { actions: [{ at: 0, pos: 0.25 }, { at: 1000, pos: 0.75 }], ms: 500 }
    const played = new Map([['R0', twist]])
    expect(resolveLinked('R1', played, links)?.actions).toEqual([{ at: 50, pos: 0.25 }, { at: 1050, pos: 0.75 }])
    expect(resolveLinked('R2', played, links)?.actions).toEqual([{ at: 50, pos: 0.75 }, { at: 1050, pos: 0.25 }])
    expect(resolveLinked('R2', played, links)?.ms).toBe(500)
    const loop = sanitizeLinks([{ channel: 'R1', on: true, source: 'R2' }, { channel: 'R2', on: true, source: 'R1' }])
    expect(resolveLinked('R1', new Map(), loop)).toBeNull()
  })
})
