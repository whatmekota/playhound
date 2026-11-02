/**
 * The Handy's own Bluetooth protocol (firmware 4): protobuf RPC, one message
 * per write and one per notification, with no other framing. Hand-written
 * for the dozen messages playhound uses, after Handy's .proto files (as
 * published with HandyVRC-OSC, syncopathy and Edi):
 *
 *   RpcMessage { type = 1; request = 2 | response = 4 | notification = 5 }
 *   Request    { id = 2; oneof params (field number = message number) }
 *   Response   { id = 1; error = 2; oneof result (same numbers) }
 *
 * Units differ from the WiFi API: a live move's position (HDSP xp) is 0–1,
 * while HSP points stay 0–100.
 */

/** RpcMessage.type */
const TYPE_REQUEST = 1
const TYPE_RESPONSE = 3
const TYPE_NOTIFICATION = 4

/** Mode enum: what the device is doing. */
export const MODE_HSP = 4

/** Request and response field numbers (they share them). */
const MSG = {
  modeSet: 701,
  clockOffsetSet: 709,
  clockOffsetGet: 712,
  stopCurrentMode: 715,
  hdspXpt: 744,
  hdspStop: 746,
  hspSetup: 860,
  hspAdd: 861,
  hspPlay: 863,
  hspStop: 864,
  hspCurrentTimeSet: 868,
} as const

/** Notification field numbers worth acting on. */
export const NOTE = {
  error: 706,
  idleTimeout: 707,
  hspStarving: 863,
  tempHigh: 1000,
  tempOk: 1001,
  sliderBlocked: 1002,
  sliderUnblocked: 1003,
  lowMemoryError: 1004,
  lowMemoryWarning: 1005,
} as const

/** The fire-and-forget request id: the device still answers, and nobody waits for it. */
export const NO_REPLY_ID = 0x7FFFFFFF

export type HandyRequest
  = | { kind: 'modeSet', mode: number }
    | { kind: 'clockOffsetGet' }
    /** Client clock minus device clock, ms, and the round trip it was measured with. */
    | { kind: 'clockOffsetSet', offset: number, rtd: number }
    | { kind: 'stopCurrentMode' }
    /** xp 0–1, over t ms. */
    | { kind: 'hdspXpt', xp: number, t: number, stopOnTarget: boolean }
    | { kind: 'hdspStop' }
    | { kind: 'hspSetup', streamId: number }
    /** x 0–100, t ms of script time. */
    | { kind: 'hspAdd', points: readonly { t: number, x: number }[], flush: boolean, tail: number }
    /** serverTime: the client clock when sent, for the device to take the delay off. */
    | { kind: 'hspPlay', startTime: number, serverTime: number, rate: number }
    | { kind: 'hspStop' }
    | { kind: 'hspCurrentTimeSet', currentTime: number, serverTime: number, filter: number }

export interface HspStateInfo {
  playState: number
  points: number
  maxPoints: number
  currentTime: number
}

export type HandyIncoming
  = | {
    type: 'response'
    id: number
    error: { code: number, message: string } | null
    /** Field number of the result, 0 for a blank answer. */
    result: number
    clock?: { time: number, offset: number, rtd: number }
    hsp?: HspStateInfo
  }
  | {
    type: 'notification'
    which: number
    error?: { code: number, message: string }
    hsp?: HspStateInfo
  }

// ─── Writing ──────────────────────────────────────────────────────────────────

/** A protobuf message under construction (also used by tests and the mock device). */
export class Writer {
  private out: number[] = []

  varint(v: bigint) {
    let x = BigInt.asUintN(64, v)
    while (x >= 0x80n) {
      this.out.push(Number(x & 0x7Fn) | 0x80)
      x >>= 7n
    }
    this.out.push(Number(x))
  }

  key(field: number, wire: number) {
    this.varint(BigInt(field * 8 + wire))
  }

  /** uint32, uint64, int32 and enums alike; a negative int32 goes out as ten bytes, as protobuf has it. */
  int(field: number, v: number): this {
    const n = Math.round(v)
    if (n) {
      this.key(field, 0)
      this.varint(BigInt(n))
    }
    return this
  }

  sint(field: number, v: number): this {
    const n = BigInt(Math.round(v))
    if (n) {
      this.key(field, 0)
      this.varint((n << 1n) ^ (n >> 63n))
    }
    return this
  }

  bool(field: number, v: boolean): this {
    if (v) {
      this.key(field, 0)
      this.out.push(1)
    }
    return this
  }

  float(field: number, v: number): this {
    if (v) {
      this.key(field, 5)
      const b = new DataView(new ArrayBuffer(4))
      b.setFloat32(0, v, true)
      for (let i = 0; i < 4; i++)
        this.out.push(b.getUint8(i))
    }
    return this
  }

  /** Always written, even empty: an empty message still picks its oneof. */
  message(field: number, m: Writer): this {
    this.key(field, 2)
    this.varint(BigInt(m.out.length))
    for (const b of m.out)
      this.out.push(b)
    return this
  }

  text(field: number, s: string): this {
    const b = new TextEncoder().encode(s)
    this.key(field, 2)
    this.varint(BigInt(b.length))
    for (const x of b)
      this.out.push(x)
    return this
  }

  bytes(): Uint8Array {
    return Uint8Array.from(this.out)
  }
}

function params(req: HandyRequest): [number, Writer] {
  const w = new Writer()
  switch (req.kind) {
    case 'modeSet':
      return [MSG.modeSet, w.int(1, req.mode)]
    case 'clockOffsetGet':
      return [MSG.clockOffsetGet, w]
    case 'clockOffsetSet':
      return [MSG.clockOffsetSet, w.sint(1, req.offset).int(2, req.rtd)]
    case 'stopCurrentMode':
      return [MSG.stopCurrentMode, w]
    case 'hdspXpt':
      return [MSG.hdspXpt, w.float(1, Math.max(0, Math.min(1, req.xp))).int(2, Math.max(0, req.t)).bool(3, req.stopOnTarget)]
    case 'hdspStop':
      return [MSG.hdspStop, w]
    case 'hspSetup':
      return [MSG.hspSetup, w.int(1, req.streamId)]
    case 'hspAdd':
      for (const p of req.points)
        w.message(1, new Writer().int(1, Math.max(0, p.t)).int(2, Math.max(0, Math.min(100, p.x))))
      return [MSG.hspAdd, w.bool(2, req.flush).int(3, req.tail)]
    case 'hspPlay':
      return [MSG.hspPlay, w.int(1, req.startTime).int(2, req.serverTime).float(3, req.rate)]
    case 'hspStop':
      return [MSG.hspStop, w]
    case 'hspCurrentTimeSet':
      return [MSG.hspCurrentTimeSet, w.int(1, req.currentTime).int(2, req.serverTime).float(3, req.filter)]
  }
}

/** One request, ready to write. */
export function encodeRequest(id: number, req: HandyRequest): Uint8Array {
  const [field, body] = params(req)
  const request = new Writer().int(2, id).message(field, body)
  return new Writer().int(1, TYPE_REQUEST).message(2, request).bytes()
}

// ─── Reading ──────────────────────────────────────────────────────────────────

interface Field {
  n: number
  /** Varints and fixed ints as bigint, length-delimited as bytes. */
  v: bigint | Uint8Array
}

function readFields(buf: Uint8Array): Field[] {
  const out: Field[] = []
  let i = 0
  const varint = (): bigint => {
    let x = 0n
    let shift = 0n
    while (true) {
      if (i >= buf.length)
        throw new Error('truncated varint')
      const b = buf[i++]
      x |= BigInt(b & 0x7F) << shift
      if (!(b & 0x80))
        return x
      shift += 7n
      if (shift > 63n)
        throw new Error('varint too long')
    }
  }
  const fixed = (n: number): bigint => {
    if (i + n > buf.length)
      throw new Error('truncated fixed field')
    let x = 0n
    for (let k = n - 1; k >= 0; k--)
      x = (x << 8n) | BigInt(buf[i + k])
    i += n
    return x
  }
  while (i < buf.length) {
    const key = Number(varint())
    const n = Math.floor(key / 8)
    switch (key & 7) {
      case 0:
        out.push({ n, v: varint() })
        break
      case 1:
        out.push({ n, v: fixed(8) })
        break
      case 2: {
        const len = Number(varint())
        if (i + len > buf.length)
          throw new Error('truncated field')
        out.push({ n, v: buf.subarray(i, i + len) })
        i += len
        break
      }
      case 5:
        out.push({ n, v: fixed(4) })
        break
      default:
        throw new Error(`unsupported wire type ${key & 7}`)
    }
  }
  return out
}

const sub = (fs: Field[], n: number) => fs.find(f => f.n === n && f.v instanceof Uint8Array)?.v as Uint8Array | undefined
function big(fs: Field[], n: number) {
  const v = fs.find(f => f.n === n && typeof f.v === 'bigint')?.v
  return typeof v === 'bigint' ? v : 0n
}
const u = (fs: Field[], n: number) => Number(BigInt.asUintN(32, big(fs, n)))
const i32 = (fs: Field[], n: number) => Number(BigInt.asIntN(32, big(fs, n)))
function s64(fs: Field[], n: number) {
  const z = BigInt.asUintN(64, big(fs, n))
  return Number((z >> 1n) ^ -(z & 1n))
}

function readError(bytes: Uint8Array | undefined): { code: number, message: string } | null {
  if (!bytes)
    return null
  const fs = readFields(bytes)
  const message = sub(fs, 2)
  return { code: i32(fs, 1), message: message ? new TextDecoder().decode(message) : '' }
}

function readHsp(holder: Uint8Array): HspStateInfo | undefined {
  const st = sub(readFields(holder), 1)
  if (!st)
    return undefined
  const fs = readFields(st)
  return { playState: u(fs, 1), points: u(fs, 2), maxPoints: u(fs, 3), currentTime: i32(fs, 5) }
}

const isHsp = (n: number) => n >= 860 && n <= 872

/**
 * A message from the device, or null for one playhound has no use for (or
 * cannot read: a truncated message is dropped rather than failing whoever
 * waits).
 */
export function decodeMessage(buf: Uint8Array): HandyIncoming | null {
  try {
    const top = readFields(buf)
    const type = u(top, 1)
    if (type === TYPE_RESPONSE) {
      const body = sub(top, 4)
      if (!body)
        return null
      const fs = readFields(body)
      const err = readError(sub(fs, 2))
      const res = fs.find(f => f.n >= 600 && f.v instanceof Uint8Array)
      const out: HandyIncoming = { type: 'response', id: u(fs, 1), error: err && err.code !== 0 ? err : null, result: res?.n ?? 0 }
      if (res && (res.n === MSG.clockOffsetGet || res.n === MSG.clockOffsetSet)) {
        const c = readFields(res.v as Uint8Array)
        out.clock = { time: u(c, 1), offset: s64(c, 2), rtd: i32(c, 3) }
      }
      else if (res && isHsp(res.n)) {
        out.hsp = readHsp(res.v as Uint8Array)
      }
      return out
    }
    if (type === TYPE_NOTIFICATION) {
      const body = sub(top, 5)
      if (!body)
        return null
      const note = readFields(body).find(f => f.n >= 600 && f.v instanceof Uint8Array)
      if (!note)
        return null
      const out: HandyIncoming = { type: 'notification', which: note.n }
      if (note.n === NOTE.error)
        out.error = readError(note.v as Uint8Array) ?? undefined
      else if (isHsp(note.n))
        out.hsp = readHsp(note.v as Uint8Array)
      return out
    }
    return null
  }
  catch {
    return null
  }
}

/** For tests and a mock device: what a request asks for. */
export function decodeRequest(buf: Uint8Array): { id: number, field: number, fields: Field[] } | null {
  try {
    const top = readFields(buf)
    if (u(top, 1) !== TYPE_REQUEST)
      return null
    const body = sub(top, 2)
    if (!body)
      return null
    const fs = readFields(body)
    const p = fs.find(f => f.n >= 600 && f.v instanceof Uint8Array)
    return p ? { id: u(fs, 2), field: p.n, fields: readFields(p.v as Uint8Array) } : null
  }
  catch {
    return null
  }
}

export const protoRead = { readFields, sub, u, i32, s64 }
