import { ref, watch } from 'vue'
import {
  beatPhaseAt,
  createOnsetDetector,
  estimatePeriod,
  periodToBpm,
  spectralFlux,
} from '~/lib/beatDetect'
import { phaseError } from '~/lib/funscriptAnalysis'
import { useAudioStore } from '~/stores/audio'
import { useMotionStore } from '~/stores/motionStore'
import { usePlayerStore } from '~/stores/playerStore'
import { useBinauralBeats } from './useBinauralBeats'

/** Proportional gain steering the pulse onto the beat. */
const PHASE_GAIN = 0.3
/** Never bend tempo by more than this while correcting. */
const MAX_BEND = 0.25
/** Onsets kept for tempo estimation — a few bars' worth. */
const HISTORY = 32

// Singleton: one element, one source node, one analysis loop.
let ctx: AudioContext | null = null
let sourceEl: HTMLVideoElement | null = null
let analyser: AnalyserNode | null = null
let raf: number | null = null

// Loop state lives here, not per call: the shell and the Motion panel both
// construct this, and a second copy of the detector would silently observe
// nothing while the first one ran.
const detector = createOnsetDetector()
let prevSpectrum: Float32Array<ArrayBuffer> | null = null
let spectrum: Float32Array<ArrayBuffer> | null = null
let onsets: number[] = []
let periodMs = 0
let lastOnsetMs = 0

const bpm = ref(0)
const locked = ref(false)
const available = ref(true)
// Published so the motion engine can lock to the beat without the binaural
// engine running — the pulse clock lives inside that graph, and requiring it
// meant "follow the music" did nothing unless a tone was playing.
const beatPeriodMs = ref(0)
const beatLastOnsetMs = ref(0)
/** Onsets seen since the track started — zero means no audio is arriving. */
const onsetCount = ref(0)
/** Whether any signal at all is reaching the analyser. */
const hasSignal = ref(false)

/**
 * Where we are in the beat, extrapolated between onsets. Null when unknown.
 *
 * Timed off performance.now() rather than the video's currentTime: that only
 * updates on timeupdate, roughly four times a second, which quantises every
 * onset to ~250ms and makes the tempo estimate impossible to settle.
 */
export function getBeatClock(): { phase: number, rateHz: number } | null {
  if (beatPeriodMs.value <= 0)
    return null
  return {
    phase: beatPhaseAt(beatLastOnsetMs.value, beatPeriodMs.value, performance.now()),
    rateHz: 1000 / beatPeriodMs.value,
  }
}

/**
 * Drive the session pulse from the music in the video.
 *
 * A PMV already carries a hard beat grid, and until now the app ignored it
 * entirely — inventing its own tempo while the music played underneath. This
 * feeds the existing pulse clock instead, so the device, the slideshow and the
 * binaural pulse all land on the track's beat.
 *
 * Opt-in, and it yields to a funscript: a script is a better description of
 * what should happen than a drum hit is.
 */
export function useVideoBeat() {
  const audio = useAudioStore()
  const player = usePlayerStore()
  const motion = useMotionStore()
  const { setPulse, getPulseClock } = useBinauralBeats()

  /**
   * Route the video element through an analyser.
   *
   * createMediaElementSource can only be called once per element and diverts
   * its audio into the graph, so the connection to the destination has to be
   * made immediately or the video goes silent.
   */
  function ensureGraph(el: HTMLVideoElement): boolean {
    if (analyser && sourceEl === el)
      return true
    if (sourceEl && sourceEl !== el) {
      // A different element would need its own source node; the app only ever
      // has one video element, so this should not happen.
      return false
    }

    try {
      const AC = (window as any).AudioContext ?? (window as any).webkitAudioContext
      const audioCtx: AudioContext = new AC()
      const source = audioCtx.createMediaElementSource(el)
      const node = audioCtx.createAnalyser()
      node.fftSize = 1024
      // Onsets *are* the transients, so no temporal smoothing: averaging
      // successive spectra flattens the very rises the detector looks for.
      node.smoothingTimeConstant = 0

      source.connect(node)
      // Straight through as well, so the video is still audible.
      source.connect(audioCtx.destination)

      ctx = audioCtx
      analyser = node
      sourceEl = el
      return true
    }
    catch {
      // Most likely the element was already routed, or the browser refused.
      available.value = false
      analyser = null
      ctx = null
      return false
    }
  }

  function reset() {
    detector.reset()
    prevSpectrum = null
    onsets = []
    periodMs = 0
    lastOnsetMs = 0
    beatPeriodMs.value = 0
    beatLastOnsetMs.value = 0
    bpm.value = 0
    locked.value = false
    onsetCount.value = 0
    hasSignal.value = false
  }

  function tick() {
    if (!analyser || !ctx) {
      raf = null
      return
    }

    if (!spectrum || spectrum.length !== analyser.frequencyBinCount)
      spectrum = new Float32Array(analyser.frequencyBinCount)
    const bins = spectrum
    analyser.getFloatFrequencyData(bins)
    // Silence reads as -Infinity; treat it as a floor so flux stays finite.
    for (let i = 0; i < bins.length; i++) {
      if (!Number.isFinite(bins[i]))
        bins[i] = -140
    }

    // High-resolution, monotonic, and advancing every frame.
    const tMs = performance.now()

    if (prevSpectrum) {
      const flux = spectralFlux(prevSpectrum, bins)
      // Silence sits at the floor across every bin.
      if (!hasSignal.value && bins.some(v => v > -139))
        hasSignal.value = true

      if (detector.push(flux, tMs)) {
        onsetCount.value++
        lastOnsetMs = tMs
        beatLastOnsetMs.value = tMs
        onsets.push(tMs)
        if (onsets.length > HISTORY)
          onsets.shift()

        const p = estimatePeriod(onsets)
        if (p) {
          periodMs = p
          beatPeriodMs.value = p
          bpm.value = Math.round(periodToBpm(p))
        }
      }
    }
    // bins is reused each frame, so keep a copy to diff against.
    if (!prevSpectrum || prevSpectrum.length !== bins.length)
      prevSpectrum = new Float32Array(bins.length)
    prevSpectrum.set(bins)

    // ── Steer the pulse onto the beat ────────────────────────────────────
    const clock = getPulseClock()
    if (periodMs > 0 && clock) {
      const target = beatPhaseAt(lastOnsetMs, periodMs, tMs)
      const err = phaseError(clock.phase, target)
      const bend = Math.max(-MAX_BEND, Math.min(MAX_BEND, err * PHASE_GAIN))
      const rateHz = 1000 / periodMs
      setPulse(
        rateHz * (1 + bend),
        audio.pulseEnabled.value ? audio.pulseDepth.value : 0,
        0.2,
      )
      locked.value = Math.abs(err) < 0.06
    }
    else {
      locked.value = false
    }

    raf = requestAnimationFrame(tick)
  }

  function start(el: HTMLVideoElement) {
    if (!ensureGraph(el))
      return
    void ctx?.resume()
    if (raf === null)
      raf = requestAnimationFrame(tick)
  }

  function stop() {
    if (raf !== null) {
      cancelAnimationFrame(raf)
      raf = null
    }
    reset()
  }

  // Re-learn the tempo when the track changes.
  watch(() => player.videoPath, reset)

  // Choosing the Music motion source implies wanting the analysis; leaving it
  // to a separate switch elsewhere was how this came to look broken.
  watch(() => motion.source, (s) => {
    if (s === 'music')
      audio.musicDrive.value = true
  }, { immediate: true })

  watch(
    // Detection only needs the video playing. Steering the *pulse* still
    // requires the audio engine, but the motion source does not.
    () => audio.musicDrive.value && player.isPlaying && !audio.scriptDrive.value,
    (on) => {
      if (!on) {
        stop()
        return
      }
      const el = document.querySelector('video')
      if (el)
        start(el)
    },
  )

  return { bpm, locked, available, beatPeriodMs, onsetCount, hasSignal, start, stop }
}
