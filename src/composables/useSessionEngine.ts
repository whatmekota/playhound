import type { SessionPhase } from '~/stores/audio'
import { useAudioStore } from '~/stores/audio'
import { useBinauralBeats } from './useBinauralBeats'
import { useLFO } from './useLFO'

type EventHandler = (data?: any) => void

// Phase definitions: each phase drives beat, noise and visual intensity
const PHASE_CONFIG: Record<SessionPhase, {
  beatRange: [number, number]
  noiseLevel: number
  intensity: number
  durationRange: [number, number] // seconds
}> = {
  idle: { beatRange: [6, 6], noiseLevel: 0.15, intensity: 0.5, durationRange: [0, 0] },
  entry: { beatRange: [10, 13], noiseLevel: 0.12, intensity: 0.35, durationRange: [60, 90] },
  build: { beatRange: [6, 10], noiseLevel: 0.22, intensity: 0.6, durationRange: [90, 150] },
  peak: { beatRange: [3, 6], noiseLevel: 0.4, intensity: 0.85, durationRange: [120, 180] },
  descent: { beatRange: [1.5, 3], noiseLevel: 0.18, intensity: 0.28, durationRange: [60, 120] },
}

const PHASE_ORDER: SessionPhase[] = ['entry', 'build', 'peak', 'descent']

// Singleton session state
const listeners = new Map<string, Set<EventHandler>>()
let phaseTimer: number | null = null
let driftTimer: number | null = null
let sessionRunning = false

function variantDelay(base: number, variance = 0.2): number {
  return base * (1 + (Math.random() * 2 - 1) * variance)
}

export function useSessionEngine() {
  const store = useAudioStore()
  const binaural = useBinauralBeats()
  const lfo = useLFO()

  function on(event: string, fn: EventHandler): () => void {
    if (!listeners.has(event)) listeners.set(event, new Set())
    listeners.get(event)!.add(fn)
    return () => listeners.get(event)?.delete(fn)
  }

  function emit(event: string, data?: any) {
    listeners.get(event)?.forEach(fn => fn(data))
  }

  function applyPhaseConfig(ph: SessionPhase) {
    const cfg = PHASE_CONFIG[ph]
    store.intensity.value = cfg.intensity

    // Pick a target delta in the phase's beat range
    const targetDelta = cfg.beatRange[0] + Math.random() * (cfg.beatRange[1] - cfg.beatRange[0])

    if (store.isPlaying.value) {
      binaural.morphTo(store.baseFrequency.value, targetDelta, variantDelay(8, 0.25))
      // Mirror store value through an animation frame loop for UI display
      animateStoreValue(store.beatDelta.value, targetDelta, 8000)
    }
    else {
      store.beatDelta.value = targetDelta
    }

    if (store.noiseEnabled.value && store.isPlaying.value) {
      binaural.setNoiseVolume(cfg.noiseLevel)
      store.noiseVolume.value = cfg.noiseLevel
    }

    // Sync LFO intensity to visual intensity
    lfo.config.zoomDepth = 0.015 + cfg.intensity * 0.04
    lfo.config.opacityDepth = 0.04 + cfg.intensity * 0.06
    lfo.config.panDepth = 3 + cfg.intensity * 8

    emit('phaseChange', { phase: ph, config: cfg })
    emit('intensityChange', { intensity: cfg.intensity })
    emit('beatChange', { delta: targetDelta })
  }

  function animateStoreValue(from: number, to: number, durationMs: number) {
    const startTime = Date.now()
    function frame() {
      const t = Math.min(1, (Date.now() - startTime) / durationMs)
      const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
      store.beatDelta.value = from + (to - from) * eased
      if (t < 1) requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  }

  function scheduleNextPhase(phaseIdx: number) {
    if (!sessionRunning) return
    const nextIdx = phaseIdx + 1

    if (nextIdx >= PHASE_ORDER.length) {
      store.phase.value = 'idle'
      store.sessionActive.value = false
      sessionRunning = false
      stopDrift()
      emit('sessionEnd', {})
      return
    }

    const nextPhase = PHASE_ORDER[nextIdx]
    const cfg = PHASE_CONFIG[nextPhase]
    const baseDuration = (cfg.durationRange[0] + cfg.durationRange[1]) / 2
    const duration = variantDelay(baseDuration, 0.2)

    phaseTimer = window.setTimeout(() => {
      store.phase.value = nextPhase
      applyPhaseConfig(nextPhase)
      scheduleNextPhase(nextIdx)
    }, duration * 1000)
  }

  function startSession() {
    stopSession()
    sessionRunning = true
    store.sessionActive.value = true
    store.phase.value = 'entry'
    applyPhaseConfig('entry')

    const entryCfg = PHASE_CONFIG.entry
    const entryDuration = variantDelay((entryCfg.durationRange[0] + entryCfg.durationRange[1]) / 2, 0.2)

    phaseTimer = window.setTimeout(() => {
      scheduleNextPhase(0)
    }, entryDuration * 1000)

    if (store.driftMode.value) startDrift()

    emit('sessionStart', { phase: 'entry' })
  }

  function stopSession() {
    sessionRunning = false
    store.sessionActive.value = false
    if (phaseTimer !== null) { clearTimeout(phaseTimer); phaseTimer = null }
    stopDrift()
    store.phase.value = 'idle'
    emit('sessionStop', {})
  }

  function startDrift() {
    stopDrift()

    function driftTick() {
      if (!sessionRunning || !store.driftMode.value) return

      const currentDelta = store.beatDelta.value
      const variation = (Math.random() * 2 - 1) * 0.35
      const newDelta = Math.max(0.5, Math.min(40, currentDelta + variation))

      if (store.isPlaying.value) {
        binaural.morphTo(store.baseFrequency.value, newDelta, variantDelay(4, 0.3))
        animateStoreValue(currentDelta, newDelta, variantDelay(4000, 0.3))
      }

      emit('beatChange', { delta: newDelta })

      driftTimer = window.setTimeout(driftTick, variantDelay(4000, 0.4))
    }

    driftTimer = window.setTimeout(driftTick, variantDelay(3000, 0.5))
  }

  function stopDrift() {
    if (driftTimer !== null) { clearTimeout(driftTimer); driftTimer = null }
  }

  function jumpToPhase(targetPhase: SessionPhase) {
    if (!sessionRunning) return
    const idx = PHASE_ORDER.indexOf(targetPhase)
    if (idx < 0) return
    if (phaseTimer !== null) { clearTimeout(phaseTimer); phaseTimer = null }
    store.phase.value = targetPhase
    applyPhaseConfig(targetPhase)
    scheduleNextPhase(idx)
  }

  return { on, emit, variantDelay, startSession, stopSession, startDrift, stopDrift, jumpToPhase }
}
