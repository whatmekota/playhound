import type { SessionHistory } from '../src/lib/sessionLog'
import { describe, expect, it } from 'vitest'
import {
  addHeart,
  currentSessionStart,
  emptyHeartAcc,
  emptyHistory,
  foldHeart,
  MAX_ITEMS,
  MAX_SESSIONS,
  normaliseHistory,
  pushCapped,
  SESSION_GAP_MS,
  sessionAt,
} from '../src/lib/sessionLog'

const T = 1_700_000_000_000

describe('sessionAt', () => {
  it('joins what happens within the gap, and starts afresh after it', () => {
    const h = emptyHistory(T)
    const a = sessionAt(h, T, false)
    expect(sessionAt(h, T + SESSION_GAP_MS - 1, false)).toBe(a)
    expect(a.end).toBe(T + SESSION_GAP_MS - 1)
    const b = sessionAt(h, a.end + SESSION_GAP_MS, false)
    expect(b).not.toBe(a)
    expect(h.sessions).toHaveLength(2)
  })

  it('an open video holds the session however long it runs', () => {
    const h = emptyHistory(T)
    const a = sessionAt(h, T, false)
    expect(sessionAt(h, T + 5 * SESSION_GAP_MS, true)).toBe(a)
  })

  it('keeps the newest sessions', () => {
    const h = emptyHistory(T)
    for (let i = 0; i < MAX_SESSIONS + 5; i++)
      sessionAt(h, T + i * 2 * SESSION_GAP_MS, false)
    expect(h.sessions).toHaveLength(MAX_SESSIONS)
    expect(h.sessions[0].start).toBe(T + 5 * 2 * SESSION_GAP_MS)
  })
})

describe('currentSessionStart', () => {
  it('is null with no session or after the gap', () => {
    const h = emptyHistory(T)
    expect(currentSessionStart(h, T, false)).toBeNull()
    sessionAt(h, T, false)
    expect(currentSessionStart(h, T + 1000, false)).toBe(T)
    expect(currentSessionStart(h, T + SESSION_GAP_MS, false)).toBeNull()
    expect(currentSessionStart(h, T + SESSION_GAP_MS, true)).toBe(T)
  })
})

describe('heart summary', () => {
  it('folds readings in and merges with what was there', () => {
    const h = emptyHistory(T)
    const s = sessionAt(h, T, false)
    const acc = emptyHeartAcc()
    for (const b of [100, 110, 120])
      addHeart(acc, b)
    foldHeart(s, acc)
    expect(s.heart).toEqual({ min: 100, max: 120, mean: 110, n: 3 })
    expect(acc.n).toBe(0)
    addHeart(acc, 150)
    foldHeart(s, acc)
    expect(s.heart).toEqual({ min: 100, max: 150, mean: 120, n: 4 })
  })

  it('leaves a session without readings alone', () => {
    const s = sessionAt(emptyHistory(T), T, false)
    foldHeart(s, emptyHeartAcc())
    expect(s.heart).toBeUndefined()
  })
})

describe('storage', () => {
  it('drops what is not a session and keeps the stamp', () => {
    const raw = { since: 5, sessions: [{ start: 1, end: 2, plays: [], edges: [], finishes: [] }, { start: 'x' }, null] }
    const h = normaliseHistory(raw, T)
    expect(h.since).toBe(5)
    expect(h.sessions).toHaveLength(1)
  })

  it('starts empty from anything unreadable', () => {
    expect(normaliseHistory(null, T)).toEqual<SessionHistory>({ since: T, sessions: [] })
    expect(normaliseHistory({ sessions: 3 }, T)).toEqual<SessionHistory>({ since: T, sessions: [] })
  })

  it('caps a list', () => {
    const list: number[] = []
    for (let i = 0; i < MAX_ITEMS + 3; i++)
      pushCapped(list, i)
    expect(list).toHaveLength(MAX_ITEMS)
    expect(list[0]).toBe(3)
  })
})
