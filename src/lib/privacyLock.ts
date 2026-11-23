/**
 * The app lock's rules, apart from any screen: how a PIN is kept and checked,
 * when time away is long enough to lock again, and how long wrong PINs make
 * the lock screen wait. The store (stores/privacyStore.ts) holds the state.
 *
 * The lock keeps playhound private from people nearby. It is not encryption:
 * nothing else in storage is scrambled, and anyone who can open the page's
 * developer tools can take it off. The PIN is still never kept as typed,
 * because people reuse PINs (the bank card's, the phone's), and a backup file
 * or a look at storage should not hand that over.
 */

/** A PIN as it is kept: a salted PBKDF2-SHA-256 hash, never the digits. */
export interface PinRecord {
  v: 1
  /** Base64. */
  salt: string
  /** Base64, 32 bytes. */
  hash: string
  iterations: number
  /** How many digits, so the lock screen can check as soon as the last one is in. */
  digits: number
}

export const PIN_MIN = 4
export const PIN_MAX = 8

/**
 * OWASP's figure for PBKDF2-HMAC-SHA256. About a tenth of a second on a
 * desktop and well under a second on a phone: unnoticed once per unlock,
 * slow enough that a stolen hash of an 8-digit PIN takes a while to undo.
 * Kept in each record, so raising it later leaves older PINs working.
 */
export const PIN_ITERATIONS = 600_000

export function isValidPin(pin: string): boolean {
  return new RegExp(`^\\d{${PIN_MIN},${PIN_MAX}}$`).test(pin)
}

/**
 * WebCrypto, which only exists on a secure page: https, the desktop app and
 * the Android app (both localhost), not plain http from another machine on
 * the network. Without it there is nothing to hash with, so no lock there.
 */
export function canHashPins(): boolean {
  return !!globalThis.crypto?.subtle
}

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes)
    s += String.fromCharCode(b)
  return btoa(s)
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++)
    out[i] = bin.charCodeAt(i)
  return out
}

async function derive(pin: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const subtle = globalThis.crypto.subtle
  const key = await subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits'])
  const bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, key, 256)
  return new Uint8Array(bits)
}

/** A new record for `pin`, with a fresh random salt. Throws on anything but 4–8 digits. */
export async function hashPin(pin: string, iterations = PIN_ITERATIONS): Promise<PinRecord> {
  if (!isValidPin(pin))
    throw new Error(`A PIN is ${PIN_MIN} to ${PIN_MAX} digits`)
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16))
  const hash = await derive(pin, salt, iterations)
  return { v: 1, salt: toBase64(salt), hash: toBase64(hash), iterations, digits: pin.length }
}

/** Whether `pin` is the one `rec` was made from. */
export async function verifyPin(pin: string, rec: PinRecord): Promise<boolean> {
  if (!isValidPin(pin))
    return false
  const got = await derive(pin, fromBase64(rec.salt), rec.iterations)
  const want = fromBase64(rec.hash)
  if (got.length !== want.length)
    return false
  // Every byte, whatever the first difference: the time taken says nothing.
  let diff = 0
  for (let i = 0; i < got.length; i++)
    diff |= got[i] ^ want[i]
  return diff === 0
}

/** A stored value as a record, or null if it isn't one (nothing set, or edited by hand). */
export function parsePinRecord(raw: unknown): PinRecord | null {
  const r = raw as Partial<PinRecord> | null
  if (!r || typeof r !== 'object' || r.v !== 1)
    return null
  if (typeof r.salt !== 'string' || typeof r.hash !== 'string' || !r.salt || !r.hash)
    return null
  if (!Number.isInteger(r.iterations) || r.iterations! < 1)
    return null
  const digits = Number.isInteger(r.digits) && r.digits! >= PIN_MIN && r.digits! <= PIN_MAX ? r.digits! : PIN_MAX
  return { v: 1, salt: r.salt, hash: r.hash, iterations: r.iterations!, digits }
}

// ─── Locking again after time away ────────────────────────────────────────────

/** Minutes away before it locks again; 0 is as soon as the app is out of sight. */
export const RELOCK_CHOICES = [0, 1, 5, 15] as const
export type RelockAfter = typeof RELOCK_CHOICES[number]
export const RELOCK_DEFAULT: RelockAfter = 1

/**
 * Leaving for a picker or a page playhound opened itself (a folder picker,
 * the share sheet, the forum's sign-in) is not walking away, but someone could
 * still go off from there. "At once" waits this long in that case, so picking
 * a folder doesn't ask for the PIN on the way back.
 */
export const OWN_LEAVE_GRACE_MS = 60_000

/** How long away (ms) locks it again. `own`: the app opened what took its place. */
export function relockDelayMs(minutes: number, own = false): number {
  const ms = Math.max(0, minutes) * 60_000
  return own ? Math.max(ms, OWN_LEAVE_GRACE_MS) : ms
}

/** On coming back: whether the time away was long enough to lock. */
export function awayLongEnough(awaySince: number, now: number, minutes: number, own = false): boolean {
  return now - awaySince >= relockDelayMs(minutes, own)
}

// ─── Wrong PINs ───────────────────────────────────────────────────────────────

/** Wrong PINs in a row, and until when (epoch ms) the lock screen takes no more. */
export interface Attempts {
  fails: number
  until: number
}

export const NO_ATTEMPTS: Attempts = { fails: 0, until: 0 }

/**
 * The wait after the n-th wrong PIN in a row: none for the first four (a
 * typo, a thumb), then longer the more there are. Kept across restarts, so
 * closing the app doesn't start the count again. A four-digit PIN then takes
 * days to find by hand.
 */
export function waitAfterFails(fails: number): number {
  if (fails < 5)
    return 0
  if (fails < 10)
    return 30_000
  if (fails < 15)
    return 60_000
  return 5 * 60_000
}

export function afterWrongPin(a: Attempts, now: number): Attempts {
  const fails = a.fails + 1
  const wait = waitAfterFails(fails)
  return { fails, until: wait ? now + wait : 0 }
}

/** Milliseconds still to wait before another try, 0 if none. */
export function waitLeft(a: Attempts, now: number): number {
  return Math.max(0, a.until - now)
}
