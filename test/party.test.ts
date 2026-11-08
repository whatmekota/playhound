import { describe, expect, it } from 'vitest'
import { createPartyCounter, PARTY_CLICK_GAP_MS } from '../src/lib/party'

describe('party counter', () => {
  it('opens on the fifth quick click, and starts over after a pause', () => {
    let t = 0
    const click = createPartyCounter(() => t)
    const clicks = (n: number, gap = 200) => Array.from({ length: n }, () => { t += gap; return click() })
    expect(clicks(4)).toEqual([false, false, false, false])
    t += PARTY_CLICK_GAP_MS + 1
    expect(clicks(4)).toEqual([false, false, false, false])
    expect(clicks(1)).toEqual([true])
    // And again from scratch.
    expect(clicks(5)).toEqual([false, false, false, false, true])
  })
})
