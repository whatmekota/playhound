/**
 * The cover picture embedded in an audio file, when there is one: ID3v2
 * (mp3, and aac or wav that carry a tag up front), FLAC's picture block, and
 * the `covr` atom of an m4a. Ogg and Opus keep theirs base64'd inside a
 * comment, which is not worth the trouble; they get a generated tile.
 *
 * Only the bytes that hold the tag are read, never the whole file, so it is
 * cheap enough for a library thumbnail. Reads go through a small `ByteSource`
 * so tests can hand it an array.
 */

export interface ByteSource {
  size: number
  read: (offset: number, length: number) => Promise<Uint8Array>
}

export interface CoverArt {
  mime: string
  data: Uint8Array
}

/** A picture bigger than this is not a cover; give up rather than read it. */
const MAX_TAG_BYTES = 16 * 1024 * 1024

export function fileSource(file: Blob): ByteSource {
  return {
    size: file.size,
    read: async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()),
  }
}

export function bytesSource(bytes: Uint8Array): ByteSource {
  return { size: bytes.length, read: async (o, l) => bytes.subarray(o, o + l) }
}

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n))
const u32 = (b: Uint8Array, at: number) => ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3]
const u24 = (b: Uint8Array, at: number) => (b[at] << 16) + (b[at + 1] << 8) + b[at + 2]
const syncsafe = (b: Uint8Array, at: number) => ((b[at] & 0x7F) << 21) | ((b[at + 1] & 0x7F) << 14) | ((b[at + 2] & 0x7F) << 7) | (b[at + 3] & 0x7F)

/** From the picture's own first bytes: tags often say "image/jpg", or nothing useful. */
export function sniffImageType(data: Uint8Array, fallback = 'image/jpeg'): string {
  if (data[0] === 0xFF && data[1] === 0xD8)
    return 'image/jpeg'
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47)
    return 'image/png'
  if (ascii(data, 0, 4) === 'RIFF' && ascii(data, 8, 4) === 'WEBP')
    return 'image/webp'
  if (ascii(data, 0, 3) === 'GIF')
    return 'image/gif'
  return fallback
}

/** Undo ID3 "unsynchronisation": every FF 00 was an FF. */
function unsync(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(b.length)
  let n = 0
  for (let i = 0; i < b.length; i++) {
    out[n++] = b[i]
    if (b[i] === 0xFF && b[i + 1] === 0x00)
      i++
  }
  return out.subarray(0, n)
}

/** Index just past a text terminator: one zero byte, or two (aligned) for UTF-16. */
function pastText(b: Uint8Array, at: number, encoding: number): number {
  if (encoding === 1 || encoding === 2) {
    for (let i = at; i + 1 < b.length; i += 2) {
      if (b[i] === 0 && b[i + 1] === 0)
        return i + 2
    }
    return b.length
  }
  const i = b.indexOf(0, at)
  return i < 0 ? b.length : i + 1
}

interface Found { type: number, art: CoverArt }

/** The front cover (picture type 3) if there is one, else the first picture. */
function best(list: Found[]): CoverArt | null {
  return (list.find(f => f.type === 3) ?? list[0])?.art ?? null
}

// ─── ID3v2 ────────────────────────────────────────────────────────────────────

export function id3Size(head: Uint8Array): number {
  if (head.length < 10 || ascii(head, 0, 3) !== 'ID3')
    return 0
  return 10 + syncsafe(head, 6) + (head[5] & 0x10 ? 10 : 0)
}

/** Pictures in an ID3v2 tag (`tag` starts at "ID3"). */
export function id3Cover(tag: Uint8Array): CoverArt | null {
  if (ascii(tag, 0, 3) !== 'ID3')
    return null
  const major = tag[3]
  const flags = tag[5]
  const end = Math.min(tag.length, 10 + syncsafe(tag, 6))
  let body = tag.subarray(10, end)
  if (major < 4 && flags & 0x80)
    body = unsync(body)
  let p = 0
  if (flags & 0x40) {
    // Extended header: v2.4 counts its own size, v2.3 does not.
    p = major >= 4 ? syncsafe(body, 0) : u32(body, 0) + 4
  }
  const found: Found[] = []
  const v22 = major === 2
  const headLen = v22 ? 6 : 10
  while (p + headLen <= body.length) {
    const id = ascii(body, p, v22 ? 3 : 4)
    if (!/^[A-Z0-9]{3,4}$/.test(id))
      break
    const size = v22 ? u24(body, p + 3) : major >= 4 ? syncsafe(body, p + 4) : u32(body, p + 4)
    const formatFlags = v22 ? 0 : body[p + 9]
    let frame = body.subarray(p + headLen, p + headLen + size)
    p += headLen + size
    if (size <= 0)
      continue
    if (id !== 'APIC' && id !== 'PIC')
      continue
    if (major >= 4) {
      // v2.4 frame flags: a data length indicator comes first; unsync is per frame.
      if (formatFlags & 0x01)
        frame = frame.subarray(4)
      if (formatFlags & 0x02)
        frame = unsync(frame)
    }
    const enc = frame[0]
    let i: number
    let mime: string
    if (v22) {
      const fmt = ascii(frame, 1, 3).toLowerCase()
      mime = fmt === 'png' ? 'image/png' : 'image/jpeg'
      i = 4
    }
    else {
      const m = frame.indexOf(0, 1)
      if (m < 0)
        continue
      mime = ascii(frame, 1, m - 1).toLowerCase()
      i = m + 1
    }
    const type = frame[i]
    const dataAt = pastText(frame, i + 1, enc)
    const data = frame.subarray(dataAt)
    if (data.length > 16)
      found.push({ type, art: { mime: sniffImageType(data, mime.includes('png') ? 'image/png' : 'image/jpeg'), data } })
  }
  return best(found)
}

// ─── FLAC ─────────────────────────────────────────────────────────────────────

async function flacCover(src: ByteSource, start: number): Promise<CoverArt | null> {
  let p = start + 4
  const found: Found[] = []
  for (let guard = 0; guard < 64 && p + 4 <= src.size; guard++) {
    const head = await src.read(p, 4)
    const last = head[0] & 0x80
    const type = head[0] & 0x7F
    const len = u24(head, 1)
    if (type === 6 && len < MAX_TAG_BYTES) {
      const b = await src.read(p + 4, len)
      const picType = u32(b, 0)
      const mimeLen = u32(b, 4)
      const mime = ascii(b, 8, mimeLen)
      const descLen = u32(b, 8 + mimeLen)
      const at = 8 + mimeLen + 4 + descLen + 16
      const dataLen = u32(b, at)
      const data = b.subarray(at + 4, at + 4 + dataLen)
      if (data.length > 16)
        found.push({ type: picType, art: { mime: sniffImageType(data, mime || 'image/jpeg'), data } })
    }
    p += 4 + len
    if (last)
      break
  }
  return best(found)
}

// ─── MP4 / M4A ────────────────────────────────────────────────────────────────

interface Atom { type: string, start: number, body: number, end: number }

/** The atoms in [from, to) of `b`. */
function atomsIn(b: Uint8Array, from: number, to: number): Atom[] {
  const out: Atom[] = []
  let p = from
  while (p + 8 <= to) {
    let size = u32(b, p)
    const type = ascii(b, p + 4, 4)
    let body = p + 8
    if (size === 1) {
      size = u32(b, p + 12) + u32(b, p + 8) * 2 ** 32
      body = p + 16
    }
    else if (size === 0) {
      size = to - p
    }
    if (size < 8)
      break
    out.push({ type, start: p, body, end: Math.min(to, p + size) })
    p += size
  }
  return out
}

function child(b: Uint8Array, a: Atom | undefined, type: string, skip = 0): Atom | undefined {
  return a ? atomsIn(b, a.body + skip, a.end).find(c => c.type === type) : undefined
}

/** The cover in an m4a's `moov` atom (`moov` is the whole atom, header included). */
export function mp4CoverIn(moov: Uint8Array): CoverArt | null {
  const root = atomsIn(moov, 0, moov.length).find(a => a.type === 'moov')
  const meta = child(moov, child(moov, root, 'udta'), 'meta') ?? child(moov, root, 'meta')
  // `meta` is a full box: four bytes of version and flags before its children.
  const covr = child(moov, child(moov, meta, 'ilst', 4), 'covr')
  if (!covr)
    return null
  for (const d of atomsIn(moov, covr.body, covr.end)) {
    if (d.type !== 'data')
      continue
    // Type indicator (13 JPEG, 14 PNG) and a locale, then the picture.
    const kind = u32(moov, d.body)
    const data = moov.subarray(d.body + 8, d.end)
    if (data.length > 16)
      return { mime: sniffImageType(data, kind === 14 ? 'image/png' : 'image/jpeg'), data }
  }
  return null
}

async function mp4Cover(src: ByteSource): Promise<CoverArt | null> {
  // Walk the top level by headers alone: `moov` may come after the media.
  let p = 0
  for (let guard = 0; guard < 256 && p + 8 <= src.size; guard++) {
    const head = await src.read(p, 16)
    let size = u32(head, 0)
    const type = ascii(head, 4, 4)
    if (size === 1)
      size = u32(head, 12) + u32(head, 8) * 2 ** 32
    else if (size === 0)
      size = src.size - p
    if (size < 8)
      return null
    if (type === 'moov')
      return size <= MAX_TAG_BYTES ? mp4CoverIn(await src.read(p, size)) : null
    p += size
  }
  return null
}

// ─── Any of them ──────────────────────────────────────────────────────────────

/** The embedded cover of an audio file, or null when it has none (or it cannot tell). */
export async function findCover(src: ByteSource): Promise<CoverArt | null> {
  try {
    const head = await src.read(0, 16)
    if (head.length < 12)
      return null
    const tagSize = id3Size(head)
    if (tagSize) {
      if (tagSize <= MAX_TAG_BYTES) {
        const art = id3Cover(await src.read(0, tagSize))
        if (art)
          return art
      }
      // A FLAC can carry an ID3 tag in front of its own header.
      const after = await src.read(tagSize, 4)
      if (ascii(after, 0, 4) === 'fLaC')
        return flacCover(src, tagSize)
      return null
    }
    if (ascii(head, 0, 4) === 'fLaC')
      return flacCover(src, 0)
    if (ascii(head, 4, 4) === 'ftyp')
      return mp4Cover(src)
    return null
  }
  catch {
    return null
  }
}
