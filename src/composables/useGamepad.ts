import { onUnmounted, watch } from 'vue'
import { clamp } from '~/lib/motionMath'
import { useMotionStore } from '~/stores/motionStore'
import { useSafetyStore } from '~/stores/safetyStore'
import { useGamepadStatus } from './useGamepadStatus'

/** Below this, a stick is treated as centred — sticks rarely rest at exactly 0. */
const DEADZONE = 0.12

/** Standard-mapping button indices we care about. */
const BUTTON = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  START: 9,
} as const

export interface GamepadActions {
  next: () => void
  prev: () => void
  random: () => void
  togglePlay: () => void
  panic: () => void
}

/**
 * Drive the manual motion source, and the transport, from a gamepad.
 *
 * Fits this app better than a mouse: the controls that matter during a session
 * are rate, depth and "next", and all three are one thumb away. The stick can
 * either set the stroke rate or steer the position directly, which is the more
 * interesting of the two — it makes the device follow your hand.
 */
export function useGamepad(actions: GamepadActions) {
  const motion = useMotionStore()
  const safety = useSafetyStore()

  const { connected, padName } = useGamepadStatus()

  let raf: number | null = null
  let prevButtons: boolean[] = []

  /** Rising edge only, so holding a button does not repeat the action. */
  function pressed(buttons: readonly GamepadButton[], index: number): boolean {
    const now = buttons[index]?.pressed ?? false
    const was = prevButtons[index] ?? false
    return now && !was
  }

  function applyDeadzone(v: number): number {
    if (Math.abs(v) < DEADZONE)
      return 0
    // Rescale so control starts smoothly at the edge of the deadzone.
    const sign = Math.sign(v)
    return sign * ((Math.abs(v) - DEADZONE) / (1 - DEADZONE))
  }

  function poll() {
    const pads = navigator.getGamepads?.() ?? []
    const pad = Array.from(pads).find(p => p && p.connected) ?? null

    connected.value = !!pad
    padName.value = pad?.id ?? ''

    if (pad) {
      // ── Buttons ──────────────────────────────────────────────────────────
      if (pressed(pad.buttons, BUTTON.START))
        actions.panic()

      if (!safety.panicked) {
        if (pressed(pad.buttons, BUTTON.A))
          actions.togglePlay()
        if (pressed(pad.buttons, BUTTON.RB))
          actions.next()
        if (pressed(pad.buttons, BUTTON.LB))
          actions.prev()
        if (pressed(pad.buttons, BUTTON.Y))
          actions.random()
        if (pressed(pad.buttons, BUTTON.B))
          motion.enabled = !motion.enabled
      }

      prevButtons = pad.buttons.map(b => b.pressed)

      // ── Sticks ───────────────────────────────────────────────────────────
      if (motion.gamepadEnabled && motion.source === 'manual' && !safety.panicked) {
        // Left stick Y, inverted so pushing up means further out.
        const y = applyDeadzone(-(pad.axes[1] ?? 0))
        // Right stick Y trims depth.
        const depth = applyDeadzone(-(pad.axes[3] ?? 0))

        if (motion.manualMode === 'direct') {
          // Stick position maps straight onto axis position.
          motion.gamepadPosition = clamp((y + 1) / 2, 0, 1)
        }
        else if (y !== 0 || motion.gamepadRateHeld) {
          // Stick magnitude sets the stroke rate.
          motion.manualSpm = Math.round(clamp(Math.abs(y) * motion.maxSpm, 0, motion.maxSpm))
          motion.gamepadRateHeld = Math.abs(y) > 0
        }

        if (depth !== 0)
          motion.manualDepth = clamp(motion.manualDepth + depth * 0.02, 0, 1)
      }
    }

    raf = requestAnimationFrame(poll)
  }

  function start() {
    if (raf === null)
      raf = requestAnimationFrame(poll)
  }

  function stop() {
    if (raf !== null) {
      cancelAnimationFrame(raf)
      raf = null
    }
    connected.value = false
  }

  function onConnect() {
    start()
  }

  window.addEventListener('gamepadconnected', onConnect)
  watch(() => motion.gamepadEnabled, (on) => {
    if (on)
      start()
    else
      stop()
  }, { immediate: true })

  onUnmounted(() => {
    window.removeEventListener('gamepadconnected', onConnect)
    stop()
  })

  return { connected, padName }
}
