/**
 * useButtplug — Buttplug.io integration via buttplug-js
 *
 * Connects to Intiface Central (or any Buttplug server) via WebSocket.
 * Scans for devices and exposes a sendLinear() method that maps funscript
 * positions to linear strokers, and sendStrength() for toys that only know
 * "how hard" (vibrate, rotate, oscillate) — useVibeSync drives those, each
 * from the source chosen for it here (vibeSettings, persisted by toy name:
 * the one given it in Intiface, else the model's; Intiface hands out a new
 * index every session).
 *
 * Usage:
 *   const bp = useButtplug()
 *   await bp.connect('ws://localhost:12345')
 *   bp.sendLinear(channel, position01, durationMs)
 */

import type {
  ButtplugClientDevice,
} from 'buttplug'
import type { VibeSettings } from '~/lib/vibeMap'
import { useLocalStorage } from '@vueuse/core'
import {
  ButtplugBrowserWebsocketClientConnector,
  ButtplugClient,
  DeviceOutput,
  InputCommandType,
  InputType,
  OutputType,
} from 'buttplug'
import { computed, reactive, ref, shallowRef } from 'vue'
import { toast } from '~/composables/useToast'
import { KEYS } from '~/lib/persist'
import { logCommand } from '~/lib/serialLog'
import { DEFAULT_VIBE } from '~/lib/vibeMap'
import { useDeviceStore } from '~/stores/deviceStore'

// ─── Singleton ────────────────────────────────────────────────────────────────
let client: ButtplugClient | null = null

// ─── Shared reactive state ────────────────────────────────────────────────────
const connected = ref(false)
const scanning = ref(false)
const devices = shallowRef<ButtplugClientDevice[]>([])
const error = ref<string | null>(null)
const serverUrl = ref(localStorage.getItem(KEYS.buttplugUrl.key) ?? 'ws://localhost:12345')
// On unless switched off: a toy that connects and then sits still because a
// switch further down was off read as a broken connection.
const enabled = ref(localStorage.getItem(KEYS.buttplugEnabled.key) !== 'false')

/** Per-toy vibration settings, keyed by device name. */
let vibeStore: ReturnType<typeof useLocalStorage<Record<string, VibeSettings>>> | null = null
function vibeSettings() {
  vibeStore ??= useLocalStorage<Record<string, VibeSettings>>(KEYS.buttplugVibe.key, {})
  return vibeStore
}

/** Strength last sent to each toy (by index), 0–1, for the live meters. */
const levels = reactive<Record<number, number>>({})
/** The same per motor (`${index}:${feature}`), for toys whose motors follow sources of their own. */
const motorLevels = reactive<Record<string, number>>({})
/** Battery, 0–1, by toy index, for toys that report one; read every minute. */
const batteries = reactive<Record<number, number>>({})
/** Battery at or under this: a notice, once a session per toy. */
const BATTERY_LOW = 0.15
const BATTERY_EVERY_MS = 60_000
const warnedLow = new Set<string>()
let batteryTimer: ReturnType<typeof setInterval> | null = null

export interface ToyOutputs {
  linear: boolean
  vibrate: boolean
  rotate: boolean
  oscillate: boolean
}

/** What a device can do. Guarded: a half-described device must not break a list. */
export function outputsOf(d: ButtplugClientDevice): ToyOutputs {
  const has = (t: OutputType) => {
    try {
      return d.hasOutput(t)
    }
    catch {
      return false
    }
  }
  const linear = has(OutputType.HwPositionWithDuration)
  return {
    linear,
    vibrate: has(OutputType.Vibrate),
    rotate: has(OutputType.Rotate),
    // A stroker that also offers oscillate (the Lovense Solace Pro) has one
    // motor with two ways to drive it: speeds sent alongside the script's
    // positions would fight them, so it only ever gets positions.
    oscillate: has(OutputType.Oscillate) && !linear,
  }
}

export type MotorKind = 'vibrate' | 'rotate' | 'oscillate'
const MOTOR_OUTPUT: Record<MotorKind, OutputType> = { vibrate: OutputType.Vibrate, rotate: OutputType.Rotate, oscillate: OutputType.Oscillate }
const MOTOR_LABEL: Record<MotorKind, string> = { vibrate: 'Vibration', rotate: 'Rotation', oscillate: 'Oscillation' }

/** One motor of a toy: a Buttplug feature that takes a strength. */
export interface ToyMotor {
  feature: number
  kind: MotorKind
  /** "Vibration", "Vibration 2", "Rotation". */
  label: string
}

/** A toy's motors, in feature order. Guarded like outputsOf. */
export function motorsOf(d: ButtplugClientDevice): ToyMotor[] {
  const o = outputsOf(d)
  const out: ToyMotor[] = []
  try {
    for (const f of d.features.values()) {
      for (const kind of ['vibrate', 'rotate', 'oscillate'] as const) {
        if (o[kind] && f.hasOutput(MOTOR_OUTPUT[kind]))
          out.push({ feature: f.index, kind, label: MOTOR_LABEL[kind] })
      }
    }
  }
  catch {
    return []
  }
  // Number the ones that share a kind: "Vibration 1", "Vibration 2".
  for (const kind of ['vibrate', 'rotate', 'oscillate'] as const) {
    const same = out.filter(m => m.kind === kind)
    if (same.length > 1)
      same.forEach((m, i) => (m.label = `${MOTOR_LABEL[kind]} ${i + 1}`))
  }
  return out
}

/** Takes a strength rather than a position: vibrators, rotators, oscillators. */
export function isStrengthToy(d: ButtplugClientDevice): boolean {
  const o = outputsOf(d)
  return o.vibrate || o.rotate || o.oscillate
}

/**
 * What the toy is called: the name given it in Intiface Central when there
 * is one, so two of the same toy can be told apart (and set up apart), else
 * the model's name.
 */
export function toyName(d: ButtplugClientDevice): string {
  try {
    return d.displayName?.trim() || d.name
  }
  catch {
    return d.name
  }
}

function ensureVibe(d: ButtplugClientDevice) {
  const store = vibeSettings()
  const key = toyName(d)
  if (!isStrengthToy(d) || store.value[key])
    return
  // Named in Intiface after it was set up here: it keeps what it had under its model's name.
  store.value = { ...store.value, [key]: { ...(store.value[d.name] ?? DEFAULT_VIBE) } }
}

function clearLevels() {
  for (const k of Object.keys(levels))
    delete levels[Number(k)]
  for (const k of Object.keys(motorLevels))
    delete motorLevels[k]
}

/** The toy's battery, 0–1, or null when it has none or doesn't answer. */
async function readBattery(d: ButtplugClientDevice): Promise<number | null> {
  try {
    for (const f of d.features.values()) {
      if (!f.hasInput(InputType.Battery))
        continue
      const r = await f.runInput(InputType.Battery, InputCommandType.Read)
      if (!r || typeof r.value !== 'number')
        return null
      const top = f.input(InputType.Battery)?.valueRange[1] ?? 100
      return Math.max(0, Math.min(1, top > 1 ? r.value / top : r.value))
    }
  }
  catch {}
  return null
}

async function checkBatteries() {
  for (const d of devices.value) {
    const b = await readBattery(d)
    if (b === null) {
      delete batteries[d.index]
      continue
    }
    batteries[d.index] = b
    const name = toyName(d)
    if (b <= BATTERY_LOW && !warnedLow.has(name)) {
      warnedLow.add(name)
      toast.warn(`${name} is low on battery`, { detail: `${Math.round(b * 100)}% left`, icon: 'i-carbon-battery-low', key: `battery-${name}` })
    }
    else if (b > BATTERY_LOW + 0.1) {
      warnedLow.delete(name)
    }
  }
}

function watchBatteries(on: boolean) {
  if (batteryTimer !== null)
    clearInterval(batteryTimer)
  batteryTimer = on ? setInterval(() => void checkBatteries(), BATTERY_EVERY_MS) : null
  if (!on) {
    for (const k of Object.keys(batteries))
      delete batteries[Number(k)]
  }
}

export function useButtplug() {
  const deviceStore = useDeviceStore()

  async function connect(url = serverUrl.value) {
    if (client)
      await disconnect()
    error.value = null
    try {
      client = new ButtplugClient('playhound')

      client.addListener('deviceadded', (d: ButtplugClientDevice) => {
        ensureVibe(d)
        devices.value = [...devices.value, d]
        void checkBatteries()
      })
      client.addListener('deviceremoved', (d: ButtplugClientDevice) => {
        devices.value = devices.value.filter(x => x.index !== d.index)
        delete levels[d.index]
        delete batteries[d.index]
      })
      client.addListener('disconnect', () => {
        connected.value = false
        devices.value = []
        clearLevels()
        watchBatteries(false)
      })

      // Use Browser WebSocket connector (works in browser, not Node)
      const connector = new ButtplugBrowserWebsocketClientConnector(url)
      await client.connect(connector)
      connected.value = true
      serverUrl.value = url
      localStorage.setItem(KEYS.buttplugUrl.key, url)
      // client.devices is a Map<number, ButtplugClientDevice>
      devices.value = [...(client.devices as unknown as Map<number, ButtplugClientDevice>).values()]
      devices.value.forEach(ensureVibe)
      watchBatteries(true)
      void checkBatteries()
    }
    catch (e: any) {
      error.value = e?.message ?? 'Connection failed'
      client = null
    }
  }

  async function disconnect() {
    try { await client?.disconnect() }
    catch {}
    client = null
    connected.value = false
    devices.value = []
    clearLevels()
    watchBatteries(false)
  }

  async function startScan() {
    if (!client)
      return
    scanning.value = true
    try { await client.startScanning() }
    catch (e: any) { error.value = e?.message }
    setTimeout(async () => {
      try { await client?.stopScanning() }
      catch {}
      scanning.value = false
    }, 5000)
  }

  async function stopScan() {
    scanning.value = false
    try { await client?.stopScanning() }
    catch {}
  }

  /**
   * Send a position to all linear devices. position: 0–1, durationMs: movement time.
   * Called every frame from useFunscript alongside TCode sends.
   */
  async function sendLinear(position: number, durationMs: number) {
    if (!enabled.value || !connected.value || devices.value.length === 0)
      return

    const axisConfig = deviceStore.axisConfigs.L0
    let pos = position
    if (axisConfig) {
      const range = axisConfig.max - axisConfig.min
      pos = axisConfig.min + pos * range
      if (axisConfig.invert)
        pos = axisConfig.min + axisConfig.max - pos
    }
    pos = Math.max(0, Math.min(1, pos))
    const dur = Math.max(50, Math.round(durationMs))

    logCommand(`[BP] pos=${pos.toFixed(3)} dur=${dur}ms`)

    for (const device of devices.value) {
      try {
        if (device.hasOutput(OutputType.HwPositionWithDuration)) {
          // Linear stroker (OSR2, Handy, etc.) — percent 0–1, duration in ms
          await device.runOutput(DeviceOutput.PositionWithDuration.percent(pos, dur))
        }
        // Vibrators are useVibeSync's: position makes a poor strength, and
        // two writers would fight over the same motor.
      }
      catch {
        // device might have disconnected mid-play, ignore
      }
    }
  }

  /**
   * Set a strength-type toy to `level` (0–1) on every motor it has: vibrate,
   * rotate (forwards) and oscillate alike. Errors are swallowed — a toy that
   * dropped off mid-session is removed by Intiface's own event.
   */
  async function sendStrength(device: ButtplugClientDevice, level: number) {
    const v = Math.max(0, Math.min(1, level))
    levels[device.index] = v
    const o = outputsOf(device)
    const sends: Promise<void>[] = []
    if (o.vibrate)
      sends.push(device.runOutput(DeviceOutput.Vibrate.percent(v)))
    if (o.rotate)
      sends.push(device.runOutput(DeviceOutput.Rotate.percent(v)))
    if (o.oscillate)
      sends.push(device.runOutput(DeviceOutput.Oscillate.percent(v)))
    await Promise.allSettled(sends)
  }

  /** One motor of a toy (motorsOf) at `level`, 0–1. */
  async function sendMotor(device: ButtplugClientDevice, motor: ToyMotor, level: number) {
    const v = Math.max(0, Math.min(1, level))
    motorLevels[`${device.index}:${motor.feature}`] = v
    const f = device.features.get(motor.feature)
    if (!f)
      return
    const cmd = motor.kind === 'vibrate' ? DeviceOutput.Vibrate : motor.kind === 'rotate' ? DeviceOutput.Rotate : DeviceOutput.Oscillate
    try {
      await f.runOutput(cmd.percent(v))
    }
    catch {}
  }

  async function stopAll() {
    clearLevels()
    for (const device of devices.value) {
      try { await device.stop() }
      catch {}
    }
  }

  function setEnabled(val: boolean) {
    enabled.value = val
    localStorage.setItem(KEYS.buttplugEnabled.key, val ? 'true' : 'false')
  }

  /** Settings for one toy, falling back to the defaults for one never seen. */
  function vibeFor(d: ButtplugClientDevice): VibeSettings {
    const store = vibeSettings().value
    return store[toyName(d)] ?? store[d.name] ?? DEFAULT_VIBE
  }

  function setVibe(d: ButtplugClientDevice, patch: Partial<VibeSettings>) {
    const store = vibeSettings()
    store.value = { ...store.value, [toyName(d)]: { ...vibeFor(d), ...patch } }
  }

  const deviceCount = computed(() => devices.value.length)
  const hasLinear = computed(() => devices.value.some(d => d.hasOutput(OutputType.HwPositionWithDuration)))
  const hasVibrators = computed(() => devices.value.some(d => d.hasOutput(OutputType.Vibrate)))
  const strengthToys = computed(() => devices.value.filter(isStrengthToy))

  return {
    connected,
    scanning,
    devices,
    error,
    serverUrl,
    enabled,
    deviceCount,
    hasLinear,
    hasVibrators,
    strengthToys,
    levels,
    motorLevels,
    batteries,
    motorsOf,
    connect,
    disconnect,
    startScan,
    stopScan,
    sendLinear,
    stopAll,
    setEnabled,
    sendStrength,
    sendMotor,
    vibeFor,
    setVibe,
  }
}
