import { watch } from 'vue'
import { MAX_BEAT_HZ, useAudioStore } from '~/stores/audio'
import { useSessionControlStore } from '~/stores/sessionControlStore'
import { useBinauralBeats } from './useBinauralBeats'
import { useSessionEngine } from './useSessionEngine'

/**
 * Keeps the audio engine in step with the audio store.
 *
 * Instantiated once by the shell so the pulse, beat mode and breath cue keep
 * working regardless of which panel happens to be open.
 */
export function useSessionAudio() {
  const audio = useAudioStore()
  const binaural = useBinauralBeats()
  const session = useSessionEngine()
  const control = useSessionControlStore()

  /**
   * How much an edge has taken out of the sound, in steps of 2%: the hold
   * moves every frame, the audio graph only needs to hear about it when it
   * has moved enough to matter (its own ramps smooth the rest).
   */
  const holdStep = () => Math.round(control.holdBack * 50) / 50
  /** Pulse depth follows the knob and the edge, like every other stimulus. */
  const pulseScale = () => Math.round(control.effectiveIntensity * 50) / 50

  /** Session pulse rate in Hz, either following intensity or held manually. */
  function pulseHz(): number {
    if (!audio.pulseFollowsSession.value)
      return audio.pulseCpm.value / 60

    // Intensity 0-1 across a usable stroke band, matching the motion mapping.
    const cpm = 24 + audio.intensity.value * 86
    audio.pulseCpm.value = Math.round(cpm)
    return cpm / 60
  }

  function pushPulse() {
    if (!audio.isPlaying.value)
      return
    // useScriptPulse owns the pulse while the script is driving it.
    if (audio.scriptDrive.value)
      return
    binaural.setPulse(
      pulseHz(),
      audio.pulseEnabled.value ? audio.pulseDepth.value * pulseScale() : 0,
    )
  }

  function pushBreath() {
    if (!audio.isPlaying.value)
      return
    binaural.setBreath(
      audio.breathEnabled.value && audio.noiseEnabled.value,
      audio.breathPeriod.value,
      audio.breathInhaleRatio.value,
    )
  }

  /**
   * Push carrier and beat into the engine whenever the store changes.
   *
   * Every setFrequencies call used to live in the Binaural panel's own event
   * handlers, so anything else writing to the store — the script driver, a
   * preset applied elsewhere — changed the displayed numbers without changing
   * the sound, and nothing moved at all while that panel was closed. A
   * deliberate morph drives the oscillators on its own schedule, so yield to it.
   */
  watch([audio.baseFrequency, audio.beatDelta], ([base, delta]) => {
    if (!audio.isPlaying.value || binaural.isMorphing())
      return
    binaural.setFrequencies(base, delta, 0.15)
  })

  // Turning script-following on should actually be audible; the pulse is the
  // part that carries the stroke, and it defaults to silent.
  watch(audio.scriptDrive, (on) => {
    if (on && !audio.pulseEnabled.value)
      audio.pulseEnabled.value = true
  })

  // Past Oster's limit the tones stop fusing into a beat, so clamp rather than
  // let the UI ask for something that cannot be heard as one.
  watch(audio.beatDelta, (d) => {
    if (d > MAX_BEAT_HZ)
      audio.beatDelta.value = MAX_BEAT_HZ
  }, { immediate: true })

  watch(audio.beatMode, (m) => {
    if (audio.isPlaying.value)
      binaural.setMode(m)
  })

  watch(
    [audio.pulseEnabled, audio.pulseCpm, audio.pulseDepth, audio.pulseFollowsSession, audio.intensity, audio.scriptDrive, audio.musicDrive, pulseScale],
    pushPulse,
  )

  // An edge eases the tone down with everything else, never to silence: a
  // sudden quiet is its own kind of jolt.
  watch(holdStep, (h) => {
    if (audio.isPlaying.value)
      binaural.setVolume(audio.volume.value * (1 - 0.6 * h))
  })

  watch(
    [audio.breathEnabled, audio.breathPeriod, audio.breathInhaleRatio, audio.noiseEnabled],
    pushBreath,
  )

  watch([audio.sessionArc, audio.edgeCycles], () => {
    session.setArc(audio.sessionArc.value, { cycles: audio.edgeCycles.value })
  }, { immediate: true })

  // ── Layers ──────────────────────────────────────────────────────────────
  // These lived in the Binaural panel, so a tone started from the dock (or
  // with the panel closed) came up without its noise, harmonics or drift.

  function startBeatDrift() {
    binaural.startBeatDrift(
      () => audio.baseFrequency.value,
      () => audio.beatDelta.value,
      (next) => { audio.beatDelta.value = next },
    )
  }

  watch([audio.noiseEnabled, audio.isPlaying], ([on, playing], [wasOn, wasPlaying]) => {
    if (on && playing && !(wasOn && wasPlaying)) {
      binaural.startNoise(audio.noiseVolume.value)
      binaural.morphNoise(audio.noiseType.value, 0.5)
    }
    else if (!on && wasOn) {
      binaural.stopNoise()
    }
  })

  watch(audio.harmonicsEnabled, (on) => {
    if (audio.isPlaying.value)
      binaural.setHarmonics(on)
  })

  watch(audio.beatDriftEnabled, (on) => {
    if (on && audio.isPlaying.value)
      startBeatDrift()
    else
      binaural.stopBeatDrift()
  })

  watch(audio.driftMode, (on) => {
    if (!audio.sessionActive.value)
      return
    if (on)
      session.startDrift()
    else
      session.stopDrift()
  })

  // Re-apply everything when the engine (re)starts.
  watch(audio.isPlaying, (playing) => {
    if (!playing)
      return
    binaural.setMode(audio.beatMode.value)
    if (audio.harmonicsEnabled.value)
      binaural.setHarmonics(true)
    if (audio.beatDriftEnabled.value)
      startBeatDrift()
    pushPulse()
    pushBreath()
  })

  return { pushPulse, pushBreath }
}
