import { onUnmounted, watch } from 'vue'
import { webviewFocused } from '~/plugins/webview'
import { useAudioStore } from '~/stores/audio'
import { useMotionStore } from '~/stores/motionStore'
import { usePlayerStore } from '~/stores/playerStore'
import { useSafetyStore } from '~/stores/safetyStore'
import { useBinauralBeats } from './useBinauralBeats'
import { estimPanic, estimStop } from './useEstim'
import { popoutFocused } from './usePopout'
import { useTCode } from './useTCode'
import { netPanic } from './useTCodeNet'

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

    // Device first — it is the output that keeps moving on its own. E-stim
    // audio goes silent at once and stays off until started again by hand.
    estimPanic()
    netPanic()
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
      estimStop()
    }, minutes * 60_000)
  }

  const IDLE_EVENTS = ['pointerdown', 'keydown', 'wheel'] as const

  let blurTimer: ReturnType<typeof setTimeout> | undefined
  function onBlur() {
    if (!safety.panicOnBlur)
      return
    // Focus moving between the main window and the pop-out player stays in
    // the app, and so does a click into a plugin's web page. The other window
    // (or page) only reports focus a moment after this one loses it, so look
    // once it has settled.
    clearTimeout(blurTimer)
    blurTimer = setTimeout(() => {
      if (!document.hasFocus() && !popoutFocused() && !webviewFocused())
        panic()
    }, 150)
  }

  for (const ev of IDLE_EVENTS)
    window.addEventListener(ev, resetIdle, { passive: true })
  window.addEventListener('ph:popout-activity', resetIdle)
  window.addEventListener('ph:webview-activity', resetIdle)
  window.addEventListener('blur', onBlur)
  window.addEventListener('ph:popout-blur', onBlur)

  watch(() => safety.idleStopMinutes, resetIdle, { immediate: true })

  safety.toggleHandler = toggle

  onUnmounted(() => {
    safety.toggleHandler = null
    for (const ev of IDLE_EVENTS)
      window.removeEventListener(ev, resetIdle)
    window.removeEventListener('ph:popout-activity', resetIdle)
    window.removeEventListener('ph:webview-activity', resetIdle)
    window.removeEventListener('blur', onBlur)
    window.removeEventListener('ph:popout-blur', onBlur)
    clearTimeout(blurTimer)
    if (idleTimer !== null)
      clearTimeout(idleTimer)
  })

  return { panic, resume, toggle }
}
