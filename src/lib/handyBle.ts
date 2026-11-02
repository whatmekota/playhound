/// <reference types="web-bluetooth" />
import type { HandyIncoming, HandyRequest } from './handyProto'
import { desktop } from './browserApi'
import { decodeMessage, encodeRequest, NO_REPLY_ID } from './handyProto'

/**
 * The Handy over Bluetooth (firmware 4), straight from the page through Web
 * Bluetooth: no Handy server, no internet, no connection key.
 *
 * One GATT service with a characteristic to write requests to and one that
 * notifies responses and the device's own notifications (lib/handyProto.ts
 * has the messages). Requests carry an id and their response comes back
 * with it, so each caller gets its own answer even out of order; a live
 * move goes out with the no-reply id and nobody waits for it, as
 * HandyVRC-OSC does. The browser runs one GATT operation at a time, so
 * writes queue here, in order.
 */

export const HANDY_BLE_SERVICE = '77834d26-40f7-11ee-be56-0242ac120002'
const TX = '77835032-40f7-11ee-be56-0242ac120002'
const RX = '77835410-40f7-11ee-be56-0242ac120002'
const TIMEOUT_MS = 5000

export const bluetoothSupported = typeof navigator !== 'undefined' && !!navigator.bluetooth

export class HandyBleError extends Error {
  constructor(message: string, readonly code = 0) {
    super(message)
  }
}

/** A readable name from what the Handy advertises (OHD_hw4_… is the Handy 2 Pro). */
export function handyModelName(advertised: string | undefined): string {
  if (/^OHD_hw4_/i.test(advertised ?? ''))
    return 'Handy 2 Pro'
  if (/^OHD_hw3_/i.test(advertised ?? ''))
    return 'Handy 2'
  return 'Handy'
}

/** The browser's (or the desktop app's) device chooser. Must come from a click. */
export function pickHandy(): Promise<BluetoothDevice> {
  // The desktop app picks for the page; tell it what is wanted.
  desktop?.bluetooth?.expect('handy')
  return navigator.bluetooth.requestDevice({
    filters: [{ services: [HANDY_BLE_SERVICE] }, { namePrefix: 'OHD_' }],
    optionalServices: [HANDY_BLE_SERVICE],
  })
}

export interface HandyBleLink {
  readonly device: BluetoothDevice
  /** Send and wait for the answer; a device error rejects. */
  request: (req: HandyRequest, timeoutMs?: number) => Promise<Extract<HandyIncoming, { type: 'response' }>>
  /** Send without waiting for an answer; resolves once written. */
  send: (req: HandyRequest) => Promise<void>
  /** Close the link (no drop is reported). */
  close: () => void
}

interface Handlers {
  onNotification: (n: Extract<HandyIncoming, { type: 'notification' }>) => void
  /** The link went down without close(). */
  onDrop: () => void
}

/** Connect to a chosen Handy and start listening. */
export async function openHandyBle(device: BluetoothDevice, handlers: Handlers): Promise<HandyBleLink> {
  if (!device.gatt)
    throw new HandyBleError('This device has no Bluetooth services')
  const server = device.gatt.connected ? device.gatt : await device.gatt.connect()
  const service = await server.getPrimaryService(HANDY_BLE_SERVICE)
  const tx = await service.getCharacteristic(TX)
  const rx = await service.getCharacteristic(RX)

  const pending = new Map<number, { resolve: (r: any) => void, reject: (e: Error) => void, timer: ReturnType<typeof setTimeout> }>()
  let nextId = 1
  let closed = false
  let writing: Promise<unknown> = Promise.resolve()
  const quick = tx.properties.writeWithoutResponse

  function failAll(e: Error) {
    for (const p of pending.values()) {
      clearTimeout(p.timer)
      p.reject(e)
    }
    pending.clear()
  }

  function onValue(ev: Event) {
    const view = (ev.target as BluetoothRemoteGATTCharacteristic).value
    if (!view)
      return
    const msg = decodeMessage(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))
    if (!msg)
      return
    if (msg.type === 'notification') {
      handlers.onNotification(msg)
      return
    }
    const p = pending.get(msg.id)
    if (!p)
      return
    pending.delete(msg.id)
    clearTimeout(p.timer)
    if (msg.error)
      p.reject(new HandyBleError(msg.error.message || `The Handy answered with error ${msg.error.code}`, msg.error.code))
    else
      p.resolve(msg)
  }

  function onGone() {
    device.removeEventListener('gattserverdisconnected', onGone)
    rx.removeEventListener('characteristicvaluechanged', onValue)
    failAll(new HandyBleError('The Bluetooth link to the Handy dropped'))
    if (!closed) {
      closed = true
      handlers.onDrop()
    }
  }

  function write(bytes: Uint8Array): Promise<void> {
    if (closed)
      return Promise.reject(new HandyBleError('The Bluetooth link to the Handy is closed'))
    const data = bytes as Uint8Array<ArrayBuffer>
    const p = writing.then(() => (quick ? tx.writeValueWithoutResponse(data) : tx.writeValueWithResponse(data)))
    writing = p.catch(() => {})
    return p
  }

  rx.addEventListener('characteristicvaluechanged', onValue)
  device.addEventListener('gattserverdisconnected', onGone)
  await rx.startNotifications()

  return {
    device,
    request(req, timeoutMs = TIMEOUT_MS) {
      const id = nextId
      nextId = nextId >= NO_REPLY_ID - 1 ? 1 : nextId + 1
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new HandyBleError('The Handy did not answer in time'))
        }, timeoutMs)
        // Waiting before writing: an answer can come back before the write resolves.
        pending.set(id, { resolve, reject, timer })
        write(encodeRequest(id, req)).catch((e) => {
          if (pending.delete(id)) {
            clearTimeout(timer)
            reject(e)
          }
        })
      })
    },
    send(req) {
      return write(encodeRequest(NO_REPLY_ID, req))
    },
    close() {
      if (closed)
        return
      closed = true
      device.removeEventListener('gattserverdisconnected', onGone)
      rx.removeEventListener('characteristicvaluechanged', onValue)
      failAll(new HandyBleError('The Bluetooth link to the Handy is closed'))
      rx.stopNotifications().catch(() => {})
      device.gatt?.disconnect()
    },
  }
}
