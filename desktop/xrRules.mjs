import { Buffer } from 'node:buffer'
import crypto from 'node:crypto'

/**
 * The headset server's small rules, apart from Electron so the tests can load
 * them (desktop/xr.mjs).
 */

/** The pairing code's length: short enough to type with a controller. */
export const CODE_DIGITS = 6
/** Wrong codes in a row before the code is replaced (shown again in the app). */
export const MAX_TRIES = 5
/** The cookie a paired headset carries. */
export const COOKIE = 'ph_xr'

/** A fresh pairing code: CODE_DIGITS digits, leading zeros kept. */
export function newCode() {
  return String(crypto.randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, '0')
}

/** A fresh headset token, and what is kept of it (its hash). */
export function newToken() {
  const token = crypto.randomBytes(32).toString('hex')
  return { token, hash: hashToken(token) }
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex')
}

/** Whether `typed` is the code, compared in constant time. Spaces and dashes are allowed. */
export function codeMatches(typed, code) {
  const a = Buffer.from(String(typed ?? '').replace(/[\s-]/g, ''))
  const b = Buffer.from(String(code ?? ''))
  return a.length === b.length && b.length > 0 && crypto.timingSafeEqual(a, b)
}

/** One cookie's value from a Cookie header, or null. */
export function readCookie(header, name) {
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name)
      return part.slice(i + 1).trim() || null
  }
  return null
}

/** The cookie that pairs a headset: a year, this site only, never to scripts. */
export function pairCookie(token) {
  return `${COOKIE}=${token}; Max-Age=31536000; Path=/; HttpOnly; Secure; SameSite=Strict`
}

/**
 * A Range header against a file of `size` bytes: { start, end } (inclusive),
 * null for none (the whole file), 'bad' for one that can't be served (416).
 * Only a single range; a suffix range (bytes=-500) is the last 500 bytes.
 */
export function parseRange(header, size) {
  if (!header)
    return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim())
  if (!m || (m[1] === '' && m[2] === ''))
    return 'bad'
  let start
  let end
  if (m[1] === '') {
    const n = Number(m[2])
    if (!n)
      return 'bad'
    start = Math.max(0, size - n)
    end = size - 1
  }
  else {
    start = Number(m[1])
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  }
  return start <= end && start < size ? { start, end } : 'bad'
}

const VIDEO_TYPES = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
}

/** A media file's Content-Type by its name. */
export function mediaType(name) {
  const ext = /\.[^.]+$/.exec(String(name).toLowerCase())?.[0] ?? ''
  return VIDEO_TYPES[ext] ?? 'application/octet-stream'
}
