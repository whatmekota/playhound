/**
 * TCode over the network: where to send it, and how.
 *
 * The same TCode the serial port gets (tcodeEncoder) goes out over a
 * WebSocket (browser and desktop app) or UDP (desktop app only, through the
 * main process: desktop/tcodenet.mjs). Pure: addresses, presets, framing and
 * retry timing, so they can be tested without a socket.
 *
 * What the targets expect, read from their source (November 2026):
 *
 * - TCode ESP32 (jcfain/TCodeESP32), the WiFi firmware for OSR2/SR6 boards:
 *   UDP on port 8000 (`udpServerPort`), and a WebSocket at `/ws` on the web
 *   server's port 80 that takes raw TCode in text frames (a frame with a `{`
 *   in it is read as JSON instead). Hostname `tcode`, so `tcode.local` over
 *   mDNS. A move only starts at a newline: several axes may share one line,
 *   space-separated, and a datagram holds at most 256 bytes. `D0` answers
 *   with the firmware's name. Nothing times out: axes hold where they are.
 * - restim (diglet48/restim): a WebSocket server on 12346 at `/tcode`, and
 *   TCP and UDP on 12347, all on by default. Each frame or datagram is split
 *   on whitespace; no newline needed (a trailing one is fine). Its own axis
 *   names: L0 is alpha and L1 beta (both 0–1 mapped to -1..1), V0 volume,
 *   C0 carrier frequency, P0–P3 pulse settings. Commands shorter than three
 *   characters (`D0`) are dropped.
 * - MultiFunPlayer's defaults agree: UDP to tcode.local:8000, one line per
 *   update with the axes space-separated and a single `\n`.
 */

export type NetProtocol = 'ws' | 'udp'

export interface NetTarget {
  protocol: NetProtocol
  /** A name, an IPv4 address or an IPv6 address (without brackets). */
  host: string
  port: number
  /** WebSocket path, starting with `/`. Empty for UDP. */
  path: string
  /** wss:// rather than ws://. */
  secure?: boolean
}

export type NetPresetId = 'esp32-udp' | 'esp32-ws' | 'restim-ws' | 'restim-udp' | 'custom'

export interface NetPreset {
  id: NetPresetId
  label: string
  /** What it is for, one line. */
  hint: string
  target: NetTarget | null
}

export const NET_PRESETS: NetPreset[] = [
  {
    id: 'esp32-udp',
    label: 'ESP32 OSR (UDP)',
    hint: 'TCode ESP32 firmware on an OSR2 or SR6 over WiFi. Desktop app only.',
    target: { protocol: 'udp', host: 'tcode.local', port: 8000, path: '' },
  },
  {
    id: 'esp32-ws',
    label: 'ESP32 OSR (WebSocket)',
    hint: 'The same firmware through its web server, for the browser.',
    target: { protocol: 'ws', host: 'tcode.local', port: 80, path: '/ws' },
  },
  {
    id: 'restim-ws',
    label: 'restim (WebSocket)',
    hint: 'restim on this computer. It reads L0 as alpha, L1 as beta and V0 as volume.',
    target: { protocol: 'ws', host: 'localhost', port: 12346, path: '/tcode' },
  },
  {
    id: 'restim-udp',
    label: 'restim (UDP)',
    hint: 'restim on this computer, over UDP. Desktop app only.',
    target: { protocol: 'udp', host: 'localhost', port: 12347, path: '' },
  },
  { id: 'custom', label: 'Custom', hint: 'Any host and port that takes TCode.', target: null },
]

export function presetById(id: string): NetPreset | undefined {
  return NET_PRESETS.find(p => p.id === id)
}

/** Default port when an address leaves it out. */
export const DEFAULT_PORT: Record<NetProtocol, number> = { ws: 80, udp: 8000 }

export type ParseResult = { ok: true, target: NetTarget } | { ok: false, error: string }

/** A DNS name or an IPv4 address: letters, digits, dots, hyphens and underscores. */
const HOSTNAME = /^\w[\w-]{0,62}(?:\.\w[\w-]{0,62})*\.?$/
const IPV6 = /^[0-9a-f:.]+(?:%\w+)?$/i

function validHost(host: string): boolean {
  if (!host || host.length > 253)
    return false
  if (host.includes(':'))
    return IPV6.test(host) && host.split(':').length >= 3
  return HOSTNAME.test(host)
}

/**
 * Read what the user typed as an address for `protocol`.
 *
 * Takes `host`, `host:port`, `[v6]:port`, a bare IPv6 address, or for a
 * WebSocket a whole `ws://host:port/path` URL. A URL's scheme wins over
 * `protocol` (`udp://` is accepted too). The port defaults per protocol, and
 * a WebSocket's path to `fallbackPath` (else `/`).
 */
export function parseAddress(input: string, protocol: NetProtocol, fallbackPath = ''): ParseResult {
  let text = input.trim()
  if (!text)
    return { ok: false, error: 'Enter an address, like tcode.local or 192.168.1.40:8000' }

  let proto = protocol
  let secure = false
  const scheme = /^([a-z]+):\/\//i.exec(text)
  if (scheme) {
    const s = scheme[1].toLowerCase()
    if (s === 'ws' || s === 'wss') {
      proto = 'ws'
      secure = s === 'wss'
    }
    else if (s === 'udp') {
      proto = 'udp'
    }
    else {
      return { ok: false, error: `${s}:// is not something TCode goes over. Use ws://, or pick UDP.` }
    }
    text = text.slice(scheme[0].length)
  }

  // Split off the path (WebSocket only).
  let path = ''
  const slash = text.indexOf('/')
  if (slash >= 0) {
    path = text.slice(slash)
    text = text.slice(0, slash)
    if (proto === 'udp' && path !== '/')
      return { ok: false, error: 'UDP has no path: just a host and a port.' }
    if (proto === 'udp')
      path = ''
  }

  let host = text
  let portText = ''
  if (text.startsWith('[')) {
    const end = text.indexOf(']')
    if (end < 0)
      return { ok: false, error: 'An IPv6 address needs its closing ]' }
    host = text.slice(1, end)
    const rest = text.slice(end + 1)
    if (rest) {
      if (!rest.startsWith(':'))
        return { ok: false, error: 'Put the port after the ], like [::1]:8000' }
      portText = rest.slice(1)
    }
  }
  else if ((text.match(/:/g) ?? []).length === 1) {
    const i = text.indexOf(':')
    host = text.slice(0, i)
    portText = text.slice(i + 1)
  }
  // More than one colon and no brackets: a bare IPv6 address.

  if (!validHost(host))
    return { ok: false, error: `"${host || text}" is not a host name or an IP address` }

  let port = DEFAULT_PORT[proto]
  if (portText !== '') {
    if (!/^\d{1,5}$/.test(portText))
      return { ok: false, error: `"${portText}" is not a port number` }
    port = Number(portText)
    if (port < 1 || port > 65535)
      return { ok: false, error: 'The port must be between 1 and 65535' }
  }
  else if (secure) {
    port = 443
  }

  if (proto === 'ws' && !path)
    path = fallbackPath || '/'

  return { ok: true, target: { protocol: proto, host: host.toLowerCase(), port, path, ...(secure ? { secure } : {}) } }
}

function hostPart(host: string) {
  return host.includes(':') ? `[${host}]` : host
}

/** How an address is written back into the address field. */
export function formatAddress(t: NetTarget): string {
  if (t.protocol === 'ws')
    return wsUrl(t)
  return `${hostPart(t.host)}:${t.port}`
}

export function wsUrl(t: NetTarget): string {
  const scheme = t.secure ? 'wss' : 'ws'
  const defaultPort = t.secure ? 443 : 80
  const port = t.port === defaultPort ? '' : `:${t.port}`
  return `${scheme}://${hostPart(t.host)}${port}${t.path || '/'}`
}

/** A short label for the status line: `tcode.local:8000` or `localhost:12346/tcode`. */
export function describeTarget(t: NetTarget): string {
  const path = t.protocol === 'ws' && t.path && t.path !== '/' ? t.path : ''
  return `${hostPart(t.host)}:${t.port}${path}`
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1'])

export function isLoopback(host: string): boolean {
  const h = host.toLowerCase()
  return LOOPBACK.has(h) || h.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(h)
}

/**
 * Whether the browser will refuse this WebSocket: a page served over https
 * may not open a plain ws:// connection, except to this computer itself.
 * The desktop app and `pnpm dev` serve over http, so it only bites the
 * hosted page.
 */
export function mixedContentBlocked(pageProtocol: string, t: NetTarget): boolean {
  return t.protocol === 'ws' && !t.secure && pageProtocol === 'https:' && !isLoopback(t.host)
}

/**
 * TCode ESP32 copies a datagram into a 256-byte buffer (MAX_COMMAND); stay
 * well inside it, terminator and all.
 */
export const MAX_DATAGRAM = 240

/**
 * Turn what the serial port would get (each command ending in `\n`) into
 * network messages: the commands of one write on one line, space-separated,
 * ending in a single `\n`, as MultiFunPlayer sends them. The firmware starts
 * every move on that line together; restim splits on whitespace either way.
 * A line longer than `max` bytes is split between commands.
 */
export function toNetMessages(serial: string, max = MAX_DATAGRAM): string[] {
  const cmds = serial.split(/\s+/).filter(Boolean)
  const out: string[] = []
  let line = ''
  for (const c of cmds) {
    const next = line ? `${line} ${c}` : c
    if (line && next.length + 1 > max) {
      out.push(`${line}\n`)
      line = c
    }
    else {
      line = next
    }
  }
  if (line)
    out.push(`${line}\n`)
  return out
}

// ─── Reconnecting ─────────────────────────────────────────────────────────────

export const RETRY_FIRST_MS = 1000
export const RETRY_MAX_MS = 15_000

/**
 * How long to wait before reconnect attempt `attempt` (0 for the first):
 * 1 s, 2 s, 4 s, 8 s, then every 15 s. `jitter` (0–1, random by default
 * in the caller) spreads it by up to ±20% so a device that rebooted is not
 * hit by every retry at once.
 */
export function retryDelay(attempt: number, jitter = 0.5): number {
  const base = Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** Math.max(0, Math.min(10, attempt)))
  const spread = 1 + 0.4 * (Math.max(0, Math.min(1, jitter)) - 0.5)
  return Math.round(Math.min(RETRY_MAX_MS, base * spread))
}

/** Give up on a connection that has not opened after this long. */
export const OPEN_TIMEOUT_MS = 5000

// ─── Coming back ──────────────────────────────────────────────────────────────

/**
 * Right after a link comes up (or back), the device can be anywhere, and the
 * next command (a script frame aimed 33 ms ahead) would throw it there at
 * full speed. For this long, every move is stretched to end no sooner than
 * the end of the window, so the device glides to where the motion is instead.
 */
export const RESUME_MS = 800

/** The interval to send `sinceUpMs` after the link came up. */
export function resumeInterval(interval: number, sinceUpMs: number, windowMs = RESUME_MS): number {
  if (!(sinceUpMs >= 0) || sinceUpMs >= windowMs)
    return interval
  return Math.max(interval, Math.round(windowMs - sinceUpMs))
}
