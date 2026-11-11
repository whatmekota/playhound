import type { PluginListenerHandle } from '@capacitor/core'
import type { PickerSession } from './picker'
import { registerPlugin } from '@capacitor/core'
import { closePicker, openPicker } from './picker'

/**
 * Web Serial for the Android app, over the USB serial plugin
 * (android/…/usb/UsbSerialPlugin.kt, usb-serial-for-android). The WebView
 * has no navigator.serial; this is one, with what
 * composables/useSerialPort.ts uses: requestPort (the app's own sheet
 * instead of the browser's chooser), open at a baud rate, the readable and
 * writable streams, close, and the port going away when the cable is pulled
 * (the read fails, writes fail, "disconnect" fires). shims.ts puts it on
 * navigator.
 */

export interface UsbInfo {
  id: string
  vendorId: number
  productId: number
  driver: string | null
  permitted: boolean
  open: boolean
  product?: string
  manufacturer?: string
}

interface PhUsbSerialPlugin {
  list: () => Promise<{ devices: UsbInfo[], others: number, host: boolean }>
  requestPermission: (o: { id: string }) => Promise<{ granted: boolean }>
  open: (o: { id: string, baudRate: number, dataBits?: number, stopBits?: number, parity?: string }) => Promise<UsbInfo>
  write: (o: { id: string, data: string }) => Promise<void>
  setSignals: (o: { id: string, dtr?: boolean, rts?: boolean }) => Promise<void>
  setPanic: (o: { id: string, data: string }) => Promise<void>
  close: (o: { id: string }) => Promise<void>
  addListener: ((event: 'data', cb: (e: { id: string, data: string }) => void) => Promise<PluginListenerHandle>)
    & ((event: 'closed', cb: (e: { id: string, reason: string }) => void) => Promise<PluginListenerHandle>)
    & ((event: 'attached', cb: (e: { device: UsbInfo }) => void) => Promise<PluginListenerHandle>)
    & ((event: 'detached', cb: (e: { id: string }) => void) => Promise<PluginListenerHandle>)
}

export const PhUsbSerial = registerPlugin<PhUsbSerialPlugin>('PhUsbSerial')

export function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++)
    out[i] = s.charCodeAt(i)
  return out
}

/** A plugged-in device in words, for the sheet. */
export function usbLabel(d: Pick<UsbInfo, 'product' | 'manufacturer' | 'driver' | 'vendorId' | 'productId'>): { name: string, detail: string } {
  const hex = (n: number) => n.toString(16).padStart(4, '0')
  const name = d.product?.trim() || (d.driver ? `${d.driver} serial device` : 'USB serial device')
  const detail = [d.manufacturer?.trim(), d.driver, `${hex(d.vendorId)}:${hex(d.productId)}`].filter(Boolean).join(' · ')
  return { name, detail }
}

/** What to say when an open fails, by the plugin's code. */
function openError(e: unknown): DOMException {
  const code = (e as { code?: string })?.code
  const msg = (e as Error)?.message ?? String(e)
  if (code === 'GONE')
    return new DOMException('The device was unplugged. Plug it back in and connect again.', 'NotFoundError')
  if (code === 'DENIED')
    return new DOMException('playhound has no access to the device. Connect again and tap Allow when Android asks.', 'SecurityError')
  if (code === 'BUSY')
    return new DOMException('Failed to open serial port: it is already open.', 'InvalidStateError')
  return new DOMException(msg, 'NetworkError')
}

let panicText = ''

class NativeSerialPort extends EventTarget {
  private isOpen = false
  private readController: ReadableStreamDefaultController<Uint8Array> | null = null
  private readStream: ReadableStream<Uint8Array> | null = null
  private writeStream: WritableStream<Uint8Array> | null = null
  private lostReason: string | null = null

  constructor(public info: UsbInfo) {
    super()
  }

  get readable(): ReadableStream<Uint8Array> | null {
    if (!this.isOpen)
      return null
    this.readStream ??= new ReadableStream<Uint8Array>({
      start: (c) => {
        this.readController = c
      },
      cancel: () => {
        // A reader let go; the next one gets a fresh stream, as in a browser.
        this.readController = null
        this.readStream = null
      },
    })
    return this.readStream
  }

  get writable(): WritableStream<Uint8Array> | null {
    if (!this.isOpen)
      return null
    this.writeStream ??= new WritableStream<Uint8Array>({
      write: async (chunk) => {
        if (!this.isOpen)
          throw new DOMException(`Write failed: the device disconnected${this.lostReason ? ` (${this.lostReason})` : ''}`, 'NetworkError')
        try {
          await PhUsbSerial.write({ id: this.info.id, data: toBase64(chunk) })
        }
        catch (e) {
          throw new DOMException(`Write failed: the device disconnected (${(e as Error).message})`, 'NetworkError')
        }
      },
    })
    return this.writeStream
  }

  async open(o: { baudRate: number, dataBits?: number, stopBits?: number, parity?: string }): Promise<void> {
    if (this.isOpen)
      throw new DOMException('The port is already open.', 'InvalidStateError')
    try {
      this.info = await PhUsbSerial.open({ id: this.info.id, baudRate: o.baudRate, dataBits: o.dataBits, stopBits: o.stopBits, parity: o.parity })
    }
    catch (e) {
      throw openError(e)
    }
    this.isOpen = true
    this.lostReason = null
    if (panicText)
      void PhUsbSerial.setPanic({ id: this.info.id, data: toBase64(new TextEncoder().encode(panicText)) }).catch(() => {})
  }

  async close(): Promise<void> {
    if (!this.isOpen)
      return
    this.shut()
    try {
      this.readController?.close()
    }
    catch {}
    await PhUsbSerial.close({ id: this.info.id }).catch(() => {})
  }

  async setSignals(s: { dataTerminalReady?: boolean, requestToSend?: boolean }): Promise<void> {
    await PhUsbSerial.setSignals({ id: this.info.id, dtr: s.dataTerminalReady, rts: s.requestToSend })
  }

  getInfo() {
    return { usbVendorId: this.info.vendorId, usbProductId: this.info.productId }
  }

  async forget(): Promise<void> {
    await this.close()
  }

  private shut() {
    this.isOpen = false
    this.readStream = null
    this.writeStream = null
  }

  /** Data from the device. */
  received(bytes: Uint8Array) {
    try {
      this.readController?.enqueue(bytes)
    }
    catch {}
  }

  /** The device went away (the cable, or an error), as a browser reports it. */
  lost(reason: string) {
    if (!this.isOpen)
      return
    this.lostReason = reason
    const c = this.readController
    this.readController = null
    this.shut()
    try {
      c?.error(new DOMException(`The device has been lost: ${reason}`, 'NetworkError'))
    }
    catch {}
    this.dispatchEvent(new Event('disconnect'))
  }

  get opened() {
    return this.isOpen
  }
}

const ports = new Map<string, NativeSerialPort>()
let serial: (EventTarget & Record<string, unknown>) | null = null

function portFor(info: UsbInfo): NativeSerialPort {
  let p = ports.get(info.id)
  if (!p) {
    p = new NativeSerialPort(info)
    ports.set(info.id, p)
  }
  else if (!p.opened) {
    p.info = info
  }
  return p
}

let listening = false
function listen() {
  if (listening)
    return
  listening = true
  void PhUsbSerial.addListener('data', e => ports.get(e.id)?.received(fromBase64(e.data)))
  void PhUsbSerial.addListener('closed', (e) => {
    const p = ports.get(e.id)
    p?.lost(e.reason)
    if (p)
      serial?.dispatchEvent(Object.assign(new Event('disconnect'), { port: p }))
  })
  void PhUsbSerial.addListener('detached', (e) => {
    ports.get(e.id)?.lost('The device was unplugged')
  })
}

/**
 * What the device should be sent if the app closes before the page can stop
 * it: TCode homing every axis. Every open port gets it, and every one opened
 * after.
 */
export function setSerialPanic(text: string) {
  if (text === panicText)
    return
  panicText = text
  const data = text ? toBase64(new TextEncoder().encode(text)) : ''
  for (const p of ports.values()) {
    if (p.opened)
      void PhUsbSerial.setPanic({ id: p.info.id, data }).catch(() => {})
  }
}

/** Close every port (the app is closing; the plugin homes them first). */
export async function closeAllSerial(): Promise<void> {
  await Promise.all([...ports.values()].map(p => p.close()))
}

// ─── The chooser ─────────────────────────────────────────────────────────────

const EMPTY_NOTE = 'Nothing plugged in. Connect the OSR2, SR6 or SSR1 with a USB OTG adapter or a USB-C cable that carries data. '
  + 'If it is plugged in and does not show up: some phones need OTG switched on in Settings (and switch it off again after a while), '
  + 'and some cannot power the board; a powered hub, or the board\'s own power supply, helps.'

function requestPort(): Promise<NativeSerialPort> {
  listen()
  return new Promise((resolve, reject) => {
    let session: PickerSession
    let done = false
    const handles: Promise<PluginListenerHandle>[] = []

    function finish() {
      done = true
      for (const h of handles)
        void h.then(x => x.remove())
      closePicker(session)
    }

    async function refresh() {
      if (done)
        return
      session.view.scanning = true
      try {
        const { devices, others, host } = await PhUsbSerial.list()
        if (done)
          return
        session.view.items = devices.map(d => ({ id: d.id, ...usbLabel(d) }))
        session.view.note = devices.length
          ? null
          : !host
              ? 'This phone says it cannot host USB devices (no USB OTG). Use TCode over the network, or the Handy, instead.'
              : others > 0
                ? `${others === 1 ? 'A USB device is' : `${others} USB devices are`} plugged in, but not a serial port playhound knows (CH340, CP210x, FTDI, PL2303 or USB CDC). ${EMPTY_NOTE}`
                : EMPTY_NOTE
      }
      catch (e) {
        session.view.error = `Could not list USB devices: ${(e as Error).message}`
      }
      finally {
        session.view.scanning = false
      }
    }

    async function choose(id: string) {
      const item = session.view.items.find(i => i.id === id)
      if (!item || item.busy)
        return
      session.view.error = null
      item.busy = true
      try {
        const { devices } = await PhUsbSerial.list()
        const info = devices.find(d => d.id === id)
        if (!info) {
          session.view.error = 'That device is not plugged in any more.'
          await refresh()
          return
        }
        if (!info.permitted) {
          const { granted } = await PhUsbSerial.requestPermission({ id })
          if (!granted) {
            session.view.error = 'Android did not give playhound access to it. Tap it again and choose Allow (or OK).'
            return
          }
          info.permitted = true
        }
        if (done)
          return
        finish()
        resolve(portFor(info))
      }
      catch (e) {
        session.view.error = (e as Error).message
      }
      finally {
        item.busy = false
      }
    }

    session = openPicker({ kind: 'usb', title: 'Choose a USB device' }, {
      choose: id => void choose(id),
      rescan: () => void refresh(),
      cancel() {
        if (done)
          return
        finish()
        reject(new DOMException('No port selected by the user.', 'NotFoundError'))
      },
    })
    handles.push(
      PhUsbSerial.addListener('attached', () => void refresh()),
      PhUsbSerial.addListener('detached', () => void refresh()),
    )
    void refresh()
  })
}

/** Ports for the plugged-in devices playhound already has access to. */
async function getPorts(): Promise<NativeSerialPort[]> {
  listen()
  try {
    const { devices } = await PhUsbSerial.list()
    return devices.filter(d => d.permitted).map(portFor)
  }
  catch {
    return []
  }
}

/** What goes on navigator.serial. */
export function createSerial() {
  serial = new EventTarget() as EventTarget & Record<string, unknown>
  serial.requestPort = requestPort
  serial.getPorts = getPorts
  return serial
}

/** For Settings → Android app. */
export async function usbStatus(): Promise<{ host: boolean, devices: UsbInfo[], others: number }> {
  return PhUsbSerial.list()
}
