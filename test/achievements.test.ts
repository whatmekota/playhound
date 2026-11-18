import type { AchievementFacts } from '~/lib/achievements'
import type { SessionLog } from '~/lib/sessionLog'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ACHIEVEMENTS, dayFacts, newlyEarned, progressOf, sessionFacts } from '~/lib/achievements'
import { readManifest } from '~/plugins/manifest'
import { cleanPluginAchievements, useAchievementStore } from '~/stores/achievementStore'

vi.mock('~/lib/idb', async (orig) => {
  const real = await orig<typeof import('~/lib/idb')>()
  const none = { get: async () => undefined, set: async () => {}, del: async () => {}, keys: async () => [], all: async () => ({}), getList: async () => undefined, setList: async () => {} }
  return { ...real, pluginDb: none, summaryDb: none, metaDb: none, handleDb: none, videoMetaDb: none }
})

function blank(): Omit<AchievementFacts, 'earned'> {
  return {
    watchMs: 0,
    plays: 0,
    videosPlayed: 0,
    mostPlays: 0,
    finishes: 0,
    videosFinished: 0,
    edges: 0,
    ...sessionFacts([]),
    ...dayFacts([]),
    library: { videos: 0, scripted: 0, multiAxis: 0, starred: 0, tagged: 0 },
    playlists: 0,
    biggestPlaylist: 0,
    bookmarks: 0,
    patterns: 0,
    rules: 0,
    programmes: 0,
    plugins: 0,
    counters: {},
  }
}

describe('achievements', () => {
  it('has a lot of them, each with its own id, and a real icon name', () => {
    expect(ACHIEVEMENTS.length).toBeGreaterThanOrEqual(120)
    expect(new Set(ACHIEVEMENTS.map(a => a.id)).size).toBe(ACHIEVEMENTS.length)
    expect(ACHIEVEMENTS.every(a => a.icon.startsWith('i-carbon-') && a.target >= 1)).toBe(true)
  })

  it('earns nothing from nothing, and the right ones from a first evening', () => {
    expect(newlyEarned(blank(), new Set())).toEqual([])
    const f = { ...blank(), plays: 12, watchMs: 2 * 3_600_000, videosPlayed: 12, finishes: 1, edges: 3, counters: { panic: 1 } }
    const got = newlyEarned(f, new Set())
    expect(got).toEqual(expect.arrayContaining(['first-play', 'plays-10', 'hours-1', 'first-edge', 'first-finish', 'panic']))
    expect(got).not.toContain('plays-100')
  })

  it('counts achievements earned, in the same check', () => {
    const many = new Set(ACHIEVEMENTS.slice(1, 10).map(a => a.id))
    const got = newlyEarned({ ...blank(), plays: 1 }, many)
    expect(got).toContain('first-play')
    expect(got).toContain('earned-10')
  })

  it('shows progress capped at the target', () => {
    const a = ACHIEVEMENTS.find(x => x.id === 'plays-100')!
    expect(progressOf(a, { ...blank(), plays: 250, earned: 0 })).toEqual({ value: 100, done: true })
    expect(progressOf(a, { ...blank(), plays: 40, earned: 0 })).toEqual({ value: 40, done: false })
  })

  it('reads streaks, weekends and special days off the days played', () => {
    const d = dayFacts(['2026-12-24', '2026-12-25', '2026-12-26', '2026-12-28', '2028-02-29', '2026-11-13'])
    expect(d.bestStreak).toBe(3)
    expect(d.daysActive).toBe(6)
    expect(d.specialDays).toEqual(expect.arrayContaining(['xmas', 'leap', 'friday13']))
    expect(d.weekendDays).toBeGreaterThan(0)
  })

  it('reads sessions: edges before a finish, how soon it came, hours of the day', () => {
    const start = new Date(2026, 10, 17, 3, 0).getTime()
    const s: SessionLog = {
      start,
      end: start + 40 * 60_000,
      plays: [{ video: 'a', from: start, ms: 0 }, { video: 'b', from: start + 60_000, ms: 0 }],
      edges: [1, 2, 3].map(i => ({ ts: start + i * 60_000, video: 'a', at: 0, source: i === 3 ? 'heart' : undefined })),
      finishes: [{ ts: start + 2 * 60_000 + 30_000, video: 'a', at: 0, spm: 260 }],
    }
    const f = sessionFacts([s])
    expect(f.edgesBeforeFinish).toBe(2)
    expect(f.fastestFinishMs).toBe(150_000)
    expect(f.hours[3]).toBe(2)
    expect(f.finishTopSpm).toBe(260)
    expect(f.edgeSources).toEqual({ key: 2, heart: 1 })
  })
})

describe('plugins\' achievements', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('keeps a declared list safe', () => {
    const out = cleanPluginAchievements([
      { id: 'first', title: 'First pull', description: 'Pull once', icon: '🎰', tier: 9 },
      { id: 'first', title: 'Again' },
      { id: 'Bad Id', title: 'x' },
      { id: 'many', title: 'Many', target: 100, hidden: true, tier: 3 },
      null,
    ])
    expect(out.map(a => a.id)).toEqual(['first', 'many'])
    expect(out[0].tier).toBe(1)
    expect(out[1]).toMatchObject({ target: 100, hidden: true, tier: 3 })
  })

  it('earns them through the plugin API, once, and on reaching a target', async () => {
    const { usePluginStore } = await import('~/stores/pluginStore')
    const { ctx, stop } = usePluginStore().contextFor(readManifest({ id: 'demo', name: 'Demo', version: '1.0.0', api: 7, permissions: [] }))
    ctx.achievements.define([{ id: 'one', title: 'One', description: 'Do it' }, { id: 'ten', title: 'Ten', description: 'Ten times', target: 10 }])
    expect(ctx.achievements.unlock('one')).toBe(true)
    expect(ctx.achievements.unlock('one')).toBe(false)
    expect(ctx.achievements.unlock('nope')).toBe(false)
    ctx.achievements.progress('ten', 4)
    expect(ctx.achievements.unlocked().ten).toBeUndefined()
    ctx.achievements.progress('ten', 10)
    expect(Object.keys(ctx.achievements.unlocked()).sort()).toEqual(['one', 'ten'])
    expect(useAchievementStore().pluginEarnedCount).toBe(2)
    stop()
  })
})
