import type { PluginContext } from '~/plugins/types'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { analysisForPlugin, analysisFromPlugin, blobOf, readLibraryScripts, safeFileName } from '~/plugins/api4'
import { readManifest } from '~/plugins/manifest'
import { clearPictureFx, composeFx, setPictureFx, vPictureFx } from '~/plugins/pictureFx'

vi.mock('~/lib/idb', async (orig) => {
  const real = await orig<typeof import('~/lib/idb')>()
  const none = { get: async () => undefined, set: async () => {}, del: async () => {}, keys: async () => [], all: async () => ({}), getList: async () => undefined, setList: async () => {} }
  return { ...real, pluginDb: none, summaryDb: none, metaDb: none, handleDb: none, videoMetaDb: none }
})

describe('picture effects', () => {
  afterEach(() => {
    clearPictureFx('a')
    clearPictureFx('b')
  })

  it('stacks plugins: transforms and filters in turn, opacities multiplied', () => {
    expect(composeFx([{ transform: 'scale(1.1)', opacity: 0.5 }, { transform: 'rotate(1deg)', filter: 'blur(1px)', opacity: 0.5 }]))
      .toEqual({ transform: 'scale(1.1) rotate(1deg)', filter: 'blur(1px)', opacity: '0.25' })
    expect(composeFx([])).toEqual({ transform: '', filter: '', opacity: '' })
  })

  it('writes to the picture\'s elements and clears', () => {
    const el = document.createElement('video')
    vPictureFx.mounted!(el, {} as any, {} as any, null)
    setPictureFx('a', { transform: 'scale(1.05)' })
    setPictureFx('b', { filter: 'brightness(1.2)' })
    expect(el.style.transform).toBe('scale(1.05)')
    expect(el.style.filter).toBe('brightness(1.2)')
    setPictureFx('a', null)
    expect(el.style.transform).toBe('')
    vPictureFx.unmounted!(el, {} as any, {} as any, null)
  })
})

describe('api 4 helpers', () => {
  it('reads every axis of a video\'s scripts, positions 0–100', async () => {
    const file = (name: string, actions: unknown) => new File([JSON.stringify({ actions })], name)
    const out = await readLibraryScripts('clip.mp4', [
      { file: file('clip.funscript', [{ at: 0, pos: 0 }, { at: 500, pos: 100 }]), isAlt: false, altName: '' },
      { file: file('clip.twist.funscript', [{ at: 0, pos: 50 }]), isAlt: false, altName: '' },
      { file: new File(['nope'], 'clip (bad).funscript'), isAlt: true, altName: 'bad' },
    ])
    expect(out.map(s => [s.axis, s.alt, s.actions.length])).toEqual([['L0', false, 2], ['R0', false, 1]])
    expect(out[0].actions[1]).toEqual({ at: 500, pos: 100 })
  })

  it('round-trips an analysis and fills short per-beat arrays', () => {
    const plain = analysisForPlugin({ version: 1, duration: 10, bpm: 120, beats: [0, 0.5, 1], energy: [-10, -12, -11], centroid: [9, 9, 9], strength: [1, 1, 1], barPos: [0, 1, 2], confidence: 0.8, gaps: [] })
    expect(plain).not.toHaveProperty('version')
    const back = analysisFromPlugin({ ...plain, energy: [-10] }, 1)
    expect(back.energy).toEqual([-10, -20, -20])
    expect(() => analysisFromPlugin({}, 1)).toThrow(/no beats/)
  })

  it('makes safe names and blobs', () => {
    expect(safeFileName('a/b:c?.png')).toBe('a_b_c_.png')
    expect(safeFileName('')).toBe('file')
    expect(blobOf('x', 'application/json').type).toBe('application/json')
    expect(() => blobOf(42 as any)).toThrow(TypeError)
  })
})

describe('api 4 permissions', () => {
  let stop: (() => void) | null = null
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => {
    stop?.()
    stop = null
  })

  async function contextWith(permissions: string[]): Promise<PluginContext> {
    const { usePluginStore } = await import('~/stores/pluginStore')
    const c = usePluginStore().contextFor(readManifest({ id: 'demo', name: 'Demo', version: '1.0.0', api: 4, permissions }))
    stop = c.stop
    return c.ctx
  }

  it('refuses the calls it didn\'t ask for', async () => {
    const ctx = await contextWith([])
    expect(() => ctx.player.video()).toThrow(/"player"/)
    expect(() => ctx.player.effects({ transform: 'scale(2)' })).toThrow(/"stage"/)
    expect(() => ctx.library.scripts('x.mp4')).toThrow(/"library"/)
    expect(() => ctx.library.open('x.mp4')).toThrow(/"library"/)
    await expect(ctx.music.analyse({ video: 'x.mp4' })).rejects.toThrow(/"library"/)
  })

  it('answers null for a video that isn\'t there', async () => {
    const ctx = await contextWith(['library'])
    expect(await ctx.library.scripts('missing.mp4')).toBeNull()
    expect(await ctx.library.open('missing.mp4')).toBeNull()
  })
})
