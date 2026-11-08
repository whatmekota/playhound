import type { FsEntry } from '../src/lib/fsWalk'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { renameEntry } from '../src/lib/fsRename'
import { buildPairs, useOrganizerStore } from '../src/stores/organizerStore'

/** A file in a folder that holds `others` too; renames are recorded in `moved`. */
function entry(relPath: string, opts: { modified?: number, size?: number, others?: string[], moved?: string[] } = {}): FsEntry {
  const i = relPath.lastIndexOf('/')
  const name = relPath.slice(i + 1)
  const file = new File(['x'.repeat(opts.size ?? 1)], name, { lastModified: opts.modified ?? 0 })
  const there = new Set(opts.others ?? [])
  const e: FsEntry = {
    name,
    relPath,
    dirRelPath: i < 0 ? '' : relPath.slice(0, i),
    dirHandle: {
      getFileHandle: async (n: string) => {
        if (!there.has(n))
          throw new DOMException('Not found', 'NotFoundError')
        return {}
      },
    } as any,
    fileHandle: {
      move: async (n: string) => void opts.moved?.push(`${e.name} -> ${n}`),
      getFile: async () => file,
    } as any,
    file,
  }
  return e
}

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
})

describe('organizer pairs', () => {
  it('dates and sizes a pair by its video, or by its scripts when there is none', () => {
    const pairs = buildPairs([
      entry('a.mp4', { modified: 5000, size: 40 }),
      entry('a.funscript', { modified: 9000, size: 3 }),
      entry('stray.funscript', { modified: 7000, size: 2 }),
      entry('stray.roll.funscript', { modified: 8000, size: 4 }),
    ])
    const a = pairs.find(p => p.basename === 'a')!
    expect([a.modified, a.size]).toEqual([5000, 40])
    const stray = pairs.find(p => p.basename === 'stray')!
    expect(stray.status).toBe('script-only')
    expect(stray.modified).toBe(7000)
  })

  it('keys a renamed pair the way a fresh scan would', async () => {
    const organizer = useOrganizerStore()
    organizer.writable = true
    const [pair] = buildPairs([entry('dir/Clip.mp4'), entry('dir/Clip.funscript')])
    await organizer.renamePair(pair, 'New')
    expect(organizer.error).toBeNull()
    expect(pair.key).toBe(buildPairs([entry('dir/New.mp4'), entry('dir/New.funscript')])[0].key)
  })
})

describe('renameEntry', () => {
  it('never renames over a file already in the folder', async () => {
    const moved: string[] = []
    await expect(renameEntry(entry('a.funscript', { others: ['b.funscript'], moved }), 'b.funscript')).rejects.toThrow(/already in that folder/)
    expect(moved).toEqual([])
  })

  it('lets a change of case through', async () => {
    const moved: string[] = []
    await renameEntry(entry('clip.funscript', { others: ['clip.funscript'], moved }), 'Clip.funscript')
    expect(moved).toEqual(['clip.funscript -> Clip.funscript'])
  })
})

describe('organizer delete', () => {
  it('deletes a pair for good where there is no bin (the browser)', async () => {
    const removed: string[] = []
    const organizer = useOrganizerStore()
    organizer.writable = true
    const files = [entry('Clip.mp4'), entry('Clip.funscript'), entry('Clip.roll.funscript')]
    for (const f of files)
      f.dirHandle = { removeEntry: async (n: string) => void removed.push(n) } as any
    const [pair] = buildPairs(files)
    expect(organizer.deletesToBin([pair.video!])).toBe(false)
    const r = await organizer.deleteEntries([pair.video!, ...pair.scripts])
    expect(r).toEqual({ ok: 3, failed: [], toBin: false })
    expect(removed).toEqual(['Clip.mp4', 'Clip.funscript', 'Clip.roll.funscript'])
  })

  it('reports what could not be deleted, and deletes nothing without permission', async () => {
    const organizer = useOrganizerStore()
    organizer.writable = true
    const f = entry('a.funscript')
    f.dirHandle = { removeEntry: async () => { throw new Error('locked') } } as any
    expect((await organizer.deleteEntries([f])).failed).toEqual([{ name: 'a.funscript', error: 'locked' }])
    organizer.writable = false
    expect((await organizer.deleteEntries([f])).ok).toBe(0)
  })
})
