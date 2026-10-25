import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
