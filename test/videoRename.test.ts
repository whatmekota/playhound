import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mem = vi.hoisted(() => ({ vidmeta: new Map<string, unknown>(), thumbs: new Map<string, unknown>() }))
vi.mock('~/lib/idb', async (orig) => {
  const real = await orig<typeof import('~/lib/idb')>()
  const store = (m: Map<string, unknown>) => ({ get: async (k: string) => m.get(k) as any, set: async (k: string, v: unknown) => void m.set(k, v), del: async (k: string) => void m.delete(k) })
  const none = { get: async () => undefined, set: async () => {}, del: async () => {}, all: async () => ({}), keys: async () => [], getList: async () => undefined, setList: async () => {} }
  return { ...real, videoMetaDb: store(mem.vidmeta), thumbDb: store(mem.thumbs), summaryDb: none, metaDb: none, handleDb: none, pluginDb: none }
})

describe('renaming a video keeps what playhound knows about it', () => {
  beforeEach(() => {
    localStorage.clear()
    mem.vidmeta.clear()
    mem.thumbs.clear()
    setActivePinia(createPinia())
  })

  it('moves saved info, star, stats, playlists, bookmarks and the thumbnail', async () => {
    const { carryVideoData } = await import('~/stores/videoRename')
    const { useStatsStore } = await import('~/stores/statsStore')
    const { usePlaylistStore } = await import('~/stores/playlistStore')
    const { useBookmarkStore } = await import('~/stores/bookmarkStore')
    mem.vidmeta.set('old.mp4', { tags: ['pmv'], sourceUrl: 'https://discuss.eroscripts.com/t/x/1' })
    mem.thumbs.set('old.mp4', 'data:image/jpeg;base64,AA')
    const stats = useStatsStore()
    stats.stats['old.mp4'] = { videoName: 'old.mp4', totalPlays: 3, totalWatchedMs: 1000, finishEvents: [], lastPlayedAt: 5 }
    const pl = usePlaylistStore()
    pl.toggleFavorite('old.mp4')
    useBookmarkStore().add('old.mp4', 12)

    await carryVideoData('old.mp4', 'new name.mp4')

    expect(mem.vidmeta.get('new name.mp4')).toMatchObject({ tags: ['pmv'], sourceUrl: 'https://discuss.eroscripts.com/t/x/1' })
    expect(mem.vidmeta.has('old.mp4')).toBe(false)
    expect(mem.thumbs.get('new name.mp4')).toBe('data:image/jpeg;base64,AA')
    expect(stats.stats['new name.mp4']?.totalPlays).toBe(3)
    expect(stats.stats['old.mp4']).toBeUndefined()
    expect(pl.isFavorite('new name.mp4')).toBe(true)
    expect(useBookmarkStore().forVideo('new name.mp4')).toHaveLength(1)
  })

  it('leaves saved info already under the new name alone', async () => {
    const { carryVideoData } = await import('~/stores/videoRename')
    mem.vidmeta.set('a.mp4', { tags: ['a'] })
    mem.vidmeta.set('b.mp4', { tags: ['b'] })
    await carryVideoData('a.mp4', 'b.mp4')
    expect(mem.vidmeta.get('b.mp4')).toEqual({ tags: ['b'] })
  })
})
