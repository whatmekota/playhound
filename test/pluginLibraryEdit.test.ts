import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { videoMetaDb } from '~/lib/idb'
import { useLibraryStore } from '~/stores/libraryStore'
import { setVideoSource, tagVideo, videoInfo } from '~/stores/pluginStore'

// Saved info in memory: jsdom has no IndexedDB. The rest of idb is not used here.
vi.mock('~/lib/idb', async (orig) => {
  const real = await orig<typeof import('~/lib/idb')>()
  const vidmeta = new Map<string, unknown>()
  const none = { get: async () => undefined, set: async () => {}, all: async () => ({}), del: async () => {} }
  return {
    ...real,
    videoMetaDb: { get: async (k: string) => vidmeta.get(k), set: async (k: string, v: unknown) => void vidmeta.set(k, v) },
    summaryDb: none,
    metaDb: none,
    handleDb: none,
  }
})

/** A file as a folder walk would hand it over, with its folder path. */
function fileAt(path: string, body = 'x') {
  const f = new File([body], path.split('/').pop()!)
  Object.defineProperty(f, 'webkitRelativePath', { value: path })
  return f
}

const SCRIPT = JSON.stringify({
  actions: [{ at: 0, pos: 0 }, { at: 500, pos: 100 }],
  metadata: { creator: 'Croove', topic_url: 'https://discuss.eroscripts.com/t/some-thread/12345', tags: ['Animation', 'pov'] },
})

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
})

describe('plugin library edits', () => {
  it('reads the thread a script came from out of its own metadata', async () => {
    const lib = useLibraryStore()
    await lib.setFiles([fileAt('Lib/clip.mp4'), fileAt('Lib/clip.funscript', SCRIPT)])
    const info = await videoInfo(lib, 'clip.mp4')
    expect(info).toEqual({
      tags: ['animation', 'pov'],
      sourceUrl: 'https://discuss.eroscripts.com/t/some-thread/12345',
      creator: 'Croove',
      scriptFiles: ['clip.funscript'],
    })
    expect(await videoInfo(lib, 'nope.mp4')).toBeNull()
  })

  it('tags a video and sets its source, which then wins over the script\'s', async () => {
    const lib = useLibraryStore()
    await lib.setFiles([fileAt('Lib/clip.mp4'), fileAt('Lib/clip.funscript', SCRIPT)])
    expect(await tagVideo(lib, 'clip.mp4', { add: ['Futanari', ' futanari '], remove: [] })).toEqual(['futanari'])
    expect(await tagVideo(lib, 'clip.mp4', { add: ['pmv'], remove: ['futanari'] })).toEqual(['pmv'])
    expect(await tagVideo(lib, 'nope.mp4', { add: ['x'] })).toBeNull()

    expect(await setVideoSource(lib, 'clip.mp4', 'https://discuss.eroscripts.com/t/other/999')).toBe(true)
    expect((await videoInfo(lib, 'clip.mp4'))!.sourceUrl).toBe('https://discuss.eroscripts.com/t/other/999')
    expect((await videoMetaDb.get('clip.mp4'))?.url).toBe('https://discuss.eroscripts.com/t/other/999')
    await expect(setVideoSource(lib, 'clip.mp4', 'javascript:alert(1)')).rejects.toThrow(/http/)
    expect(await setVideoSource(lib, 'clip.mp4', null)).toBe(true)
    expect((await videoMetaDb.get('clip.mp4'))?.url).toBeUndefined()
  })
})
