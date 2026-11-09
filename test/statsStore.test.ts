import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { useSessionControlStore } from '../src/stores/sessionControlStore'
import { useStatsStore } from '../src/stores/statsStore'

describe('finish marks', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('records a mark and takes back only the one undone', () => {
    const stats = useStatsStore()
    stats.recordFinish('clip.mp4', 61.5)
    vi.advanceTimersByTime(1000)
    const second = stats.recordFinish('clip.mp4', 200)
    expect(stats.stats['clip.mp4'].finishEvents.map(f => f.at)).toEqual([61.5, 200])

    stats.removeFinish('clip.mp4', second.ts)
    expect(stats.stats['clip.mp4'].finishEvents.map(f => f.at)).toEqual([61.5])
  })

  it('ignores an undo for a video it never saw', () => {
    const stats = useStatsStore()
    expect(() => stats.removeFinish('nope.mp4', 1)).not.toThrow()
  })
})

describe('session log', () => {
  const MIN = 60_000
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 10, 9, 20, 0, 0))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps one record per session: plays, edges and finishes', async () => {
    const stats = useStatsStore()
    const control = useSessionControlStore()
    stats.startSession('a.mp4')
    vi.advanceTimersByTime(10 * MIN)
    control.edge('key', { videoTime: 600, videoName: 'a.mp4' })
    await nextTick()
    stats.recordFinish('a.mp4', 650, { spm: 151.4, moment: 0.876 })
    stats.startSession('b.mp4')
    vi.advanceTimersByTime(5 * MIN)
    stats.endSession()

    const [s] = stats.history.sessions
    expect(stats.history.sessions).toHaveLength(1)
    expect(s.plays.map(p => [p.video, p.ms])).toEqual([['a.mp4', 10 * MIN], ['b.mp4', 5 * MIN]])
    expect(s.edges).toMatchObject([{ video: 'a.mp4', at: 600, source: 'key' }])
    expect(s.finishes).toMatchObject([{ video: 'a.mp4', at: 650, spm: 151, moment: 0.88 }])
    expect(s.end - s.start).toBe(15 * MIN)
    expect(stats.finishSeq).toBe(1)
  })

  it('starts a new session after half an hour of nothing', () => {
    const stats = useStatsStore()
    stats.startSession('a.mp4')
    vi.advanceTimersByTime(5 * MIN)
    stats.endSession()
    expect(stats.sessionStartedAt()).not.toBeNull()
    vi.advanceTimersByTime(31 * MIN)
    expect(stats.sessionStartedAt()).toBeNull()
    stats.startSession('b.mp4')
    expect(stats.history.sessions).toHaveLength(2)
    expect(stats.sessionStartedAt()).toBe(Date.now())
  })

  it('a video left open keeps its session going', async () => {
    const stats = useStatsStore()
    const control = useSessionControlStore()
    stats.startSession('long.mp4')
    const start = Date.now()
    vi.advanceTimersByTime(2 * 60 * MIN)
    expect(stats.sessionStartedAt()).toBe(start)
    control.edge('heart', { videoTime: 7000, videoName: 'long.mp4' })
    await nextTick()
    expect(stats.history.sessions).toHaveLength(1)
    expect(stats.history.sessions[0].edges).toHaveLength(1)
  })

  it('an undone finish leaves the session too', () => {
    const stats = useStatsStore()
    stats.startSession('a.mp4')
    const f = stats.recordFinish('a.mp4', 10)
    stats.removeFinish('a.mp4', f.ts)
    expect(stats.history.sessions[0].finishes).toEqual([])
  })

  it('is written to storage and read back', async () => {
    const stats = useStatsStore()
    stats.startSession('a.mp4')
    vi.advanceTimersByTime(MIN)
    stats.endSession()
    await nextTick()
    setActivePinia(createPinia())
    const again = useStatsStore()
    expect(again.history.sessions).toHaveLength(1)
    expect(again.history.sessions[0].plays[0].ms).toBe(MIN)
  })

  it('stamps when logging began on first use', () => {
    const stats = useStatsStore()
    expect(stats.history.since).toBe(Date.now())
    expect(JSON.parse(localStorage.getItem('ph:stats.sessions')!).since).toBe(Date.now())
  })

  it('clearing stats clears the log', () => {
    const stats = useStatsStore()
    stats.startSession('a.mp4')
    stats.clearAll()
    expect(stats.history.sessions).toEqual([])
  })
})
