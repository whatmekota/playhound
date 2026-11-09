import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTCode } from '~/composables/useTCode'
import { netDisconnect, useTCodeNet } from '~/composables/useTCodeNet'
import { encodeTCode } from '~/lib/tcodeEncoder'
import { RESUME_MS } from '~/lib/tcodeNet'
import { useDeviceStore } from '~/stores/deviceStore'

/** Just enough of a WebSocket to see what is sent and to open and drop it. */
class FakeSocket {
  static all: FakeSocket[] = []
  static OPEN = 1
  readyState = 0
  bufferedAmount = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  constructor(public url: string) {
    FakeSocket.all.push(this)
  }

  send(m: string) {
    this.sent.push(m)
  }

  close() {
    this.readyState = 3
  }

  open() {
    this.readyState = 1
    this.onopen?.()
  }

  drop() {
    this.readyState = 3
    this.onclose?.()
  }
}

function last() {
  return FakeSocket.all[FakeSocket.all.length - 1]
}

describe('tCode over a WebSocket', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] })
    vi.stubGlobal('WebSocket', FakeSocket)
    FakeSocket.all = []
    setActivePinia(createPinia())
    localStorage.clear()
  })
  afterEach(() => {
    netDisconnect()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  async function connectRestim() {
    const net = useTCodeNet()
    net.applyPreset('restim-ws')
    net.settings.value = { ...net.settings.value, link: 'network' }
    expect(await net.connect()).toBe(true)
    expect(last().url).toBe('ws://localhost:12346/tcode')
    expect(net.status.value).toBe('connecting')
    last().open()
    return net
  }

  it('connects, says hello, and sends the same commands serial would', async () => {
    const net = await connectRestim()
    const device = useDeviceStore()
    expect(net.status.value).toBe('connected')
    expect(device.connected).toBe(true)
    expect(device.portPath).toBe('WebSocket localhost:12346/tcode')
    expect(last().sent).toEqual(['D0\n'])

    const { sendPosition } = useTCode()
    const limits = { min: device.axisConfigs.L0.min, max: device.axisConfigs.L0.max, invert: false }

    // The first move after the link comes up glides over RESUME_MS, counted from that move.
    vi.advanceTimersByTime(100)
    sendPosition('L0', 0.8, 50)
    expect(last().sent[1]).toBe(encodeTCode({ channel: 'L0', position: 0.8, interval: RESUME_MS }, limits, 'v3'))

    // Then exactly what the serial port gets.
    vi.advanceTimersByTime(RESUME_MS + 10)
    sendPosition('L0', 0.3, 50)
    expect(last().sent[2]).toBe(encodeTCode({ channel: 'L0', position: 0.3, interval: 50 }, limits, 'v3'))
    expect(device.lastCommand).toBe(last().sent[2].trim())
  })

  it('homes every axis on one line, as panic and stop do', async () => {
    await connectRestim()
    const device = useDeviceStore()
    device.axisConfigs.R0.enabled = true
    await useTCode().homeAllAxes(400)
    const line = last().sent[last().sent.length - 1]
    expect(line.endsWith('\n')).toBe(true)
    const home = (ch: 'L0' | 'R0') => {
      const a = device.axisConfigs[ch]
      return encodeTCode({ channel: ch, position: a.defaultPos, interval: 400 }, { min: a.min, max: a.max, invert: a.invert }, 'v3').trim()
    }
    expect(line.trim().split(' ').sort()).toEqual([home('L0'), home('R0')])
  })

  it('reconnects with backoff after a drop, and stops trying on disconnect', async () => {
    const net = await connectRestim()
    const device = useDeviceStore()
    last().drop()
    expect(net.status.value).toBe('reconnecting')
    expect(device.connected).toBe(false)
    expect(net.error.value).toMatch(/Lost the connection/)

    // Nothing is sent while it is down.
    const before = FakeSocket.all.length
    useTCode().sendPosition('L0', 0.5, 50)
    expect(FakeSocket.all.length).toBe(before)

    // First retry within 1 s ± 20%.
    vi.advanceTimersByTime(1250)
    expect(FakeSocket.all.length).toBe(before + 1)
    last().drop()
    // Still never up: the second wait is longer.
    expect(net.status.value).toBe('reconnecting')
    vi.advanceTimersByTime(1250)
    expect(FakeSocket.all.length).toBe(before + 1)
    vi.advanceTimersByTime(1300)
    expect(FakeSocket.all.length).toBe(before + 2)
    last().open()
    expect(net.status.value).toBe('connected')
    expect(net.attempt.value).toBe(0)
    expect(device.connected).toBe(true)

    net.disconnect()
    expect(device.connected).toBe(false)
    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.all.length).toBe(before + 2)
  })

  it('reports a first connection that fails instead of retrying it', async () => {
    const net = useTCodeNet()
    net.settings.value = { ...net.settings.value, link: 'network', preset: 'custom', protocol: 'ws', address: 'ws://192.168.1.99/ws' }
    await net.connect()
    last().drop()
    expect(net.status.value).toBe('idle')
    expect(net.error.value).toMatch(/Could not connect/)
    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.all.length).toBe(1)
  })

  it('gives up on a socket that never opens', async () => {
    const net = useTCodeNet()
    net.applyPreset('esp32-ws')
    await net.connect()
    vi.advanceTimersByTime(5100)
    expect(net.status.value).toBe('idle')
    expect(net.error.value).toMatch(/No answer/)
  })

  it('refuses UDP in a browser, and bad addresses, before trying', async () => {
    const net = useTCodeNet()
    net.applyPreset('esp32-udp')
    expect(await net.connect()).toBe(false)
    expect(net.error.value).toMatch(/desktop app/)
    net.settings.value = { ...net.settings.value, preset: 'custom', protocol: 'ws', address: 'not a host' }
    expect(await net.connect()).toBe(false)
    expect(FakeSocket.all.length).toBe(0)
  })
})
