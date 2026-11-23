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
const { usePlayerStore } = await import('../src/stores/playerStore')
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
    expect(vidmeta.get('clip.mp4')).toEqual({ tags: ['x'], scriptTweaks: { L0: {
      min: 20,
      max: 80,
      invert: false,
      speedCap: 0,
      smooth: 'off',
      smoothAbove: 0,
      strokes: 'as-is',
      humanise: 'off',
      repeatFromMs: 0,
      repeatToMs: 0,
      plays: '',
      offsetMs: 0,
    } } })

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

  it('an axis can play another loaded axis\'s script, with its own tweaks on top', async () => {
    const ROLL = [{ at: 0, pos: 0.2 }, { at: 400, pos: 0.6 }, { at: 800, pos: 0.2 }]
    const store = useScriptStore()
    await store.useTweaksFor('clip.mp4', false)
    store.setScripts([file(STROKES), file(ROLL, { channel: 'R1' })])
    store.setTweaks('L0', { plays: 'R1', invert: true })
    expect(store.scripts[0].parsed.actions.map(a => a.pos)).toEqual([0.8, 0.4, 0.8])
    // Its own file is untouched, and the other axis plays as before.
    expect(sourceOf(store.scripts[0]).actions).toEqual(STROKES)
    expect(store.scripts[1].parsed.actions).toEqual(ROLL)
    // Playing each other's scripts swaps them: each takes the other's as written.
    store.setTweaks('R1', { plays: 'L0' })
    expect(store.scripts[1].parsed.actions).toEqual(STROKES)
    expect(store.scripts[0].parsed.actions.map(a => a.pos)).toEqual([0.8, 0.4, 0.8])
    // An edit of the other axis reaches this one.
    store.setSourceActions(store.scripts[1], [{ at: 0, pos: 0.5 }, { at: 400, pos: 1 }])
    expect(store.scripts[0].parsed.actions.map(a => a.pos)).toEqual([0.5, 0])
    // Itself: nothing to play. Not loaded on another video: its own script.
    store.setTweaks('L0', { plays: 'L0', invert: false })
    expect(store.isTweaked('L0')).toBe(false)
    store.setTweaks('L0', { plays: 'R2' })
    expect(store.scripts[0].parsed.actions).toEqual(STROKES)
  })

  it('a repeated stretch reaches the video\'s end once its length is known', async () => {
    const store = useScriptStore()
    const player = usePlayerStore()
    await store.useTweaksFor('clip.mp4', false)
    store.setScripts([file([...STROKES, { at: 1500, pos: 1 }, { at: 2000, pos: 0 }])])
    store.setTweaks('L0', { repeatFromMs: 0, repeatToMs: 1000 })
    expect(store.scripts[0].parsed.duration).toBe(2000)
    expect(store.awaitingLength).toBe(true)
    player.videoDuration = 5
    await nextTick()
    expect(store.scripts[0].parsed.duration).toBe(5000)
    expect(store.awaitingLength).toBe(false)
    expect(store.scripts[0].parsed.actions.filter(a => a.at % 1000 === 0).every(a => a.pos === 0)).toBe(true)
  })

  it('humanises the same way every time for a video and axis, differently for another video', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ at: i * 400, pos: i % 2 ? 0.9 : 0.1 }))
    const store = useScriptStore()
    const playedOn = async (video: string) => {
      await store.useTweaksFor(video, false)
      store.setScripts([file(many)])
      store.setTweaks('L0', { humanise: 'medium' })
      return store.scripts[0].parsed.actions.map(a => ({ ...a }))
    }
    const a = await playedOn('a.mp4')
    expect(a).not.toEqual(many)
    expect(await playedOn('a.mp4')).toEqual(a)
    expect(await playedOn('b.mp4')).not.toEqual(a)
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
