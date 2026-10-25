import type { Ref } from 'vue'
import type { FunscriptAction } from '~/lib/funscriptParser'
import type { ScaledScript } from '~/lib/scriptScale'
import { useLocalStorage } from '@vueuse/core'
import { onUnmounted, ref } from 'vue'
import { advanceTwistPhase, estimateVelocity, synthAxes, synthTargets } from '~/lib/axisSynth'
import { nextActionAt } from '~/lib/funscriptParser'
import { clampLatency } from '~/lib/latency'
import { KEYS } from '~/lib/persist'
import { backOff, intensityParams, sampleScaled, scaleScript } from '~/lib/scriptScale'
import { calcInterval } from '~/lib/tcodeEncoder'
import { useMotionStore } from '~/stores/motionStore'
import { useScriptStore } from '~/stores/scriptStore'
import { useSessionControlStore } from '~/stores/sessionControlStore'
import { useButtplug } from './useButtplug'
import { useTCode } from './useTCode'

let latency: Ref<number> | null = null

/**
 * Global device latency in ms, on top of every script's own offset and with
 * the same sign: positive reads the script that much further ahead, for a
 * device that arrives late. It is wall-clock time, so it is scaled by the
 * playback rate before being added to video time.
 *
 * Only the device path uses it. The script pulse (useScriptPulse) stays on
 * script offset alone: the audio has no device lag to make up, and with the
 * device compensated, the strokes are felt at video time + offset — exactly
 * where the pulse already sits.
 */
export function useDeviceLatency(): Ref<number> {
  latency ??= useLocalStorage<number>(KEYS.deviceLatency.key, 0)
  return latency
}

/**
 * Each script's gentler version for the current knob setting, built once per
 * script per knob change rather than per frame. Keyed by the actions array,
 * so a reloaded or edited script simply misses and is rebuilt.
 */
const scaledCache = new WeakMap<FunscriptAction[], { knob: number, scaled: ScaledScript }>()

function scaledFor(actions: FunscriptAction[], knob: number): ScaledScript {
  const hit = scaledCache.get(actions)
  if (hit && hit.knob === knob)
    return hit.scaled
  const scaled = scaleScript(actions, intensityParams(knob))
  scaledCache.set(actions, { knob, scaled })
  return scaled
}

/**
 * Channels whose position is a level rather than a place (vibration,
 * suction): turning these down means toward zero, not toward a centre.
 */
function isLevelChannel(channel: string): boolean {
  return channel[0] === 'V' || channel[0] === 'A'
}

export function useVideoSync() {
  const control = useSessionControlStore()
  const scriptStore = useScriptStore()
  const latencyMs = useDeviceLatency()
  const motion = useMotionStore()
  const { sendPosition, homeAllAxes } = useTCode()
  const bp = useButtplug()
  /**
   * Buttplug linear strokers take "go to P over D ms" rather than a stream of
   * positions, so the stroke is sent once per script action, aimed at the
   * next one. Nothing called sendLinear before, so Intiface strokers never
   * moved. NaN means "send on the next frame" (start, seek).
   */
  let bpSegmentAt = Number.NaN

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

  /** Device latency in video milliseconds at this playback rate. */
  function leadMs(speed: number) {
    return clampLatency(latencyMs.value) * (speed || 1)
  }

  function attach(el: HTMLVideoElement) {
    videoEl = el
  }

  function start() {
    if (syncing.value)
      return
    syncing.value = true
    bpSegmentAt = Number.NaN
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

  /**
   * Where a script puts an axis at `ms`, after the intensity knob and any
   * running edge. The knob reshapes the script (shorter, slower strokes on
   * the same beats); the edge's hold then shrinks every stroke toward its
   * centre, smoothly, frame by frame.
   */
  function positionAt(channel: string, actions: FunscriptAction[], ms: number): number {
    const knob = control.intensityScale
    const hold = control.holdBack
    if (isLevelChannel(channel)) {
      const { pos } = sampleScaled(scaledFor(actions, 1), ms)
      return pos * Math.max(0, Math.min(1, knob)) * (1 - hold)
    }
    const { pos, centre } = sampleScaled(scaledFor(actions, knob), ms)
    return hold > 0 ? backOff(pos, centre, hold) : pos
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

    const lead = leadMs(speed)
    for (const script of scriptStore.activeScripts) {
      const { channel, parsed, offsetMs } = script
      const { actions } = parsed
      if (actions.length === 0)
        continue

      const adjustedMs = timeMs + (offsetMs ?? 0) + lead
      const pos = positionAt(channel, actions, adjustedMs)
      const nextAt = nextActionAt(actions, adjustedMs)
      const interval = calcInterval(nextAt, adjustedMs, speed)
      sendPosition(channel, pos, interval)

      if (channel === 'L0') {
        strokePos = pos
        strokeInterval = interval
        if (nextAt !== null && nextAt !== bpSegmentAt) {
          bpSegmentAt = nextAt
          void bp.sendLinear(positionAt(channel, actions, nextAt), Math.max(0, (nextAt - adjustedMs) / speed))
        }
      }
    }

    if (strokePos !== null) {
      driveDerivedAxes(strokePos, dtSec, strokeInterval)
      prevStrokePos = strokePos
    }

    rafId = requestAnimationFrame(tick)
  }

  function onSeeked() {
    bpSegmentAt = Number.NaN
    // After seek, immediately send current position without waiting for next RAF
    if (!videoEl || !syncing.value)
      return
    const timeMs = videoEl.currentTime * 1000
    const speed = videoEl.playbackRate
    const lead = leadMs(speed)
    for (const script of scriptStore.activeScripts) {
      const { channel, parsed, offsetMs } = script
      const adjustedMs = timeMs + (offsetMs ?? 0) + lead
      if (parsed.actions.length === 0)
        continue
      const pos = positionAt(channel, parsed.actions, adjustedMs)
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
