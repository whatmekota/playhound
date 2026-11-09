/**
 * E-stim audio output (experimental): the stroke as a stereo carrier on a
 * sound output of its own, for a stim box with an audio input.
 *
 * The maths (what each channel gets, how fast the volume may move) is in
 * lib/estim.ts. This wires it to Web Audio: two oscillators (the carrier's
 * sine and cosine) into four gains (left and right, sine and cosine part),
 * merged to stereo, through one master gain, on an AudioContext sent to the
 * output the user picked (setSinkId), never the default one the video uses.
 *
 * Safety:
 * - Nothing runs until Start, and Start is never remembered: every launch
 *   starts disarmed. The volume settings are remembered.
 * - Every gain change is a ramp. The master volume follows stepLevel: a slow
 *   start from silence, fast falls, the user's ceiling, and silence when the
 *   stroke stops (pause, stop) or nothing drives it.
 * - Each update also schedules a fade to silence half a second later, so if
 *   the page stops updating (hung, or a hidden browser tab) the output fades
 *   out by itself.
 * - Panic (estimPanic, called from useSafety) cuts the master to zero at
 *   once, disarms, and suspends the audio; only Start brings it back.
 * - The chosen output disappearing (unplugged) does the same.
 */

import type { EstimMapping, LevelState, OutputDevice } from '~/lib/estim'
import { useLocalStorage } from '@vueuse/core'
import { computed, effectScope, reactive, ref, shallowRef } from 'vue'
import { CARRIER_DEFAULT_HZ, clampCarrier, DEADMAN_FADE_SEC, DEADMAN_HOLD_SEC, isLive, mixFor, outputProblem, SILENCE, SILENT, stepLevel } from '~/lib/estim'
import { KEYS } from '~/lib/persist'
import { createAxisModel } from '~/lib/recording'
import { useSafetyStore } from '~/stores/safetyStore'
import { useSessionControlStore } from '~/stores/sessionControlStore'
import { addAxisListener } from './useTCode'

export interface EstimSettings {
  /** 0–1 of full scale; never above the ceiling. */
  volume: number
  /** The user's hard limit, 0–1 of full scale. */
  ceiling: number
  carrierHz: number
  mapping: EstimMapping
  /** The sound output's deviceId, and its name when it was picked. */
  sinkId: string
  sinkLabel: string
}

export const ESTIM_DEFAULTS: EstimSettings = {
  volume: 0.1,
  ceiling: 0.25,
  carrierHz: CARRIER_DEFAULT_HZ,
  mapping: 'threephase',
  sinkId: '',
  sinkLabel: '',
}

const TICK_MS = 25
const TICK_SEC = TICK_MS / 1000
/** Panel readouts refresh at this rate, not every tick. */
const METER_EVERY = 4

// ─── Shared state (one output for the whole app) ─────────────────────────────

let settingsRef: ReturnType<typeof useLocalStorage<EstimSettings>> | null = null
function settings() {
  // In a scope of its own: made inside a panel, it must outlive the panel.
  settingsRef ??= effectScope(true).run(() => useLocalStorage<EstimSettings>(KEYS.estim.key, { ...ESTIM_DEFAULTS }, { mergeDefaults: true }))!
  return settingsRef
}

/** Started by the user and not stopped since. Deliberately not persisted. */
const armed = ref(false)
/** Why it last stopped on its own, for the panel. */
const stoppedBy = ref<'panic' | 'output-lost' | 'error' | null>(null)
const error = ref<string | null>(null)
const outputs = shallowRef<OutputDevice[]>([])
/** Whether the outputs carry names (browsers hide them until a media permission). */
const namesShown = ref(false)
const meter = reactive({ level: 0, left: 0, right: 0, starting: false, live: false, position: 0.5 })
const running = ref(false)

let ctx: AudioContext | null = null
let sinkInUse = ''
let nodes: {
  sin: OscillatorNode
  cos: OscillatorNode
  lc: GainNode
  ls: GainNode
  rc: GainNode
  rs: GainNode
  master: GainNode
} | null = null
let loop: ReturnType<typeof setInterval> | null = null
let unlisten: (() => void) | null = null
let level: LevelState = SILENCE
let lastTick = 0
let tickCount = 0
const stroke = createAxisModel()
let lastCommandAt = Number.NEGATIVE_INFINITY

export const sinkSupported = typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype

function onAxis(channel: string, position: number, intervalMs: number) {
  if (channel !== 'L0')
    return
  const now = performance.now()
  stroke.command(position, intervalMs, now)
  lastCommandAt = now
}

/** The two oscillators, the four gains, the master; built once per context. */
function buildGraph(c: AudioContext) {
  const sin = c.createOscillator()
  sin.type = 'sine'
  const cos = c.createOscillator()
  // A cosine: the same partial as 'sine', a quarter turn on.
  cos.setPeriodicWave(c.createPeriodicWave(new Float32Array([0, 1]), new Float32Array([0, 0])))
  const hz = clampCarrier(settings().value.carrierHz)
  sin.frequency.value = hz
  cos.frequency.value = hz

  const gain = () => {
    const g = c.createGain()
    g.gain.value = 0
    return g
  }
  const lc = gain()
  const ls = gain()
  const rc = gain()
  const rs = gain()
  const merger = c.createChannelMerger(2)
  const master = gain()
  cos.connect(lc).connect(merger, 0, 0)
  sin.connect(ls).connect(merger, 0, 0)
  cos.connect(rc).connect(merger, 0, 1)
  sin.connect(rs).connect(merger, 0, 1)
  merger.connect(master).connect(c.destination)
  try {
    c.destination.channelCount = 2
    c.destination.channelInterpretation = 'discrete'
  }
  catch {}
  // Started together, so the two stay exactly a quarter turn apart.
  const t = c.currentTime + 0.05
  sin.start(t)
  cos.start(t)
  return { sin, cos, lc, ls, rc, rs, master }
}

/**
 * Glide `param` to `value`, starting at `t`, about `over` seconds to get there.
 *
 * setTargetAtTime starts from whatever the param is at `t`, so a late or early
 * tick can never make it jump. cancelAndHoldAtTime + linearRampToValueAtTime
 * did: in Chrome the ramp now and then started from the param's initial value
 * (0) instead, a drop to silence and a 25 ms climb back, about once a second.
 * An exponential approach between two mixes is still a blend of them, so it
 * never exceeds the louder one either.
 */
function rampTo(param: AudioParam, value: number, t: number, over: number) {
  param.cancelScheduledValues(t)
  param.setTargetAtTime(value, t, over / 3)
}

/** Silence at once: no ramp. */
function cutMaster() {
  if (!ctx || !nodes)
    return
  const g = nodes.master.gain
  g.cancelScheduledValues(0)
  g.setValueAtTime(0, ctx.currentTime)
  g.value = 0
}

function stopLoop() {
  if (loop !== null)
    clearInterval(loop)
  loop = null
  unlisten?.()
  unlisten = null
  running.value = false
  level = SILENCE
  meter.level = 0
  meter.left = 0
  meter.right = 0
  meter.starting = false
  meter.live = false
}

/**
 * Panic: silence now, disarm, suspend. Safe to call at any time, armed or
 * not; nothing restarts it until the user presses Start again.
 */
export function estimPanic(reason: 'panic' | 'output-lost' | 'error' = 'panic') {
  const was = armed.value || running.value
  armed.value = false
  cutMaster()
  stopLoop()
  void ctx?.suspend().catch(() => {})
  if (was)
    stoppedBy.value = reason
}

/** Stop: a quick fade to silence, then the audio rests. Start brings it back. */
export function estimStop() {
  armed.value = false
}

async function refreshOutputs() {
  const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined
  if (!md?.enumerateDevices) {
    outputs.value = []
    return
  }
  try {
    const all = await md.enumerateDevices()
    const outs = all.filter(d => d.kind === 'audiooutput')
    namesShown.value = outs.some(d => !!d.label)
    outputs.value = outs.map(d => ({ deviceId: d.deviceId, label: d.label, groupId: d.groupId }))
  }
  catch {
    outputs.value = []
  }
  // Unplugged while running: stop, as panic does.
  const s = settings().value
  if (running.value && s.sinkId && !outputs.value.some(o => o.deviceId === s.sinkId))
    estimPanic('output-lost')
}

let watchingDevices = false
function watchDevices() {
  if (watchingDevices || typeof navigator === 'undefined' || !navigator.mediaDevices?.addEventListener)
    return
  watchingDevices = true
  navigator.mediaDevices.addEventListener('devicechange', () => void refreshOutputs())
}

export function useEstim() {
  const safety = useSafetyStore()
  const control = useSessionControlStore()
  const s = settings()
  watchDevices()

  const problem = computed(() => {
    if (!sinkSupported)
      return 'This browser cannot send sound to a chosen output. Use Chrome or Edge, or the desktop app.'
    return outputProblem(s.value.sinkId, outputs.value)
  })

  function tick() {
    if (!ctx || !nodes)
      return
    const now = performance.now()
    const dt = lastTick ? (now - lastTick) / 1000 : TICK_SEC
    lastTick = now
    const cfg = s.value
    const live = isLive(lastCommandAt, now)
    level = stepLevel(level, {
      armed: armed.value,
      panicked: safety.panicked,
      live,
      volume: cfg.volume,
      ceiling: cfg.ceiling,
      intensity: control.effectiveIntensity,
    }, dt)
    if (safety.panicked) {
      estimPanic('panic')
      return
    }

    const pos = stroke.at(now)
    const mix = mixFor(cfg.mapping, pos)
    const t = ctx.currentTime
    // Gains move to the next update's values over one update: smooth, and a
    // blend of two mixes never exceeds the louder of them.
    rampTo(nodes.lc.gain, mix.left.c, t, TICK_SEC)
    rampTo(nodes.ls.gain, mix.left.s, t, TICK_SEC)
    rampTo(nodes.rc.gain, mix.right.c, t, TICK_SEC)
    rampTo(nodes.rs.gain, mix.right.s, t, TICK_SEC)
    const g = nodes.master.gain
    rampTo(g, level.level, t, TICK_SEC)
    // Dead man's switch: unless the next update comes (and cancels this), fade out.
    g.setTargetAtTime(0, t + DEADMAN_HOLD_SEC, DEADMAN_FADE_SEC / 3)

    const hz = clampCarrier(cfg.carrierHz)
    if (Math.abs(nodes.sin.frequency.value - hz) > 0.5) {
      // Both together, so they keep their quarter turn.
      for (const o of [nodes.sin, nodes.cos])
        rampTo(o.frequency, hz, t, 0.2)
    }

    if (++tickCount % METER_EVERY === 0) {
      meter.level = level.level
      meter.left = Math.hypot(mix.left.c, mix.left.s) * level.level
      meter.right = Math.hypot(mix.right.c, mix.right.s) * level.level
      meter.starting = level.starting
      meter.live = live
      meter.position = pos
    }

    // Stopped and silent: let the audio rest, once the fade to zero just
    // scheduled has played. Suspending in the same tick stopped the output
    // mid-fade, about a quarter of the level, a small click at every Stop.
    // (Panic still cuts and suspends at once: estimPanic.)
    if (!armed.value && level.level <= SILENT) {
      stopLoop()
      const c = ctx
      setTimeout(() => {
        if (running.value || armed.value || ctx !== c)
          return
        cutMaster()
        void c.suspend().catch(() => {})
      }, 150)
    }
  }

  /** Start: must come from a click (it opens the audio output). Ramps up from silence. */
  async function start(): Promise<boolean> {
    error.value = null
    if (safety.panicked) {
      error.value = 'Panic is on. Resume first.'
      return false
    }
    await refreshOutputs()
    const why = problem.value
    if (why) {
      error.value = why
      return false
    }
    const sinkId = s.value.sinkId
    try {
      if (!ctx)
        ctx = new AudioContext({ latencyHint: 'interactive' })
      if (sinkInUse !== sinkId) {
        // Silence before moving to another output, then move.
        cutMaster()
        await (ctx as AudioContext & { setSinkId: (id: string) => Promise<void> }).setSinkId(sinkId)
        sinkInUse = sinkId
      }
      nodes ??= buildGraph(ctx)
      cutMaster()
      await ctx.resume()
    }
    catch (e: any) {
      error.value = `Could not open that output: ${e?.message ?? e}`
      estimPanic('error')
      return false
    }
    // Panic may have come while the output was opening.
    if (safety.panicked)
      return false
    stoppedBy.value = null
    level = SILENCE
    lastTick = 0
    armed.value = true
    unlisten ??= addAxisListener(onAxis)
    if (loop === null)
      loop = setInterval(tick, TICK_MS)
    running.value = true
    return true
  }

  function setOutput(deviceId: string) {
    const dev = outputs.value.find(o => o.deviceId === deviceId)
    // Changing the output while running stops it: the new one starts from silence.
    if (running.value && deviceId !== s.value.sinkId)
      estimPanic('error')
    stoppedBy.value = null
    s.value = { ...s.value, sinkId: deviceId, sinkLabel: dev?.label || s.value.sinkLabel }
  }

  /**
   * Browsers hide output names until the page may use a microphone. Ask for
   * it once, close it straight away, and list again.
   */
  async function showNames() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach(t => t.stop())
    }
    catch {}
    await refreshOutputs()
  }

  function setVolume(v: number) {
    s.value = { ...s.value, volume: Math.max(0, Math.min(s.value.ceiling, v)) }
  }

  function setCeiling(v: number) {
    const ceiling = Math.max(0.01, Math.min(1, v))
    s.value = { ...s.value, ceiling, volume: Math.min(s.value.volume, ceiling) }
  }

  const state = computed<'off' | 'starting' | 'on' | 'waiting' | 'stopping'>(() => {
    if (!running.value)
      return 'off'
    if (!armed.value)
      return 'stopping'
    if (!meter.live)
      return 'waiting'
    return meter.starting ? 'starting' : 'on'
  })

  return {
    settings: s,
    armed,
    running,
    state,
    stoppedBy,
    error,
    outputs,
    namesShown,
    meter,
    problem,
    sinkSupported,
    start,
    stop: estimStop,
    panic: estimPanic,
    refreshOutputs,
    showNames,
    setOutput,
    setVolume,
    setCeiling,
  }
}
