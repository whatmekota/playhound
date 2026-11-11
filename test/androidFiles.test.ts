import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { offeredHere } from '~/lib/android/features'
import { isNativeMediaUrl, NativeFile, setMediaBase, sliceBounds } from '~/lib/android/nativeFile'

const BASE = 'http://127.0.0.1:41234/tok/'
const DATA = new TextEncoder().encode('{"actions":[{"at":0,"pos":50}]}')

describe('sliceBounds', () => {
  it('follows Blob.slice', () => {
    expect(sliceBounds(100)).toEqual([0, 100])
    expect(sliceBounds(100, 10, 20)).toEqual([10, 20])
    expect(sliceBounds(100, -10)).toEqual([90, 100])
    expect(sliceBounds(100, 50, 500)).toEqual([50, 100])
    expect(sliceBounds(100, 60, 40)).toEqual([60, 60])
    expect(sliceBounds(100, -500, -50)).toEqual([0, 50])
  })
})

describe('nativeFile', () => {
  const calls: { url: string, range: string | null }[] = []

  beforeEach(() => {
    setMediaBase(BASE)
    calls.length = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const range = (init?.headers as Record<string, string> | undefined)?.Range ?? null
      calls.push({ url, range })
      const m = range?.match(/bytes=(\d+)-(\d+)/)
      const body = m ? DATA.slice(Number(m[1]), Number(m[2]) + 1) : DATA
      return new Response(body, { status: m ? 206 : 200 })
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    setMediaBase(null)
  })

  const file = () => new NativeFile({ uri: 'content://tree/doc/clip.funscript', name: 'clip.funscript', size: DATA.length, modified: 1700000000000, mime: 'application/octet-stream' })

  it('carries the real name, size and date', () => {
    const f = file()
    expect(f).toBeInstanceOf(File)
    expect(f.name).toBe('clip.funscript')
    expect(f.size).toBe(DATA.length)
    expect(f.lastModified).toBe(1700000000000)
    expect(f.type).toBe('')
  })

  it('reads the whole file from the media server', async () => {
    expect(await file().text()).toBe(new TextDecoder().decode(DATA))
    expect(calls).toEqual([{ url: `${BASE}f?u=${encodeURIComponent('content://tree/doc/clip.funscript')}`, range: null }])
  })

  it('reads a slice as a Range request', async () => {
    const part = file().slice(2, 9)
    expect(part.size).toBe(7)
    expect(await part.text()).toBe(new TextDecoder().decode(DATA.slice(2, 9)))
    expect(calls[0].range).toBe('bytes=2-8')
    // A slice of a slice stays in the file's coordinates.
    expect(await part.slice(1, 3).text()).toBe(new TextDecoder().decode(DATA.slice(3, 5)))
    expect(calls[1].range).toBe('bytes=3-4')
  })

  it('an empty slice asks for nothing', async () => {
    expect(await file().slice(5, 5).text()).toBe('')
    expect(calls).toEqual([])
  })

  it('knows its own URLs', () => {
    expect(isNativeMediaUrl(file().mediaUrl)).toBe(true)
    expect(isNativeMediaUrl('blob:http://localhost/x')).toBe(false)
    expect(isNativeMediaUrl(null)).toBe(false)
  })
})

describe('offeredHere', () => {
  it('offers everything outside the Android app', () => {
    for (const id of ['eroscripts', 'organizer', 'remote', 'face', 'player'] as const)
      expect(offeredHere(id)).toBe(true)
  })
})
