// Which hosts a plugin's socket may reach (desktop/netsocket.mjs): this
// computer and the local network, nothing on the internet. Pure, so the
// tests can check the rules without a network.

import net from 'node:net'

/** IPv4 as four numbers, or null. */
function v4Parts(ip) {
  if (!net.isIPv4(ip))
    return null
  return ip.split('.').map(Number)
}

/**
 * Loopback, the private ranges of RFC 1918, link-local, and their IPv6
 * counterparts (::1, fe80::/10, fc00::/7). An IPv4 address written as IPv6
 * (::ffff:192.168.1.5) is judged as the IPv4 one.
 */
export function isPrivateAddress(ip) {
  if (typeof ip !== 'string')
    return false
  let a = ip.trim()
  if (a.startsWith('[') && a.endsWith(']'))
    a = a.slice(1, -1)
  // A zone (fe80::1%eth0) says which adapter; the address is what counts.
  a = a.replace(/%.*$/, '')
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a)
  if (mapped)
    a = mapped[1]
  const p = v4Parts(a)
  if (p) {
    const [x, y] = p
    return x === 127 // loopback
      || x === 10
      || (x === 172 && y >= 16 && y <= 31)
      || (x === 192 && y === 168)
      || (x === 169 && y === 254) // link-local
  }
  if (!net.isIPv6(a))
    return false
  const lower = a.toLowerCase()
  if (lower === '::1')
    return true
  const first = Number.parseInt(lower.split(':')[0] || '0', 16)
  return (first & 0xFFC0) === 0xFE80 // fe80::/10
    || (first & 0xFE00) === 0xFC00 // fc00::/7
}

/**
 * Whether a socket may go to `host`, before any lookup:
 * - `{ ok: true, address }` for localhost or a private IP address
 * - `{ ok: true, lookup: true }` for a `.local` name, which still has to
 *   resolve to private addresses only (see allowedAddresses)
 * - `{ ok: false, reason }` for anything else, in words for the plugin
 */
export function checkHost(host) {
  if (typeof host !== 'string' || !host.trim())
    return { ok: false, reason: 'host must be a name or an address' }
  let h = host.trim().toLowerCase()
  if (h.startsWith('[') && h.endsWith(']'))
    h = h.slice(1, -1)
  if (h === 'localhost')
    return { ok: true, address: '127.0.0.1' }
  if (net.isIP(h.replace(/%.*$/, ''))) {
    return isPrivateAddress(h)
      ? { ok: true, address: h }
      : { ok: false, reason: `${host} is not on your network: only this computer and private addresses (192.168.x.x, 10.x.x.x, 172.16–31.x.x, link-local) can be reached` }
  }
  if (/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+local\.?$/.test(h))
    return { ok: true, lookup: true }
  return { ok: false, reason: `${host} is not on your network: use an address on it (192.168.x.x…), localhost, or a .local name` }
}

/**
 * The addresses a `.local` name resolved to, if every one is private;
 * otherwise null (a name that points outside the network is refused whole).
 */
export function allowedAddresses(resolved) {
  const list = (resolved ?? []).map(r => (typeof r === 'string' ? r : r?.address)).filter(Boolean)
  if (!list.length || !list.every(isPrivateAddress))
    return null
  return list
}

/** A TCP port, 1–65535, or null. */
export function portOf(p) {
  return Number.isInteger(p) && p >= 1 && p <= 65535 ? p : null
}
