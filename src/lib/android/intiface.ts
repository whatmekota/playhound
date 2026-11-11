/**
 * Intiface Central from the Android app: it runs on the PC, and the phone
 * reaches it over Wi-Fi (a plain ws:// to a LAN address, which the app's
 * http://localhost page may open). "localhost" there is the phone itself.
 */

export const INTIFACE_PORT = 12345

/** Whether an address points at this device itself. */
function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  return h === 'localhost' || h === '::1' || /^127\./.test(h)
}

/**
 * The server address from what was typed: "192.168.1.20", "pc.local:12345",
 * "ws://192.168.1.20:12345" all work; the scheme and Intiface's port are
 * added when left out. A problem in words instead, for an empty field or
 * the phone's own address.
 */
export function intifaceUrl(input: string): { url: string, problem: null } | { url: null, problem: string } {
  let s = input.trim()
  if (!s)
    return { url: null, problem: 'Enter the address of the PC running Intiface Central, like 192.168.1.20.' }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s))
    s = `ws://${s}`
  let u: URL
  try {
    u = new URL(s)
  }
  catch {
    return { url: null, problem: `"${input.trim()}" is not an address. Enter the PC's address on your Wi-Fi, like 192.168.1.20.` }
  }
  if (u.protocol === 'http:')
    u.protocol = 'ws:'
  else if (u.protocol === 'https:')
    u.protocol = 'wss:'
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:')
    return { url: null, problem: 'Intiface\'s address starts with ws://, like ws://192.168.1.20:12345.' }
  if (isLoopback(u.hostname))
    return { url: null, problem: 'On the phone, localhost is the phone itself. Enter the address of the PC running Intiface Central instead, like 192.168.1.20.' }
  if (!u.port)
    u.port = String(INTIFACE_PORT)
  const out = u.toString()
  return { url: u.pathname === '/' && !u.search ? out.replace(/\/$/, '') : out, problem: null }
}

/** A saved address that is no use on the phone (the desktop's default) reads as empty. */
export function phoneIntifaceField(saved: string): string {
  try {
    const u = new URL(saved)
    return isLoopback(u.hostname) ? '' : saved
  }
  catch {
    return saved
  }
}
