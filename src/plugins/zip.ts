/**
 * Just enough of a zip reader to unpack a plugin: stored and deflated
 * entries, read through the central directory, inflated with the browser's
 * own DecompressionStream. No zip64, no encryption, no spanning; a plugin
 * that needs those is doing something else.
 */

const EOCD_SIG = 0x06054B50
const CEN_SIG = 0x02014B50
const LOC_SIG = 0x04034B50
/** Unpacked, all files together. A plugin is code and a few assets. */
const MAX_TOTAL = 64 * 1024 * 1024

export interface ZipEntry {
  path: string
  data: Uint8Array
}

async function inflate(raw: Uint8Array): Promise<Uint8Array> {
  const reader = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(raw)
      c.close()
    },
  }).pipeThrough(new DecompressionStream('deflate-raw') as unknown as TransformStream<Uint8Array, Uint8Array>).getReader()
  const parts: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done)
      break
    parts.push(value)
    size += value.length
  }
  const out = new Uint8Array(size)
  let p = 0
  for (const part of parts) {
    out.set(part, p)
    p += part.length
  }
  return out
}

/** Every file in the archive (directories left out), paths with forward slashes. */
export async function unzip(buf: ArrayBuffer | Uint8Array): Promise<ZipEntry[]> {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  // The end record sits in the last 22 bytes plus up to 64 KiB of comment.
  let eocd = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xFFFF); i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd < 0)
    throw new Error('Not a zip file')
  const count = view.getUint16(eocd + 10, true)
  let p = view.getUint32(eocd + 16, true)

  const out: ZipEntry[] = []
  let total = 0
  const decoder = new TextDecoder()
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== CEN_SIG)
      throw new Error('Damaged zip (central directory)')
    const flags = view.getUint16(p + 8, true)
    const method = view.getUint16(p + 10, true)
    const size = view.getUint32(p + 20, true)
    const usize = view.getUint32(p + 24, true)
    const nameLen = view.getUint16(p + 28, true)
    const extraLen = view.getUint16(p + 30, true)
    const commentLen = view.getUint16(p + 32, true)
    const local = view.getUint32(p + 42, true)
    const path = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen)).replace(/\\/g, '/')
    p += 46 + nameLen + extraLen + commentLen

    if (path.endsWith('/'))
      continue
    if (flags & 1)
      throw new Error(`${path} is encrypted`)
    if (path.startsWith('/') || path.split('/').includes('..'))
      throw new Error(`Unsafe path in zip: ${path}`)
    total += usize
    if (total > MAX_TOTAL)
      throw new Error('Zip unpacks to more than 64 MB')

    if (view.getUint32(local, true) !== LOC_SIG)
      throw new Error(`Damaged zip (${path})`)
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
    const raw = bytes.subarray(start, start + size)
    let data: Uint8Array
    if (method === 0)
      data = raw.slice()
    else if (method === 8)
      data = await inflate(raw)
    else
      throw new Error(`${path}: compression method ${method} is not supported`)
    out.push({ path, data })
  }
  return out
}

/**
 * The files as the plugin sees them: a zip made by right-clicking a folder
 * wraps everything in that folder, so a single top-level directory around a
 * manifest.json is taken off.
 */
export function stripCommonRoot(entries: ZipEntry[]): ZipEntry[] {
  if (entries.some(e => e.path === 'manifest.json'))
    return entries
  const roots = new Set(entries.map(e => e.path.split('/')[0]))
  if (roots.size !== 1)
    return entries
  const [root] = roots
  if (!entries.some(e => e.path === `${root}/manifest.json`))
    return entries
  return entries.map(e => ({ ...e, path: e.path.slice(root.length + 1) }))
}
