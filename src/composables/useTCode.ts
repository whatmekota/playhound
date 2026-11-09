import type { AxisLimits } from '~/lib/tcodeEncoder'
import { logCommand } from '~/lib/serialLog'
import { encodeTCode, SEND_INTERVAL_MS } from '~/lib/tcodeEncoder'
import { resumeInterval } from '~/lib/tcodeNet'
import { useDeviceStore } from '~/stores/deviceStore'
import { useSerialPort } from './useSerialPort'
import { netWrite } from './useTCodeNet'

let emuInstance: { write: (s: string) => void } | null = null
export function setEmuInstance(inst: { write: (s: string) => void } | null) { emuInstance = inst }
export const setEmuRef = setEmuInstance

/**
 * Last position sent per axis, after range and inversion: where the hardware
 * is being told to be, 0-1. A plain object rather than a ref on purpose - it
 * changes every frame, and the panels that show it read it on their own
 * animation frame instead of re-rendering through Vue.
 */
export const axisOutput: Record<string, number> = {}

/**
 * Every position any part of the app sends, before range and inversion:
 * script, generators, plugins, derived axes, homing. The session recorder
 * listens here; null when nothing does, so it costs nothing then.
 * `intervalMs` 0 means "it is here now" (a script's reported position).
 */
export type AxisTap = (channel: string, position: number, intervalMs: number) => void
let axisTap: AxisTap | null = null
export function setAxisTap(fn: AxisTap | null) {
  axisTap = fn
}

function track(channel: string, position: number, limits: AxisLimits, intervalMs: number) {
  axisTap?.(channel, position, intervalMs)
  let p = limits.invert ? 1 - position : position
  p = limits.min + p * (limits.max - limits.min)
  axisOutput[channel] = Math.max(0, Math.min(1, p))
}

// Per-axis rate limiting: don't flood the serial port (min 33ms between writes per axis)
const lastSentAt: Record<string, number> = {}

/**
 * When the link (serial or network) last came up, or output was switched
 * back on, as seen by the first move sent after it: moves are stretched for
 * a moment then, so the device glides to the motion instead of jumping
 * (lib/tcodeNet, resumeInterval).
 */
let linkWasUp = false
let linkUpAt = Number.NEGATIVE_INFINITY

export function useTCode() {
  const deviceStore = useDeviceStore()
  const { write: serialWrite } = useSerialPort()

  /**
   * To whichever TCode link is open: the serial port or the network. Only
   * one is ever open (see useTCodeNet), and each ignores a write when closed.
   */
  async function write(data: string) {
    await Promise.all([serialWrite(data), netWrite(data)])
  }

  function sendPosition(
    channel: string,
    position: number,
    interval: number,
    opts: { reported?: number, force?: boolean } = {},
  ) {
    const axisCfg = deviceStore.axisConfigs[channel]
    const ver = deviceStore.tcodeVersion
    const limits: AxisLimits = axisCfg
      ? { min: axisCfg.min, max: axisCfg.max, invert: axisCfg.invert }
      : { min: 0, max: 1, invert: false }

    const cmd = encodeTCode({ channel, position, interval }, limits, ver)
    // A script's frame command aims ahead; `reported` is where it is now.
    track(channel, opts.reported ?? position, limits, opts.reported === undefined ? interval : 0)

    logCommand(cmd)
    emuInstance?.write(cmd)

    const now = performance.now()
    const up = deviceStore.connected && deviceStore.deviceEnabled
    if (up && !linkWasUp)
      linkUpAt = now
    linkWasUp = up

    if (!axisCfg || !up || !axisCfg.enabled)
      return

    // Rate-limit per axis — skip if sent too recently
    if (!opts.force && (now - (lastSentAt[channel] ?? 0)) < SEND_INTERVAL_MS)
      return
    lastSentAt[channel] = now

    const gentle = resumeInterval(interval, now - linkUpAt)
    const out = gentle === interval ? cmd : encodeTCode({ channel, position, interval: gentle }, limits, ver)

    // Fire-and-forget — do NOT await, RAF can't block waiting for serial
    write(out).catch(e => console.warn('TCode write error:', e.message))
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
      track(channel, axisCfg.defaultPos, limits, interval)
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
      track(channel, pos, limits, ivl)
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
