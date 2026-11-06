/**
 * Video fingerprints: an id for a file's contents, the same on any machine
 * whatever the file is called, cheap enough for a whole library.
 *
 * SHA-256 over the file's size and three 64 KB pieces: the start, the middle
 * and the end (a small file is hashed whole). Containers put headers and
 * indexes at the ends and the middle is deep in the picture, so two different
 * videos of the same size practically never share all three. The duration is
 * left out on purpose: it adds nothing the bytes don't already say, and
 * reading it means decoding, which differs between machines in the last
 * decimal and would make the same file disagree with itself.
 *
 * Written `v1:<size>:<hash>`: the size up front lets a lookup skip every file
 * of another size without reading it.
 */

export const CHUNK = 64 * 1024

/** Byte ranges [start, end) to hash for a file of `size` bytes. */
export function fingerprintRanges(size: number, chunk = CHUNK): [number, number][] {
  if (size <= chunk * 3)
    return [[0, size]]
  const mid = Math.floor((size - chunk) / 2)
  return [[0, chunk], [mid, mid + chunk], [size - chunk, size]]
}

/** The size a fingerprint was made for, or null if it isn't one. */
export function fingerprintSize(fp: unknown): number | null {
  if (typeof fp !== 'string')
    return null
  const m = fp.match(/^v1:(\d+):[0-9a-f]{64}$/)
  return m ? Number(m[1]) : null
}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('')

/** The fingerprint of a file (or any Blob). */
export async function fingerprintOf(file: Blob): Promise<string> {
  const parts: BlobPart[] = [`playhound-fp-v1:${file.size}:`]
  for (const [a, b] of fingerprintRanges(file.size))
    parts.push(await file.slice(a, b).arrayBuffer())
  // Copied into this realm's own array: digest() refuses a buffer made elsewhere (jsdom's, in tests).
  const data = new Uint8Array(await new Blob(parts).arrayBuffer())
  return `v1:${file.size}:${hex(await crypto.subtle.digest('SHA-256', data))}`
}
