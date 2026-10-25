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
import { createSubdivisionHold, pickStrokesPerBeat, steerPhase } from '~/lib/musicMotion'
import { useAudioStore } from '~/stores/audio'
import { useMotionStore } from '~/stores/motionStore'
import { usePlayerStore } from '~/stores/playerStore'
import { useScriptStore } from '~/stores/scriptStore'
import { useSessionControlStore } from '~/stores/sessionControlStore'
import { useBinauralBeats } from './useBinauralBeats'
import { useTCode } from './useTCode'
import { getBeatGrid, isBeatReady } from './useVideoBeat'

// ─── Singleton loop state ─────────────────────────────────────────────────────
// One engine drives the device regardless of how many panels are mounted.
let rafId: number | null = null
let lastTs: number | null = null
let phase = 0
let spm = 0
let depth = 0
let running = false
/** Music source: the stroke's own 0–1 phase, steered onto the beat grid. */
let musicPhase = 0
const subdivision = createSubdivisionHold()

/** TCode interval hint: how long the device should take to reach the position. */
const SEND_INTERVAL_MS = 40

const TAU = Math.PI * 2

/**
 * Musical slow-down for the music source: strokes per beat are halved rather
 * than scaled, so a held-back stroke still lands on the beat.
 */
function musicDivisor(rateFactor: number): number {
  if (rateFactor >= 0.75)
    return 1
  if (rateFactor >= 0.375)
    return 2
  if (rateFactor >= 0.1875)
    return 4
  return 8
}

/** Signed shortest distance between two 0–1 phases. */
function phaseError(from: number, to: number): number {
  const d = (to - from) % 1
  return d > 0.5 ? d - 1 : d < -0.5 ? d + 1 : d
}

export function useMotionEngine() {
  const motion = useMotionStore()
  const audio = useAudioStore()
  const player = usePlayerStore()
  const script = useScriptStore()
  const { sendPosition, homeAllAxes } = useTCode()
  const { getPulseClock } = useBinauralBeats()
  const control = useSessionControlStore()

  /**
   * The funscript wins whenever a script is actually playing — the generator
   * must never fight useVideoSync for the same axis.
   */
  const funscriptBusy = computed(() =>
    script.activeScripts.length > 0 && player.isPlaying,
  )

  /**
   * Whether the thing the chosen source derives from is actually running.
   *
   * Without this the generator keeps stroking after the session ends or the
   * audio stops: intensity and beat delta keep their last values, so `session`
   * and `beat` still resolve to a perfectly valid rate with nothing driving
   * them. Manual is the only source that stands on its own.
   */
  const sourceLive = computed(() => {
    switch (motion.source) {
      case 'manual':
        return true
      case 'session':
        return audio.sessionActive.value
      case 'beat':
        return audio.isPlaying.value
      case 'pulse':
        return audio.isPlaying.value && getPulseClock() !== null
      case 'music':
        // Needs a tempo, and the track has to be running for one to mean
        // anything. Deliberately does not require the binaural engine.
        return player.isPlaying && isBeatReady()
      default:
        return false
    }
  })

  const shouldRun = computed(() =>
    motion.enabled && motion.isGenerated && sourceLive.value && !funscriptBusy.value,
  )

  /** Target strokes/min for the active source, before ramping and clamping. */
  function targetSpm(): number {
    if (motion.source === 'manual')
      return motion.manualMode === 'direct' ? 0 : motion.manualSpm

    if (motion.source === 'beat') {
      const beat = Math.max(0.1, audio.beatDelta.value)
      const divisor = pickBeatDivisor(beat, motion.beatBandLo, motion.beatBandHi)
      motion.beatDivisor = divisor
      return (beat * 60) / divisor
    }

    if (motion.source === 'music') {
      // A musical subdivision of the tempo, chosen to sit in the band and
      // under the ceiling, and switched only on bar lines. One stroke per beat
      // put most tracks at the ceiling, where every song felt the same.
      const grid = getBeatGrid()
      if (!grid)
        return 0
      const wanted = pickStrokesPerBeat(grid.bpm, { lo: motion.beatBandLo, hi: motion.beatBandHi }, motion.maxSpm, grid.energy)
      const k = subdivision.update(grid.beats, wanted)
      motion.musicStrokesPerBeat = k
      motion.musicEnergy = grid.energy
      motion.musicConfidence = grid.confidence
      return grid.bpm * k
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
    if (motion.source === 'music') {
      // Loud passages stroke deeper, quiet ones shallower — relative to this
      // track. A shaky beat grid holds back a little until it settles.
      const grid = getBeatGrid()
      if (!grid)
        return motion.minDepth
      const d = motion.minDepth + (motion.maxDepth - motion.minDepth) * grid.energy
      return d * (0.6 + 0.4 * grid.confidence)
    }
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

    // The intensity knob and an edge's hold both turn generated motion down:
    // depth fully, rate more gently for the knob (a slow shallow stroke reads
    // as gentler than a fast shallow one, a crawl does not) and fully for the
    // hold. The existing ramps make every change smooth.
    const knob = clamp(control.intensityScale, 0.1, 1)
    const hold = 1 - clamp(control.holdBack, 0, 1)
    const depthFactor = knob * hold
    const rateFactor = (0.6 + 0.4 * knob) * hold
    const divisor = motion.source === 'music' ? musicDivisor(rateFactor) : 1

    // Ramp toward the targets rather than snapping — this is the main
    // hardware-safety guard alongside the maxSpm ceiling.
    const rawSpm = targetSpm()
    const wantSpm = clamp(motion.source === 'music' ? rawSpm / divisor : rawSpm * rateFactor, 0, motion.maxSpm)
    const wantDepth = clamp(targetDepth() * depthFactor, 0, 1)
    spm = rampToward(spm, wantSpm, motion.spmRampPerSec, dt)
    depth = rampToward(depth, wantDepth, motion.depthRampPerSec, dt)

    if (motion.source === 'music') {
      // Steer our own phase onto the grid instead of copying it: a grid that
      // gets nudged, or a switch of subdivision, eases in over a stroke or two
      // and the rate never exceeds the ceiling while catching up.
      const grid = getBeatGrid()
      const k = (motion.musicStrokesPerBeat || 1) / divisor
      if (grid) {
        const strokes = grid.beats * k
        musicPhase = steerPhase(musicPhase, strokes - Math.floor(strokes), Math.max(spm, 1) / 60, dt, {
          maxRateHz: motion.maxSpm / 60,
        })
      }
      phase = musicPhase * Math.PI * 2
    }
    else {
      // Locked to the pulse: read the audio clock's phase rather than
      // integrating our own, so the stroke is in step with what is heard —
      // but only while that clock runs under the ceiling. Copying a faster
      // clock's phase used to bypass maxSpm entirely.
      // Slowed by the knob or an edge, it lets go of the clock and steers
      // after it instead, then locks again once back in step — copying the
      // clock's phase straight away would jump the stroke.
      const locked = motion.source === 'pulse' ? getPulseClock() : null
      if (locked && locked.rateHz * 60 <= motion.maxSpm) {
        const own = phase / TAU
        if ((rateFactor >= 0.999 && Math.abs(phaseError(own, locked.phase)) < 0.03) || depth < 0.02)
          phase = locked.phase * TAU
        else
          phase = steerPhase(own, locked.phase, locked.rateHz * rateFactor, dt, { maxRateHz: motion.maxSpm / 60 }) * TAU
      }
      else {
        phase = advancePhase(phase, spm, dt)
      }
    }

    // Direct control bypasses the oscillator entirely: the stick *is* the
    // position. Still ramped, so a flick of the thumb cannot snap the axis.
    let pos: number
    if (motion.source === 'manual' && motion.manualMode === 'direct') {
      const full = applyDepth(motion.gamepadPosition, motion.center, 1)
      const want = motion.center + (full - motion.center) * depthFactor
      // Limit travel speed to the same ceiling the oscillator obeys.
      const maxTravelPerSec = (motion.maxSpm / 60) * 2
      pos = rampToward(motion.currentPos, want, maxTravelPerSec, dt)
    }
    else {
      const unit = strokePosition(phase, motion.shape)
      pos = applyDepth(unit, motion.center, depth)
    }

    // Turned down, give the device a little longer to reach each point, so
    // the gentler motion is also a softer one.
    const interval = Math.round(SEND_INTERVAL_MS * (1 + 0.5 * (1 - depthFactor)))
    sendPosition('L0', pos, interval)

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
      sendPosition('R0', twist, interval)
      sendPosition('R1', roll, interval)
    }

    if (motion.vibrateFromIntensity)
      sendPosition('V0', clamp(audio.intensity.value * depthFactor, 0, 1), interval)

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
    musicPhase = 0
    subdivision.reset()
    motion.musicStrokesPerBeat = 0
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
    sourceLive,
    funscriptBusy,
    /** Exposed for tests and the panel readout. */
    state: () => ({ phase, spm, depth }),
  }
}
