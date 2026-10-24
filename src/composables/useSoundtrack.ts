import type { AnalysedGrid, SoundtrackAnalysis } from '~/lib/beatTrack'
import type { ParsedAxis } from '~/lib/funscriptParser'
import type { SoundtrackFailure } from '~/lib/soundtrack'
import { computed, effectScope, markRaw, reactive, ref, shallowReactive, shallowRef, toRaw, watch } from 'vue'
import { createAnalysedGrid } from '~/lib/beatTrack'
import { musicFunscript, musicScript } from '~/lib/musicScript'
import {
  analyseInWorker,
  cachedAnalysis,
  decodeSoundtrack,
  FAILURE_TEXT,
  SoundtrackError,
  soundtrackKey,
  storeAnalysis,
} from '~/lib/soundtrack'
import { useDeviceStore } from '~/stores/deviceStore'
import { useMotionStore } from '~/stores/motionStore'
import { usePlaybackStore } from '~/stores/playbackStore'
import { usePlayerStore } from '~/stores/playerStore'
import { useScriptStore } from '~/stores/scriptStore'
import { useFunscript } from './useFunscript'
import { toast } from './useToast'

export type SoundtrackStatus = 'idle' | 'decoding' | 'analysing' | 'ready' | 'failed'

export interface SoundtrackState {
  status: SoundtrackStatus
  /** 0–1 while analysing; decoding has no measurable progress. */
  progress: number
  error: string | null
  reason: SoundtrackFailure | null
  analysis: SoundtrackAnalysis | null
}

// ─── Module state: one per app, whoever asks ─────────────────────────────────

const states = shallowReactive(new Map<string, SoundtrackState>())
const pending = new Map<string, Promise<SoundtrackAnalysis | null>>()
// Decoding holds a whole video in memory; never two at once.
let chain: Promise<unknown> = Promise.resolve()

let grid: AnalysedGrid | null = null
const gridReady = ref(false)

/** Options for a script made from the music that have no home in the motion store. Session-only. */
const scriptOptions = reactive({ centreRange: 0.5, restInGaps: true })
const making = ref(false)
const generated = shallowRef<{ key: string, filename: string, json: string, parsed: ParsedAxis | null } | null>(null)

function stateOf(key: string): SoundtrackState {
  let s = states.get(key)
  if (!s) {
    s = reactive({ status: 'idle', progress: 0, error: null, reason: null, analysis: null }) as SoundtrackState
    states.set(key, s)
  }
  return s
}

function setReady(s: SoundtrackState, a: SoundtrackAnalysis) {
  // Thousands of numbers that never change: no need for them to be reactive.
  s.analysis = markRaw(a)
  s.status = 'ready'
  s.progress = 1
  s.error = null
  s.reason = null
}

/**
 * Analyse a video's soundtrack, from the cache when it can be.
 * Resolves to null on failure; the state says why.
 */
export function analyseSoundtrack(file: File, opts: { durationHint?: number } = {}): Promise<SoundtrackAnalysis | null> {
  const key = soundtrackKey(file)
  const st = stateOf(key)
  if (st.status === 'ready' && st.analysis)
    return Promise.resolve(st.analysis)
  const running = pending.get(key)
  if (running)
    return running

  const job = (async () => {
    const cached = await cachedAnalysis(key)
    if (cached) {
      setReady(st, cached)
      return cached
    }
    st.status = 'decoding'
    st.progress = 0
    st.error = null
    st.reason = null
    const run = chain.then(async () => {
      const { samples, sampleRate } = await decodeSoundtrack(file, opts)
      st.status = 'analysing'
      const a = await analyseInWorker(samples, sampleRate, (p) => {
        st.progress = p
      })
      void storeAnalysis(key, a)
      return a
    })
    chain = run.catch(() => {})
    try {
      const a = await run
      setReady(st, a)
      return a
    }
    catch (err) {
      st.status = 'failed'
      st.reason = err instanceof SoundtrackError ? err.reason : 'failed'
      st.error = err instanceof SoundtrackError ? err.message : FAILURE_TEXT.failed
      console.warn('Soundtrack analysis failed:', file.name, err)
      return null
    }
  })()
  pending.set(key, job)
  void job.finally(() => pending.delete(key))
  return job
}

/** The analysed beat grid for the playing video, or null. Cheap: call it every frame. */
export function getAnalysedGrid(): AnalysedGrid | null {
  return grid
}

/** Reactive: whether the playing video has an analysed beat grid. */
export function isAnalysedGridReady(): boolean {
  return gridReady.value
}

// ─── Wiring, installed once ──────────────────────────────────────────────────

let installed: ReturnType<typeof install> | null = null

function install() {
  const playback = usePlaybackStore()
  const player = usePlayerStore()
  const motion = useMotionStore()
  const scripts = useScriptStore()
  const device = useDeviceStore()
  const { loadScriptFiles } = useFunscript()

  const currentKey = computed(() => (playback.currentFile ? soundtrackKey(playback.currentFile) : null))
  const current = computed<SoundtrackState | null>(() => (currentKey.value ? states.get(currentKey.value) ?? null : null))
  const analysis = computed(() => (current.value?.status === 'ready' ? current.value.analysis : null))

  // The grid follows the playing video's analysis.
  watch(analysis, (a) => {
    grid = a ? createAnalysedGrid(a) : null
    gridReady.value = !!grid
  }, { immediate: true })

  // A cached analysis is free, so pick it up for every video.
  watch(currentKey, async (key) => {
    generated.value = null
    if (!key)
      return
    const st = stateOf(key)
    if (st.status !== 'idle')
      return
    const a = await cachedAnalysis(key)
    if (a && st.status === 'idle')
      setReady(st, a)
  }, { immediate: true })

  // Analyse on its own only when it is the thing being asked for: the Music
  // source chosen and an unscripted video playing. A script describes what
  // should happen better than any beat does.
  watch(
    () => [motion.source === 'music', player.isPlaying, scripts.hasScripts, currentKey.value] as const,
    ([music, playing, scripted, key]) => {
      if (!music || !playing || scripted || !key || !playback.currentFile)
        return
      if (stateOf(key).status !== 'idle')
        return
      void analyseSoundtrack(playback.currentFile, { durationHint: player.videoDuration })
    },
    { immediate: true },
  )

  const canAnalyse = computed(() => !!playback.currentFile)

  async function analyseCurrent(): Promise<SoundtrackAnalysis | null> {
    const file = playback.currentFile
    if (!file)
      return null
    const st = stateOf(soundtrackKey(file))
    // An explicit request retries a failure.
    if (st.status === 'failed')
      st.status = 'idle'
    const a = await analyseSoundtrack(file, { durationHint: player.videoDuration })
    if (!a)
      toast.error('Could not analyse the soundtrack', { detail: st.error ?? undefined, key: 'soundtrack' })
    return a
  }

  /** Write a funscript from the music and load it as the L0 script. */
  async function makeScript(): Promise<boolean> {
    const file = playback.currentFile
    if (!file || making.value)
      return false
    const key = soundtrackKey(file)
    making.value = true
    try {
      const a = await analyseCurrent()
      if (!a || currentKey.value !== key)
        return false
      if (a.beats.length < 8) {
        toast.warn('No beat to follow', { detail: 'The soundtrack has no steady rhythm to script from.', key: 'soundtrack' })
        return false
      }
      const actions = musicScript(a, {
        bandLo: motion.beatBandLo,
        bandHi: motion.beatBandHi,
        maxSpm: motion.maxSpm,
        minDepth: motion.minDepth,
        maxDepth: motion.maxDepth,
        centre: motion.center,
        centreRange: scriptOptions.centreRange,
        restInGaps: scriptOptions.restInGaps,
      })
      const base = file.name.replace(/\.[^.]+$/, '')
      const json = JSON.stringify(musicFunscript(actions, { title: base, bpm: a.bpm, duration: a.duration }))
      const script = new File([json], `${base}.funscript`, { type: 'application/json' })
      // Through the same path as a hand-picked file, so the timeline,
      // heatmap, chapters and device sync treat it like any other script.
      const results = await loadScriptFiles([script], base)
      if (!results.length)
        return false
      generated.value = { key, filename: script.name, json, parsed: toRaw(results[0].parsed) }
      if (device.axisConfigs.L0)
        device.axisConfigs.L0.enabled = true
      toast.success('Script made from the music', {
        detail: `${actions.length.toLocaleString()} actions at ${Math.round(a.bpm)} bpm. Save it to keep it.`,
        icon: 'i-carbon-music',
        key: 'soundtrack',
      })
      return true
    }
    finally {
      making.value = false
    }
  }

  /** Whether the loaded script is the one made from the music. */
  const generatedLoaded = computed(() => {
    const g = generated.value
    return !!g?.parsed && scripts.scripts.some(s => toRaw(s.parsed) === g.parsed)
  })

  function saveScript() {
    const g = generated.value
    if (!g)
      return
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([g.json], { type: 'application/json' }))
    a.download = g.filename
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }

  return {
    current,
    analysis,
    canAnalyse,
    analyseCurrent,
    makeScript,
    saveScript,
    making,
    generated,
    generatedLoaded,
    scriptOptions,
  }
}

/**
 * Whole-track soundtrack analysis for the playing video, and scripts made
 * from it. Shared state: every caller sees the same thing.
 */
export function useSoundtrack() {
  if (!installed) {
    // Detached so the watchers outlive whichever component asked first.
    installed = effectScope(true).run(install)!
  }
  return installed
}
