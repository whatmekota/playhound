/**
 * TCode over the network: a WebSocket (browser and desktop app) or UDP
 * (desktop app, through desktop/tcodenet.mjs), beside Web Serial.
 *
 * It runs beside the serial port, not instead of it (an OSR on USB and restim
 * on the network, say): each link has its own flag in the device store
 * (`serialUp`, `netUp`) and `deviceStore.connected` is either, so everything
 * that sends TCode (useTCode) and everything that asks whether a device is
 * there sees one TCode device. The axis ranges, inversion, rest positions,
 * presets, latency and update rate apply unchanged: useTCode encodes exactly
 * as for serial and hands the text to both links (netWrite here), and each
 * open one sends it.
 *
 * A link that was up and drops is tried again by itself, after 1, 2, 4, 8 and
 * then every 15 seconds, until it comes back or the user disconnects. A
 * first connection that fails is reported instead, since the address is
 * usually wrong.
 */

import type { NetPresetId, NetProtocol, NetTarget } from '~/lib/tcodeNet'
import { useLocalStorage } from '@vueuse/core'
import { effectScope, ref, shallowRef } from 'vue'
import { desktop } from '~/lib/browserApi'
import { KEYS } from '~/lib/persist'
import { describeTarget, mixedContentBlocked, OPEN_TIMEOUT_MS, parseAddress, presetById, retryDelay, toNetMessages, wsUrl } from '~/lib/tcodeNet'
import { useDeviceStore } from '~/stores/deviceStore'

export type TcodeLink = 'usb' | 'network'

export interface TcodeNetSettings {
  /** Which link the TCode tab shows: the USB port or the network. */
  link: TcodeLink
  preset: NetPresetId
  protocol: NetProtocol
  /** As typed: `tcode.local:8000`, `ws://localhost:12346/tcode`. */
  address: string
}

export const udpAvailable = !!desktop?.tcode

function defaults(): TcodeNetSettings {
  const p = presetById(udpAvailable ? 'esp32-udp' : 'esp32-ws')!
  return { link: 'usb', preset: p.id, protocol: p.target!.protocol, address: p.target!.protocol === 'ws' ? wsUrl(p.target!) : `${p.target!.host}:${p.target!.port}` }
}

export type NetStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting'

// ─── Shared state ─────────────────────────────────────────────────────────────

let settingsRef: ReturnType<typeof useLocalStorage<TcodeNetSettings>> | null = null
function settings() {
  // In a scope of its own: made inside a panel, it must outlive the panel.
  settingsRef ??= effectScope(true).run(() => useLocalStorage<TcodeNetSettings>(KEYS.tcodeNet.key, defaults(), { mergeDefaults: true }))!
  return settingsRef
}

const status = ref<NetStatus>('idle')
const error = ref<string | null>(null)
/** Reconnect attempts since the link dropped. */
const attempt = ref(0)
/** When the next attempt is due (performance.now()), while reconnecting. */
const retryAt = ref(0)
/** The device's answer to D0, when it gives one (TCode ESP32 does). */
const reply = ref<string | null>(null)
const target = shallowRef<NetTarget | null>(null)

let ws: WebSocket | null = null
let udpId: number | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let openTimer: ReturnType<typeof setTimeout> | null = null
/** Bumped on every open and close, so a late callback from an old socket is ignored. */
let gen = 0
/** The user wants a link: drops are retried. */
let wanted = false
/** It has been up since the user connected: a failure now is a drop, not a wrong address. */
let wasUp = false
/** This link set deviceStore.netUp, so it is the one to clear it. */
let holding = false
let store: ReturnType<typeof useDeviceStore> | null = null

/** A WebSocket with more than this waiting has fallen behind: skip frames rather than queue stale moves. */
const WS_BACKLOG = 16 * 1024

let udpWired = false
function wireUdp() {
  if (udpWired || !desktop?.tcode)
    return
  udpWired = true
  desktop.tcode.onUdpError((id, message) => {
    if (id !== udpId)
      return
    udpId = null
    down(message)
  })
  desktop.tcode.onUdpMessage((id, text) => {
    if (id === udpId)
      noteReply(text)
  })
}

function noteReply(text: string) {
  // TCode ESP32 also pushes JSON status over its WebSocket; only plain lines answer D0.
  const line = text.split(/\r?\n/).map(s => s.trim()).find(s => s && !s.startsWith('{'))
  if (line)
    reply.value = line.slice(0, 80)
}

function clearTimers() {
  if (retryTimer)
    clearTimeout(retryTimer)
  if (openTimer)
    clearTimeout(openTimer)
  retryTimer = null
  openTimer = null
}

function closeSockets() {
  const w = ws
  ws = null
  if (w) {
    w.onopen = w.onclose = w.onerror = w.onmessage = null
    try {
      w.close()
    }
    catch {}
  }
  if (udpId !== null) {
    desktop?.tcode?.udpClose(udpId)
    udpId = null
  }
}

function release() {
  if (holding && store) {
    store.netUp = false
  }
  holding = false
}

function up(t: NetTarget) {
  clearTimers()
  status.value = 'connected'
  attempt.value = 0
  error.value = null
  wasUp = true
  if (store) {
    store.netUp = true
    store.netPath = `${t.protocol === 'ws' ? 'WebSocket' : 'UDP'} ${describeTarget(t)}`
    store.connectionError = null
  }
  holding = true
  // Ask who is there. TCode ESP32 answers with its firmware; restim ignores it.
  sendRaw('D0\n')
}

function down(message: string) {
  gen++
  clearTimers()
  closeSockets()
  release()
  if (store)
    store.connectionError = message
  if (wanted && wasUp) {
    status.value = 'reconnecting'
    error.value = message
    const wait = retryDelay(attempt.value, Math.random())
    attempt.value++
    retryAt.value = performance.now() + wait
    retryTimer = setTimeout(() => void open(), wait)
  }
  else {
    wanted = false
    status.value = 'idle'
    error.value = message
  }
}

async function open() {
  const t = target.value
  if (!t)
    return
  const g = ++gen
  clearTimers()
  closeSockets()
  if (status.value !== 'reconnecting')
    status.value = 'connecting'
  const label = describeTarget(t)

  if (t.protocol === 'udp') {
    if (!desktop?.tcode) {
      down('UDP needs the desktop app. In the browser, use a WebSocket.')
      return
    }
    wireUdp()
    const res = await desktop.tcode.udpOpen(t.host, t.port)
    if (g !== gen) {
      if (res.id !== undefined)
        desktop.tcode.udpClose(res.id)
      return
    }
    if (res.error !== undefined) {
      down(res.error)
      return
    }
    udpId = res.id
    up(t)
    return
  }

  let socket: WebSocket
  try {
    socket = new WebSocket(wsUrl(t))
  }
  catch (e: any) {
    down(e?.message ?? `Could not open ${label}`)
    return
  }
  ws = socket
  openTimer = setTimeout(() => {
    if (g === gen)
      down(`No answer from ${label}`)
  }, OPEN_TIMEOUT_MS)
  socket.onopen = () => {
    if (g === gen)
      up(t)
  }
  socket.onmessage = (e) => {
    if (g === gen && typeof e.data === 'string')
      noteReply(e.data)
  }
  socket.onclose = () => {
    if (g === gen)
      down(wasUp && status.value === 'connected' ? `Lost the connection to ${label}` : `Could not connect to ${label}`)
  }
}

function sendRaw(text: string) {
  if (status.value !== 'connected')
    return
  for (const m of toNetMessages(text)) {
    if (ws) {
      if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > WS_BACKLOG)
        return
      ws.send(m)
    }
    else if (udpId !== null) {
      desktop?.tcode?.udpSend(udpId, m)
    }
  }
}

/**
 * Send what the serial port would get (each command ending in `\n`).
 * Nothing happens unless a network link is up. Never throws.
 */
export async function netWrite(data: string): Promise<void> {
  if (status.value !== 'connected')
    return
  if (store)
    store.lastCommand = data.trim()
  try {
    sendRaw(data)
  }
  catch (e: any) {
    console.warn('TCode network write failed:', e?.message)
  }
}

/** Close the network link, if any, without retrying. */
export function netDisconnect() {
  wanted = false
  wasUp = false
  gen++
  clearTimers()
  closeSockets()
  release()
  status.value = 'idle'
  attempt.value = 0
  reply.value = null
}

export function useTCodeNet() {
  store = useDeviceStore()
  const s = settings()

  /** Check the address in the settings; null when it is fine, else what is wrong. */
  function check(): { target: NetTarget, error?: undefined } | { error: string, target?: undefined } {
    const preset = presetById(s.value.preset)
    const fallbackPath = preset?.target?.protocol === 'ws' ? preset.target.path : ''
    const parsed = parseAddress(s.value.address, s.value.protocol, fallbackPath)
    if (!parsed.ok)
      return { error: parsed.error }
    const t = parsed.target
    if (t.protocol === 'udp' && !udpAvailable)
      return { error: 'UDP needs the desktop app. In the browser, use a WebSocket (TCode ESP32 serves one at /ws).' }
    if (typeof location !== 'undefined' && mixedContentBlocked(location.protocol, t))
      return { error: 'This page is served over https, so the browser will not open a ws:// link to another device. Use the desktop app, or run playhound from source.' }
    return { target: t }
  }

  async function connect() {
    const c = check()
    if (c.error !== undefined) {
      error.value = c.error
      return false
    }
    netDisconnect()
    target.value = c.target
    error.value = null
    reply.value = null
    wanted = true
    wasUp = false
    await open()
    return true
  }

  function applyPreset(id: NetPresetId) {
    const p = presetById(id)
    if (!p)
      return
    if (!p.target) {
      s.value = { ...s.value, preset: id }
      return
    }
    const t = p.target
    s.value = { ...s.value, preset: id, protocol: t.protocol, address: t.protocol === 'ws' ? wsUrl(t) : `${t.host}:${t.port}` }
  }

  return {
    settings: s,
    status,
    error,
    attempt,
    retryAt,
    reply,
    target,
    udpAvailable,
    check,
    connect,
    disconnect: netDisconnect,
    applyPreset,
  }
}
