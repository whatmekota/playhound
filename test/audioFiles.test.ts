import type { VideoEntry } from '../src/stores/libraryStore'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bytesSource, findCover, id3Cover, mp4CoverIn } from '../src/lib/audioCover'
import { tileActions, tileColumns, tileHue } from '../src/lib/audioTile'
import { filterCounts, filterEntries, toggleFilter } from '../src/lib/libraryQuery'
import { isListed, matchScripts, mediaKindOf, sameKindAs, scriptMapOf } from '../src/lib/mediaFiles'
import { baseNameFor, videoExtFor } from '../src/lib/postDownload'
import { buildActivity, DEFAULT_PRESENCE } from '../src/lib/presence'
import { autoTags, parseSearch } from '../src/lib/tags'
import { useLibraryStore } from '../src/stores/libraryStore'
import { buildPairs } from '../src/stores/organizerStore'

/** A file as a folder walk would hand it over, with its folder path. */
function fileAt(path: string, body = 'x') {
  const f = new File([body], path.split('/').pop()!)
  Object.defineProperty(f, 'webkitRelativePath', { value: path })
  return f
}

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  globalThis.URL.createObjectURL = vi.fn(() => `blob:${Math.random()}`)
  globalThis.URL.revokeObjectURL = vi.fn()
})

describe('media kinds', () => {
  it('tells audio from video by extension', () => {
    for (const n of ['a.mp3', 'a.M4A', 'a.aac', 'a.ogg', 'a.opus', 'a.flac', 'a.wav'])
      expect(mediaKindOf(n)).toBe('audio')
    for (const n of ['a.mp4', 'a.MKV', 'a.webm', 'a.mov', 'a.m4v'])
      expect(mediaKindOf(n)).toBe('video')
    for (const n of ['a.funscript', 'a.srt', 'a.jpg', 'mp3', '', null])
      expect(mediaKindOf(n)).toBeNull()
  })

  it('lists audio only when it has a script', () => {
    const scripts = scriptMapOf([new File([''], 'Track.funscript'), new File([''], 'Song.roll.funscript')])
    expect(isListed('Track.mp3', scripts)).toBe(true)
    expect(isListed('song.flac', scripts)).toBe(true)
    expect(isListed('Other.mp3', scripts)).toBe(false)
    expect(isListed('Other.mp4', scripts)).toBe(true)
    expect(isListed('Track.funscript', scripts)).toBe(false)
  })

  it('pairs axes and alternate takes the same way for audio and video', () => {
    const scripts = scriptMapOf(['Track.funscript', 'Track.roll.funscript', 'Track (soft).funscript', 'Track.twist.funscript', 'Other.funscript']
      .map(n => new File([''], n)))
    const m = matchScripts('Track.mp3', scripts)
    expect(m.map(x => [x.file.name, x.isAlt, x.altName])).toEqual([
      ['Track.funscript', false, ''],
      ['Track.roll.funscript', false, ''],
      ['Track.twist.funscript', false, ''],
      ['Track (soft).funscript', true, 'soft'],
    ])
    expect(matchScripts('Track.mp4', scripts).map(x => x.file.name)).toEqual(m.map(x => x.file.name))
  })

  it('keeps to the kind that is playing when picking on its own', () => {
    const list = [{ name: 'a.mp4' }, { name: 'b.mp3' }, { name: 'c.mkv' }]
    expect(sameKindAs(list, 'x.flac').map(v => v.name)).toEqual(['b.mp3'])
    expect(sameKindAs(list, 'x.webm').map(v => v.name)).toEqual(['a.mp4', 'c.mkv'])
    expect(sameKindAs(list, null)).toBe(list)
    expect(sameKindAs([{ name: 'a.mp4' }], 'x.mp3').map(v => v.name)).toEqual(['a.mp4'])
  })
})

describe('library scan with audio', () => {
  it('lists scripted audio with its scripts and subtitles, and skips loose songs', async () => {
    const lib = useLibraryStore()
    await lib.setFiles([
      fileAt('Lib/asmr/Track.mp3'),
      fileAt('Lib/asmr/Track.funscript'),
      fileAt('Lib/asmr/Track.roll.funscript'),
      fileAt('Lib/asmr/Track.en.srt'),
      fileAt('Lib/music/Song.flac'),
      fileAt('Lib/clip.mp4'),
    ])
    expect(lib.videos.map(v => v.name)).toEqual(['clip.mp4', 'Track.mp3'])
    const track = lib.videos.find(v => v.name === 'Track.mp3')!
    expect(track.kind).toBe('audio')
    expect(track.scriptType).toBe('multi')
    expect(track.scriptCount).toBe(2)
    expect(track.subtitles?.map(s => s.file.name)).toEqual(['Track.en.srt'])
    expect(lib.videos.find(v => v.name === 'clip.mp4')!.kind).toBeUndefined()
  })
})

describe('organizer and downloads with audio', () => {
  it('pairs scripted audio for renaming, and leaves loose songs and same-named videos alone', () => {
    const fs = (relPath: string) => {
      const name = relPath.split('/').pop()!
      return { name, relPath, dirRelPath: relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '', dirHandle: {} as any, fileHandle: {} as any, file: new File([''], name) }
    }
    const pairs = buildPairs(['a/Track.mp3', 'a/Track.funscript', 'a/Track.en.srt', 'a/Song.flac', 'b/Clip.mp3', 'b/Clip.mp4', 'b/Clip.funscript'].map(fs))
    expect(pairs.map(p => [p.video?.name, p.scripts.map(s => s.name), p.subtitles.map(s => s.name), p.status])).toEqual([
      ['Track.mp3', ['Track.funscript'], ['Track.en.srt'], 'matched'],
      ['Clip.mp4', ['Clip.funscript'], [], 'matched'],
    ])
  })

  it('names a downloaded audio file by its own extension', () => {
    expect(baseNameFor('Whisper.mp3')).toBe('Whisper')
    expect(videoExtFor('Whisper.mp3')).toBe('.mp3')
    expect(videoExtFor('Whisper', 'audio/mpeg')).toBe('.mp3')
    expect(videoExtFor('Whisper', 'audio/x-m4a')).toBe('.m4a')
    expect(videoExtFor('Clip', 'video/webm')).toBe('.webm')
  })
})

function entry(name: string, over: Partial<VideoEntry> = {}): VideoEntry {
  return {
    file: { size: 100, lastModified: 0 } as File,
    name,
    basename: name.replace(/\.[^.]+$/, ''),
    path: name,
    folder: '',
    hasScript: true,
    scriptCount: 1,
    altCount: 0,
    scriptFiles: [],
    scriptMatches: [],
    thumbnailUrl: null,
    duration: null,
    scriptType: 'single',
    starred: false,
    ...over,
  }
}

describe('finding audio in the library', () => {
  const vids = [entry('Clip.mp4'), entry('Whisper VR.mp3', { kind: 'audio' }), entry('Beat.flac', { kind: 'audio' })]
  const none = new Set<never>()
  const run = (query: string, filters = new Set<never>() as Set<any>) =>
    filterEntries(vids, { query, filters, bands: none }, () => undefined).map(v => v.name)

  it('tags audio automatically, and not as VR', () => {
    expect(autoTags(vids[1])).toEqual(['audio'])
    expect(autoTags(vids[0])).toEqual([])
  })

  it('searches by type', () => {
    expect(parseSearch('type:audio whisper')).toEqual({ text: 'whisper', include: ['audio'], exclude: [] })
    expect(parseSearch('-type:audio')).toMatchObject({ exclude: ['audio'] })
    expect(parseSearch('type:video')).toMatchObject({ include: [], exclude: ['audio'] })
    expect(run('type:audio')).toEqual(['Whisper VR.mp3', 'Beat.flac'])
    expect(run('type:video')).toEqual(['Clip.mp4'])
    expect(run('type:audio beat')).toEqual(['Beat.flac'])
  })

  it('has a chip, which "no script" cancels', () => {
    expect(run('', new Set(['audio']))).toEqual(['Whisper VR.mp3', 'Beat.flac'])
    expect(filterCounts(vids).audio).toBe(2)
    expect([...toggleFilter(new Set(['audio']), 'unscripted')]).toEqual(['unscripted'])
    expect([...toggleFilter(new Set(['unscripted']), 'audio')]).toEqual(['audio'])
  })
})

describe('discord presence', () => {
  it('says "listening to" an audio file instead of "watching" it', () => {
    const s = { ...DEFAULT_PRESENCE, enabled: true, activityType: 3 as const }
    expect(buildActivity(s, { media: 'audio' }, { sessionStart: 0, videoStart: null })?.type).toBe(2)
    expect(buildActivity(s, { media: 'video' }, { sessionStart: 0, videoStart: null })?.type).toBe(3)
    expect(buildActivity({ ...s, activityType: 0 }, { media: 'audio' }, { sessionStart: 0, videoStart: null })?.type).toBe(0)
  })
})

describe('generated tile', () => {
  it('reads a script and squeezes it into columns', () => {
    const actions = tileActions(JSON.stringify({ actions: [{ at: 1000, pos: 100 }, { at: 0, pos: 0 }, { at: 2000, pos: 0 }, { at: 'x', pos: 1 }] }))
    expect(actions).toEqual([{ at: 0, pos: 0 }, { at: 1000, pos: 100 }, { at: 2000, pos: 0 }])
    const c = tileColumns(actions, 4)
    expect(c.speed).toEqual([100, 100, 100, 100])
    expect(c.pos.map(Math.round)).toEqual([25, 75, 75, 25])
    // Longer than the script: the end says nothing.
    expect(Number.isNaN(tileColumns(actions, 4, 4000).pos[3])).toBe(true)
    expect(tileActions('not json')).toEqual([])
  })

  it('keeps a colour per name', () => {
    expect(tileHue('Track.mp3')).toBe(tileHue('Track.mp3'))
    expect(tileHue('Track.mp3')).not.toBe(tileHue('Other.mp3'))
  })
})

// ─── Cover art ──────────────────────────────────────────────────────────────

const JPEG = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, ...Array.from({ length: 40 }, (_, i) => i)])
const PNG = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, ...Array.from({ length: 40 }, (_, i) => i)])
const enc = (s: string) => Array.from(s, c => c.charCodeAt(0))
const be32 = (n: number) => [(n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF]
const syncsafe = (n: number) => [(n >> 21) & 0x7F, (n >> 14) & 0x7F, (n >> 7) & 0x7F, n & 0x7F]

function id3(major: 3 | 4, frames: number[][]): Uint8Array {
  const body = frames.flat()
  return new Uint8Array([...enc('ID3'), major, 0, 0, ...syncsafe(body.length), ...body])
}

function apic(major: 3 | 4, picType: number, data: Uint8Array, mime = 'image/jpeg'): number[] {
  const payload = [0, ...enc(mime), 0, picType, ...enc('cover'), 0, ...data]
  return [...enc('APIC'), ...(major === 4 ? syncsafe(payload.length) : be32(payload.length)), 0, 0, ...payload]
}

function textFrame(id: string, text: string): number[] {
  const payload = [0, ...enc(text)]
  return [...enc(id), ...be32(payload.length), 0, 0, ...payload]
}

function atom(type: string, body: number[]): number[] {
  return [...be32(8 + body.length), ...enc(type), ...body]
}

describe('cover art', () => {
  it('reads the front cover from an ID3v2.3 tag', async () => {
    const tag = id3(3, [textFrame('TIT2', 'Track'), apic(3, 0, PNG, 'image/png'), apic(3, 3, JPEG)])
    const art = id3Cover(tag)
    expect(art?.mime).toBe('image/jpeg')
    expect([...art!.data]).toEqual([...JPEG])
    const mp3 = new Uint8Array([...tag, 0xFF, 0xFB, 0x90, 0x00, ...Array.from({ length: 64 }).fill(0) as number[]])
    expect((await findCover(bytesSource(mp3)))?.data.length).toBe(JPEG.length)
  })

  it('reads ID3v2.4 with syncsafe frame sizes, and trusts the bytes over the tag', async () => {
    const tag = id3(4, [apic(4, 3, PNG, 'image/jpg')])
    expect(id3Cover(tag)?.mime).toBe('image/png')
  })

  it('reads a FLAC picture block', async () => {
    const pic = [...be32(3), ...be32(9), ...enc('image/png'), ...be32(0), ...be32(1), ...be32(1), ...be32(24), ...be32(0), ...be32(PNG.length), ...PNG]
    const flac = new Uint8Array([
      ...enc('fLaC'),
      0x00,
      0,
      0,
      34,
      ...Array.from({ length: 34 }).fill(0) as number[],
      0x86,
      ...be32(pic.length).slice(1),
      ...pic,
    ])
    const art = await findCover(bytesSource(flac))
    expect(art?.mime).toBe('image/png')
    expect(art?.data.length).toBe(PNG.length)
  })

  it('reads the covr atom of an m4a, wherever moov is', async () => {
    const data = atom('data', [...be32(13), ...be32(0), ...JPEG])
    const moov = atom('moov', atom('udta', atom('meta', [0, 0, 0, 0, ...atom('hdlr', [0, 0, 0, 0]), ...atom('ilst', atom('covr', data))])))
    expect(mp4CoverIn(new Uint8Array(moov))?.data.length).toBe(JPEG.length)
    const m4a = new Uint8Array([...atom('ftyp', enc('M4A ')), ...atom('mdat', Array.from({ length: 100 }).fill(1) as number[]), ...moov])
    expect((await findCover(bytesSource(m4a)))?.mime).toBe('image/jpeg')
  })

  it('gives null for a file with no picture', async () => {
    expect(await findCover(bytesSource(id3(3, [textFrame('TIT2', 'x')])))).toBeNull()
    expect(await findCover(bytesSource(new Uint8Array(64)))).toBeNull()
    expect(await findCover(bytesSource(new Uint8Array([...enc('OggS'), ...Array.from({ length: 40 }).fill(0) as number[]])))).toBeNull()
  })
})
