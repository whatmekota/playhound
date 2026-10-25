import type { RemoteAction, RemoteEdge, RemoteState } from './useRemoteLink'
import { watch } from 'vue'
import { EDGE_FALL_SEC } from '~/lib/edging'
import { useAudioStore } from '~/stores/audio'
import { useMotionStore } from '~/stores/motionStore'
import { usePlayerStore } from '~/stores/playerStore'
import { remoteEnabled } from '~/stores/remoteStore'
import { useSafetyStore } from '~/stores/safetyStore'
import { useSessionControlStore } from '~/stores/sessionControlStore'
import { useFaceLink } from './useFaceLink'
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
  /** Call an edge from the phone. */
  edge?: () => void
  /** "I'm OK": end the hold early. */
  release?: () => void
  /** Move the intensity knob. */
  nudgeIntensity?: (delta: number) => void
}) {
  const player = usePlayerStore()
  const motion = useMotionStore()
  const audio = useAudioStore()
  const safety = useSafetyStore()
  const ctl = useSessionControlStore()

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
      // The phone's +/- used to nudge the session intensity, which the
      // session arc then overwrote at its next step. They are the intensity
      // knob now: it scales scripts and generated motion, and it sticks.
      case 'intensityUp':
        nudge(0.05)
        break
      case 'intensityDown':
        nudge(-0.05)
        break
      // Edging is allowed even while panicked: it only ever turns things down.
      case 'edge':
        if (actions.edge)
          actions.edge()
        else
          ctl.edge('remote')
        break
      case 'edgeRelease':
        if (actions.release)
          actions.release()
        else
          ctl.release()
        break
    }
    pushState()
  }

  function nudge(delta: number) {
    if (actions.nudgeIntensity)
      actions.nudgeIntensity(delta)
    else
      ctl.nudgeIntensity(delta)
  }

  function edgeState(): RemoteEdge {
    const { cooldownSec, rebuildSec } = ctl.settings
    const holding = ctl.phase === 'falling' || ctl.phase === 'holding'
    return {
      phase: ctl.phase,
      remaining: Math.ceil(ctl.remainingSec),
      hold: holding ? Math.max(0, Math.ceil(ctl.remainingSec - rebuildSec)) : 0,
      total: EDGE_FALL_SEC + cooldownSec + rebuildSec,
      count: ctl.edges.length,
    }
  }

  const status = useRemoteStatus()

  const link = useRemoteLink('host', () => remoteRoom.value, (msg) => {
    if (msg?.type === 'cmd' && msg.action)
      apply(msg.action as RemoteAction)
    if (msg?.type === 'hello')
      pushState()
    status.emit(msg)
  })

  function pushState() {
    const state: RemoteState = {
      title: player.videoPath?.split(/[\\/]/).pop() ?? '',
      playing: player.isPlaying,
      panicked: safety.panicked,
      motion: motion.enabled,
      audio: audio.isPlaying.value,
      intensity: audio.intensity.value,
      knob: ctl.intensityScale,
      edge: edgeState(),
      spm: motion.currentSpm,
      phase: audio.phase.value,
    }
    link.send({ type: 'state', state })
  }

  // Mirror into the shared status so panels can show it without opening a
  // second connection.
  status.send.value = link.send
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

  // The edge countdown ticks every frame too; once a second is plenty for a
  // phone to draw it.
  watch(
    () => [ctl.phase, Math.ceil(ctl.remainingSec), ctl.edges.length, ctl.intensityScale],
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

  // The CYD face rides this same socket; it stays quiet until switched on.
  useFaceLink()

  return { connected: link.connected, peers: link.peers, room: remoteRoom }
}
