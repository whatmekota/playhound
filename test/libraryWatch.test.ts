import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { findFolder, isInside } from '../desktop/libfiles.mjs'
import { applyChanges, diffPaths, diskPathOf, isLibraryName, keepUnchanged, normaliseChanges } from '../src/lib/libraryWatch'
import { keysStartingWith, matchScripts, scriptMapOf } from '../src/lib/mediaFiles'
import { useLibraryStore } from '../src/stores/libraryStore'

// jsdom has no IndexedDB; the library only caches script sniffs there.
vi.mock('~/lib/idb', async (orig) => {
  const real = await orig<typeof import('~/lib/idb')>()
  const none = { get: async () => undefined, set: async () => {}, del: async () => {}, keys: async () => [], all: async () => ({}), getList: async () => undefined, setList: async () => {} }
  return { ...real, metaDb: none, handleDb: none, videoMetaDb: none }
})

/** A file as a folder walk would hand it over, with its folder path. */
function fileAt(path: string, body = 'x') {
  const f = new File([body], path.split('/').pop()!)
  Object.defineProperty(f, 'webkitRelativePath', { value: path })
  return f
}

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
})

describe('changed paths', () => {
  it('normalises, dedupes and folds paths inside a changed folder', () => {
    expect(normaliseChanges(['a\\b.mp4', 'a/b.mp4', 'c', 'c/d.mp4', 'c/e/f.mp4', '/x/'])).toEqual(['a/b.mp4', 'c', 'x'])
  })

  it('replaces what sat at a changed path, file or folder', () => {
    const files = ['L/a.mp4', 'L/s/b.mp4', 'L/s/t/c.mp4', 'L/sx.mp4']
    const out = applyChanges(files, p => p, [
      { path: 'L/s', files: ['L/s/new.mp4'] },
      { path: 'L/a.mp4', files: [] },
    ])
    expect(out).toEqual(['L/sx.mp4', 'L/s/new.mp4'])
  })

  it('diffs two listings', () => {
    expect(diffPaths(['a', 'b'], new Set(['b', 'c']))).toEqual({ added: ['c'], removed: ['a'] })
  })

  it('keeps the old object for a file that did not change', () => {
    const a1 = { p: 'a', size: 1, lastModified: 5 }
    const b1 = { p: 'b', size: 1, lastModified: 5 }
    const a2 = { p: 'a', size: 1, lastModified: 5 }
    const b2 = { p: 'b', size: 2, lastModified: 6 }
    const out = keepUnchanged([a1, b1], [a2, b2], f => f.p)
    expect(out[0]).toBe(a1)
    expect(out[1]).toBe(b2)
  })

  it('knows what the library is made of', () => {
    expect(['a.mp4', 'a.MKV', 'a.mp3', 'a.funscript', 'a.roll.funscript', 'a.srt', 'a.vtt'].every(isLibraryName)).toBe(true)
    expect(['a.jpg', 'a.txt', 'a.mp4.part', 'folder'].some(isLibraryName)).toBe(false)
  })

  it('puts a library path under its folder on disk', () => {
    expect(diskPathOf('D:\\Videos', 'Videos (2)/sub/clip.mp4')).toBe('D:\\Videos\\sub\\clip.mp4')
    expect(diskPathOf('D:\\', 'D/clip.mp4')).toBe('D:\\clip.mp4')
    expect(diskPathOf('/home/me/Videos', 'Videos/clip.mp4')).toBe('/home/me/Videos/clip.mp4')
  })
})

describe('script lookup', () => {
  it('finds the same scripts as a full scan, in the map\'s order', () => {
    const names = ['b.funscript', 'clip.roll.funscript', 'clip.funscript', 'clip (bounce).funscript', 'clipper.funscript', 'cl.funscript', 'clip.twist.funscript']
    const map = scriptMapOf(names.map(n => new File(['{}'], n)))
    expect(keysStartingWith(map, 'clip')).toEqual(['clip.roll.funscript', 'clip.funscript', 'clip (bounce).funscript', 'clipper.funscript', 'clip.twist.funscript'])
    expect(keysStartingWith(map, 'zzz')).toEqual([])
    // A map that grows is indexed again.
    map.set('clip.pitch.funscript', new File(['{}'], 'clip.pitch.funscript'))
    expect(matchScripts('Clip.mp4', map).filter(m => !m.isAlt).map(m => m.file.name)).toEqual(['clip.roll.funscript', 'clip.funscript', 'clip.twist.funscript', 'clip.pitch.funscript'])
  })
})

describe('desktop folders', () => {
  it('tells inside from outside', () => {
    expect(isInside('/lib', '/lib/a/b.mp4')).toBe(true)
    expect(isInside('/lib', '/lib')).toBe(true)
    expect(isInside('/lib', '/lib2/a.mp4')).toBe(false)
    expect(isInside('/lib', '/lib/../etc/passwd')).toBe(false)
  })

  it('finds the folder a handle means among those the session reported', () => {
    const known = new Set(['/a/Videos', '/b/Videos', '/c/Other'])
    const exists = (p: string) => p.replace(/\\/g, '/') === '/b/Videos/sub/clip.mp4'
    expect(findFolder(known, 'Videos', 'sub/clip.mp4', exists).replace(/\\/g, '/')).toBe('/b/Videos')
    expect(findFolder(known, 'Videos', 'nope.mp4', exists)).toBe('')
    // Empty: by name, only when that is unambiguous.
    expect(findFolder(known, 'Other', '', exists)).toBe('/c/Other')
    expect(findFolder(known, 'Videos', '', exists)).toBe('')
    expect(findFolder(known, 'Videos', '../x', () => true)).toBe('')
  })
})

describe('library rebuilds', () => {
  it('keeps what it knew of a video whose files did not change', async () => {
    const lib = useLibraryStore()
    const video = fileAt('L/clip.mp4')
    const script = fileAt('L/clip.funscript', '{"actions":[]}')
    await lib.setFiles([video, script])
    const entry = lib.videos[0]
    entry.duration = 42
    await lib.setFiles([video, script, fileAt('L/other.mp4')])
    expect(lib.videos).toHaveLength(2)
    expect(lib.videos.find(v => v.name === 'clip.mp4')!.duration).toBe(42)
    // A rewritten script: built afresh.
    await lib.setFiles([video, fileAt('L/clip.funscript', '{"actions":[]}')])
    expect(lib.videos[0].duration).toBeNull()
  })

  it('remembers the watch switch', async () => {
    const lib = useLibraryStore()
    lib.setWatching(false)
    await nextTick()
    expect(localStorage.getItem('ph:library.watch')).toBe('false')
    expect(lib.isWatching).toBe(false)
    setActivePinia(createPinia())
    expect(useLibraryStore().watchOn).toBe(false)
  })
})
