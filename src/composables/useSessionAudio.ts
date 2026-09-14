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
    [audio.pulseEnabled, audio.pulseCpm, audio.pulseDepth, audio.pulseFollowsSession, audio.intensity],
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
