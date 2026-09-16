import type { RemoteAction, RemoteState } from './useRemoteLink'
import { watch } from 'vue'
import { useAudioStore } from '~/stores/audio'
import { useMotionStore } from '~/stores/motionStore'
import { usePlayerStore } from '~/stores/playerStore'
import { remoteEnabled } from '~/stores/remoteStore'
import { useSafetyStore } from '~/stores/safetyStore'
import { remoteRoom, useRemoteLink } from './useRemoteLink'
import { useRemoteStatus } from './useRemoteStatus'

/**
 * Desktop end of the phone remote: executes what the phone sends, and pushes
 * back enough state for the phone to show something truthful.
 */
export function useRemoteHost(actions: {
  togglePlay: () => void
  next: () => void
  prev: () => void
  random: () => void
  panic: () => void
}) {
  const player = usePlayerStore()
  const motion = useMotionStore()
  const audio = useAudioStore()
  const safety = useSafetyStore()

  function apply(action: RemoteAction) {
    switch (action) {
      case 'panic':
        actions.panic()
        return
      // Everything else is inert while the screen is covered; panic is the
      // only thing that should still get through.
      case 'togglePlay':
        if (!safety.panicked)
          actions.togglePlay()
        break
      case 'next':
        if (!safety.panicked)
          actions.next()
        break
      case 'prev':
        if (!safety.panicked)
          actions.prev()
        break
      case 'random':
        if (!safety.panicked)
          actions.random()
        break
      case 'motionToggle':
        if (!safety.panicked)
          motion.enabled = !motion.enabled
        break
      case 'audioToggle':
        if (!safety.panicked)
          audio.isPlaying.value = !audio.isPlaying.value
        break
      case 'intensityUp':
        audio.intensity.value = Math.min(1, audio.intensity.value + 0.05)
        break
      case 'intensityDown':
        audio.intensity.value = Math.max(0, audio.intensity.value - 0.05)
        break
    }
    pushState()
  }

  const link = useRemoteLink('host', () => remoteRoom.value, (msg) => {
    if (msg?.type === 'cmd' && msg.action)
      apply(msg.action as RemoteAction)
    if (msg?.type === 'hello')
      pushState()
  })

  function pushState() {
    const state: RemoteState = {
      title: player.videoPath?.split(/[\\/]/).pop() ?? '',
      playing: player.isPlaying,
      panicked: safety.panicked,
      motion: motion.enabled,
      audio: audio.isPlaying.value,
      intensity: audio.intensity.value,
      spm: motion.currentSpm,
      phase: audio.phase.value,
    }
    link.send({ type: 'state', state })
  }

  // Mirror into the shared status so panels can show it without opening a
  // second connection.
  const status = useRemoteStatus()
  watch(link.connected, v => (status.connected.value = v), { immediate: true })
  watch(link.peers, v => (status.peers.value = v), { deep: true, immediate: true })

  watch(remoteEnabled, (on) => {
    if (on)
      link.connect()
    else
      link.disconnect()
  }, { immediate: true })

  // Keep the phone honest about what the desktop is doing.
  watch(
    () => [player.isPlaying, player.videoPath, motion.enabled, audio.isPlaying.value, safety.panicked, audio.phase.value],
    pushState,
  )

  // spm and intensity are written every animation frame, so they cannot go in
  // the watch above - that would push sixty frames a second at the relay. They
  // were previously left out altogether, which meant a remote only ever saw
  // whatever they happened to be when a discrete field last changed: usually
  // spm 0, taken the instant motion was switched on. Push them on a gate
  // instead, once they have moved enough to be worth seeing.
  const CONTINUOUS_MS = 250
  const SPM_EPSILON = 2
  const INTENSITY_EPSILON = 0.03

  let lastContinuousAt = 0
  let seenContinuous = false
  let lastSpm = 0
  let lastIntensity = 0

  watch(
    () => [motion.currentSpm, audio.intensity.value] as const,
    ([spm, level]) => {
      const moved = !seenContinuous
        || Math.abs(spm - lastSpm) >= SPM_EPSILON
        || Math.abs(level - lastIntensity) >= INTENSITY_EPSILON
      if (!moved)
        return

      const now = performance.now()
      if (now - lastContinuousAt < CONTINUOUS_MS)
        return

      lastContinuousAt = now
      seenContinuous = true
      lastSpm = spm
      lastIntensity = level
      pushState()
    },
  )

  return { connected: link.connected, peers: link.peers, room: remoteRoom }
}
