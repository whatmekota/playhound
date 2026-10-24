import { onUnmounted, watch } from 'vue'
import { useAudioStore } from '~/stores/audio'
import { useMotionStore } from '~/stores/motionStore'
import { usePlayerStore } from '~/stores/playerStore'
import { useSafetyStore } from '~/stores/safetyStore'
import { useBinauralBeats } from './useBinauralBeats'
import { useTCode } from './useTCode'

/**
 * Wires panic and the idle cut-off.
 *
 * Panic has to reach every output at once — video, audio and the device — and
 * the device matters most, since it is the one that keeps physically moving if
 * nothing tells it to stop.
 */
export function useSafety(controls: {
  pauseVideo: () => void
  playVideo: () => void
  isVideoPlaying: () => boolean
}) {
  const safety = useSafetyStore()
  const audio = useAudioStore()
  const motion = useMotionStore()
  const player = usePlayerStore()
  const binaural = useBinauralBeats()
  const { homeAllAxes } = useTCode()

  let idleTimer: ReturnType<typeof setTimeout> | null = null

  function panic() {
    if (safety.panicked)
      return

    safety.remember({
      videoPlaying: controls.isVideoPlaying(),
      audioPlaying: audio.isPlaying.value,
      motionEnabled: motion.enabled,
      wasMuted: player.isMuted,
    })

    // Device first — it is the output that keeps moving on its own.
    motion.enabled = false
    void homeAllAxes(400)

    if (audio.isPlaying.value) {
      binaural.stop()
      audio.isPlaying.value = false
    }

    controls.pauseVideo()
    safety.panicked = true
  }

  function resume() {
    if (!safety.panicked)
      return
    const s = safety.suspended

    safety.panicked = false

    if (s?.audioPlaying) {
      binaural.start(
        audio.baseFrequency.value,
        audio.beatDelta.value,
        audio.volume.value,
        audio.waveType.value,
      )
      audio.isPlaying.value = true
    }
    if (s?.motionEnabled)
      motion.enabled = true
    if (s?.videoPlaying)
      controls.playVideo()

    safety.clear()
  }

  function toggle() {
    if (safety.panicked)
      resume()
    else
      panic()
  }

  // ─── Idle cut-off ──────────────────────────────────────────────────────────
  function resetIdle() {
    if (idleTimer !== null) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
    const minutes = safety.idleStopMinutes
    if (minutes <= 0)
      return

    idleTimer = setTimeout(() => {
      // Only the device: going quiet unattended is sensible, hiding the screen
      // without being asked is not.
      motion.enabled = false
      void homeAllAxes(600)
    }, minutes * 60_000)
  }

  const IDLE_EVENTS = ['pointerdown', 'keydown', 'wheel'] as const

  function onBlur() {
    if (safety.panicOnBlur)
      panic()
  }

  for (const ev of IDLE_EVENTS)
    window.addEventListener(ev, resetIdle, { passive: true })
  window.addEventListener('blur', onBlur)

  watch(() => safety.idleStopMinutes, resetIdle, { immediate: true })

  safety.toggleHandler = toggle

  onUnmounted(() => {
    safety.toggleHandler = null
    for (const ev of IDLE_EVENTS)
      window.removeEventListener(ev, resetIdle)
    window.removeEventListener('blur', onBlur)
    if (idleTimer !== null)
      clearTimeout(idleTimer)
  })

  return { panic, resume, toggle }
}
