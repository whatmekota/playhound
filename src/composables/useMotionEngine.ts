import { computed, watch } from 'vue'
import {
  advancePhase,
  applyDepth,
  clamp,
  depthFromIntensity,
  pickBeatDivisor,
  rampToward,
  spmFromIntensity,
  strokePosition,
} from '~/lib/motionMath'
import { useAudioStore } from '~/stores/audio'
import { useMotionStore } from '~/stores/motionStore'
import { usePlayerStore } from '~/stores/playerStore'
import { useScriptStore } from '~/stores/scriptStore'
import { useBinauralBeats } from './useBinauralBeats'
import { useTCode } from './useTCode'

// ─── Singleton loop state ─────────────────────────────────────────────────────
// One engine drives the device regardless of how many panels are mounted.
let rafId: number | null = null
let lastTs: number | null = null
let phase = 0
let spm = 0
let depth = 0
let running = false

/** TCode interval hint: how long the device should take to reach the position. */
const SEND_INTERVAL_MS = 40

export function useMotionEngine() {
  const motion = useMotionStore()
  const audio = useAudioStore()
  const player = usePlayerStore()
  const script = useScriptStore()
  const { sendPosition, homeAllAxes } = useTCode()
  const { getPulseClock } = useBinauralBeats()

  /**
   * The funscript wins whenever a script is actually playing — the generator
   * must never fight useVideoSync for the same axis.
   */
  const funscriptBusy = computed(() =>
    script.activeScripts.length > 0 && player.isPlaying,
  )

  const shouldRun = computed(() =>
    motion.enabled && motion.isGenerated && !funscriptBusy.value,
  )

  /** Target strokes/min for the active source, before ramping and clamping. */
  function targetSpm(): number {
    if (motion.source === 'manual')
      return motion.manualSpm

    if (motion.source === 'beat') {
      const beat = Math.max(0.1, audio.beatDelta.value)
      const divisor = pickBeatDivisor(beat, motion.beatBandLo, motion.beatBandHi)
      motion.beatDivisor = divisor
      return (beat * 60) / divisor
    }

    if (motion.source === 'pulse') {
      // Rate comes from the audio clock; phase is taken from it directly below.
      const clock = getPulseClock()
      return clock ? clock.rateHz * 60 : 0
    }

    // session
    return spmFromIntensity(audio.intensity.value, motion.minSpm, motion.sessionMaxSpm)
  }

  /** Target depth for the active source. */
  function targetDepth(): number {
    if (motion.source === 'manual')
      return motion.manualDepth
    return depthFromIntensity(audio.intensity.value, motion.minDepth, motion.maxDepth)
  }

  function tick(ts: number) {
    if (!running)
      return

    if (lastTs === null)
      lastTs = ts
    // Clamp dt so a backgrounded tab doesn't resume with a huge phase jump.
    const dt = clamp((ts - lastTs) / 1000, 0, 0.1)
    lastTs = ts

    // Ramp toward the targets rather than snapping — this is the main
    // hardware-safety guard alongside the maxSpm ceiling.
    const wantSpm = clamp(targetSpm(), 0, motion.maxSpm)
    const wantDepth = clamp(targetDepth(), 0, 1)
    spm = rampToward(spm, wantSpm, motion.spmRampPerSec, dt)
    depth = rampToward(depth, wantDepth, motion.depthRampPerSec, dt)

    // When locked to the pulse, read the audio clock's phase rather than
    // integrating our own — that keeps the stroke genuinely in step with what
    // is being heard instead of merely at the same tempo.
    const locked = motion.source === 'pulse' ? getPulseClock() : null
    if (locked)
      phase = locked.phase * Math.PI * 2
    else
      phase = advancePhase(phase, spm, dt)

    const unit = strokePosition(phase, motion.shape)
    const pos = applyDepth(unit, motion.center, depth)

    sendPosition('L0', pos, SEND_INTERVAL_MS)

    if (motion.secondaryAxes) {
      // Offset rotations so they read as a related motion, not a copy of L0.
      const twist = applyDepth(
        strokePosition(phase * 0.5 + Math.PI / 2, 'sine'),
        0.5,
        depth * motion.secondaryDepth,
      )
      const roll = applyDepth(
        strokePosition(phase * 0.25, 'sine'),
        0.5,
        depth * motion.secondaryDepth,
      )
      sendPosition('R0', twist, SEND_INTERVAL_MS)
      sendPosition('R1', roll, SEND_INTERVAL_MS)
    }

    if (motion.vibrateFromIntensity)
      sendPosition('V0', clamp(audio.intensity.value, 0, 1), SEND_INTERVAL_MS)

    motion.currentSpm = spm
    motion.currentDepth = depth
    motion.currentPos = pos

    rafId = requestAnimationFrame(tick)
  }

  function start() {
    if (running)
      return
    running = true
    lastTs = null
    rafId = requestAnimationFrame(tick)
  }

  /**
   * Ease the depth to zero before releasing the axis, so stopping settles the
   * device instead of dropping it wherever the phase happened to be.
   */
  function stop(home = true) {
    if (!running)
      return
    running = false
    if (rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
    lastTs = null
    spm = 0
    depth = 0
    motion.currentSpm = 0
    motion.currentDepth = 0
    if (home)
      void homeAllAxes(600)
  }

  watch(shouldRun, (run) => {
    if (run)
      start()
    else
      stop()
  }, { immediate: true })

  return {
    start,
    stop,
    shouldRun,
    funscriptBusy,
    /** Exposed for tests and the panel readout. */
    state: () => ({ phase, spm, depth }),
  }
}
