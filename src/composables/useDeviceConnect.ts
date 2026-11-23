import type { Ref } from 'vue'
import { useLocalStorage } from '@vueuse/core'
import { computed, ref, watch } from 'vue'
import { useButtplug } from '~/composables/useButtplug'
import { useHandy } from '~/composables/useHandy'
import { useSerialPort } from '~/composables/useSerialPort'
import { useTCode } from '~/composables/useTCode'
import { useTCodeNet } from '~/composables/useTCodeNet'
import { toast } from '~/composables/useToast'
import { intifaceUrl, phoneIntifaceField } from '~/lib/android/intiface'
import { webSerial } from '~/lib/browserApi'
import { KEYS } from '~/lib/persist'
import { isAndroidApp, MISSING } from '~/lib/platform'
import { useDeviceStore } from '~/stores/deviceStore'

/**
 * Connecting a device: which link is picked, each link's connect with what to
 * tell the user when it fails, the status line, and a test stroke. Shared by
 * the Device panel and the first-run setup, so both say the same things and
 * leave the same settings behind (the setup's pick is where the panel opens).
 */

export type Transport = 'serial' | 'buttplug' | 'handy'
export type Tone = 'ok' | 'info' | 'warn' | 'danger' | 'idle'

export const TONE_DOT: Record<Tone, string> = {
  ok: 'bg-ok text-ok',
  info: 'bg-info text-info',
  warn: 'bg-warn text-warn',
  danger: 'bg-danger text-danger',
  idle: 'bg-fg-faint text-fg-faint',
}
export const TONE_TILE: Record<Tone, string> = {
  ok: 'bg-ok/12 text-ok',
  info: 'bg-info/12 text-info',
  warn: 'bg-warn/12 text-warn',
  danger: 'bg-danger/12 text-danger',
  idle: 'bg-surface-800 text-fg-muted',
}

/** Browser error strings are written for developers; say what to actually do. */
export function explainSerialError(msg: string) {
  if (/failed to open/i.test(msg))
    return 'The port is busy. Close anything else using it (another tab, MultiFunPlayer, a serial monitor) and try again.'
  if (/disconnected|device lost|closed/i.test(msg))
    return 'The device went away. Check the USB cable, then reconnect.'
  if (/not supported/i.test(msg))
    return 'This browser has no Web Serial. Use Chrome or Edge.'
  return msg
}

// One of each for every caller: the panel and the setup show the same address
// being typed and the same connect under way.
let bpUrl: Ref<string> | null = null
const bpConnecting = ref(false)
/** A disconnect asked for, so the link going down is no surprise. */
let leaving = false
let handySweep: ReturnType<typeof setTimeout>[] = []

export function useDeviceConnect() {
  const device = useDeviceStore()
  const bp = useButtplug()
  const handy = useHandy()
  const net = useTCodeNet()
  const { requestAndConnect, disconnect, connecting } = useSerialPort()
  const { testAxis } = useTCode()

  const transport = useLocalStorage<Transport>(KEYS.deviceTransport.key, 'serial')

  // ─── TCode: USB (Web Serial) or the network ──────────────────────────────────
  const tcodeNet = computed(() => net.settings.value.link === 'network')
  function setTcodeLink(link: 'usb' | 'network') {
    net.settings.value = { ...net.settings.value, link }
  }

  async function connectSerial() {
    await requestAndConnect(device.baudRate)
    if (device.connected) {
      toast.success('Device connected', { detail: `${device.baudRate} baud · TCode ${device.tcodeVersion}`, icon: 'i-carbon-plug-filled', key: 'serial' })
    }
    else if (device.connectionError) {
      toast.error('Could not connect', { detail: explainSerialError(device.connectionError), key: 'serial' })
    }
    // A cancelled port picker leaves neither, and deserves no toast.
  }

  async function disconnectSerial() {
    leaving = true
    await disconnect()
    leaving = false
    toast('Device disconnected', { icon: 'i-carbon-plug', key: 'serial' })
  }

  /** Say so when the read loop drops the link (the cable pulled). A network link says so itself, and reconnects on its own. */
  function watchSerialLoss() {
    watch(() => device.serialUp, (now, was) => {
      if (was && !now && !leaving) {
        toast.warn('Device connection lost', {
          detail: explainSerialError(device.connectionError ?? 'disconnected'),
          key: 'serial',
          action: { label: 'Reconnect', run: () => void connectSerial() },
        })
      }
    })
  }

  // ─── Intiface (the Buttplug protocol) ────────────────────────────────────────
  // On the phone, Intiface runs on the PC: the desktop's localhost default means nothing there.
  bpUrl ??= ref(isAndroidApp ? phoneIntifaceField(bp.serverUrl.value) : bp.serverUrl.value)
  const url = bpUrl

  async function connectIntiface() {
    let to = url.value.trim() || 'ws://localhost:12345'
    if (isAndroidApp) {
      const r = intifaceUrl(url.value)
      if (r.url === null) {
        toast.error('Where is Intiface?', { detail: r.problem, key: 'bp' })
        return
      }
      to = url.value = r.url
    }
    bpConnecting.value = true
    try {
      await bp.connect(to)
    }
    finally {
      bpConnecting.value = false
    }
    if (bp.connected.value) {
      toast.success('Connected to Intiface', { detail: bp.deviceCount.value ? `${bp.deviceCount.value} device(s) ready` : 'Scan to find your devices', icon: 'i-brand-intiface', key: 'bp' })
      if (!bp.deviceCount.value)
        void bp.startScan()
    }
    else {
      toast.error('Could not reach Intiface', {
        detail: isAndroidApp
          ? `Nothing answered at ${url.value}. Is Intiface Central's server started on the PC, set to listen on all network interfaces, and is the phone on the same Wi-Fi? A firewall on the PC may also be blocking port ${new URL(url.value).port || 12345}.`
          : `Is Intiface Central running with its server started at ${url.value}?`,
        key: 'bp',
      })
    }
  }

  async function disconnectIntiface() {
    await bp.disconnect()
    toast('Disconnected from Intiface', { icon: 'i-carbon-bluetooth-off', key: 'bp' })
  }

  // ─── The Handy (WiFi or Bluetooth) ───────────────────────────────────────────
  const handyBle = computed(() => handy.link.value === 'ble')
  const handyBusy = computed(() => handy.state.value === 'connecting')

  async function connectHandy() {
    await handy.connect()
    const i = handy.info.value
    if (handy.connected.value)
      toast.success('Connected to the Handy', { detail: i ? [i.model, i.firmware && `firmware ${i.firmware}`, handyBle.value ? 'Bluetooth' : 'WiFi'].filter(Boolean).join(' · ') : undefined, icon: handyBle.value ? 'i-carbon-bluetooth' : 'i-carbon-wifi', key: 'handy' })
    else if (handy.error.value)
      toast.error('Could not connect to the Handy', { detail: handy.error.value, key: 'handy' })
  }

  async function disconnectHandy() {
    await handy.disconnect()
    toast('Disconnected from the Handy', { icon: handyBle.value ? 'i-carbon-bluetooth-off' : 'i-carbon-wifi-off', key: 'handy' })
  }

  // ─── Where the picked link stands ────────────────────────────────────────────
  const serialSummary = computed(() => `${device.baudRate} baud · TCode ${device.tcodeVersion}`)

  const status = computed<{ tone: Tone, label: string, detail: string }>(() => {
    if (transport.value === 'serial' && tcodeNet.value) {
      const where = net.target.value ? net.settings.value.address : ''
      switch (net.status.value) {
        case 'connecting':
          return { tone: 'info', label: 'Connecting…', detail: `Reaching ${where}` }
        case 'reconnecting':
          return { tone: 'warn', label: 'Reconnecting…', detail: net.error.value ?? `Trying ${where} again` }
        case 'connected':
          return device.deviceEnabled
            ? { tone: 'ok', label: 'Connected', detail: `${device.netPath} · TCode ${device.tcodeVersion}` }
            : { tone: 'warn', label: 'Connected, output held', detail: 'Device output is switched off' }
      }
      return { tone: 'idle', label: 'Not connected', detail: net.udpAvailable ? 'An ESP32 build on WiFi, or restim' : 'An ESP32 build on WiFi (WebSocket), or restim' }
    }
    if (transport.value === 'serial') {
      if (connecting.value)
        return { tone: 'info', label: 'Connecting…', detail: isAndroidApp ? 'Pick the device in the list' : 'Pick the port in the browser dialog' }
      if (device.serialUp) {
        return device.deviceEnabled
          ? { tone: 'ok', label: 'Connected', detail: `${device.portPath || 'Serial port'} · ${serialSummary.value}` }
          : { tone: 'warn', label: 'Connected, output held', detail: 'Device output is switched off' }
      }
      if (!webSerial.supported)
        return { tone: 'danger', label: 'Web Serial unavailable', detail: MISSING.serialShort }
      return { tone: 'idle', label: 'Not connected', detail: 'Plug the device in by USB, then connect' }
    }
    if (transport.value === 'handy') {
      const via = handyBle.value ? 'Bluetooth' : 'WiFi'
      if (handyBusy.value)
        return { tone: 'info', label: 'Connecting…', detail: handyBle.value ? 'Reaching the Handy over Bluetooth' : 'Reaching the Handy through Handy\'s server' }
      if (handy.connected.value) {
        if (!handy.enabled.value)
          return { tone: 'warn', label: 'Connected, output held', detail: '"Send to device" is off' }
        return { tone: 'ok', label: 'Connected', detail: handy.info.value ? `${handy.info.value.model} · ${via}` : via }
      }
      if (handyBle.value && !handy.bluetoothSupported)
        return { tone: 'danger', label: 'Web Bluetooth unavailable', detail: MISSING.bluetoothShort }
      return { tone: 'idle', label: 'Not connected', detail: handyBle.value ? 'Turn the Handy on, then connect' : 'Enter the connection key from the Handy app' }
    }
    if (bpConnecting.value)
      return { tone: 'info', label: 'Connecting…', detail: url.value }
    if (bp.connected.value) {
      const n = bp.deviceCount.value
      if (!bp.enabled.value)
        return { tone: 'warn', label: 'Connected, output held', detail: '"Send to devices" is off' }
      return { tone: n ? 'ok' : 'warn', label: n ? 'Connected' : 'No devices yet', detail: n ? `Intiface · ${n} device${n === 1 ? '' : 's'}` : 'Scan, then wake the toy' }
    }
    return { tone: 'idle', label: 'Not connected', detail: 'Start Intiface Central, then connect' }
  })

  /** Connected but nothing is sent: worth a button right where it says so. */
  const held = computed(() => {
    if (transport.value === 'serial')
      return device.connected && !device.deviceEnabled
    if (transport.value === 'handy')
      return handy.connected.value && !handy.enabled.value
    return bp.connected.value && !bp.enabled.value
  })
  function releaseOutput() {
    if (transport.value === 'serial')
      device.deviceEnabled = true
    else if (transport.value === 'handy')
      handy.setEnabled(true)
    else
      bp.setEnabled(true)
  }

  // ─── A test stroke ───────────────────────────────────────────────────────────
  /**
   * Bottom, top, then back to rest on one axis, on everything connected that
   * moves it: TCode (and the emulator), the Handy, and Intiface's strokers on
   * the stroke axis; a vibrating toy buzzes for the length of it instead.
   * Returns whether a device got it, rather than only the emulator.
   */
  function testStroke(ch = 'L0'): boolean {
    void testAxis(ch)
    let reached = device.connected
    if (ch !== 'L0')
      return reached
    handySweep.forEach(clearTimeout)
    handySweep = []
    if (handy.connected.value && handy.enabled.value) {
      reached = true
      handy.liveMove(0, 1000)
      handySweep.push(
        setTimeout(() => handy.liveMove(1, 1000), 1100),
        setTimeout(() => handy.liveRest(500), 2200),
      )
    }
    if (bp.connected.value && bp.enabled.value && bp.deviceCount.value) {
      reached = true
      if (bp.hasLinear.value) {
        void bp.sendLinear(0, 1000)
        handySweep.push(
          setTimeout(() => void bp.sendLinear(1, 1000), 1100),
          setTimeout(() => void bp.sendLinear(device.axisConfigs.L0?.defaultPos ?? 0.5, 500), 2200),
        )
      }
      for (const d of bp.strengthToys.value) {
        void bp.sendStrength(d, 0.4).catch(() => {})
        handySweep.push(setTimeout(() => void bp.sendStrength(d, 0).catch(() => {}), 2200))
      }
    }
    return reached
  }

  return {
    transport,
    tcodeNet,
    setTcodeLink,
    serialConnecting: connecting,
    connectSerial,
    disconnectSerial,
    watchSerialLoss,
    serialSummary,
    bpUrl: url,
    bpConnecting,
    connectIntiface,
    disconnectIntiface,
    handyBle,
    handyBusy,
    connectHandy,
    disconnectHandy,
    status,
    held,
    releaseOutput,
    testStroke,
  }
}
