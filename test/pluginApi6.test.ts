import type { PluginContext } from '~/plugins/types'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { heartReading } from '~/composables/useHeartRate'
import { axisOutput } from '~/composables/useTCode'
import { readManifest } from '~/plugins/manifest'

vi.mock('~/lib/idb', async (orig) => {
  const real = await orig<typeof import('~/lib/idb')>()
  const none = { get: async () => undefined, set: async () => {}, del: async () => {}, keys: async () => [], all: async () => ({}), getList: async () => undefined, setList: async () => {} }
  return { ...real, pluginDb: none, summaryDb: none, metaDb: none, handleDb: none, videoMetaDb: none }
})

describe('plugin api 6', () => {
  let stop: (() => void) | null = null
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => {
    stop?.()
    stop = null
  })

  async function contextWith(permissions: string[]) {
    const { usePluginStore } = await import('~/stores/pluginStore')
    const store = usePluginStore()
    const c = store.contextFor(readManifest({ id: 'demo', name: 'Demo', version: '1.0.0', api: 6, permissions }))
    stop = c.stop
    return { ctx: c.ctx as PluginContext, info: () => store.plugins.find(p => p.manifest.id === 'demo')! }
  }

  it('shows a status until cleared or switched off', async () => {
    const { ctx, info } = await contextWith([])
    ctx.ui.status({ text: 'Connected', tone: 'ok', detail: 'Stash at 192.168.1.5' })
    expect(info().note).toEqual({ text: 'Connected', tone: 'ok', detail: 'Stash at 192.168.1.5' })
    ctx.ui.status({ text: 'Odd', tone: 'purple' as any })
    expect(info().note?.tone).toBe('neutral')
    ctx.ui.status(null)
    expect(info().note).toBeNull()
    ctx.ui.status({ text: 'Syncing', tone: 'busy' })
    stop!()
    expect(info().note).toBeNull()
  })

  it('reads every axis, with player or device', async () => {
    axisOutput.R2 = 0.25
    const none = (await contextWith([])).ctx
    expect(() => none.motion.axes()).toThrow(/"player" or the "device"/)
    const ctx = (await contextWith(['player'])).ctx
    expect(ctx.motion.axes().R2).toBe(0.25)
  })

  it('supplies heart rate, and stops when switched off', async () => {
    const none = (await contextWith([])).ctx
    expect(() => none.heart.reading()).toThrow(/"heart"/)
    const { ctx } = await contextWith(['heart'])
    const seen: number[] = []
    ctx.heart.onReading(r => seen.push(r.bpm))
    const src = ctx.heart.provide('Watch')
    expect(src.push(10)).toBe(false)
    for (let i = 0; i < 5; i++)
      expect(src.push(72)).toBe(true)
    expect(ctx.heart.reading()?.source).toBe('Watch')
    expect(seen.length).toBeGreaterThan(0)
    stop!()
    stop = null
    expect(heartReading()).toBeNull()
    expect(src.push(72)).toBe(false)
  })
})
