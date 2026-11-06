import type { ParsedAxis } from '../src/lib/funscriptParser'
import type { ScriptFile } from '../src/stores/scriptStore'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

// Saved video info, in memory.
const vidmeta = new Map<string, any>()
vi.mock('~/lib/idb', () => ({
  videoMetaDb: {
    get: async (k: string) => vidmeta.get(k),
    set: async (k: string, v: unknown) => void vidmeta.set(k, structuredClone(v)),
  },
}))

const { useScriptStore, sourceOf } = await import('../src/stores/scriptStore')
const { snapshotOf } = await import('../src/plugins/scripts')
const { analysisKey, scriptAnalysisKey } = await import('../src/composables/useScriptAnalysis')

function axis(actions: { at: number, pos: number }[], channel = 'L0'): ParsedAxis {
  return {
    channel,
    axisKey: channel === 'L0' ? 'default' : channel,
    label: channel,
    axisDef: { channel, label: channel, defaultPos: 0.5, isLinear: true },
    actions,
    filePath: 'clip.funscript',
    duration: actions.at(-1)?.at ?? 0,
  }
}

function file(actions: { at: number, pos: number }[], opts: Partial<ScriptFile> = {}): ScriptFile {
  const parsed = axis(actions, opts.channel)
  return {
    path: 'clip.funscript',
    filename: 'clip.funscript',
    channel: parsed.channel,
    axisKey: parsed.axisKey,
    label: parsed.label,
    enabled: true,
    isAlt: false,
    altName: '',
    offsetMs: 0,
    parsed,
    ...opts,
  }
}

const STROKES = [{ at: 0, pos: 0 }, { at: 500, pos: 1 }, { at: 1000, pos: 0 }]
async function flush() {
  await vi.runAllTimersAsync()
  await nextTick()
}

describe('script tweaks', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vidmeta.clear()
    vi.useFakeTimers()
  })

  it('applies a video\'s saved tweaks to scripts as they load, keeping the source', async () => {
    vidmeta.set('clip.mp4', { tags: ['x'], scriptTweaks: { L0: { invert: true, offsetMs: 120 } } })
    const store = useScriptStore()
    await store.useTweaksFor('clip.mp4', false)
    store.setAutoDetected([file(STROKES)])
    const s = store.scripts[0]
    expect(s.parsed.actions.map(a => a.pos)).toEqual([1, 0, 1])
    expect(sourceOf(s).actions.map(a => a.pos)).toEqual([0, 1, 0])
    expect(s.offsetMs).toBe(120)
    expect(s.parsed.rev).toBeGreaterThan(0)
    expect(store.isTweaked('L0')).toBe(true)
    // Plugins see what plays.
    expect(snapshotOf(store.scripts, 'clip.mp4').axes[0].actions.map(a => a.pos)).toEqual([100, 0, 100])
  })

  it('saves tweaks with the video, next to what else is saved there', async () => {
    vidmeta.set('clip.mp4', { tags: ['x'] })
    const store = useScriptStore()
    await store.useTweaksFor('clip.mp4', false)
    store.setScripts([file(STROKES)])
    store.setTweaks('L0', { min: 20, max: 80 })
    expect(store.scripts[0].parsed.actions.map(a => a.pos)).toEqual([0.2, 0.8, 0.2])
    await flush()
    expect(vidmeta.get('clip.mp4')).toEqual({ tags: ['x'], scriptTweaks: { L0: { min: 20, max: 80, invert: false, speedCap: 0, smooth: 'off', offsetMs: 0 } } })

    store.resetTweaks()
    expect(store.scripts[0].parsed).toStrictEqual(sourceOf(store.scripts[0]))
    expect(store.anyTweaked).toBe(false)
    await flush()
    expect(vidmeta.get('clip.mp4')).toEqual({ tags: ['x'] })
  })

  it('treats the offset as a tweak, and keeps every take of an axis on it', async () => {
    const store = useScriptStore()
    await store.useTweaksFor('clip.mp4', false)
    store.setScripts([file(STROKES), file(STROKES, { path: 'alt.funscript', isAlt: true, enabled: false })])
    store.scripts[0].offsetMs = 250
    await nextTick()
    expect(store.tweaksFor('L0').offsetMs).toBe(250)
    expect(store.scripts[1].offsetMs).toBe(250)
    // The shape is untouched: only the offset is set.
    expect(store.scripts[0].parsed).toStrictEqual(sourceOf(store.scripts[0]))
    await flush()
    expect(vidmeta.get('clip.mp4').scriptTweaks.L0.offsetMs).toBe(250)
  })

  it('switching videos brings that video\'s tweaks, not the last one\'s', async () => {
    vidmeta.set('a.mp4', { scriptTweaks: { L0: { invert: true } } })
    const store = useScriptStore()
    await store.useTweaksFor('a.mp4', false)
    store.setScripts([file(STROKES)])
    expect(store.isTweaked('L0')).toBe(true)
    await store.useTweaksFor('b.mp4', false)
    store.setScripts([file(STROKES)])
    expect(store.isTweaked('L0')).toBe(false)
    expect(store.scripts[0].parsed.actions[0].pos).toBe(0)
  })

  it('plays edits through the tweaks, and caches see a new version', async () => {
    const store = useScriptStore()
    await store.useTweaksFor('clip.mp4', false)
    store.setScripts([file(STROKES)])
    store.setTweaks('L0', { invert: true })
    const before = scriptAnalysisKey(store.scripts[0])
    store.setSourceActions(store.scripts[0], [{ at: 0, pos: 0.25 }, { at: 500, pos: 0.75 }, { at: 1000, pos: 0.25 }])
    const s = store.scripts[0]
    expect(s.edited).toBe(true)
    expect(s.parsed.actions.map(a => a.pos)).toEqual([0.75, 0.25, 0.75])
    // Same file, same point count: only the version tells the caches apart.
    expect(scriptAnalysisKey(s)).not.toBe(before)
    expect(analysisKey('a', 'L0', 3)).toBe(analysisKey('a', 'L0', 3, 0))
  })
})
