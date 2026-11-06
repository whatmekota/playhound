import type { FsEntry } from '../src/lib/fsWalk'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pairSubtitles, subtitleLabel } from '../src/lib/subtitles'
import { useLibraryStore } from '../src/stores/libraryStore'
import { buildPairs, useOrganizerStore } from '../src/stores/organizerStore'
import { useSubtitleStore } from '../src/stores/subtitleStore'

const SRT = '1\n00:00:01,000 --> 00:00:02,000\nHello\n'

/** A file as a folder walk would hand it over, with its folder path. */
function fileAt(path: string, body = 'x') {
  const f = new File([body], path.split('/').pop()!)
  Object.defineProperty(f, 'webkitRelativePath', { value: path })
  return f
}

function match(name: string, video: string, body = SRT) {
  const file = new File([body], name)
  const p = pairSubtitles([video], [file])[0]
  return { file, name: p.name, label: subtitleLabel(p.name, name) }
}

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  globalThis.URL.createObjectURL = vi.fn(() => `blob:${Math.random()}`)
  globalThis.URL.revokeObjectURL = vi.fn()
})

describe('library scan', () => {
  it('pairs subtitles within a folder only', async () => {
    const lib = useLibraryStore()
    await lib.setFiles([
      fileAt('Lib/a/clip.mp4'),
      fileAt('Lib/a/clip.en.srt'),
      fileAt('Lib/a/clip.srt'),
      fileAt('Lib/b/clip.mp4'),
      fileAt('Lib/b/other.srt'),
      fileAt('Lib/c/clip.ja.vtt'),
    ])
    const [a, b] = lib.videos
    expect(a.path).toBe('Lib/a/clip.mp4')
    expect(a.subtitles?.map(s => [s.file.name, s.label])).toEqual([['clip.en.srt', 'English'], ['clip.srt', 'clip.srt']])
    expect(b.subtitles).toBeUndefined()
  })
})

describe('organizer', () => {
  function entry(relPath: string): FsEntry {
    const i = relPath.lastIndexOf('/')
    const name = relPath.slice(i + 1)
    return { name, relPath, dirRelPath: i < 0 ? '' : relPath.slice(0, i), dirHandle: {} as any, fileHandle: {} as any, file: new File([''], name) }
  }

  it('carries subtitles with the video they belong to', () => {
    const pairs = buildPairs(['s/clip.mp4', 's/clip.funscript', 's/clip.en.srt', 's/clip.srt', 's/stray.srt', 'clip.vtt'].map(entry))
    expect(pairs).toHaveLength(1)
    expect(pairs[0].subtitles.map(s => s.name)).toEqual(['clip.en.srt', 'clip.srt'])
    expect(pairs[0].scripts.map(s => s.name)).toEqual(['clip.funscript'])
  })

  it('renames subtitles with the pair, keeping their language tag', async () => {
    const moved: string[] = []
    const movable = (relPath: string): FsEntry => {
      const e = entry(relPath)
      e.fileHandle = { move: async (n: string) => void moved.push(`${e.name} -> ${n}`), getFile: async () => new File([''], 'x') } as any
      return e
    }
    const organizer = useOrganizerStore()
    organizer.writable = true
    const [pair] = buildPairs(['Clip.mp4', 'Clip (Bounce).funscript', 'Clip.en.srt', 'Clip.srt'].map(movable))
    await organizer.renamePair(pair, 'New name')
    expect(organizer.error).toBeNull()
    expect(moved).toEqual([
      'Clip.mp4 -> New name.mp4',
      'Clip (Bounce).funscript -> New name (Bounce).funscript',
      'Clip.en.srt -> New name.en.srt',
      'Clip.srt -> New name.srt',
    ])
    expect(pair.subtitles.map(s => s.name)).toEqual(['New name.en.srt', 'New name.srt'])
  })
})

describe('subtitle store', () => {
  it('loads tracks and shows the preferred language', async () => {
    const subs = useSubtitleStore()
    subs.prefs.lang = 'ja'
    await subs.load([match('clip.en.srt', 'clip.mp4'), match('clip.ja.srt', 'clip.mp4')])
    expect(subs.tracks.map(t => t.label)).toEqual(['English', 'Japanese'])
    expect(subs.active?.label).toBe('Japanese')
  })

  it('leaves them off when they were switched off, and remembers a pick', async () => {
    const subs = useSubtitleStore()
    subs.prefs.enabled = false
    await subs.load([match('clip.en.srt', 'clip.mp4'), match('clip.de.srt', 'clip.mp4')])
    expect(subs.activeId).toBeNull()
    subs.select(subs.tracks.find(t => t.lang === 'de')!.id)
    expect(subs.prefs).toMatchObject({ enabled: true, lang: 'de' })
    subs.select(null)
    expect(subs.prefs).toMatchObject({ enabled: false, lang: 'de' })
  })

  it('toggles and cycles through off and each track', async () => {
    const subs = useSubtitleStore()
    await subs.load([match('clip.en.srt', 'clip.mp4'), match('clip.fr.srt', 'clip.mp4')])
    expect(subs.active?.lang).toBe('en')
    subs.toggle()
    expect(subs.activeId).toBeNull()
    subs.toggle()
    expect(subs.active?.lang).toBe('en')
    subs.cycle()
    expect(subs.active?.lang).toBe('fr')
    subs.cycle()
    expect(subs.activeId).toBeNull()
  })

  it('skips files with no cues and clears for a stream', async () => {
    const subs = useSubtitleStore()
    await subs.load([match('clip.srt', 'clip.mp4', 'not a subtitle'), match('clip.en.srt', 'clip.mp4')])
    expect(subs.tracks).toHaveLength(1)
    subs.clear()
    expect(subs.tracks).toEqual([])
    expect(subs.toggle()).toBe(false)
  })

  it('adds a dropped file and shows it', async () => {
    const subs = useSubtitleStore()
    subs.prefs.enabled = false
    await subs.addFile(new File([SRT], 'Some Movie.eng.srt'), 'clip.mp4')
    expect(subs.active?.label).toBe('English')
    expect(subs.prefs.enabled).toBe(true)
  })

  it('a newer load wins over a slower one', async () => {
    const subs = useSubtitleStore()
    const first = subs.load([match('a.en.srt', 'a.mp4')])
    const second = subs.load([match('b.de.srt', 'b.mp4')])
    await Promise.all([first, second])
    expect(subs.tracks.map(t => t.lang)).toEqual(['de'])
  })
})
