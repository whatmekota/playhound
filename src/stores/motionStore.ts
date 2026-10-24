import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

/**
 * Where the device's stroke position comes from.
 *
 * - `funscript` — the loaded script, driven by video playback (useVideoSync)
 * - `session`   — generated from the session engine's phase/intensity
 * - `beat`      — generated, phase-locked to the binaural beat
 * - `manual`    — generated, driven directly by the sliders below
 */
export type MotionSourceId = 'funscript' | 'session' | 'beat' | 'pulse' | 'music' | 'manual'

export const MOTION_SOURCES: { id: MotionSourceId, label: string, hint: string }[] = [
  { id: 'funscript', label: 'Script', hint: 'Follow the loaded funscript' },
  { id: 'session', label: 'Session', hint: 'Generated from session phase and intensity' },
  { id: 'beat', label: 'Beat', hint: 'Generated, locked to the binaural beat' },
  { id: 'pulse', label: 'Pulse', hint: 'Locked in phase to the audible session pulse' },
  { id: 'music', label: 'Music', hint: 'Locked to the beat of the video soundtrack' },
  { id: 'manual', label: 'Manual', hint: 'Generated, driven by the controls here' },
]

/** Waveform used to turn the stroke phase into a position. */
export type StrokeShape = 'sine' | 'ease' | 'pulse'

export const useMotionStore = defineStore('motion', () => {
  const source = ref<MotionSourceId>('funscript')
  const enabled = ref(false)

  // ─── Safety limits ────────────────────────────────────────────────────────
  // Hard ceiling on generated speed. The generator never exceeds this no matter
  // what the session or beat asks for.
  const maxSpm = ref(150)
  // Maximum rate of change, so a phase transition ramps instead of slamming.
  const spmRampPerSec = ref(25)
  const depthRampPerSec = ref(0.4)

  // ─── Generated motion shape ───────────────────────────────────────────────
  const shape = ref<StrokeShape>('sine')
  /** Midpoint of the stroke within the axis range, 0–1. */
  const center = ref(0.5)

  // Session mapping: intensity 0–1 is interpolated across these.
  const minSpm = ref(20)
  const sessionMaxSpm = ref(130)
  const minDepth = ref(0.35)
  const maxDepth = ref(0.95)

  // Beat mapping: the divisor is chosen to land the stroke in this band.
  const beatBandLo = ref(35)
  const beatBandHi = ref(140)

  // Manual mapping
  const manualSpm = ref(60)
  const manualDepth = ref(0.7)

  /**
   * How the manual source behaves:
   * - `oscillate` strokes at manualSpm, as before
   * - `direct` follows gamepadPosition, so the device tracks the stick
   */
  const manualMode = ref<'oscillate' | 'direct'>('oscillate')

  // ─── Derived axes ─────────────────────────────────────────────────────────
  /**
   * Fill the axes a script does not drive, from the stroke axis itself.
   * Off by default: it is an embellishment, not what the scripter wrote.
   */
  const synthEnabled = ref(false)
  const synthDepth = ref(0.35)
  const synthTwist = ref(true)
  const synthRoll = ref(true)
  const synthSurge = ref(false)

  // ─── Gamepad ──────────────────────────────────────────────────────────────
  const gamepadEnabled = ref(false)
  /** Axis position requested by the stick, 0-1, used in direct mode. */
  const gamepadPosition = ref(0.5)
  /** Whether the stick is currently away from centre, for rate mode. */
  const gamepadRateHeld = ref(false)

  // ─── Secondary axes ───────────────────────────────────────────────────────
  /** Drive R0/R1 alongside L0, at a slower rate and shallower depth. */
  const secondaryAxes = ref(false)
  const secondaryDepth = ref(0.25)
  /** Map intensity onto V0 vibration. */
  const vibrateFromIntensity = ref(false)

  // ─── Live readout (written by the engine) ─────────────────────────────────
  const currentSpm = ref(0)
  const currentDepth = ref(0)
  const currentPos = ref(0.5)
  const beatDivisor = ref(1)
  /** Music source readouts: strokes per beat in use, loudness 0–1, beat-grid confidence 0–1. */
  const musicStrokesPerBeat = ref(0)
  const musicEnergy = ref(0)
  const musicConfidence = ref(0)

  const isGenerated = computed(() => source.value !== 'funscript')
  const running = computed(() => enabled.value && isGenerated.value)

  function serialize() {
    return {
      source: source.value,
      maxSpm: maxSpm.value,
      shape: shape.value,
      center: center.value,
      minSpm: minSpm.value,
      sessionMaxSpm: sessionMaxSpm.value,
      minDepth: minDepth.value,
      maxDepth: maxDepth.value,
      beatBandLo: beatBandLo.value,
      beatBandHi: beatBandHi.value,
      manualSpm: manualSpm.value,
      manualDepth: manualDepth.value,
      manualMode: manualMode.value,
      synthEnabled: synthEnabled.value,
      synthDepth: synthDepth.value,
      synthTwist: synthTwist.value,
      synthRoll: synthRoll.value,
      synthSurge: synthSurge.value,
      gamepadEnabled: gamepadEnabled.value,
      secondaryAxes: secondaryAxes.value,
      secondaryDepth: secondaryDepth.value,
      vibrateFromIntensity: vibrateFromIntensity.value,
    }
  }

  function deserialize(data: any) {
    if (!data)
      return
    const nums: [string, { value: number }][] = [
      ['maxSpm', maxSpm],
      ['center', center],
      ['minSpm', minSpm],
      ['sessionMaxSpm', sessionMaxSpm],
      ['minDepth', minDepth],
      ['maxDepth', maxDepth],
      ['beatBandLo', beatBandLo],
      ['beatBandHi', beatBandHi],
      ['manualSpm', manualSpm],
      ['manualDepth', manualDepth],
      ['secondaryDepth', secondaryDepth],
    ]
    for (const [key, target] of nums) {
      if (typeof data[key] === 'number')
        target.value = data[key]
    }
    if (data.source)
      source.value = data.source
    if (data.shape)
      shape.value = data.shape
    if (data.manualMode === 'oscillate' || data.manualMode === 'direct')
      manualMode.value = data.manualMode
    if (typeof data.gamepadEnabled === 'boolean')
      gamepadEnabled.value = data.gamepadEnabled
    if (typeof data.synthEnabled === 'boolean')
      synthEnabled.value = data.synthEnabled
    if (typeof data.synthDepth === 'number')
      synthDepth.value = data.synthDepth
    for (const [k, target] of [['synthTwist', synthTwist], ['synthRoll', synthRoll], ['synthSurge', synthSurge]] as const) {
      if (typeof data[k] === 'boolean')
        target.value = data[k]
    }
    if (typeof data.secondaryAxes === 'boolean')
      secondaryAxes.value = data.secondaryAxes
    if (typeof data.vibrateFromIntensity === 'boolean')
      vibrateFromIntensity.value = data.vibrateFromIntensity
  }

  return {
    source,
    enabled,
    maxSpm,
    spmRampPerSec,
    depthRampPerSec,
    shape,
    center,
    minSpm,
    sessionMaxSpm,
    minDepth,
    maxDepth,
    beatBandLo,
    beatBandHi,
    manualSpm,
    manualDepth,
    manualMode,
    synthEnabled,
    synthDepth,
    synthTwist,
    synthRoll,
    synthSurge,
    gamepadEnabled,
    gamepadPosition,
    gamepadRateHeld,
    secondaryAxes,
    secondaryDepth,
    vibrateFromIntensity,
    currentSpm,
    currentDepth,
    currentPos,
    musicStrokesPerBeat,
    musicEnergy,
    musicConfidence,
    beatDivisor,
    isGenerated,
    running,
    serialize,
    deserialize,
  }
})
