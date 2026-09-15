import { onUnmounted, ref } from 'vue'
import { advanceTwistPhase, estimateVelocity, synthAxes, synthTargets } from '~/lib/axisSynth'
import { interpolatePosition, nextActionAt } from '~/lib/funscriptParser'
import { calcInterval } from '~/lib/tcodeEncoder'
import { useMotionStore } from '~/stores/motionStore'
import { useScriptStore } from '~/stores/scriptStore'
import { useTCode } from './useTCode'

export function useVideoSync() {
  const scriptStore = useScriptStore()
  const motion = useMotionStore()
  const { sendPosition, homeAllAxes } = useTCode()

  let rafId: number | null = null
  let videoEl: HTMLVideoElement | null = null
  const syncing = ref(false)

  // Derived-axis state, kept across frames so twist turns continuously and
  // velocity is measured rather than guessed.
  let twistPhase = 0
  let prevStrokePos: number | null = null
  let prevTs = 0

  function synthConfig() {
    return {
      depth: motion.synthDepth,
      twist: motion.synthTwist,
      roll: motion.synthRoll,
      surge: motion.synthSurge,
    }
  }

  /**
   * Fill the axes the script leaves idle, from the stroke axis.
   *
   * Only ever writes channels the script does not drive — a scripted twist
   * always wins over an invented one.
   */
  function driveDerivedAxes(strokePos: number, dtSec: number, interval: number) {
    if (!motion.synthEnabled)
      return

    const cfg = synthConfig()
    const targets = synthTargets(scriptStore.activeScripts.map(s => s.channel), cfg)
    if (!targets.length)
      return

    const velocity = prevStrokePos === null
      ? 0
      : estimateVelocity(prevStrokePos, strokePos, dtSec)

    // Turn at the stroke's own rate, inferred from how fast it is moving.
    const strokeHz = Math.abs(velocity) * 1.5
    twistPhase = advanceTwistPhase(twistPhase, strokeHz, dtSec)

    const derived = synthAxes({ pos: strokePos, velocity, twistPhase }, cfg)
    for (const channel of targets) {
      const value = derived[channel]
      if (value !== undefined)
        sendPosition(channel, value, interval)
    }
  }

  function attach(el: HTMLVideoElement) {
    videoEl = el
  }

  function start() {
    if (syncing.value)
      return
    syncing.value = true
    tick()
  }

  function stop() {
    syncing.value = false
    prevStrokePos = null
    prevTs = 0
    if (rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
    homeAllAxes(500)
  }

  function tick() {
    if (!syncing.value || !videoEl)
      return

    const timeMs = videoEl.currentTime * 1000
    const speed = videoEl.playbackRate

    const now = performance.now()
    const dtSec = prevTs ? Math.min(0.1, (now - prevTs) / 1000) : 0
    prevTs = now
    let strokePos: number | null = null
    let strokeInterval = 100

    for (const script of scriptStore.activeScripts) {
      const { channel, parsed, offsetMs } = script
      const { actions } = parsed
      if (actions.length === 0)
        continue

      const adjustedMs = timeMs + (offsetMs ?? 0)
      const pos = interpolatePosition(actions, adjustedMs)
      const nextAt = nextActionAt(actions, adjustedMs)
      const interval = calcInterval(nextAt, adjustedMs, speed)
      sendPosition(channel, pos, interval)

      if (channel === 'L0') {
        strokePos = pos
        strokeInterval = interval
      }
    }

    if (strokePos !== null) {
      driveDerivedAxes(strokePos, dtSec, strokeInterval)
      prevStrokePos = strokePos
    }

    rafId = requestAnimationFrame(tick)
  }

  function onSeeked() {
    // After seek, immediately send current position without waiting for next RAF
    if (!videoEl || !syncing.value)
      return
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
