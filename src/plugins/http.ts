import type { HttpHandler, HttpRequest, HttpResponse } from './types'
import type { DesktopHttpReply, DesktopHttpRequest } from '~/lib/browserApi'
import { desktop } from '~/lib/browserApi'

/**
 * Plugins' answers on the desktop app's LAN server, on this side.
 *
 * The desktop app hands every request for `/plugins/<id>/…` or
 * `/ph-files/<token>` to the page (desktop/pluginhttp.mjs), and the page
 * answers it from here:
 * - `/plugins/<id>/…` goes to that plugin's handler (ctx.http.serve), and to
 *   nobody else's; a plugin that is switched off has none
 * - `/ph-files/<token>` streams one file a plugin asked a link for
 *   (ctx.library.mediaUrl / scriptUrl), with Range for seeking. The token is
 *   random and the link stops working when that plugin is switched off.
 * Nothing else is reachable: there is no path that reads the disk.
 */

export const SERVE_NEEDS_DESKTOP = 'Sharing on your network needs the playhound desktop app'

/** Bytes a body is sent in, one per pull. */
const CHUNK = 1024 * 1024

export type Route = { kind: 'plugin', id: string, path: string } | { kind: 'file', token: string } | null

/** Which of ours a path is: a plugin's, a shared file, or neither. */
export function routeOf(pathname: string): Route {
  const p = /^\/plugins\/([a-z0-9][a-z0-9-]{0,47})(\/.*)?$/.exec(pathname)
  if (p)
    return { kind: 'plugin', id: p[1], path: p[2] || '/' }
  const f = /^\/ph-files\/([\w-]{16,64})(?:\/.*)?$/.exec(pathname)
  if (f)
    return { kind: 'file', token: f[1] }
  return null
}

/**
 * A Range header against a file of `size` bytes: the first range asked for
 * (several in one header are rare from video players, and serving one is
 * allowed), 'unsatisfiable' when it lies outside the file, or null to send
 * the whole file (none, or one this doesn't read).
 */
export function parseRange(header: string | null | undefined, size: number): { start: number, end: number } | 'unsatisfiable' | null {
  if (!header)
    return null
  const m = /^bytes=(\d*)-(\d*)(?:,.*)?$/i.exec(header.replace(/\s+/g, ''))
  if (!m || (m[1] === '' && m[2] === ''))
    return null
  if (m[1] === '') {
    // The last n bytes.
    const n = Number(m[2])
    if (n === 0)
      return 'unsatisfiable'
    return { start: Math.max(0, size - n), end: size - 1 }
  }
  const start = Number(m[1])
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  if (start >= size || end < start)
    return 'unsatisfiable'
  return { start, end }
}

const encoder = new TextEncoder()

/**
 * A plugin's answer as status, headers and body, or throw saying what is
 * wrong with it. `json` wins over `body`; a body's type is guessed when the
 * headers don't say.
 */
export function responseOf(r: unknown): { status: number, headers: [string, string][], body: Uint8Array | Blob } {
  if (r === undefined || r === null)
    return { status: 404, headers: [['Content-Type', 'text/plain; charset=utf-8']], body: encoder.encode('Not found') }
  if (typeof r !== 'object' || Array.isArray(r))
    throw new TypeError('An http handler returns { status?, headers?, body? } or { json }')
  const o = r as HttpResponse
  const status = o.status === undefined ? 200 : Number(o.status)
  if (!Number.isInteger(status) || status < 100 || status > 599)
    throw new TypeError(`status must be an HTTP status, not ${String(o.status)}`)
  const headers: [string, string][] = []
  for (const [k, v] of Object.entries(o.headers ?? {})) {
    if (/^[\w-]+$/.test(k) && v !== undefined && v !== null)
      headers.push([k, String(v)])
  }
  const has = (name: string) => headers.some(([k]) => k.toLowerCase() === name)
  let body: Uint8Array | Blob
  let type: string
  if ('json' in o && o.json !== undefined) {
    body = encoder.encode(JSON.stringify(o.json))
    type = 'application/json; charset=utf-8'
  }
  else if (typeof o.body === 'string') {
    body = encoder.encode(o.body)
    type = 'text/plain; charset=utf-8'
  }
  else if (o.body instanceof Uint8Array) {
    body = o.body
    type = 'application/octet-stream'
  }
  else if (o.body instanceof Blob) {
    body = o.body
    type = o.body.type || 'application/octet-stream'
  }
  else if (o.body === undefined || o.body === null) {
    body = new Uint8Array(0)
    type = 'text/plain; charset=utf-8'
  }
  else {
    throw new TypeError('body must be a string, a Uint8Array or a Blob (or give json instead)')
  }
  if (!has('content-type'))
    headers.push(['Content-Type', type])
  return { status, headers, body }
}

// ─── The host ─────────────────────────────────────────────────────────────────

interface SharedFile {
  owner: string
  key: string
  /** The file, fetched when asked for (a script is read then, so an edit shows). */
  get: () => Promise<Blob> | Blob
  name: string
}

const handlers = new Map<string, HttpHandler>()
const files = new Map<string, SharedFile>()
/** owner + key → token, so asking twice gives the same link. */
const tokens = new Map<string, string>()
let port: number | null = null
let unlisten: (() => void) | null = null

export function servingAvailable(): boolean {
  return !!desktop?.http
}

/** http://<this computer on the LAN>:<port>, or null when nothing can be reached. */
export function baseUrl(): string | null {
  return baseUrls()[0] ?? null
}

/**
 * Every http://<address>:<port> this computer answers on, one per network
 * adapter (Wi-Fi, Ethernet, but also a VPN or a virtual machine's): a
 * device can only reach some of them, so a plugin can show them all, or
 * build its links from the Host header a request came in with.
 */
export function baseUrls(): string[] {
  if (!port)
    return []
  return (desktop?.lan ?? []).map(a => `http://${a.address}:${port}`)
}

/**
 * Short paths at the server's root that headsets ask for on their own
 * (DeoVR: http://<pc>/deovr, HereSphere: http://<pc>/heresphere). A plugin
 * serving them claims one; the first to claim it keeps it while it serves.
 */
export const ROOT_ALIASES = ['deovr', 'heresphere'] as const
export type RootAlias = typeof ROOT_ALIASES[number]
const aliases = new Map<RootAlias, string>()

/** Which root aliases a plugin holds. */
export function aliasesOf(owner: string): RootAlias[] {
  return [...aliases].filter(([, o]) => o === owner).map(([a]) => a)
}

/** Tell the desktop app whether anything is shared, and learn the port. */
async function sync() {
  const http = desktop?.http
  if (!http)
    return
  const on = handlers.size > 0 || files.size > 0
  if (on && !unlisten)
    unlisten = http.onRequest((req, reply) => void answer(req, reply))
  const r = await http.setOpen(on, [...aliases].map(([name, owner]) => ({ name, owner }))).catch(() => null)
  port = r?.port ?? null
}

function token(): string {
  const b = crypto.getRandomValues(new Uint8Array(18))
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * A plugin's handler for `/plugins/<owner>/…`; replaces the one before.
 * `rootAliases` also routes `/deovr…` or `/heresphere…` to it (as
 * `/plugins/<owner>/deovr…`) when no other plugin holds them. Resolves its base URL.
 */
export async function serve(owner: string, handler: HttpHandler, rootAliases: readonly string[] = []): Promise<string | null> {
  if (!desktop?.http)
    throw new Error(SERVE_NEEDS_DESKTOP)
  if (typeof handler !== 'function')
    throw new TypeError('http.serve takes a function (request) => response')
  for (const a of rootAliases) {
    if (!(ROOT_ALIASES as readonly string[]).includes(a))
      throw new TypeError(`http.serve: "${a}" isn't a root path a plugin can take (${ROOT_ALIASES.join(', ')})`)
  }
  for (const [a, o] of aliases) {
    if (o === owner && !rootAliases.includes(a))
      aliases.delete(a)
  }
  for (const a of rootAliases as RootAlias[]) {
    if (!aliases.has(a))
      aliases.set(a, owner)
  }
  handlers.set(owner, handler)
  await sync()
  const base = baseUrl()
  return base ? `${base}/plugins/${owner}/` : null
}

export async function unserve(owner: string) {
  for (const [a, o] of aliases) {
    if (o === owner)
      aliases.delete(a)
  }
  if (handlers.delete(owner))
    await sync()
}

/** A link to one file, for as long as its plugin stays on. */
export async function shareFile(owner: string, key: string, get: SharedFile['get'], name: string): Promise<string | null> {
  if (!desktop?.http)
    throw new Error(SERVE_NEEDS_DESKTOP)
  const id = `${owner}\n${key}`
  let t = tokens.get(id)
  if (!t) {
    t = token()
    tokens.set(id, t)
  }
  files.set(t, { owner, key, get, name })
  await sync()
  const base = baseUrl()
  return base ? `${base}/ph-files/${t}/${encodeURIComponent(name)}` : null
}

/** Everything a plugin shared stops working: its handler and its links. */
export async function unshareAll(owner: string) {
  handlers.delete(owner)
  for (const [a, o] of aliases) {
    if (o === owner)
      aliases.delete(a)
  }
  for (const [t, f] of files) {
    if (f.owner === owner) {
      files.delete(t)
      tokens.delete(`${owner}\n${f.key}`)
    }
  }
  await sync()
}

/** Send a body, a chunk per pull. */
function stream(reply: DesktopHttpReply, body: Uint8Array | Blob, start = 0, end = (body instanceof Blob ? body.size : body.byteLength) - 1) {
  let at = start
  let aborted = false
  reply.onAbort(() => (aborted = true))
  reply.onPull(async () => {
    if (aborted)
      return
    if (at > end) {
      reply.end()
      return
    }
    const stop = Math.min(end + 1, at + CHUNK)
    try {
      const piece = body instanceof Blob ? new Uint8Array(await body.slice(at, stop).arrayBuffer()) : body.subarray(at, stop)
      at = stop
      if (!aborted)
        reply.chunk(piece)
    }
    catch (err) {
      reply.error(err instanceof Error ? err.message : String(err))
    }
  })
}

function header(req: DesktopHttpRequest, name: string): string | null {
  const n = name.toLowerCase()
  return req.headers.find(([k]) => k.toLowerCase() === n)?.[1] ?? null
}

const CORS: [string, string][] = [['Access-Control-Allow-Origin', '*']]

const VIDEO_TYPES: Record<string, string> = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime', avi: 'video/x-msvideo', wmv: 'video/x-ms-wmv', funscript: 'application/json; charset=utf-8' }

async function answerFile(req: DesktopHttpRequest, reply: DesktopHttpReply, t: string) {
  const f = files.get(t)
  if (!f) {
    reply.head(404, [...CORS, ['Content-Type', 'text/plain; charset=utf-8']])
    reply.chunk(encoder.encode('Not shared any more'))
    reply.end()
    return
  }
  if (req.method === 'OPTIONS') {
    reply.head(204, [...CORS, ['Access-Control-Allow-Headers', 'Range'], ['Access-Control-Allow-Methods', 'GET, HEAD']])
    reply.end()
    return
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    reply.head(405, [['Allow', 'GET, HEAD']])
    reply.end()
    return
  }
  const blob = await f.get()
  const size = blob.size
  const type = blob.type || VIDEO_TYPES[f.name.split('.').pop()?.toLowerCase() ?? ''] || 'application/octet-stream'
  const base: [string, string][] = [...CORS, ['Accept-Ranges', 'bytes'], ['Content-Type', type], ['Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length']]
  const range = parseRange(header(req, 'range'), size)
  if (range === 'unsatisfiable') {
    reply.head(416, [...base, ['Content-Range', `bytes */${size}`]])
    reply.end()
    return
  }
  if (range) {
    reply.head(206, [...base, ['Content-Range', `bytes ${range.start}-${range.end}/${size}`], ['Content-Length', String(range.end - range.start + 1)]])
    stream(reply, blob, range.start, range.end)
    return
  }
  reply.head(200, [...base, ['Content-Length', String(size)]])
  stream(reply, blob)
}

const decoder = new TextDecoder()

/** The request as a plugin sees it. */
export function requestFor(req: DesktopHttpRequest, path: string): HttpRequest {
  const url = new URL(req.url, 'http://localhost')
  const query: Record<string, string> = {}
  for (const [k, v] of url.searchParams)
    query[k] = v
  const headers: Record<string, string> = {}
  for (const [k, v] of req.headers)
    headers[k.toLowerCase()] = v
  const body = req.body
  return Object.freeze({
    method: req.method,
    path,
    query,
    headers,
    body,
    remote: req.remote,
    text: () => (body ? decoder.decode(body) : ''),
    json: () => (body ? JSON.parse(decoder.decode(body)) : null),
  })
}

async function answer(req: DesktopHttpRequest, reply: DesktopHttpReply) {
  try {
    const route = routeOf(new URL(req.url, 'http://localhost').pathname)
    if (route?.kind === 'file')
      return await answerFile(req, reply, route.token)
    const handler = route?.kind === 'plugin' ? handlers.get(route.id) : undefined
    if (!route || !handler) {
      reply.head(404, [['Content-Type', 'text/plain; charset=utf-8']])
      reply.chunk(encoder.encode('Not found'))
      reply.end()
      return
    }
    const out = responseOf(await handler(requestFor(req, route.path)))
    reply.head(out.status, out.headers)
    if (req.method === 'HEAD')
      reply.end()
    else
      stream(reply, out.body)
  }
  catch (err) {
    console.error('[plugins] answering', req.url, 'failed', err)
    reply.error(err instanceof Error ? err.message : String(err))
  }
}
