/// <reference types="web-bluetooth" />
import type { Ref } from 'vue'
import type { HeartGuardSettings, HeartRateReading } from '~/lib/heartRate'
import { useLocalStorage } from '@vueuse/core'
import { effectScope, reactive, readonly, ref, shallowRef, triggerRef } from 'vue'
import { createGuardState, createHeartRateProcessor, DEFAULT_GUARD, parseHeartRateMeasurement, stepGuard } from '~/lib/heartRate'
import { KEYS } from '~/lib/persist'
import { usePlayerStore } from '~/stores/playerStore'
import { useSessionControlStore } from '~/stores/sessionControlStore'
import { toast } from './useToast'

/**
 * Heart rate from any Bluetooth monitor that speaks the standard Heart Rate
 * Service (chest straps, arm bands, watches that can broadcast).
 *
 * Connecting needs a click (the browser's device chooser, or the desktop
 * app's own); after that a dropped link is retried on its own with a growing
 * pause, since straps and watches drop out whenever you turn away from the
 * computer. Nothing here asks for anything at startup: with no monitor, or no
 * Web Bluetooth at all, it simply stays idle.
 *
 * What it gives the rest of the app, all module-level so any component can
 * import it without mounting this again:
 * - `heartRate`: the live reading (bpm, baseline, arousal…) and link status,
 *   for the Device panel and a dock chip
 * - `heartSparkline`: the last two minutes, one point a second
 * - `heartTimeline`: everything this session, one point a second, with the
 *   video and time it happened at — for stats to pick up
 * - the guard, which calls an edge when the rate climbs fast above resting
 */

export type HeartStatus = 'unsupported' | 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'lost'

export interface HeartTimelinePoint {
  /** Wall clock, ms. */
  at: number
  /** Smoothed bpm. */
  bpm: number
  /** Where in the video, seconds, when one was playing. */
  videoTime: number | null
  videoName: string | null
}

const supported = typeof navigator !== 'undefined' && !!navigator.bluetooth

/** Live reading and link state. Read-only outside this file. */
const state = reactive({
  status: (supported ? 'idle' : 'unsupported') as HeartStatus,
  deviceName: null as string | null,
  error: null as string | null,
  /** Smoothed bpm, rounded; null until the first packet (and after a drop). */
  bpm: null as number | null,
  /** Last value the monitor sent. */
  raw: null as number | null,
  baseline: null as number | null,
  /** 0–1, how far above resting. */
  arousal: 0,
  /** Smoothed beats gained over the last ~15 s. */
  rise: 0,
  /** Skin contact, when the monitor reports it. */
  contact: null as boolean | null,
  /** Latest beat-to-beat intervals, ms, when the monitor sends them. */
  rrMs: [] as number[],
  /** performance.now() of the last packet. */
  at: 0,
  /** Wall clock of the last guard-called edge. */
  guardFiredAt: null as number | null,
})

export const heartRate = readonly(state)

const SPARK_POINTS = 120
/** Smoothed bpm, one a second, newest last. */
export const heartSparkline = shallowRef<number[]>([])

/** Six hours at one a second; a session longer than that keeps its latest part. */
const TIMELINE_MAX = 6 * 3600
export const heartTimeline = shallowRef<HeartTimelinePoint[]>([])

// ─── Link ────────────────────────────────────────────────────────────────────

const RETRY_MAX_MS = 30_000
/** Roughly ten minutes of retrying before giving up and asking. */
const RETRY_LIMIT = 25

let device: BluetoothDevice | null = null
let characteristic: BluetoothRemoteGATTCharacteristic | null = null
let userClosed = false
let retries = 0
let retryTimer: ReturnType<typeof setTimeout> | null = null
const watched = new WeakSet<BluetoothDevice>()

const processor = createHeartRateProcessor()
let guardState = createGuardState()
let lastPointAt = 0

let started = false
let onReading: (r: HeartRateReading) => void = () => {}
let remember: (d: BluetoothDevice) => void = () => {}
interface SavedDevice { id: string, name: string }
let guardSettings: Ref<HeartGuardSettings> = ref({ ...DEFAULT_GUARD })
let savedDevice: Ref<SavedDevice | null> = ref(null)

function clearReading() {
  state.bpm = null
  state.raw = null
  state.contact = null
  state.rrMs = []
  state.rise = 0
  state.arousal = 0
}

function onValue(e: Event) {
  const view = (e.target as BluetoothRemoteGATTCharacteristic).value
  if (!view)
    return
  const p = parseHeartRateMeasurement(view)
  if (!p)
    return
  state.raw = p.bpm
  state.contact = p.contact
  if (p.rrMs.length)
    state.rrMs = p.rrMs
  state.at = performance.now()
  // A watch with no skin contact sends zeros or its last guess; neither is a heart rate.
  if (p.contact === false)
    return
  const r = processor.push(p.bpm, Date.now())
  if (r)
    onReading(r)
}

function onDisconnected() {
  characteristic = null
  clearReading()
  if (userClosed || !device) {
    state.status = supported ? 'idle' : 'unsupported'
    return
  }
  state.status = 'reconnecting'
  scheduleRetry()
}

function scheduleRetry() {
  if (retryTimer !== null || !device)
    return
  if (retries >= RETRY_LIMIT) {
    state.status = 'lost'
    state.error = 'The monitor stopped answering. Wake it (or restart the workout on a watch), then reconnect.'
    return
  }
  const delay = Math.min(RETRY_MAX_MS, 1000 * 2 ** retries)
  retries++
  retryTimer = setTimeout(() => {
    retryTimer = null
    if (!device || userClosed)
      return
    attach(device).catch(() => scheduleRetry())
  }, delay)
}

async function attach(d: BluetoothDevice) {
  if (!d.gatt)
    throw new Error('This device has no GATT server')
  device = d
  userClosed = false
  if (!watched.has(d)) {
    d.addEventListener('gattserverdisconnected', onDisconnected)
    watched.add(d)
  }
  const server = d.gatt.connected ? d.gatt : await d.gatt.connect()
  const service = await server.getPrimaryService('heart_rate')
  const ch = await service.getCharacteristic('heart_rate_measurement')
  if (characteristic && characteristic !== ch)
    characteristic.removeEventListener('characteristicvaluechanged', onValue)
  ch.addEventListener('characteristicvaluechanged', onValue)
  await ch.startNotifications()
  characteristic = ch
  retries = 0
  state.status = 'connected'
  state.deviceName = d.name ?? 'Heart-rate monitor'
  state.error = null
}

function explain(e: unknown): string | null {
  const err = e as { name?: string, message?: string }
  // The chooser was closed without picking: not an error worth showing.
  if (err?.name === 'NotFoundError' && /cancel/i.test(err.message ?? ''))
    return null
  if (err?.name === 'NotFoundError')
    return 'No heart-rate monitor found. Make sure it is broadcasting (on a watch, start a workout with heart-rate sharing on) and close to this computer.'
  if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError')
    return 'Bluetooth access was refused. Allow it for this site, or use the desktop app.'
  if (err?.name === 'NetworkError')
    return 'Could not connect. The monitor may already be connected to a phone or another app; disconnect it there first.'
  return err?.message || 'Could not connect to the monitor'
}

/** Pick a monitor and connect. Must come from a click. */
async function connect() {
  if (!supported) {
    state.error = 'This browser has no Web Bluetooth. Use Chrome, Edge or the desktop app.'
    return
  }
  if (retryTimer !== null) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
  state.error = null
  state.status = 'connecting'
  try {
    if (navigator.bluetooth.getAvailability && !(await navigator.bluetooth.getAvailability())) {
      state.status = 'idle'
      state.error = 'Bluetooth is off or this computer has no Bluetooth adapter.'
      return
    }
    const d = await navigator.bluetooth.requestDevice({ filters: [{ services: ['heart_rate'] }] })
    await attach(d)
    remember(d)
    toast.success('Heart-rate monitor connected', { detail: state.deviceName ?? undefined, icon: 'i-carbon-favorite', key: 'heart' })
  }
  catch (e) {
    state.status = 'idle'
    state.error = explain(e)
    // A half-made link would otherwise sit there retrying on its own.
    if (device && !device.gatt?.connected) {
      userClosed = true
      device = null
    }
  }
}

/** Retry the monitor already chosen, without a chooser. */
async function reconnect() {
  if (!device)
    return connect()
  retries = 0
  state.error = null
  state.status = 'connecting'
  try {
    await attach(device)
  }
  catch (e) {
    state.status = 'lost'
    state.error = explain(e)
  }
}

async function disconnect() {
  userClosed = true
  if (retryTimer !== null) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
  try {
    await characteristic?.stopNotifications()
  }
  catch {}
  characteristic?.removeEventListener('characteristicvaluechanged', onValue)
  characteristic = null
  try {
    device?.gatt?.disconnect()
  }
  catch {}
  device = null
  clearReading()
  processor.reset()
  guardState = createGuardState()
  state.status = supported ? 'idle' : 'unsupported'
  state.deviceName = null
  state.error = null
}

/** Stop remembering the monitor (and disconnect it). */
async function forget() {
  const d = device
  await disconnect()
  savedDevice.value = null
  try {
    await d?.forget?.()
  }
  catch {}
}

function clearTimeline() {
  heartTimeline.value = []
}

/**
 * Reconnect to the monitor used last time, without asking. Only possible
 * where the browser lists already-permitted devices (Chrome behind the
 * "Web Bluetooth new permissions backend" flag); everywhere else it quietly
 * does nothing and the button does the work.
 */
async function restore() {
  const saved = savedDevice.value
  if (!supported || !saved || typeof navigator.bluetooth.getDevices !== 'function')
    return
  try {
    const list = await navigator.bluetooth.getDevices()
    const d = list.find(x => x.id === saved.id)
    if (!d || device)
      return
    state.status = 'reconnecting'
    state.deviceName = d.name ?? saved.name
    device = d
    userClosed = false
    // Out of range at startup is normal; the retry loop picks it up when it appears.
    await attach(d).catch(() => scheduleRetry())
  }
  catch {
    state.status = 'idle'
  }
}

// ─── Composable ──────────────────────────────────────────────────────────────

function setup() {
  const session = useSessionControlStore()
  const player = usePlayerStore()
  guardSettings = useLocalStorage<HeartGuardSettings>(KEYS.heartGuard.key, { ...DEFAULT_GUARD }, { mergeDefaults: true })
  savedDevice = useLocalStorage<SavedDevice | null>(KEYS.heartDevice.key, null, {
    serializer: { read: v => (v ? JSON.parse(v) : null), write: v => JSON.stringify(v) },
  })

  remember = (d) => {
    savedDevice.value = { id: d.id, name: d.name ?? 'Heart-rate monitor' }
  }

  onReading = (r) => {
    state.bpm = Math.round(r.bpm)
    state.baseline = r.baseline === null ? null : Math.round(r.baseline)
    state.arousal = r.arousal
    state.rise = r.rise

    if (r.at - lastPointAt >= 1000) {
      lastPointAt = r.at
      const spark = heartSparkline.value
      spark.push(r.bpm)
      if (spark.length > SPARK_POINTS)
        spark.splice(0, spark.length - SPARK_POINTS)
      triggerRef(heartSparkline)

      const tl = heartTimeline.value
      tl.push({
        at: r.at,
        bpm: Math.round(r.bpm),
        videoTime: player.isPlaying ? player.currentTime : null,
        videoName: player.videoPath ?? null,
      })
      if (tl.length > TIMELINE_MAX)
        tl.splice(0, tl.length - TIMELINE_MAX)
      triggerRef(heartTimeline)
    }

    const step = stepGuard(guardState, r, guardSettings.value)
    guardState = step.state
    if (step.fire) {
      state.guardFiredAt = Date.now()
      session.edge('heart', {
        videoTime: player.isPlaying ? player.currentTime : null,
        videoName: player.videoPath ?? null,
      })
      toast.warn('Heart rate climbing — easing off', {
        detail: `${Math.round(r.bpm)} bpm, ${Math.round(r.rise)} up in the last few seconds`,
        icon: 'i-carbon-favorite',
        key: 'heart-guard',
      })
    }
  }

  void restore()
}

export function useHeartRate() {
  if (!started) {
    started = true
    effectScope(true).run(setup)
  }
  return {
    supported,
    heartRate,
    heartSparkline,
    heartTimeline,
    guard: guardSettings,
    savedDevice,
    connect,
    reconnect,
    disconnect,
    forget,
    clearTimeline,
  }
}
