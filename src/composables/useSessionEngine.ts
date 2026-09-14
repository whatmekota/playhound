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

/**
 * Arc shape.
 *
 * `smooth` is the original meditation curve: one rise, one fall.
 *
 * `edged` repeats build -> peak with a partial retreat between passes, each
 * pass reaching a little higher than the last. Nothing about entrainment
 * produces that shape; it is a pacing structure, and pacing is the part of
 * this stack that actually does something.
 */
export type SessionArc = 'smooth' | 'edged'

export interface EdgeConfig {
  /** How many build -> peak passes before the session winds down. */
  cycles: number
  /** How far intensity falls back between passes, 0-1 of the gap to entry. */
  retreat: number
  /** How much higher each successive pass reaches, added to intensity. */
  climb: number
  /** Seconds held at the top of each pass. */
  holdSeconds: [number, number]
}

const DEFAULT_EDGE: EdgeConfig = {
  cycles: 3,
  retreat: 0.45,
  climb: 0.06,
  holdSeconds: [25, 55],
}

// Singleton session state
let arc: SessionArc = 'smooth'
let edgeCfg: EdgeConfig = { ...DEFAULT_EDGE }
let edgePass = 0
let edgeBoost = 0
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
    if (!listeners.has(event))
      listeners.set(event, new Set())
    listeners.get(event)!.add(fn)
    return () => listeners.get(event)?.delete(fn)
  }

  function emit(event: string, data?: any) {
    listeners.get(event)?.forEach(fn => fn(data))
  }

  function applyPhaseConfig(ph: SessionPhase) {
    const cfg = PHASE_CONFIG[ph]

    // While the script is driving, it owns beat and intensity — the phase
    // engine morphing on its own 8-second schedule would simply override it,
    // which looks exactly like the script having no effect. The engine still
    // owns the noise bed, the visual LFO and phase progression.
    const scriptOwnsBeat = store.scriptDrive.value
    const scriptOwnsIntensity = scriptOwnsBeat && store.scriptDriveIntensity.value

    if (!scriptOwnsIntensity) {
      // Each edged pass reaches a little higher than the last.
      store.intensity.value = Math.min(1, cfg.intensity + edgeBoost)
    }

    // Pick a target delta in the phase's beat range
    const targetDelta = cfg.beatRange[0] + Math.random() * (cfg.beatRange[1] - cfg.beatRange[0])

    if (scriptOwnsBeat) {
      // leave the beat to useScriptPulse
    }
    else if (store.isPlaying.value) {
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
    emit('intensityChange', { intensity: store.intensity.value })
    emit('beatChange', { delta: targetDelta })
  }

  function animateStoreValue(from: number, to: number, durationMs: number) {
    const startTime = Date.now()
    function frame() {
      const t = Math.min(1, (Date.now() - startTime) / durationMs)
      const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
      store.beatDelta.value = from + (to - from) * eased
      if (t < 1)
        requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  }

  /**
   * Ease intensity back down without leaving the peak phase, then climb again.
   * This hold-and-retreat is what the smooth arc has no equivalent for.
   */
  function runEdgeRetreat(onDone: () => void) {
    const peak = PHASE_CONFIG.peak.intensity + edgeBoost
    const floor = PHASE_CONFIG.entry.intensity
    const target = Math.max(floor, peak - (peak - floor) * edgeCfg.retreat)
    const from = store.intensity.value
    const durationMs = variantDelay(9000, 0.25)
    const startTime = Date.now()

    emit('edgeRetreat', { pass: edgePass, from, to: target })

    function frame() {
      if (!sessionRunning)
        return
      const p = Math.min(1, (Date.now() - startTime) / durationMs)
      const eased = 1 - (1 - p) ** 3
      store.intensity.value = from + (target - from) * eased
      if (p < 1)
        requestAnimationFrame(frame)
      else
        onDone()
    }
    requestAnimationFrame(frame)
  }

  function scheduleEdgedPeak() {
    if (!sessionRunning)
      return
    const [lo, hi] = edgeCfg.holdSeconds
    const hold = (lo + Math.random() * (hi - lo)) * 1000

    emit('edgeHold', { pass: edgePass, seconds: hold / 1000 })

    phaseTimer = window.setTimeout(() => {
      if (!sessionRunning)
        return
      edgePass += 1

      if (edgePass >= edgeCfg.cycles) {
        store.phase.value = 'descent'
        edgeBoost = 0
        applyPhaseConfig('descent')
        const d = PHASE_CONFIG.descent
        const dur = variantDelay((d.durationRange[0] + d.durationRange[1]) / 2, 0.2)
        phaseTimer = window.setTimeout(() => {
          if (!sessionRunning)
            return
          store.phase.value = 'idle'
          store.sessionActive.value = false
          sessionRunning = false
          stopDrift()
          store.intensity.value = 0
          emit('sessionEnd', {})
        }, dur * 1000)
        return
      }

      edgeBoost = Math.min(0.12, edgeBoost + edgeCfg.climb)
      runEdgeRetreat(() => {
        if (!sessionRunning)
          return
        store.phase.value = 'build'
        applyPhaseConfig('build')
        const cfg = PHASE_CONFIG.build
        const dur = variantDelay((cfg.durationRange[0] + cfg.durationRange[1]) / 2, 0.25)
        phaseTimer = window.setTimeout(() => {
          if (!sessionRunning)
            return
          store.phase.value = 'peak'
          applyPhaseConfig('peak')
          scheduleEdgedPeak()
        }, dur * 1000)
      })
    }, hold)
  }

  function scheduleNextPhase(phaseIdx: number) {
    if (!sessionRunning)
      return

    // In the edged arc the peak is a loop, not a waypoint.
    if (arc === 'edged' && PHASE_ORDER[phaseIdx] === 'peak') {
      scheduleEdgedPeak()
      return
    }

    const nextIdx = phaseIdx + 1

    if (nextIdx >= PHASE_ORDER.length) {
      edgeBoost = 0
      store.phase.value = 'idle'
      store.sessionActive.value = false
      sessionRunning = false
      stopDrift()
      // Settle intensity so nothing downstream keeps running off a stale value.
      store.intensity.value = 0
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
    edgePass = 0
    edgeBoost = 0
    sessionRunning = true
    store.sessionActive.value = true
    store.phase.value = 'entry'
    applyPhaseConfig('entry')

    const entryCfg = PHASE_CONFIG.entry
    const entryDuration = variantDelay((entryCfg.durationRange[0] + entryCfg.durationRange[1]) / 2, 0.2)

    phaseTimer = window.setTimeout(() => {
      scheduleNextPhase(0)
    }, entryDuration * 1000)

    if (store.driftMode.value)
      startDrift()

    emit('sessionStart', { phase: 'entry' })
  }

  function stopSession() {
    sessionRunning = false
    store.sessionActive.value = false
    if (phaseTimer !== null) { clearTimeout(phaseTimer); phaseTimer = null }
    stopDrift()
    store.intensity.value = 0
    store.phase.value = 'idle'
    emit('sessionStop', {})
  }

  function startDrift() {
    stopDrift()

    function driftTick() {
      if (!sessionRunning || !store.driftMode.value)
        return

      const currentDelta = store.beatDelta.value
      const variation = (Math.random() * 2 - 1) * 0.35
      const newDelta = Math.max(0.5, Math.min(40, currentDelta + variation))

      if (store.scriptDrive.value) {
        // The script sets the beat; drifting it as well just fights.
      }
      else if (store.isPlaying.value) {
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
    if (!sessionRunning)
      return
    const idx = PHASE_ORDER.indexOf(targetPhase)
    if (idx < 0)
      return
    if (phaseTimer !== null) { clearTimeout(phaseTimer); phaseTimer = null }
    store.phase.value = targetPhase
    applyPhaseConfig(targetPhase)
    scheduleNextPhase(idx)
  }

  function setArc(next: SessionArc, cfg?: Partial<EdgeConfig>) {
    arc = next
    edgeCfg = { ...DEFAULT_EDGE, ...cfg }
  }

  function getArc(): { arc: SessionArc, cfg: EdgeConfig, pass: number } {
    return { arc, cfg: edgeCfg, pass: edgePass }
  }

  return {
    on,
    emit,
    variantDelay,
    startSession,
    stopSession,
    startDrift,
    stopDrift,
    jumpToPhase,
    setArc,
    getArc,
  }
}
