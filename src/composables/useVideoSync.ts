import type { Ref } from 'vue'
import type { FunscriptAction } from '~/lib/funscriptParser'
import type { ScaledScript } from '~/lib/scriptScale'
import { useLocalStorage } from '@vueuse/core'
import { onUnmounted, ref } from 'vue'
import { advanceTwistPhase, estimateVelocity, synthAxes, synthTargets } from '~/lib/axisSynth'
import { cancelFrame, requestFrame } from '~/lib/frames'
import { nextActionAt } from '~/lib/funscriptParser'
import { clampLatency } from '~/lib/latency'
import { KEYS } from '~/lib/persist'
import { backOff, intensityParams, sampleScaled, scaleScript } from '~/lib/scriptScale'
import { createSteadyClock } from '~/lib/steadyClock'
import { frameCommand, holdCommand, SEND_INTERVAL_MS } from '~/lib/tcodeEncoder'
import { capMove, ceilingPerMs, motionFilters } from '~/plugins/filters'
import { useMotionStore } from '~/stores/motionStore'
import { useScriptStore } from '~/stores/scriptStore'
import { useSessionControlStore } from '~/stores/sessionControlStore'
import { useButtplug } from './useButtplug'
import { useHandy } from './useHandy'
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

/** The video's time standing still this long, while meant to play, is a stall. */
const STILL_MS = 60

export function useVideoSync() {
  const control = useSessionControlStore()
  const scriptStore = useScriptStore()
  const latencyMs = useDeviceLatency()
  const motion = useMotionStore()
  const { sendPosition, homeAllAxes } = useTCode()
  const bp = useButtplug()
  const handy = useHandy()
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

  let snap = true
  /** When the video's time last moved (performance.now()). */
  let stillSince = 0
  const clock = createSteadyClock()
  let prevVideoMs = -1
  let wasHolding = false
  let lastDir: Record<string, number> = {}

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
  function driveDerivedAxes(strokePos: number, dtSec: number) {
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
        sendPosition(channel, value, SEND_INTERVAL_MS)
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
    prevVideoMs = -1
    stillSince = 0
    wasHolding = false
    lastDir = {}
    snap = true
    clock.reset()
    if (motion.softStart)
      control.softStart()
    tick()
  }

  function stop() {
    syncing.value = false
    prevStrokePos = null
    prevTs = 0
    prevVideoMs = -1
    stillSince = 0
    wasHolding = false
    lastDir = {}
    snap = true
    if (rafId !== null) {
      cancelFrame(rafId)
      rafId = null
    }
    homeAllAxes(500)
    handy.halt()
  }

  function holdsNow(): number {
    return 1 - (1 - control.holdBack) * (1 - control.softHold)
  }

  /**
   * Where a script puts an axis at `ms`, after the intensity knob and any
   * running edge. The knob reshapes the script (shorter, slower strokes on
   * the same beats); the edge's hold then shrinks every stroke toward its
   * centre, smoothly, frame by frame.
   */
  function positionAt(channel: string, actions: FunscriptAction[], ms: number, filtered = true): number {
    const knob = control.intensityScale
    const hold = holdsNow()
    // Plugins' filters reshape the script itself; the knob's scaling of a
    // level and an edge's hold come after them, so the user's controls win.
    const filter = (p: number) => (filtered && motionFilters.active() ? motionFilters.apply(p, channel, ms) : p)
    if (isLevelChannel(channel)) {
      const { pos } = sampleScaled(scaledFor(actions, 1), ms)
      return filter(pos) * Math.max(0, Math.min(1, knob)) * (1 - hold)
    }
    const pos = filter(sampleScaled(scaledFor(actions, knob), ms).pos)
    // An edge settles the device toward the middle of its range. Shrinking
    // toward each stroke's own centre kept it travelling between strokes
    // whose centres differ, so a "held" script still moved ~40% of its range.
    // The ramp in/out is smooth (see edging.ts), so this never jumps.
    return hold > 0 ? backOff(pos, 0.5, hold) : pos
  }

  /**
   * Where the stroke should be at `to`, held by the speed rule for filters:
   * no faster than the script itself goes from `from` to `to`, or than the
   * speed ceiling, whichever is more. Unfiltered, as it is.
   */
  function cappedTarget(channel: string, actions: FunscriptAction[], from: number, to: number, fromPos: number, speed: number): number {
    const toPos = positionAt(channel, actions, to)
    if (!motionFilters.active())
      return toPos
    const rawFrom = positionAt(channel, actions, from, false)
    const rawTo = positionAt(channel, actions, to, false)
    // Script time runs `speed` times faster than the wall clock the ceiling is in.
    return capMove(fromPos, toPos, rawFrom, rawTo, (to - from) / (speed || 1), ceilingPerMs(motion.maxSpm))
  }

  function sendAxis(
    channel: string,
    actions: FunscriptAction[],
    ms: number,
    speed: number,
    nextAt: number | null,
    hold: boolean,
  ): number {
    const pos = positionAt(channel, actions, ms)
    if (hold) {
      const cmd = holdCommand(pos)
      sendPosition(channel, cmd.pos, cmd.interval, { force: snap })
      return pos
    }
    const end = nextAt === null ? null : cappedTarget(channel, actions, ms, nextAt, pos, speed)
    const cmd = frameCommand(pos, end, nextAt, ms, speed)
    const dir = Math.sign((end ?? pos) - pos)
    const reversal = lastDir[channel] !== undefined && dir !== 0 && dir !== lastDir[channel]
    lastDir[channel] = dir
    sendPosition(channel, cmd.pos, cmd.interval, { reported: pos, force: reversal })
    return pos
  }

  function tick() {
    if (!syncing.value || !videoEl)
      return

    const rawMs = videoEl.currentTime * 1000
    const speed = videoEl.playbackRate

    const now = performance.now()
    // Stalled (buffering, a frame that will not decode): hold where it is.
    // Judged by time, not frames: on a fast screen currentTime can sit on
    // one value for two or three frames while playing perfectly well, and
    // holding then puts a flat spot and a jump into every stroke.
    if (rawMs !== prevVideoMs) {
      prevVideoMs = rawMs
      stillSince = now
    }
    const hold = snap || now - stillSince >= STILL_MS
    const settle = hold && !wasHolding
    wasHolding = hold

    // Positions come off a steadied clock: currentTime itself moves in uneven
    // steps, which would put a wobble into every stroke (lib/steadyClock).
    const timeMs = clock.read(rawMs, now, speed, !hold && !videoEl.paused && !videoEl.seeking)
    const dtSec = prevTs ? Math.min(0.1, (now - prevTs) / 1000) : 0
    prevTs = now
    let strokePos: number | null = null

    const lead = leadMs(speed)
    for (const script of scriptStore.activeScripts) {
      const { channel, parsed, offsetMs } = script
      const { actions } = parsed
      if (actions.length === 0)
        continue

      const adjustedMs = timeMs + (offsetMs ?? 0) + lead
      const nextAt = nextActionAt(actions, adjustedMs)
      const pos = sendAxis(channel, actions, adjustedMs, speed, nextAt, hold)

      if (channel === 'L0') {
        strokePos = pos
        // The Handy plays the script itself: it is only told where the video
        // is and how deep an edge is. Buffering stops it, and its own offset
        // stands in for the device latency.
        handy.follow({
          playing: !videoEl.paused && !videoEl.seeking && videoEl.readyState >= 3,
          at: timeMs + (offsetMs ?? 0),
          rate: speed,
          // Edges only: the Handy moves between points at its own pace, so a
          // resume needs no soft start, and under Whole script any hold stops it.
          hold: control.holdBack,
        })
        if (settle) {
          void bp.sendLinear(pos, SEND_INTERVAL_MS)
          bpSegmentAt = Number.NaN
        }
        else if (!hold && nextAt !== null && nextAt !== bpSegmentAt) {
          bpSegmentAt = nextAt
          void bp.sendLinear(cappedTarget(channel, actions, adjustedMs, nextAt, pos, speed), Math.max(0, (nextAt - adjustedMs) / speed))
        }
      }
    }

    if (strokePos !== null) {
      driveDerivedAxes(strokePos, dtSec)
      prevStrokePos = strokePos
    }

    snap = false
    rafId = requestFrame(tick)
  }

  function onSeeked() {
    bpSegmentAt = Number.NaN
    clock.reset()
    // After seek, immediately send current position without waiting for next RAF
    if (!videoEl || !syncing.value)
      return
    if (motion.softStart)
      control.softStart()
    const timeMs = videoEl.currentTime * 1000
    const speed = videoEl.playbackRate
    const lead = leadMs(speed)
    snap = true
    prevVideoMs = timeMs
    // Still until the new frame plays: hold from the first tick on.
    stillSince = performance.now() - STILL_MS
    wasHolding = false
    lastDir = {}
    for (const script of scriptStore.activeScripts) {
      const { channel, parsed, offsetMs } = script
      const adjustedMs = timeMs + (offsetMs ?? 0) + lead
      if (parsed.actions.length === 0)
        continue
      const nextAt = nextActionAt(parsed.actions, adjustedMs)
      sendAxis(channel, parsed.actions, adjustedMs, speed, nextAt, true)
    }
    snap = false
  }

  onUnmounted(() => {
    stop()
  })

  return { attach, start, stop, onSeeked, syncing }
}
