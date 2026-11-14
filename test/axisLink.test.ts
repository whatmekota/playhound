import { describe, expect, it } from 'vitest'
import { activeLinks, createStrokeHistory, defaultLinks, linkedActions, linkedPosition, sanitizeLinks } from '~/lib/axisLink'

describe('axis links', () => {
  it('maps the stroke: inverted, turned down around the middle', () => {
    expect(linkedPosition(1, { invert: false, amount: 1 })).toBe(1)
    expect(linkedPosition(1, { invert: true, amount: 1 })).toBe(0)
    expect(linkedPosition(1, { invert: false, amount: 0.5 })).toBe(0.75)
    expect(linkedPosition(0.2, { invert: true, amount: 0.5 })).toBeCloseTo(0.65)
  })

  it('shifts the script by the delay and keeps the same array per setting', () => {
    const actions = [{ at: 0, pos: 0 }, { at: 500, pos: 100 }]
    const link = { delayMs: 80, invert: true, amount: 1 }
    const out = linkedActions(actions, link)
    expect(out).toEqual([{ at: 80, pos: 100 }, { at: 580, pos: 0 }])
    expect(linkedActions(actions, { ...link })).toBe(out)
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
})
