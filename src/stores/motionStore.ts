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
export type MotionSourceId = 'funscript' | 'session' | 'beat' | 'pulse' | 'manual'

export const MOTION_SOURCES: { id: MotionSourceId, label: string, hint: string }[] = [
  { id: 'funscript', label: 'Script', hint: 'Follow the loaded funscript' },
  { id: 'session', label: 'Session', hint: 'Generated from session phase and intensity' },
  { id: 'beat', label: 'Beat', hint: 'Generated, locked to the binaural beat' },
  { id: 'pulse', label: 'Pulse', hint: 'Locked in phase to the audible session pulse' },
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
    secondaryAxes,
    secondaryDepth,
    vibrateFromIntensity,
    currentSpm,
    currentDepth,
    currentPos,
    beatDivisor,
    isGenerated,
    running,
    serialize,
    deserialize,
  }
})
