import { watch } from 'vue'
import { MAX_BEAT_HZ, useAudioStore } from '~/stores/audio'
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
      audio.pulseEnabled.value ? audio.pulseDepth.value : 0,
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
    [audio.pulseEnabled, audio.pulseCpm, audio.pulseDepth, audio.pulseFollowsSession, audio.intensity, audio.scriptDrive, audio.musicDrive],
    pushPulse,
  )

  watch(
    [audio.breathEnabled, audio.breathPeriod, audio.breathInhaleRatio, audio.noiseEnabled],
    pushBreath,
  )

  watch([audio.sessionArc, audio.edgeCycles], () => {
    session.setArc(audio.sessionArc.value, { cycles: audio.edgeCycles.value })
  }, { immediate: true })

  // Re-apply everything when the engine (re)starts.
  watch(audio.isPlaying, (playing) => {
    if (!playing)
      return
    binaural.setMode(audio.beatMode.value)
    pushPulse()
    pushBreath()
  })

  return { pushPulse, pushBreath }
}
