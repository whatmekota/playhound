import { ref, watch } from 'vue'
import {
  createOnsetDetector,
  estimatePeriod,
  periodToBpm,
  spectralFlux,
} from '~/lib/beatDetect'
import { phaseError } from '~/lib/funscriptAnalysis'
import { createBeatGrid, createEnergyFollower } from '~/lib/musicMotion'
import { useAudioStore } from '~/stores/audio'
import { useMotionStore } from '~/stores/motionStore'
import { usePlayerStore } from '~/stores/playerStore'
import { useBinauralBeats } from './useBinauralBeats'
import { getAnalysedGrid, isAnalysedGridReady, useSoundtrack } from './useSoundtrack'

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
// Onsets steer a grid instead of each one resetting the phase: an off-beat
// hat used to yank the stroke half a beat over, which is what felt like
// vibrating rather than moving to the music.
const grid = createBeatGrid()
const loudness = createEnergyFollower()
let lastFrameMs = 0
let lastPublishMs = 0
let prevSpectrum: Float32Array<ArrayBuffer> | null = null
let spectrum: Float32Array<ArrayBuffer> | null = null
let onsets: number[] = []
let periodMs = 0

const bpm = ref(0)
const locked = ref(false)
const available = ref(true)
// Published so the motion engine can lock to the beat without the binaural
// engine running — the pulse clock lives inside that graph, and requiring it
// meant "follow the music" did nothing unless a tone was playing.
const beatPeriodMs = ref(0)
/** Onsets seen since the track started — zero means no audio is arriving. */
const onsetCount = ref(0)
/** Whether any signal at all is reaching the analyser. */
const hasSignal = ref(false)
/**
 * Whether the beat grid has a tempo and a downbeat. Reactive, unlike the grid
 * itself, so whatever waits on a beat (the motion engine's "is the music
 * source live") re-evaluates the moment one appears.
 */
const beatReady = ref(false)
/** How loud the track is right now relative to itself, 0–1 (published ~10 Hz). */
const energy = ref(0)
/** Share of recent onsets on the beat grid, 0–1 (published ~10 Hz). */
const confidence = ref(0)

// ─── The analysed grid ────────────────────────────────────────────────────────
// When the whole soundtrack has been analysed, the beat comes from that
// instead: no settling, no drift, and it survives seeks. It is read against
// the <video> element's own clock, every frame — playerStore.currentTime only
// moves on timeupdate, a few times a second.

let videoEl: HTMLVideoElement | null = null
/** The playing video's URL, so the right <video> is found (previews use others). */
let videoSrc = ''

function playingVideo(): HTMLVideoElement | null {
  if (videoEl?.isConnected && (!videoSrc || videoEl.src === videoSrc || videoEl.hasAttribute('data-ph-main')))
    return videoEl
  // The player marks its own <video>; with an HLS stream its src is a blob.
  const main = document.querySelector<HTMLVideoElement>('video[data-ph-main]')
  if (main) {
    videoEl = main
    return main
  }
  const all = Array.from(document.querySelectorAll('video'))
  videoEl = all.find(v => v.src === videoSrc) ?? all[0] ?? null
  return videoEl
}

/** The analysed grid at the video's current position, tempo in real time. */
function analysedReading() {
  const g = getAnalysedGrid()
  const el = g && playingVideo()
  if (!g || !el)
    return null
  const r = g.at(el.currentTime)
  // At 1.5× speed the beat comes 1.5× as often.
  return { ...r, bpm: r.bpm * (el.playbackRate || 1) }
}

/**
 * Where we are in the beat, extrapolated between onsets. Null when unknown.
 *
 * Timed off performance.now() rather than the video's currentTime: that only
 * updates on timeupdate, roughly four times a second, which quantises every
 * onset to ~250ms and makes the tempo estimate impossible to settle.
 */
export function getBeatClock(): { phase: number, rateHz: number } | null {
  const r = analysedReading()
  if (r)
    return { phase: r.beats - Math.floor(r.beats), rateHz: r.bpm / 60 }
  if (!grid.ready)
    return null
  const beats = grid.beatsAt(performance.now())
  return {
    phase: beats - Math.floor(beats),
    rateHz: 1000 / grid.periodMs,
  }
}

/** Reactive: true once the soundtrack has given up a tempo and a downbeat. */
export function isBeatReady(): boolean {
  return isAnalysedGridReady() || beatReady.value
}

/**
 * The beat grid as the motion engine needs it: where we are in beats (a
 * continuous count, so bars and subdivisions can be derived), the tempo, how
 * sure the grid is, and how loud the music is. Null until a tempo is known.
 *
 * From the whole-track analysis when there is one — its count puts bar lines
 * on the analysed downbeats — and from live listening otherwise.
 */
export function getBeatGrid(): { beats: number, bpm: number, confidence: number, energy: number } | null {
  const r = analysedReading()
  if (r)
    return { beats: r.beats, bpm: r.bpm, confidence: r.confidence, energy: r.energy }
  if (!grid.ready)
    return null
  return {
    beats: grid.beatsAt(performance.now()),
    bpm: 60000 / grid.periodMs,
    confidence: grid.confidence(),
    energy: loudness.energy,
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
  // Installs the soundtrack analysis wiring (once); the grid above reads it.
  useSoundtrack()

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
    grid.reset()
    loudness.reset()
    beatReady.value = false
    lastFrameMs = 0
    energy.value = 0
    confidence.value = 0
    prevSpectrum = null
    onsets = []
    periodMs = 0
    beatPeriodMs.value = 0
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

    // Loudness: the mean level of the lower two thirds of the spectrum, where
    // kick, bass and vocals live; the top end is mostly hats and air.
    const upto = Math.floor(bins.length * 0.66)
    let sum = 0
    for (let i = 0; i < upto; i++)
      sum += bins[i]
    loudness.push(sum / (upto || 1), lastFrameMs ? (tMs - lastFrameMs) / 1000 : 0)
    lastFrameMs = tMs
    const analysed = analysedReading()
    if (tMs - lastPublishMs > 100) {
      lastPublishMs = tMs
      energy.value = analysed ? analysed.energy : loudness.energy
      confidence.value = analysed ? analysed.confidence : grid.confidence()
      if (analysed) {
        bpm.value = Math.round(analysed.bpm)
        beatPeriodMs.value = 60000 / analysed.bpm
      }
    }

    if (prevSpectrum) {
      const flux = spectralFlux(prevSpectrum, bins)
      // Silence sits at the floor across every bin.
      if (!hasSignal.value && bins.some(v => v > -139))
        hasSignal.value = true

      if (detector.push(flux, tMs)) {
        onsetCount.value++
        onsets.push(tMs)
        if (onsets.length > HISTORY)
          onsets.shift()

        const p = estimatePeriod(onsets)
        if (p) {
          grid.setPeriod(p)
          periodMs = grid.periodMs
          if (!analysed) {
            beatPeriodMs.value = periodMs
            bpm.value = Math.round(periodToBpm(periodMs))
          }
        }
        grid.onset(tMs)
        beatReady.value = grid.ready
      }
    }
    // bins is reused each frame, so keep a copy to diff against.
    if (!prevSpectrum || prevSpectrum.length !== bins.length)
      prevSpectrum = new Float32Array(bins.length)
    prevSpectrum.set(bins)

    // ── Steer the pulse onto the beat ────────────────────────────────────
    const clock = getPulseClock()
    const beat = getBeatGrid()
    if (beat && clock) {
      const target = beat.beats - Math.floor(beat.beats)
      const err = phaseError(clock.phase, target)
      const bend = Math.max(-MAX_BEND, Math.min(MAX_BEND, err * PHASE_GAIN))
      const rateHz = beat.bpm / 60
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
  watch(() => player.videoUrl, (url) => {
    videoSrc = url ?? ''
    videoEl = null
  }, { immediate: true })

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
      const el = document.querySelector<HTMLVideoElement>('video[data-ph-main]') ?? document.querySelector('video')
      if (el)
        start(el)
    },
  )

  return { bpm, locked, available, beatPeriodMs, onsetCount, hasSignal, energy, confidence, start, stop }
}
