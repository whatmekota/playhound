import { useLocalStorage } from '@vueuse/core'
/**
 * In-the-moment control over a session: the edge button and the intensity knob.
 *
 * Everything that produces stimulation reads from here — script playback, the
 * motion generator, vibrators, sound and visuals — and everything that can ask
 * for a change writes here: the keyboard, the gamepad, the phone remote, a
 * heart-rate guard, a programme. Keeping it in one small store is what lets
 * those be built independently and still agree.
 *
 * Two outputs matter to consumers:
 *
 * - `holdBack` (0–1): how much to back off right now because of an edge. 1 is
 *   "almost nothing", 0 is normal. It rises fast when an edge is called, holds
 *   through the cooldown, then eases back over the rebuild.
 * - `intensityScale` (0.1–1): the user's knob. Scripts are compressed and
 *   slowed by it, generated motion and vibration are scaled by it.
 *
 * `effectiveIntensity` combines the two for consumers that only want one
 * number. The dynamics (rise, hold, rebuild) live in src/lib/edging.ts so they
 * can be tested without a clock.
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { createEdgeEnvelope } from '~/lib/edging'
import { KEYS } from '~/lib/persist'

export type EdgeSource = 'key' | 'gamepad' | 'remote' | 'heart' | 'programme' | 'ui'

export interface EdgeEvent {
  /** Wall clock, ms. */
  at: number
  /** Where in the video it happened, seconds, when a video was playing. */
  videoTime: number | null
  videoName: string | null
  source: EdgeSource
}

export interface EdgeSettings {
  /** Seconds to hold right back after an edge is called. */
  cooldownSec: number
  /** Seconds to ease back up to normal afterwards. */
  rebuildSec: number
  /** How far down an edge takes things: 0.85 leaves 15%. */
  depth: number
}

const DEFAULT_EDGE: EdgeSettings = { cooldownSec: 20, rebuildSec: 25, depth: 0.85 }

export const useSessionControlStore = defineStore('sessionControl', () => {
  const settings = useLocalStorage<EdgeSettings>(KEYS.edgeSettings.key, { ...DEFAULT_EDGE }, { mergeDefaults: true })
  const intensityScale = useLocalStorage<number>(KEYS.intensityScale.key, 1)

  const envelope = createEdgeEnvelope()
  /** Edges called this session (since the app started or the log was cleared). */
  const edges = ref<EdgeEvent[]>([])
  /** 0–1, updated by tick(). */
  const holdBack = ref(0)
  /** Which part of the edge we are in, for the UI. */
  const phase = ref<'idle' | 'falling' | 'holding' | 'rebuilding'>('idle')
  /** Seconds left in the current hold + rebuild, for a countdown. */
  const remainingSec = ref(0)

  const effectiveIntensity = computed(() =>
    Math.max(0, Math.min(1, intensityScale.value)) * (1 - holdBack.value))

  /**
   * Call an edge. Calling again while one is running restarts the hold —
   * "still close" — rather than stacking.
   */
  function edge(source: EdgeSource, ctx: { videoTime?: number | null, videoName?: string | null } = {}) {
    envelope.trigger(performance.now(), settings.value)
    edges.value.push({
      at: Date.now(),
      videoTime: ctx.videoTime ?? null,
      videoName: ctx.videoName ?? null,
      source,
    })
    tick()
  }

  /** End the hold early and start rebuilding now. */
  function release() {
    envelope.release(performance.now(), settings.value)
    tick()
  }

  /** Cancel any edge immediately (panic, stop). */
  function reset() {
    envelope.reset()
    tick()
  }

  /** Advance the envelope; the shell calls this every frame. Cheap when idle. */
  function tick(now = performance.now()) {
    const s = envelope.sample(now, settings.value)
    holdBack.value = s.holdBack
    phase.value = s.phase
    remainingSec.value = s.remainingSec
  }

  function setIntensityScale(v: number) {
    intensityScale.value = Math.max(0.1, Math.min(1, Math.round(v * 100) / 100))
  }

  function nudgeIntensity(delta: number) {
    setIntensityScale(intensityScale.value + delta)
  }

  function clearLog() {
    edges.value = []
  }

  return {
    settings,
    intensityScale,
    edges,
    holdBack,
    phase,
    remainingSec,
    effectiveIntensity,
    edge,
    release,
    reset,
    tick,
    setIntensityScale,
    nudgeIntensity,
    clearLog,
  }
})
