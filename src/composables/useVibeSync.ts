import type { ButtplugClientDevice } from 'buttplug'
import type { SendGate, VibeSource } from '~/lib/vibeMap'
import { computed, effectScope, ref, watch } from 'vue'
import { interpolatePosition } from '~/lib/funscriptParser'
import { clampLatency } from '~/lib/latency'
import { localSpeed, mapVibe, musicLevel, quantize, shouldSend, smoothLevel, speedToLevel } from '~/lib/vibeMap'
import { useAudioStore } from '~/stores/audio'
import { useMotionStore } from '~/stores/motionStore'
import { usePlayerStore } from '~/stores/playerStore'
import { useSafetyStore } from '~/stores/safetyStore'
import { useScriptStore } from '~/stores/scriptStore'
import { useSessionControlStore } from '~/stores/sessionControlStore'
import { useButtplug } from './useButtplug'
import { axisOutput } from './useTCode'
import { getBeatGrid } from './useVideoBeat'
import { useDeviceLatency } from './useVideoSync'

/**
 * Drives Buttplug vibrators (and rotators, oscillators) from the session.
 *
 * Each toy follows the source picked for it in the Device panel — script
 * speed by default — through its own range and curve, scaled last by the
 * session's effective intensity so the knob and an edge reach it like they
 * reach everything else. Runs beside the serial OSR: that one takes the
 * script's positions, these take how hard.
 *
 * Mounted once by the shell; loops only while Intiface is connected, output
 * is on and at least one toy can take a strength.
 */

/** How often levels are worked out. Sending is rate-limited separately. */
const TICK_MS = 50

let started = false
const running = ref(false)

/** The playing <video>, for a playhead finer than timeupdate's four a second. */
function findVideo(src: string | null): HTMLVideoElement | null {
  const all = Array.from(document.querySelectorAll('video'))
  return (src ? all.find(v => v.src === src) : null) ?? null
}

export function useVibeSync() {
  if (!started) {
    started = true
    effectScope(true).run(setup)
  }
  return { running }
}

function setup() {
  const bp = useButtplug()
  const player = usePlayerStore()
  const scripts = useScriptStore()
  const audio = useAudioStore()
  const motion = useMotionStore()
  const safety = useSafetyStore()
  const session = useSessionControlStore()
  const latencyMs = useDeviceLatency()

  const active = computed(() => bp.connected.value && bp.enabled.value && bp.strengthToys.value.length > 0)

  /** The stroke script: L0 when there is one, else whatever is primary. */
  const stroke = computed(() =>
    scripts.activeScripts.find(s => s.channel === 'L0') ?? scripts.primaryScript ?? null)

  let video: HTMLVideoElement | null = null
  function playheadMs(): number {
    if (!video?.isConnected || video.src !== player.videoUrl)
      video = findVideo(player.videoUrl)
    const t = video ? video.currentTime : player.currentTime
    return t * 1000
  }

  /** Script time at the playhead, with the same offset and latency the OSR gets. */
  function scriptTimeMs(): number | null {
    const s = stroke.value
    if (!s || !s.parsed.actions.length)
      return null
    const speed = video?.playbackRate || player.playbackSpeed || 1
    return playheadMs() + (s.offsetMs ?? 0) + clampLatency(latencyMs.value) * speed
  }

  /**
   * One source's level, 0–1, or null when it has stopped (paused, nothing
   * loaded, session off) — null snaps the toy off rather than easing down.
   */
  function sample(source: VibeSource): number | null {
    switch (source) {
      case 'script-speed':
      case 'script-position': {
        if (!player.isPlaying)
          return null
        const t = scriptTimeMs()
        const actions = stroke.value?.parsed.actions
        if (t === null || !actions)
          return null
        return source === 'script-speed'
          ? speedToLevel(localSpeed(actions, t))
          : interpolatePosition(actions, t)
      }
      case 'music': {
        if (!player.isPlaying)
          return null
        const g = getBeatGrid()
        return g ? musicLevel(g.energy, g.beats - Math.floor(g.beats)) : null
      }
      case 'session':
        return audio.sessionActive.value || audio.isPlaying.value ? audio.intensity.value : null
      case 'motion':
        return motion.running ? (axisOutput.L0 ?? null) : null
      default:
        return null
    }
  }

  const state = new Map<number, { smooth: number, gate: SendGate }>()
  let timer: ReturnType<typeof setInterval> | null = null
  let lastTick = 0

  function send(d: ButtplugClientDevice, v: number, now: number) {
    const st = state.get(d.index)
    if (st)
      st.gate = { value: v, at: now }
    void bp.sendStrength(d, v).catch(() => {})
  }

  function tick() {
    const now = performance.now()
    const dt = lastTick ? Math.min(250, now - lastTick) : TICK_MS
    lastTick = now
    const intensity = session.effectiveIntensity
    const cache = new Map<VibeSource, number | null>()

    for (const d of bp.strengthToys.value) {
      const cfg = bp.vibeFor(d)
      let st = state.get(d.index)
      if (!st) {
        st = { smooth: 0, gate: { value: null, at: 0 } }
        state.set(d.index, st)
      }

      let level: number | null = null
      if (!safety.panicked) {
        if (!cache.has(cfg.source))
          cache.set(cfg.source, sample(cfg.source))
        level = cache.get(cfg.source) ?? null
      }

      if (level === null) {
        st.smooth = 0
      }
      else {
        const target = mapVibe(level, cfg, intensity)
        st.smooth = smoothLevel(st.smooth, target, dt)
      }

      let out = quantize(st.smooth)
      if (out < 0.01)
        out = 0
      if (shouldSend(st.gate, out, now))
        send(d, out, now)
    }
  }

  function stopToys() {
    const now = performance.now()
    for (const d of bp.strengthToys.value) {
      const st = state.get(d.index)
      if (st)
        st.smooth = 0
      send(d, 0, now)
    }
  }

  function start() {
    if (timer !== null)
      return
    lastTick = 0
    timer = setInterval(tick, TICK_MS)
    running.value = true
  }

  function stop() {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
    if (running.value && bp.connected.value)
      stopToys()
    state.clear()
    running.value = false
  }

  watch(active, on => (on ? start() : stop()), { immediate: true })

  // Panic should not wait for the next tick or the rate limit.
  watch(() => safety.panicked, (p) => {
    if (p && running.value)
      stopToys()
  })

  // A toy that went away and came back gets a fresh index; forget the old one.
  watch(() => bp.strengthToys.value.map(d => d.index), (ids) => {
    for (const k of state.keys()) {
      if (!ids.includes(k))
        state.delete(k)
    }
  })
}
