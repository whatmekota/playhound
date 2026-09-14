import { ref, onUnmounted } from 'vue'
import { useScriptStore } from '~/stores/scriptStore'
import { usePlayerStore } from '~/stores/playerStore'
import { useTCode } from './useTCode'
import { interpolatePosition, nextActionAt } from '~/lib/funscriptParser'
import { calcInterval } from '~/lib/tcodeEncoder'

export function useVideoSync() {
  const scriptStore = useScriptStore()
  const playerStore = usePlayerStore()
  const { sendPosition, homeAllAxes } = useTCode()

  let rafId: number | null = null
  let videoEl: HTMLVideoElement | null = null
  const syncing = ref(false)

  function attach(el: HTMLVideoElement) {
    videoEl = el
  }

  function start() {
    if (syncing.value) return
    syncing.value = true
    tick()
  }

  function stop() {
    syncing.value = false
    if (rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
    homeAllAxes(500)
  }

  function tick() {
    if (!syncing.value || !videoEl) return

    const timeMs = videoEl.currentTime * 1000
    const speed = videoEl.playbackRate

    for (const script of scriptStore.activeScripts) {
      const { channel, parsed, offsetMs } = script
      const { actions } = parsed
      if (actions.length === 0) continue

      const adjustedMs = timeMs + (offsetMs ?? 0)
      const pos = interpolatePosition(actions, adjustedMs)
      const nextAt = nextActionAt(actions, adjustedMs)
      const interval = calcInterval(nextAt, adjustedMs, speed)
      sendPosition(channel, pos, interval)
    }

    rafId = requestAnimationFrame(tick)
  }

  function onSeeked() {
    // After seek, immediately send current position without waiting for next RAF
    if (!videoEl || !syncing.value) return
    const timeMs = videoEl.currentTime * 1000
    const speed = videoEl.playbackRate
    for (const script of scriptStore.activeScripts) {
      const { channel, parsed, offsetMs } = script
      const adjustedMs = timeMs + (offsetMs ?? 0)
      const pos = interpolatePosition(parsed.actions, adjustedMs)
      const nextAt = nextActionAt(parsed.actions, adjustedMs)
      const interval = calcInterval(nextAt, adjustedMs, speed)
      sendPosition(channel, pos, interval)
    }
  }

  onUnmounted(() => {
    stop()
  })

  return { attach, start, stop, onSeeked, syncing }
}
