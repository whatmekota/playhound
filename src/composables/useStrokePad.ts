import type { MotionSourceId } from '~/stores/motionStore'
import { watch } from 'vue'
import { PAD_IDLE_MS, readPad } from '~/lib/strokePad'
import { useDeviceStore } from '~/stores/deviceStore'
import { useMotionStore } from '~/stores/motionStore'
import { usePlayerStore } from '~/stores/playerStore'
import { remotePad } from '~/stores/remoteStore'
import { useSafetyStore } from '~/stores/safetyStore'
import { useScriptStore } from '~/stores/scriptStore'
import { useSessionControlStore } from '~/stores/sessionControlStore'
import { axisOutput } from './useTCode'

/**
 * The desktop end of the phone's stroke pad (lib/strokePad): while a finger
 * is on it, the device follows the finger through the motion engine's direct
 * mode, the gamepad's, so the speed ceiling, the intensity knob, edges,
 * linked axes and panic all still apply, and recording picks it up. A
 * playing script waits meanwhile. Lifting the finger, or the phone going
 * quiet, hands back whatever was running before.
 */

interface Held {
  before: { source: MotionSourceId, enabled: boolean, manualMode: 'oscillate' | 'direct' }
  stop: () => void
}

let held: Held | null = null
let idle: ReturnType<typeof setTimeout> | undefined

export function useStrokePad() {
  const motion = useMotionStore()
  const safety = useSafetyStore()
  const device = useDeviceStore()
  const player = usePlayerStore()
  const scripts = useScriptStore()
  const control = useSessionControlStore()

  /** Where the stroke is now, 0–1 before the axis range, so taking over starts from there. */
  function strokeNow(): number {
    const out = axisOutput.L0
    if (out === undefined)
      return motion.currentPos
    const axis = device.axisConfigs.L0
    const min = axis?.min ?? 0
    const max = axis?.max ?? 1
    const p = max > min ? (out - min) / (max - min) : 0.5
    return Math.min(1, Math.max(0, axis?.invert ? 1 - p : p))
  }

  function take(): boolean {
    if (held)
      return true
    if (safety.panicked || !remotePad.value)
      return false
    const before = { source: motion.source, enabled: motion.enabled, manualMode: motion.manualMode }
    motion.currentPos = strokeNow()
    motion.gamepadPosition = motion.currentPos
    motion.source = 'manual'
    motion.manualMode = 'direct'
    motion.enabled = true
    motion.handHeld = true
    // Someone picked another source, or panic: the pad has lost it.
    const stopSource = watch(() => [motion.source, motion.manualMode, motion.enabled], ([s, m, on]) => {
      if (s !== 'manual' || m !== 'direct' || !on)
        release(false)
    })
    const stopPanic = watch(() => safety.panicked, (p) => {
      if (p)
        release(true)
    })
    const stopAllowed = watch(remotePad, (on) => {
      if (!on)
        release(true)
    })
    held = {
      before,
      stop: () => {
        stopSource()
        stopPanic()
        stopAllowed()
      },
    }
    return true
  }

  /** Let go: hand back what was running before (`restore`), or leave things as someone else set them. */
  function release(restore = true) {
    clearTimeout(idle)
    if (!held)
      return
    const { before, stop } = held
    held = null
    stop()
    motion.handHeld = false
    if (restore) {
      motion.manualMode = before.manualMode
      motion.source = before.source
      motion.enabled = before.enabled
    }
    // A script picking up again eases in, the way it does after a seek.
    if (scripts.activeScripts.length && player.isPlaying)
      control.softStart()
  }

  /** A message from the phone; anything that is not a pad message is ignored. */
  function input(msg: unknown) {
    const r = readPad(msg)
    if (r === null)
      return
    if (r === 'up') {
      release(true)
      return
    }
    if (!take())
      return
    motion.gamepadPosition = r
    clearTimeout(idle)
    idle = setTimeout(() => release(true), PAD_IDLE_MS)
  }

  return { input, release, held: () => !!held }
}
