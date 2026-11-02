import { describe, expect, it, vi } from 'vitest'
import { HANDY_BLE_SERVICE, HandyBleError, handyModelName, openHandyBle } from '../src/lib/handyBle'
import { decodeMessage, decodeRequest, encodeRequest, NO_REPLY_ID, NOTE, protoRead, Writer } from '../src/lib/handyProto'

const { u, i32, s64, sub } = protoRead

// ─── What the device sends back ───────────────────────────────────────────────

function reply(id: number, field = 0, body = new Writer()) {
  const r = new Writer().int(1, id)
  if (field)
    r.message(field, body)
  return new Writer().int(1, 3).message(4, r).bytes()
}
function failure(id: number, code: number, message: string) {
  return new Writer().int(1, 3).message(4, new Writer().int(1, id).message(2, new Writer().int(1, code).text(2, message))).bytes()
}
function notification(field: number, body = new Writer()) {
  return new Writer().int(1, 4).message(5, new Writer().message(field, body).int(2, 9)).bytes()
}
const hspState = (maxPoints: number, playState = 2) => new Writer().message(1, new Writer().int(1, playState).int(3, maxPoints).int(5, -1))

describe('handyProto', () => {
  it('writes each request as the device reads it', () => {
    const play = decodeRequest(encodeRequest(41, { kind: 'hspPlay', startTime: -250, serverTime: 1_762_098_765_432, rate: 1.25 }))!
    expect(play.id).toBe(41)
    expect(play.field).toBe(863)
    expect(i32(play.fields, 1)).toBe(-250)
    expect(Number(play.fields.find(f => f.n === 2)!.v)).toBe(1_762_098_765_432)

    const offset = decodeRequest(encodeRequest(1, { kind: 'clockOffsetSet', offset: -1_762_098_641_976, rtd: 31 }))!
    expect(s64(offset.fields, 1)).toBe(-1_762_098_641_976)
    expect(u(offset.fields, 2)).toBe(31)

    const add = decodeRequest(encodeRequest(2, { kind: 'hspAdd', points: [{ t: 0, x: 0 }, { t: 500, x: 100 }, { t: 2_400_000, x: 37 }], flush: true, tail: 3 }))!
    const pts = add.fields.filter(f => f.n === 1).map(f => protoRead.readFields(f.v as Uint8Array))
    expect(pts.map(p => [u(p, 1), u(p, 2)])).toEqual([[0, 0], [500, 100], [2_400_000, 37]])
    expect(u(add.fields, 2)).toBe(1)
    expect(u(add.fields, 3)).toBe(3)
  })

  it('sends a live move at 0–1, with the no-reply id', () => {
    const m = decodeRequest(encodeRequest(NO_REPLY_ID, { kind: 'hdspXpt', xp: 1.4, t: 412, stopOnTarget: true }))!
    expect(m.id).toBe(NO_REPLY_ID)
    expect(m.field).toBe(744)
    const xp = m.fields.find(f => f.n === 1)!.v as bigint
    expect(new DataView(new Uint32Array([Number(xp)]).buffer).getFloat32(0, true)).toBe(1)
    expect(u(m.fields, 2)).toBe(412)
  })

  it('still names an empty request, so the device knows which one it is', () => {
    expect(decodeRequest(encodeRequest(5, { kind: 'hspStop' }))?.field).toBe(864)
    expect(sub(protoRead.readFields(encodeRequest(5, { kind: 'clockOffsetGet' })), 2)).toBeDefined()
  })

  it('keeps fifty points far into a script inside one Bluetooth write', () => {
    const points = Array.from({ length: 50 }, (_, i) => ({ t: 30_000_000 + i * 100, x: 100 }))
    expect(encodeRequest(NO_REPLY_ID - 1, { kind: 'hspAdd', points, flush: true, tail: 1_000_000 }).length).toBeLessThan(509)
  })

  it('reads answers, errors and notifications', () => {
    const clock = new Writer().int(1, 123_456).sint(2, -42).int(3, 7)
    expect(decodeMessage(reply(8, 712, clock))).toMatchObject({ type: 'response', id: 8, error: null, result: 712, clock: { time: 123_456, offset: -42, rtd: 7 } })
    expect(decodeMessage(reply(11, 860, hspState(4000)))).toMatchObject({ result: 860, hsp: { playState: 2, maxPoints: 4000, currentTime: -1 } })
    expect(decodeMessage(reply(15))).toMatchObject({ id: 15, result: 0, error: null })
    expect(decodeMessage(failure(13, 3001, 'Not in HSP mode'))).toMatchObject({ id: 13, error: { code: 3001, message: 'Not in HSP mode' } })
    expect(decodeMessage(notification(NOTE.error, new Writer().int(1, -5).text(2, 'oops')))).toEqual({ type: 'notification', which: 706, error: { code: -5, message: 'oops' } })
    expect(decodeMessage(notification(NOTE.tempHigh))).toEqual({ type: 'notification', which: 1000 })
  })

  it('drops what it cannot read instead of throwing', () => {
    expect(decodeMessage(new Uint8Array([8, 3, 34, 200, 1]))).toBeNull()
    expect(decodeMessage(new Uint8Array([0xFF]))).toBeNull()
  })
})

// ─── The link, against a pretend Handy ────────────────────────────────────────

class FakeCharacteristic extends EventTarget {
  value: DataView | null = null
  properties = { writeWithoutResponse: true }
  writes: Uint8Array[] = []
  busy = 0
  overlapped = false
  onWrite: (bytes: Uint8Array) => void = () => {}
  async writeValueWithoutResponse(b: Uint8Array) {
    if (this.busy)
      this.overlapped = true
    this.busy++
    await new Promise(r => setTimeout(r, 2))
    this.busy--
    this.writes.push(b)
    this.onWrite(b)
  }

  async startNotifications() {}
  async stopNotifications() {}
  emit(bytes: Uint8Array) {
    this.value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    this.dispatchEvent(new Event('characteristicvaluechanged'))
  }
}

function fakeHandy(name = 'OHD_hw4_ABCD') {
  const tx = new FakeCharacteristic()
  const rx = new FakeCharacteristic()
  const device = new EventTarget() as EventTarget & { name: string, gatt: any }
  device.name = name
  device.gatt = {
    connected: false,
    async connect() {
      this.connected = true
      return this
    },
    async getPrimaryService(uuid: string) {
      expect(uuid).toBe(HANDY_BLE_SERVICE)
      return { getCharacteristic: async (c: string) => (c.startsWith('77835032') ? tx : rx) }
    },
    disconnect() {
      this.connected = false
      device.dispatchEvent(new Event('gattserverdisconnected'))
    },
  }
  return { device: device as unknown as BluetoothDevice, tx, rx }
}

describe('openHandyBle', () => {
  it('matches each answer to its request by id, even out of order', async () => {
    const { device, tx, rx } = fakeHandy()
    const held: number[] = []
    tx.onWrite = (b) => {
      held.push(decodeRequest(b)!.id)
      // Answer both at once, the second first.
      if (held.length === 2)
        setTimeout(() => [...held].reverse().forEach(id => rx.emit(reply(id, 712, new Writer().int(1, id * 10)))), 1)
    }
    const link = await openHandyBle(device, { onNotification: () => {}, onDrop: () => {} })
    const [a, b] = await Promise.all([link.request({ kind: 'clockOffsetGet' }), link.request({ kind: 'clockOffsetGet' })])
    expect(a.clock!.time).toBe(held[0] * 10)
    expect(b.clock!.time).toBe(held[1] * 10)
    expect(tx.overlapped).toBe(false)
  })

  it('turns a device error into a rejection, and passes notifications on', async () => {
    const { device, tx, rx } = fakeHandy()
    const notes: number[] = []
    tx.onWrite = b => rx.emit(failure(decodeRequest(b)!.id, 3001, 'Not in HSP mode'))
    const link = await openHandyBle(device, { onNotification: n => notes.push(n.which), onDrop: () => {} })
    await expect(link.request({ kind: 'hspStop' })).rejects.toThrow(HandyBleError)
    rx.emit(notification(NOTE.sliderBlocked))
    expect(notes).toEqual([NOTE.sliderBlocked])
  })

  it('sends live moves without waiting, one write at a time', async () => {
    const { device, tx } = fakeHandy()
    const link = await openHandyBle(device, { onNotification: () => {}, onDrop: () => {} })
    await Promise.all([0.2, 0.8, 0.4].map(xp => link.send({ kind: 'hdspXpt', xp, t: 200, stopOnTarget: true })))
    expect(tx.writes.map(w => decodeRequest(w)!.id)).toEqual([NO_REPLY_ID, NO_REPLY_ID, NO_REPLY_ID])
    expect(tx.overlapped).toBe(false)
  })

  it('times out a request nobody answers', async () => {
    vi.useFakeTimers()
    try {
      const { device } = fakeHandy()
      const link = await openHandyBle(device, { onNotification: () => {}, onDrop: () => {} })
      const p = link.request({ kind: 'hspStop' }, 1000)
      const caught = p.catch(e => e)
      await vi.advanceTimersByTimeAsync(1100)
      expect(await caught).toBeInstanceOf(HandyBleError)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('reports a dropped link once, and fails what was waiting; closing is not a drop', async () => {
    const { device } = fakeHandy()
    const onDrop = vi.fn()
    const link = await openHandyBle(device, { onNotification: () => {}, onDrop })
    const waiting = link.request({ kind: 'hspStop' }).catch(e => e)
    ;(device.gatt as any).disconnect()
    expect(await waiting).toBeInstanceOf(HandyBleError)
    expect(onDrop).toHaveBeenCalledTimes(1)

    const other = fakeHandy()
    const quiet = vi.fn()
    const link2 = await openHandyBle(other.device, { onNotification: () => {}, onDrop: quiet })
    link2.close()
    expect(quiet).not.toHaveBeenCalled()
    await expect(link2.send({ kind: 'hdspStop' })).rejects.toThrow(HandyBleError)
    void link
  })
})

describe('handyModelName', () => {
  it('reads the model from the advertised name', () => {
    expect(handyModelName('OHD_hw4_1A2B')).toBe('Handy 2 Pro')
    expect(handyModelName('OHD_hw3_1A2B')).toBe('Handy 2')
    expect(handyModelName(undefined)).toBe('Handy')
  })
})
