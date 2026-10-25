import type { EnvelopeSample, Peak } from '~/lib/funscriptAnalysis'
import { computed, ref, watch } from 'vue'
import {
  phaseError,
  sampleEnvelope,
  speedToIntensity,
  strokePhaseAt,
} from '~/lib/funscriptAnalysis'
import { MAX_BEAT_HZ, useAudioStore } from '~/stores/audio'
import { usePlayerStore } from '~/stores/playerStore'
import { useScriptStore } from '~/stores/scriptStore'
import { useSessionControlStore } from '~/stores/sessionControlStore'
import { useBinauralBeats } from './useBinauralBeats'
import { analyseActions, analysisKey } from './useScriptAnalysis'

/** How often to re-steer the pulse, in ms. Fast enough to track, slow enough to be cheap. */
const TICK_MS = 100

/**
 * Proportional gain for steering the pulse onto the script's stroke phase.
 * Low enough that corrections are a gentle tempo bend rather than a jump.
 */
const PHASE_GAIN = 0.35

/** Never bend the tempo by more than this fraction while correcting. */
const MAX_BEND = 0.25

// Singleton loop state: the shell and the Binaural panel both call this, and
// two interval timers steering the same pulse would fight each other.
let timer: ReturnType<typeof setInterval> | null = null
let peaks: Peak[] = []
let envelope: EnvelopeSample[] = []
let analysedFor = ''

/** Live readout for the UI. */
const locked = ref(false)
const scriptSpm = ref(0)
const scriptIntensity = ref(0)

/**
 * Drive the audio session from the funscript currently loaded.
 *
 * The script already describes exactly what the session wants to know — how
 * fast the strokes are coming, how deep, and where in the current stroke we
 * are — so rather than running the audio on its own clock, this locks the
 * pulse onto the script's stroke phase and feeds its speed in as session
 * intensity. Everything downstream (noise, visuals, and the device when it is
 * on a generated source) then follows the script too.
 *
 * Entirely opt-in: does nothing unless `scriptDrive` is on.
 */
export function useScriptPulse() {
  const audio = useAudioStore()
  const player = usePlayerStore()
  const script = useScriptStore()
  const { setPulse, getPulseClock } = useBinauralBeats()
  const control = useSessionControlStore()

  /** The axis the beat is derived from — the primary stroke script. */
  const source = computed(() => script.primaryScript ?? script.activeScripts[0] ?? null)

  const canDrive = computed(() =>
    audio.scriptDrive.value
    && audio.isPlaying.value
    && player.isPlaying
    && !!source.value,
  )

  function analyse() {
    const s = source.value
    if (!s) {
      peaks = []
      envelope = []
      analysedFor = ''
      return
    }
    const key = analysisKey(s.filename, s.channel, s.parsed.actions.length)
    if (key === analysedFor)
      return

    // Shared cache: the timeline and the auto-director want the same result.
    const a = analyseActions(s.parsed.actions, key)
    peaks = a.peaks
    envelope = a.envelope
    analysedFor = key
  }

  function tick() {
    if (!canDrive.value)
      return
    const s = source.value
    if (!s)
      return

    analyse()
    // Same sign as useVideoSync, so the pulse and the device agree on an offset.
    const tMs = player.currentTime * 1000 + (s.offsetMs ?? 0)

    // ── Intensity from stroke speed ──────────────────────────────────────
    const sample = sampleEnvelope(envelope, tMs)
    if (sample) {
      const intensity = speedToIntensity(sample.speed)
      scriptSpm.value = sample.spm
      scriptIntensity.value = intensity

      if (audio.scriptDriveIntensity.value) {
        audio.intensity.value = intensity
        // Busier script -> lower beat, matching the session engine's own
        // direction of travel. Clamped to the fusion limit either way.
        const delta = 12 - intensity * 8
        audio.beatDelta.value = Math.min(MAX_BEAT_HZ, Math.max(1, delta))
      }
    }

    // ── Phase-lock the pulse to the strokes ──────────────────────────────
    const target = strokePhaseAt(peaks, tMs)
    const clock = getPulseClock()
    if (!target || !clock) {
      locked.value = false
      return
    }

    // Steer by bending the tempo toward the target phase rather than jumping,
    // so the pulse slides into step instead of clicking.
    const err = phaseError(clock.phase, target.phase)
    const bend = Math.max(-MAX_BEND, Math.min(MAX_BEND, err * PHASE_GAIN))
    // Same knob and edge hold-back as everything else that stimulates.
    const depth = audio.pulseEnabled.value ? audio.pulseDepth.value * control.effectiveIntensity : 0
    setPulse(target.rateHz * (1 + bend), depth, 0.2)

    locked.value = Math.abs(err) < 0.05
  }

  function start() {
    if (timer !== null)
      return
    analyse()
    timer = setInterval(tick, TICK_MS)
  }

  function stop() {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
    locked.value = false
    scriptSpm.value = 0
    scriptIntensity.value = 0
  }

  watch(canDrive, (on) => {
    if (on)
      start()
    else
      stop()
  }, { immediate: true })

  // A different script means a different analysis.
  watch(source, () => {
    analysedFor = ''
    analyse()
  })

  return { locked, scriptSpm, scriptIntensity, canDrive }
}
