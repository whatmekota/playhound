import type { AxisLimits } from '~/lib/tcodeEncoder'
import { logCommand } from '~/lib/serialLog'
import { encodeTCode } from '~/lib/tcodeEncoder'
import { useDeviceStore } from '~/stores/deviceStore'
import { useSerialPort } from './useSerialPort'

let emuInstance: { write: (s: string) => void } | null = null
export function setEmuInstance(inst: { write: (s: string) => void } | null) { emuInstance = inst }
export const setEmuRef = setEmuInstance

// Per-axis rate limiting: don't flood the serial port (min 33ms between writes per axis)
const lastSentAt: Record<string, number> = {}
const SEND_INTERVAL_MS = 33 // ~30 Hz max per axis

export function useTCode() {
  const deviceStore = useDeviceStore()
  const { write } = useSerialPort()

  function sendPosition(channel: string, position: number, interval: number) {
    const axisCfg = deviceStore.axisConfigs[channel]
    const ver = deviceStore.tcodeVersion
    const limits: AxisLimits = axisCfg
      ? { min: axisCfg.min, max: axisCfg.max, invert: axisCfg.invert }
      : { min: 0, max: 1, invert: false }

    const cmd = encodeTCode({ channel, position, interval }, limits, ver)

    logCommand(cmd)
    emuInstance?.write(cmd)

    if (!axisCfg || !deviceStore.connected || !deviceStore.deviceEnabled || !axisCfg.enabled)
      return

    // Rate-limit per axis — skip if sent too recently
    const now = performance.now()
    if ((now - (lastSentAt[channel] ?? 0)) < SEND_INTERVAL_MS)
      return
    lastSentAt[channel] = now

    // Fire-and-forget — do NOT await, RAF can't block waiting for serial
    write(cmd).catch(e => console.warn('Serial write error:', e.message))
  }

  async function homeAllAxes(interval = 500) {
    const ver = deviceStore.tcodeVersion
    const channels = new Set([...deviceStore.enabledAxes.map(a => a.channel), 'L0'])
    for (const channel of channels) {
      const axisCfg = deviceStore.axisConfigs[channel]
      if (!axisCfg)
        continue
      const limits: AxisLimits = { min: axisCfg.min, max: axisCfg.max, invert: axisCfg.invert }
      const cmd = encodeTCode({ channel, position: axisCfg.defaultPos, interval }, limits, ver)
      logCommand(cmd)
      emuInstance?.write(cmd)
    }
    if (deviceStore.connected && deviceStore.deviceEnabled) {
      const cmds = [...channels].map((ch) => {
        const a = deviceStore.axisConfigs[ch]
        if (!a)
          return ''
        const limits: AxisLimits = { min: a.min, max: a.max, invert: a.invert }
        return encodeTCode({ channel: ch, position: a.defaultPos, interval }, limits, ver)
      }).filter(Boolean).join('')
      await write(cmds)
    }
  }

  async function testAxis(channel: string) {
    const axisCfg = deviceStore.axisConfigs[channel]
    if (!axisCfg)
      return
    const ver = deviceStore.tcodeVersion
    const limits: AxisLimits = { min: axisCfg.min, max: axisCfg.max, invert: axisCfg.invert }
    const send = (pos: number, ivl: number) => {
      const cmd = encodeTCode({ channel, position: pos, interval: ivl }, limits, ver)
      logCommand(cmd)
      emuInstance?.write(cmd)
      if (deviceStore.connected)
        write(cmd).catch(() => {})
    }
    send(0, 1000)
    setTimeout(() => send(1, 1000), 1100)
    setTimeout(() => send(axisCfg.defaultPos, 500), 2200)
  }

  return { sendPosition, homeAllAxes, testAxis }
}
