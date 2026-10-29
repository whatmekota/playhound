/**
 * useButtplug — Buttplug.io integration via buttplug-js
 *
 * Connects to Intiface Central (or any Buttplug server) via WebSocket.
 * Scans for devices and exposes a sendLinear() method that maps funscript
 * positions to linear strokers, and sendStrength() for toys that only know
 * "how hard" (vibrate, rotate, oscillate) — useVibeSync drives those, each
 * from the source chosen for it here (vibeSettings, persisted by toy name,
 * since Intiface hands out a new index every session).
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
  OutputType,
} from 'buttplug'
import { computed, reactive, ref, shallowRef } from 'vue'
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

/** Takes a strength rather than a position: vibrators, rotators, oscillators. */
export function isStrengthToy(d: ButtplugClientDevice): boolean {
  const o = outputsOf(d)
  return o.vibrate || o.rotate || o.oscillate
}

function ensureVibe(d: ButtplugClientDevice) {
  const store = vibeSettings()
  if (isStrengthToy(d) && !store.value[d.name])
    store.value = { ...store.value, [d.name]: { ...DEFAULT_VIBE } }
}

function clearLevels() {
  for (const k of Object.keys(levels))
    delete levels[Number(k)]
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
      })
      client.addListener('deviceremoved', (d: ButtplugClientDevice) => {
        devices.value = devices.value.filter(x => x.index !== d.index)
        delete levels[d.index]
      })
      client.addListener('disconnect', () => {
        connected.value = false
        devices.value = []
        clearLevels()
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
    return vibeSettings().value[d.name] ?? DEFAULT_VIBE
  }

  function setVibe(d: ButtplugClientDevice, patch: Partial<VibeSettings>) {
    const store = vibeSettings()
    store.value = { ...store.value, [d.name]: { ...vibeFor(d), ...patch } }
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
    connect,
    disconnect,
    startScan,
    stopScan,
    sendLinear,
    stopAll,
    setEnabled,
    sendStrength,
    vibeFor,
    setVibe,
  }
}
