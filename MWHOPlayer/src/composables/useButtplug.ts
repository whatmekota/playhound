/**
 * useButtplug — Buttplug.io integration via buttplug-js
 *
 * Connects to Intiface Central (or any Buttplug server) via WebSocket.
 * Scans for devices and exposes a sendLinear() method that maps funscript
 * positions to compatible devices (linear actuators, vibrators, rotators).
 *
 * Usage:
 *   const bp = useButtplug()
 *   await bp.connect('ws://localhost:12345')
 *   bp.sendLinear(channel, position01, durationMs)
 */

import { ref, computed } from 'vue'
import {
  ButtplugClient,
  ButtplugClientDevice,
  ButtplugBrowserWebsocketClientConnector,
  DeviceOutput,
  OutputType,
} from 'buttplug'
import { useDeviceStore } from '@/stores/deviceStore'
import { logCommand } from '@/lib/serialLog'

// ─── Singleton ────────────────────────────────────────────────────────────────
let client: ButtplugClient | null = null

// ─── Shared reactive state ────────────────────────────────────────────────────
const connected = ref(false)
const scanning = ref(false)
const devices = ref<ButtplugClientDevice[]>([])
const error = ref<string | null>(null)
const serverUrl = ref(localStorage.getItem('bp:url') ?? 'ws://localhost:12345')
const enabled = ref(localStorage.getItem('bp:enabled') === 'true')

export function useButtplug() {
  const deviceStore = useDeviceStore()

  async function connect(url = serverUrl.value) {
    if (client) await disconnect()
    error.value = null
    try {
      client = new ButtplugClient('MWHOPlayer')

      client.addListener('deviceadded', (d: ButtplugClientDevice) => {
        devices.value = [...devices.value, d]
      })
      client.addListener('deviceremoved', (d: ButtplugClientDevice) => {
        devices.value = devices.value.filter(x => x.index !== d.index)
      })
      client.addListener('disconnect', () => {
        connected.value = false
        devices.value = []
      })

      // Use Browser WebSocket connector (works in browser, not Node)
      const connector = new ButtplugBrowserWebsocketClientConnector(url)
      await client.connect(connector)
      connected.value = true
      serverUrl.value = url
      localStorage.setItem('bp:url', url)
      // client.devices is a Map<number, ButtplugClientDevice>
      devices.value = [...(client.devices as unknown as Map<number, ButtplugClientDevice>).values()]
    } catch (e: any) {
      error.value = e?.message ?? 'Connection failed'
      client = null
    }
  }

  async function disconnect() {
    try { await client?.disconnect() } catch {}
    client = null
    connected.value = false
    devices.value = []
  }

  async function startScan() {
    if (!client) return
    scanning.value = true
    try { await client.startScanning() } catch (e: any) { error.value = e?.message }
    setTimeout(async () => {
      try { await client?.stopScanning() } catch {}
      scanning.value = false
    }, 5000)
  }

  async function stopScan() {
    scanning.value = false
    try { await client?.stopScanning() } catch {}
  }

  /**
   * Send a position to all linear devices. position: 0–1, durationMs: movement time.
   * Called every frame from useFunscript alongside TCode sends.
   */
  async function sendLinear(position: number, durationMs: number) {
    if (!enabled.value || !connected.value || devices.value.length === 0) return

    const axisConfig = deviceStore.axisConfigs['L0']
    let pos = position
    if (axisConfig) {
      const range = axisConfig.max - axisConfig.min
      pos = axisConfig.min + pos * range
      if (axisConfig.invert) pos = axisConfig.min + axisConfig.max - pos
    }
    pos = Math.max(0, Math.min(1, pos))
    const dur = Math.max(50, Math.round(durationMs))

    logCommand(`[BP] pos=${pos.toFixed(3)} dur=${dur}ms`)

    for (const device of devices.value) {
      try {
        if (device.hasOutput(OutputType.PositionWithDuration)) {
          // Linear stroker (OSR2, Handy, etc.) — percent 0–1, duration in ms
          await device.runOutput(DeviceOutput.PositionWithDuration.percent(pos, dur))
        } else if (device.hasOutput(OutputType.Vibrate)) {
          // Vibrator — use position as intensity
          await device.runOutput(DeviceOutput.Vibrate.percent(pos))
        }
      } catch {
        // device might have disconnected mid-play, ignore
      }
    }
  }

  async function stopAll() {
    for (const device of devices.value) {
      try { await device.stop() } catch {}
    }
  }

  function setEnabled(val: boolean) {
    enabled.value = val
    localStorage.setItem('bp:enabled', val ? 'true' : 'false')
  }

  const deviceCount = computed(() => devices.value.length)
  const hasLinear = computed(() => devices.value.some(d => d.hasOutput(OutputType.PositionWithDuration)))
  const hasVibrators = computed(() => devices.value.some(d => d.hasOutput(OutputType.Vibrate)))

  return {
    connected, scanning, devices, error, serverUrl, enabled,
    deviceCount, hasLinear, hasVibrators,
    connect, disconnect, startScan, stopScan,
    sendLinear, stopAll, setEnabled,
  }
}
