/// <reference types="web-bluetooth" />
import type { BleCharacteristicProperties, BleService, ScanResult } from '@capacitor-community/bluetooth-le'
import type { RequestOptions } from './bleMatch'
import type { PickerSession } from './picker'
import { BleClient, BluetoothLe, ScanMode } from '@capacitor-community/bluetooth-le'
import { KEYS } from '../persist'
import { canonicalUuid, lookingFor, matchesRequest, signalWords } from './bleMatch'
import { closePicker, openPicker, upsertItem } from './picker'
import { androidMajor } from './session'

/**
 * Web Bluetooth for the Android app, over @capacitor-community/bluetooth-le.
 * The WebView has no navigator.bluetooth; this is one, with the parts the
 * app uses (lib/handyBle.ts, composables/useHeartRate.ts): requestDevice
 * with filters, GATT connect, services and characteristics, read, write
 * with and without response, notifications with characteristicvaluechanged,
 * and gattserverdisconnected. shims.ts puts it on navigator.
 *
 * The browser's chooser is the app's own sheet (picker.ts), which also asks
 * for Android's permission first, in plain words, and says when Bluetooth
 * is off.
 */

const SCAN_MS = 30_000
const CONNECT_MS = 12_000
const SAVED_KEY = KEYS.androidBleDevices.key

let ready: Promise<void> | null = null
/** Devices with a link up now. */
const connectedIds = new Set<string>()

/** Android 12 and later ask for "Nearby devices"; older ones for Location. */
function modern() {
  return androidMajor() >= 12
}

/** Whether Bluetooth permission is already granted, without asking. */
export async function blePermitted(): Promise<boolean> {
  try {
    const st = await (BluetoothLe as unknown as { checkPermissions: () => Promise<Record<string, string>> }).checkPermissions()
    const need = modern() ? ['BLUETOOTH_SCAN', 'BLUETOOTH_CONNECT'] : ['ACCESS_FINE_LOCATION']
    return need.every(k => st[k] === 'granted')
  }
  catch {
    return false
  }
}

/** Set the plugin up. Asks for permission if it is not granted yet, so only from a tap. */
function initialize(): Promise<void> {
  ready ??= BleClient.initialize({ androidNeverForLocation: true }).catch((e) => {
    ready = null
    throw e
  })
  return ready
}

/** Is Bluetooth on? Null when that cannot be told (no permission yet). */
export async function bleEnabled(): Promise<boolean | null> {
  if (!(await blePermitted()))
    return null
  try {
    await initialize()
    return await BleClient.isEnabled()
  }
  catch {
    return null
  }
}

function toDataView(b: BufferSource): DataView {
  if (b instanceof DataView)
    return b
  if (ArrayBuffer.isView(b))
    return new DataView(b.buffer, b.byteOffset, b.byteLength)
  return new DataView(b as ArrayBuffer)
}

function lost(what: string, e: unknown): DOMException {
  return new DOMException(`${what}: ${(e as Error)?.message ?? e}`, 'NetworkError')
}

// ─── Devices, GATT ───────────────────────────────────────────────────────────

class NativeCharacteristic extends EventTarget {
  value: DataView | null = null
  private notifying = false

  constructor(
    readonly service: NativeService,
    readonly uuid: string,
    readonly properties: BleCharacteristicProperties,
  ) {
    super()
  }

  private get deviceId() {
    return this.service.device.id
  }

  private changed(v: DataView) {
    this.value = v
    this.dispatchEvent(new Event('characteristicvaluechanged'))
  }

  async readValue(): Promise<DataView> {
    try {
      const v = await BleClient.read(this.deviceId, this.service.uuid, this.uuid)
      this.changed(v)
      return v
    }
    catch (e) {
      throw lost('Reading from the device failed', e)
    }
  }

  writeValueWithResponse(data: BufferSource): Promise<void> {
    return BleClient.write(this.deviceId, this.service.uuid, this.uuid, toDataView(data)).catch((e) => {
      throw lost('Writing to the device failed', e)
    })
  }

  writeValueWithoutResponse(data: BufferSource): Promise<void> {
    return BleClient.writeWithoutResponse(this.deviceId, this.service.uuid, this.uuid, toDataView(data)).catch((e) => {
      throw lost('Writing to the device failed', e)
    })
  }

  /** Deprecated in Web Bluetooth, still around: with a response when it can. */
  writeValue(data: BufferSource): Promise<void> {
    return this.properties.write || !this.properties.writeWithoutResponse
      ? this.writeValueWithResponse(data)
      : this.writeValueWithoutResponse(data)
  }

  async startNotifications(): Promise<this> {
    if (this.notifying)
      return this
    try {
      await BleClient.startNotifications(this.deviceId, this.service.uuid, this.uuid, v => this.changed(v))
    }
    catch (e) {
      throw lost('The device would not send updates', e)
    }
    this.notifying = true
    this.service.device.gatt.notifying.add(this)
    return this
  }

  async stopNotifications(): Promise<this> {
    if (!this.notifying)
      return this
    this.notifying = false
    this.service.device.gatt.notifying.delete(this)
    await BleClient.stopNotifications(this.deviceId, this.service.uuid, this.uuid).catch(() => {})
    return this
  }

  /** The link went down: the plugin has forgotten its listener too. */
  dropped() {
    this.notifying = false
  }

  async getDescriptor(): Promise<never> {
    throw new DOMException('Descriptors are not available in the Android app', 'NotSupportedError')
  }
}

class NativeService {
  readonly isPrimary = true
  private chars = new Map<string, NativeCharacteristic>()

  constructor(readonly device: NativeBluetoothDevice, readonly uuid: string, private readonly info: BleService) {}

  async getCharacteristic(uuid: string | number): Promise<NativeCharacteristic> {
    const want = canonicalUuid(uuid)
    const c = this.info.characteristics.find(x => x.uuid.toLowerCase() === want)
    if (!c)
      throw new DOMException(`The device has no characteristic ${want}`, 'NotFoundError')
    let ch = this.chars.get(want)
    if (!ch) {
      ch = new NativeCharacteristic(this, want, c.properties)
      this.chars.set(want, ch)
    }
    return ch
  }

  async getCharacteristics(): Promise<NativeCharacteristic[]> {
    return Promise.all(this.info.characteristics.map(c => this.getCharacteristic(c.uuid)))
  }
}

class NativeGattServer {
  connected = false
  /** Characteristics with notifications on, to reset when the link drops. */
  readonly notifying = new Set<NativeCharacteristic>()
  private connecting: Promise<void> | null = null
  private services: BleService[] | null = null
  private wrapped = new Map<string, NativeService>()

  constructor(readonly device: NativeBluetoothDevice) {}

  async connect(): Promise<this> {
    if (this.connected)
      return this
    if (!(await blePermitted()))
      throw new DOMException('playhound no longer has the Bluetooth ("Nearby devices") permission. Connect again to allow it, or turn it on in its app settings.', 'InvalidStateError')
    await initialize()
    this.connecting ??= BleClient.connect(this.device.id, () => this.dropped(), { timeout: CONNECT_MS })
    try {
      await this.connecting
    }
    catch (e) {
      throw lost(`Could not connect to ${this.device.name ?? 'the device'}`, e)
    }
    finally {
      this.connecting = null
    }
    this.connected = true
    this.services = null
    this.wrapped.clear()
    connectedIds.add(this.device.id)
    return this
  }

  disconnect() {
    if (!this.connected)
      return
    void BleClient.disconnect(this.device.id).catch(() => {})
    this.dropped()
  }

  /** The link is down (asked for, or lost): once. */
  private dropped() {
    if (!this.connected)
      return
    this.connected = false
    connectedIds.delete(this.device.id)
    for (const c of this.notifying)
      c.dropped()
    this.notifying.clear()
    this.device.dispatchEvent(new Event('gattserverdisconnected'))
  }

  private async list(): Promise<BleService[]> {
    if (!this.connected)
      throw new DOMException('The device is not connected', 'NetworkError')
    this.services ??= await BleClient.getServices(this.device.id)
    return this.services
  }

  async getPrimaryService(uuid: string | number): Promise<NativeService> {
    const want = canonicalUuid(uuid)
    const info = (await this.list()).find(s => s.uuid.toLowerCase() === want)
    if (!info)
      throw new DOMException(`The device has no service ${want}`, 'NotFoundError')
    let s = this.wrapped.get(want)
    if (!s) {
      s = new NativeService(this.device, want, info)
      this.wrapped.set(want, s)
    }
    return s
  }

  async getPrimaryServices(): Promise<NativeService[]> {
    return Promise.all((await this.list()).map(s => this.getPrimaryService(s.uuid)))
  }
}

class NativeBluetoothDevice extends EventTarget {
  readonly gatt: NativeGattServer

  constructor(readonly id: string, public name: string | undefined) {
    super()
    this.gatt = new NativeGattServer(this)
  }

  async forget(): Promise<void> {
    this.gatt.disconnect()
    saved(saved().filter(d => d.id !== this.id))
  }

  async watchAdvertisements(): Promise<void> {
    throw new DOMException('Not available in the Android app', 'NotSupportedError')
  }
}

const devices = new Map<string, NativeBluetoothDevice>()

function deviceFor(id: string, name: string | undefined): NativeBluetoothDevice {
  let d = devices.get(id)
  if (!d) {
    d = new NativeBluetoothDevice(id, name)
    devices.set(id, d)
  }
  else if (name) {
    d.name = name
  }
  return d
}

/** Devices picked before (Web Bluetooth's "permitted devices"), for getDevices. */
function saved(next?: { id: string, name?: string }[]): { id: string, name?: string }[] {
  try {
    if (next) {
      localStorage.setItem(SAVED_KEY, JSON.stringify(next.slice(-20)))
      return next
    }
    const v = JSON.parse(localStorage.getItem(SAVED_KEY) ?? '[]')
    return Array.isArray(v) ? v : []
  }
  catch {
    return []
  }
}

/** Disconnect everything (the app is closing). */
export async function disconnectAllBle(): Promise<void> {
  await Promise.all([...connectedIds].map(id => BleClient.disconnect(id).catch(() => {})))
}

/** How many Bluetooth devices are connected right now. */
export function bleConnectedCount(): number {
  return connectedIds.size
}

// ─── The chooser ─────────────────────────────────────────────────────────────

function requestDevice(opts: RequestOptions = {}): Promise<NativeBluetoothDevice> {
  return new Promise((resolve, reject) => {
    const { title, thing } = lookingFor(opts)
    let session: PickerSession
    let scanTimer: ReturnType<typeof setTimeout> | null = null
    let done = false
    const names = new Map<string, string>()

    function finish() {
      done = true
      void stopScan()
      closePicker(session)
    }

    async function stopScan() {
      if (scanTimer !== null) {
        clearTimeout(scanTimer)
        scanTimer = null
      }
      if (session.view.scanning) {
        session.view.scanning = false
        await BleClient.stopLEScan().catch(() => {})
      }
    }

    function show(stage: 'ask' | 'blocked', message: string, action: string | null, secondary: string | null = null) {
      Object.assign(session.view, { stage, message, action, secondary, error: null, scanning: false })
    }

    async function begin() {
      if (await blePermitted())
        return afterPermission()
      session.on.action = askPermission
      session.on.secondary = undefined
      show('ask', modern()
        ? `To find ${thing}, playhound needs Android's "Nearby devices" permission. It is used for that and nothing else: playhound never asks where you are.`
        : `On this version of Android, finding Bluetooth devices needs the Location permission. playhound uses it only to find ${thing}; it never looks at where you are.`, 'Continue')
    }

    async function askPermission() {
      try {
        await initialize()
      }
      catch (e) {
        if (done)
          return
        if (await blePermitted()) {
          // Allowed, and still no Bluetooth: a phone without BLE, or a broken stack.
          session.on.action = undefined
          session.on.secondary = () => void askPermission()
          show('blocked', `Bluetooth did not start on this phone: ${(e as Error)?.message ?? e}`, null, 'Try again')
          return
        }
        session.on.action = () => void BleClient.openAppSettings()
        session.on.secondary = () => void askPermission()
        show('blocked', modern()
          ? 'Android did not give playhound the "Nearby devices" permission. Open playhound\'s app settings, then Permissions → Nearby devices → Allow, and come back.'
          : 'Android did not give playhound the Location permission, which Bluetooth needs on this phone. Open playhound\'s app settings, then Permissions → Location → Allow, and come back.', 'Open app settings', 'Try again')
        return
      }
      await afterPermission()
    }

    async function afterPermission() {
      try {
        await initialize()
        if (done)
          return
        if (!(await BleClient.isEnabled())) {
          session.on.action = async () => {
            try {
              await BleClient.requestEnable()
            }
            catch {}
            void afterPermission()
          }
          session.on.secondary = () => void afterPermission()
          show('blocked', 'Bluetooth is off.', 'Turn on Bluetooth', 'Try again')
          return
        }
        if (!modern() && !(await BleClient.isLocationEnabled())) {
          session.on.action = () => void BleClient.openLocationSettings()
          session.on.secondary = () => void afterPermission()
          show('blocked', 'Location is off. Android 11 and older only find Bluetooth devices with it on; playhound still never looks at where you are.', 'Open location settings', 'Try again')
          return
        }
      }
      catch (e) {
        session.view.stage = 'list'
        session.view.error = `Bluetooth did not start: ${(e as Error).message}`
        return
      }
      await scan()
    }

    function onResult(r: ScanResult) {
      if (done)
        return
      const id = r.device.deviceId
      const name = r.localName || r.device.name || names.get(id)
      if (name)
        names.set(id, name)
      if (!matchesRequest({ name, uuids: (r.uuids ?? []).map(u => u.toLowerCase()) }, opts))
        return
      upsertItem(session.view, { id, name: name || 'Unnamed device', detail: signalWords(r.rssi) || id })
    }

    async function scan() {
      if (done)
        return
      await stopScan()
      Object.assign(session.view, { stage: 'list', error: null, scanning: true, note: null })
      try {
        await BleClient.requestLEScan({ allowDuplicates: true, scanMode: ScanMode.SCAN_MODE_LOW_LATENCY }, onResult)
      }
      catch (e) {
        session.view.scanning = false
        session.view.error = `Could not look for devices: ${(e as Error).message}`
        return
      }
      scanTimer = setTimeout(() => {
        scanTimer = null
        void stopScan().then(() => {
          if (!session.view.items.length)
            session.view.note = `Nothing found. Make sure ${thing} is on, charged and close by, and not connected to another app or phone, then scan again.`
        })
      }, SCAN_MS)
    }

    // Spinning while it checks the permission, a moment.
    session = openPicker({ kind: 'bluetooth', title, scanning: true }, {
      choose(id) {
        const item = session.view.items.find(i => i.id === id)
        const device = deviceFor(id, item?.name)
        saved([...saved().filter(d => d.id !== id), { id, name: item?.name }])
        finish()
        resolve(device)
      },
      rescan: () => void scan(),
      cancel() {
        if (done)
          return
        finish()
        reject(new DOMException('User cancelled the requestDevice() chooser.', 'NotFoundError'))
      },
    })
    void begin()
  })
}

/** Devices picked before, without asking: only once permission is there already. */
async function getDevices(): Promise<NativeBluetoothDevice[]> {
  if (!(await blePermitted()))
    return []
  return saved().map(d => deviceFor(d.id, d.name))
}

/** What goes on navigator.bluetooth. */
export function createBluetooth() {
  const bt = new EventTarget() as EventTarget & Record<string, unknown>
  bt.requestDevice = requestDevice
  bt.getDevices = getDevices
  // Web Bluetooth's meaning: is there an adapter at all. Off is the
  // chooser's business: it says so and offers to turn it on.
  bt.getAvailability = async () => true
  return bt
}
