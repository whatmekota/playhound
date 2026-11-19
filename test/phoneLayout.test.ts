import { describe, expect, it } from 'vitest'
import { typesText } from '~/composables/useCompactLayout'
import { viewportContent } from '~/composables/useUiScale'
import { describe as describeError, ENTRY_MAX, formatEntries, pushEntry } from '~/lib/android/crashReport'
import { cornerPosition, fitSize, nearestCorner, PHONE_EMU_MARGIN } from '~/lib/emuPlacement'

describe('crash report ring', () => {
  const e = (text: string, at = 0) => ({ at, kind: 'error' as const, text })

  it('keeps the newest entries and drops the oldest', () => {
    let list = [] as ReturnType<typeof pushEntry>
    for (let i = 0; i < 5; i++)
      list = pushEntry(list, e(`n${i}`), 3)
    expect(list.map(x => x.text)).toEqual(['n2', 'n3', 'n4'])
  })

  it('counts the same error twice in a row once, and cuts long ones', () => {
    let list = pushEntry([], e('boom'))
    list = pushEntry(list, e('boom'))
    expect(list).toHaveLength(1)
    list = pushEntry(list, e('x'.repeat(ENTRY_MAX + 50)))
    expect(list[1].text.length).toBe(ENTRY_MAX + 1)
  })

  it('describes errors with their stack, and anything else as text', () => {
    const err = new TypeError('bad thing')
    expect(describeError(err)).toContain('bad thing')
    expect(describeError({ a: 1 })).toBe('{"a":1}')
    expect(formatEntries([])).toBe('(none)')
    expect(formatEntries([e('hi', Date.UTC(2026, 0, 2))])).toBe('2026-01-02T00:00:00.000Z [error] hi')
  })
})

describe('emulator placement on a phone', () => {
  const stage = { left: 72, top: 0, width: 700, height: 390 }

  it('snaps to the corner nearest the window', () => {
    expect(nearestCorner(100, 50, stage)).toBe('tl')
    expect(nearestCorner(700, 50, stage)).toBe('tr')
    expect(nearestCorner(100, 300, stage)).toBe('bl')
    expect(nearestCorner(700, 300, stage)).toBe('br')
  })

  it('places a window in a corner inside the stage', () => {
    expect(cornerPosition('tl', 160, 200, stage)).toEqual({ x: 72 + PHONE_EMU_MARGIN, y: PHONE_EMU_MARGIN })
    expect(cornerPosition('br', 160, 200, stage)).toEqual({ x: 72 + 700 - 160 - PHONE_EMU_MARGIN, y: 390 - 200 - PHONE_EMU_MARGIN })
  })

  it('keeps a pinched size within the stage and the limits', () => {
    expect(fitSize(50, stage).w).toBe(132)
    const big = fitSize(2000, stage)
    expect(big.h).toBeLessThanOrEqual(390 - PHONE_EMU_MARGIN * 2)
    expect(big.w / big.h).toBeCloseTo(168 / 208, 1)
  })
})

describe('the keyboard and the layout', () => {
  it('knows the fields the on-screen keyboard comes up for', () => {
    const make = (html: string) => {
      const box = document.createElement('div')
      box.innerHTML = html
      return box.firstElementChild
    }
    expect(typesText(make('<input placeholder="Search">'))).toBe(true)
    expect(typesText(make('<input type="search">'))).toBe(true)
    expect(typesText(make('<input type="number">'))).toBe(true)
    expect(typesText(make('<textarea></textarea>'))).toBe(true)
    expect(typesText(make('<input type="checkbox">'))).toBe(false)
    expect(typesText(make('<input type="range">'))).toBe(false)
    expect(typesText(make('<button>Go</button>'))).toBe(false)
    expect(typesText(null)).toBe(false)
  })
})

describe('interface size in the Android app', () => {
  it('fixes the page scale, with no width (the WebView lays out at its width divided by it)', () => {
    expect(viewportContent(1.5)).toBe('initial-scale=1.5, minimum-scale=1.5, maximum-scale=1.5, user-scalable=no')
    expect(viewportContent(1.5)).not.toContain('width')
    expect(viewportContent(1, 'width=device-width, initial-scale=1.0, viewport-fit=cover')).toBe('width=device-width, initial-scale=1.0, viewport-fit=cover')
  })
})
