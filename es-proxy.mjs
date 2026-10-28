/**
 * EroScripts proxy + phone-remote relay.
 * Forwards requests to discuss.eroscripts.com with the user's _t session cookie,
 * bypassing CORS entirely since the request is made server-side.
 *
 * Usage: node es-proxy.mjs (or pnpm dev:proxy) next to the Vite dev server.
 * The desktop app (desktop/main.mjs) imports startProxy() and runs both in-process.
 *   7071  EroScripts / Pixeldrain proxy, loopback only
 *   7072  remote-control relay (WebSocket), all interfaces
 */

import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { WebSocketServer } from 'ws'
import { resolve as resolveLink } from './server/hosts.mjs'
import { register, serveMedia } from './server/media.mjs'
import { httpsAgentFor, onProxyChange, proxyInfo, setBrowserFetch, setProxy } from './server/net.mjs'
import { install as installYtdlp, setBinDir, status as ytdlpStatus } from './server/ytdlp.mjs'

export const PORT = 7071
export const RC_PORT = 7072
const TARGET = 'discuss.eroscripts.com'

function makeRequest(hostname, path, reqHeaders, res, depth = 0) {
  if (depth > 8) {
    if (!res.headersSent) { res.writeHead(508); res.end('Too many redirects') }
    return
  }

  const options = {
    hostname,
    port: 443,
    path,
    method: 'GET',
    agent: httpsAgentFor(hostname),
    headers: {
      'Accept': '*/*',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      ...reqHeaders,
    },
  }

  const proxyReq = https.request(options, (proxyRes) => {
    const status = proxyRes.statusCode

    if ([301, 302, 307, 308].includes(status) && proxyRes.headers.location) {
      proxyRes.resume() // drain redirect body
      try {
        const loc = new URL(proxyRes.headers.location)
        // Strip auth headers when crossing to a different host, but keep Range
        const range = reqHeaders.Range ?? reqHeaders.range
        const nextHeaders = loc.hostname !== hostname
          ? { 'Accept': '*/*', 'User-Agent': options.headers['User-Agent'], ...(range ? { Range: range } : {}) }
          : reqHeaders
        makeRequest(loc.hostname, loc.pathname + loc.search, nextHeaders, res, depth + 1)
      }
      catch {
        makeRequest(hostname, proxyRes.headers.location, reqHeaders, res, depth + 1)
      }
      return
    }

    if (res.headersSent) { proxyRes.resume(); return }

    const skip = new Set(['access-control-allow-origin', 'x-frame-options', 'content-security-policy'])
    const fwd = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges' }
    for (const [k, v] of Object.entries(proxyRes.headers)) {
      if (!skip.has(k.toLowerCase()))
        fwd[k] = v
    }
    res.writeHead(status, fwd)
    proxyRes.pipe(res)
  })

  proxyReq.on('error', (err) => {
    console.error('[ES Proxy] Error:', err.message)
    if (!res.headersSent) { res.writeHead(502); res.end(JSON.stringify({ error: err.message })) }
  })
  proxyReq.end()
}

// The stream endpoints fetch whatever link they are given and can install
// yt-dlp, so only the app itself (served from localhost) may call them; a page
// elsewhere on the web could otherwise use the proxy through the browser.
// A <video> element sends no Origin at all, which is fine for /media.
const APP_ORIGIN = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/

function sendJson(res, status, body) {
  if (!res.headersSent)
    res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > limit) {
        req.destroy()
        reject(new Error('Body too large'))
      }
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

/** /resolve, /media, /ytdlp and /config. Returns true when it handled the request. */
async function handleStreams(req, res) {
  const url = new URL(req.url, 'http://localhost')
  const isMedia = url.pathname.startsWith('/media/')
  if (!isMedia && !['/resolve', '/ytdlp/status', '/ytdlp/install', '/config'].includes(url.pathname))
    return false
  const origin = req.headers.origin
  if (origin ? !APP_ORIGIN.test(origin) : !isMedia) {
    sendJson(res, 403, { error: 'Only playhound itself may use this' })
    return true
  }
  if (isMedia)
    return serveMedia(req, res)

  try {
    if (url.pathname === '/config') {
      // The proxy from Settings → Network. GET reports, POST sets.
      if (req.method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}')
        try {
          sendJson(res, 200, setProxy(body.proxy ?? ''))
        }
        catch (err) {
          sendJson(res, 400, { error: err.message, ...proxyInfo() })
        }
      }
      else {
        sendJson(res, 200, proxyInfo())
      }
    }
    else if (url.pathname === '/ytdlp/status') {
      sendJson(res, 200, await ytdlpStatus())
    }
    else if (url.pathname === '/ytdlp/install') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'POST only' })
      }
      else {
        await installYtdlp()
        sendJson(res, 200, await ytdlpStatus())
      }
    }
    else {
      // /resolve?url=…: swap each source's target for a /media URL on this proxy.
      const out = await resolveLink(url.searchParams.get('url') ?? '')
      for (const item of out.items)
        item.sources = item.sources.map(({ target, ...src }) => ({ ...src, url: `http://localhost:${PORT}/media/${register(target)}` }))
      sendJson(res, 200, out)
    }
  }
  catch (err) {
    sendJson(res, err?.code === 'needs-ytdlp' ? 424 : 502, { error: err?.message ?? 'Could not resolve', code: err?.code ?? null })
  }
  return true
}

function handleProxy(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type, X-ES-Cookie, Range')

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  handleStreams(req, res).then((handled) => {
    if (!handled)
      handleEroScripts(req, res)
  }, (err) => {
    console.error('[ES Proxy] Stream error:', err?.message)
    if (!res.headersSent) { res.writeHead(500); res.end() }
  })
}

// The desktop app's own forum session (see desktop/main.mjs): a Chromium
// fetch that keeps its cookies, so Discourse's token rotation is handled the
// way a browser handles it. Null when running from source.
let esFetch = null

/**
 * Fetch a forum path through the app's session and stream it back. The body
 * arrives decompressed, so the encoding and length headers are dropped.
 */
async function viaSession(path, reqHeaders, res) {
  try {
    const headers = {
      'Accept': reqHeaders.accept ?? '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://discuss.eroscripts.com/',
    }
    if (reqHeaders.range)
      headers.Range = reqHeaders.range
    const upstream = await esFetch(`https://${TARGET}${path}`, { headers, redirect: 'follow' })
    const skip = new Set(['access-control-allow-origin', 'x-frame-options', 'content-security-policy', 'set-cookie', 'content-encoding', 'content-length', 'transfer-encoding'])
    const fwd = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges' }
    for (const [k, v] of upstream.headers) {
      if (!skip.has(k.toLowerCase()))
        fwd[k] = v
    }
    res.writeHead(upstream.status, fwd)
    if (!upstream.body)
      return res.end()
    Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res)
  }
  catch (err) {
    console.error('[ES Proxy] Session fetch failed:', err?.message)
    if (!res.headersSent) {
      res.writeHead(502)
      res.end(JSON.stringify({ error: err?.message ?? 'Could not reach EroScripts' }))
    }
  }
}

function handleEroScripts(req, res) {
  const userCookie = req.headers['x-es-cookie'] ?? ''

  // ── Pixeldrain resolve: /pd-resolve/:fileId — returns {url} JSON ─────────
  const pdResolve = req.url.match(/^\/pd-resolve\/([A-Za-z0-9]+)/)
  if (pdResolve) {
    const fileId = pdResolve[1]
    // Follow redirect chain and return final URL as JSON — video element hits CDN directly
    function followRedirect(hostname, path, depth) {
      if (depth > 8) { res.writeHead(508); res.end(JSON.stringify({ error: 'Too many redirects' })); return }
      const options = {
        hostname,
        port: 443,
        path,
        method: 'HEAD',
        agent: httpsAgentFor(hostname),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://pixeldrain.com/',
        },
      }
      const r = https.request(options, (pr) => {
        pr.resume()
        if ([301, 302, 307, 308].includes(pr.statusCode) && pr.headers.location) {
          try {
            const loc = new URL(pr.headers.location)
            followRedirect(loc.hostname, loc.pathname + loc.search, depth + 1)
          }
          catch { followRedirect(hostname, pr.headers.location, depth + 1) }
        }
        else {
          const finalUrl = `https://${hostname}${path}`
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
          res.end(JSON.stringify({ url: finalUrl, contentType: pr.headers['content-type'] }))
        }
      })
      r.on('error', (err) => { res.writeHead(502); res.end(JSON.stringify({ error: err.message })) })
      r.end()
    }
    followRedirect('pixeldrain.com', `/api/file/${fileId}`, 0)
    return
  }

  // ── Pixeldrain stream: /pd-stream/:fileId — for video element (no ?download) ─
  const pdStream = req.url.match(/^\/pd-stream\/([A-Za-z0-9]+)/)
  if (pdStream) {
    const fileId = pdStream[1]
    const headers = {
      'Host': 'pixeldrain.com',
      'Origin': 'https://pixeldrain.com',
      'Referer': 'https://pixeldrain.com/',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Sec-Fetch-Dest': 'video',
      'Sec-Fetch-Mode': 'no-cors',
      'Sec-Fetch-Site': 'same-origin',
      ...(req.headers.range ? { Range: req.headers.range } : {}),
    }
    makeRequest('pixeldrain.com', `/api/file/${fileId}`, headers, res)
    return
  }

  // ── Pixeldrain download: /pd/:fileId — for script downloads (?download + close) ─
  const pdMatch = req.url.match(/^\/pd\/([A-Za-z0-9]+)/)
  if (pdMatch) {
    const fileId = pdMatch[1]
    const headers = {
      'Host': 'pixeldrain.com',
      'Origin': 'https://pixeldrain.com',
      'Referer': 'https://pixeldrain.com/',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Connection': 'close',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      ...(req.headers.range ? { Range: req.headers.range } : {}),
    }
    makeRequest('pixeldrain.com', `/api/file/${fileId}?download`, headers, res)
    return
  }

  // ── EroScripts proxy: everything else ─────────────────────────────────────
  // No pasted cookie and the desktop app's own session available: use it.
  if (!userCookie && esFetch) {
    void viaSession(req.url, req.headers, res)
    return
  }
  const esHeaders = {
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://discuss.eroscripts.com/',
    'Origin': 'https://discuss.eroscripts.com',
    'Host': TARGET,
    ...(userCookie ? { Cookie: userCookie } : {}),
  }
  makeRequest(TARGET, req.url, esHeaders, res)
}

// ── Remote-control relay ─────────────────────────────────────────────────────
//
// Dumb room-based broadcast: whatever a client sends is forwarded to the other
// members of its room. Rooms are named by a random id the desktop generates and
// shows, so nothing secret has to reach this process out of band, and guessing a
// room is the only way in from the LAN.

function createRelay() {
  const rooms = new Map() // room -> Set<ws>

  const rcServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('playhound remote relay')
  })

  const wss = new WebSocketServer({ server: rcServer, path: '/rc' })
  // ws re-emits the http server's errors; listen() below reports a busy port,
  // and without a listener here the same error would also crash the process.
  wss.on('error', () => {})

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost')
    const room = url.searchParams.get('room')
    const role = url.searchParams.get('role') === 'remote' ? 'remote' : 'host'

    if (!room || room.length < 6) {
      ws.close(1008, 'room required')
      return
    }

    if (!rooms.has(room))
      rooms.set(room, new Set())
    const peers = rooms.get(room)
    ws.__room = room
    ws.__role = role
    peers.add(ws)

    // Tell both sides who else is present, so the UI can show a real status.
    const announce = () => {
      const counts = { hosts: 0, remotes: 0 }
      for (const p of peers) {
        if (p.__role === 'host')
          counts.hosts++
        else counts.remotes++
      }
      const msg = JSON.stringify({ type: 'peers', ...counts })
      for (const p of peers) {
        if (p.readyState === 1)
          p.send(msg)
      }
    }
    announce()

    ws.on('message', (data) => {
      const text = typeof data === 'string' ? data : data.toString()
      for (const p of peers) {
        if (p !== ws && p.readyState === 1)
          p.send(text)
      }
    })

    ws.on('close', () => {
      peers.delete(ws)
      if (peers.size === 0)
        rooms.delete(room)
      else announce()
    })
  })
  return { server: rcServer, wss }
}

function lanAddresses() {
  const out = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal)
        out.push(ni.address)
    }
  }
  return out
}

/**
 * Listen, but treat a busy port as "someone else already serves this" rather
 * than crashing: a second playhound, or `pnpm dev:proxy` left running next to
 * the desktop app, is the usual cause and both serve the same thing.
 */
function listen(server, port, host, name, log) {
  return new Promise((resolve) => {
    function onListening() {
      server.off('error', onError)
      resolve(true)
    }
    function onError(err) {
      server.off('listening', onListening)
      if (err.code === 'EADDRINUSE')
        log.warn(`[${name}] port ${port} is already in use; leaving it to whatever holds it`)
      else
        log.error(`[${name}] could not listen on ${port}:`, err.message)
      resolve(false)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

/**
 * Start the EroScripts proxy and the remote relay.
 *
 * `ready` resolves once both have either bound or given up; `close()` stops
 * whichever did bind, dropping any connected phones.
 */
export function startProxy({ log = console, binDir, browserFetch, onProxy, forumFetch } = {}) {
  if (forumFetch)
    esFetch = forumFetch
  if (binDir)
    setBinDir(binDir)
  if (browserFetch)
    setBrowserFetch(browserFetch)
  if (onProxy)
    onProxyChange(onProxy)
  const proxy = http.createServer(handleProxy)
  const relay = createRelay()

  // The EroScripts proxy forwards the user's session cookie, so it stays bound to
  // loopback. The remote-control relay is a separate server on its own port,
  // because that one genuinely has to be reachable from a phone on the LAN.
  const ready = Promise.all([
    listen(proxy, PORT, '127.0.0.1', 'ES Proxy', log).then((ok) => {
      if (ok) {
        log.log(`[ES Proxy] Running at http://localhost:${PORT}`)
        log.log(`[ES Proxy] EroScripts → https://${TARGET}`)
        log.log(`[ES Proxy] Pixeldrain → /pd/:id · streams → /resolve?url=…`)
      }
      return ok
    }),
    listen(relay.server, RC_PORT, '0.0.0.0', 'Remote', log).then((ok) => {
      if (ok) {
        log.log(`[Remote] Relay on ws://0.0.0.0:${RC_PORT}/rc`)
        for (const ip of lanAddresses())
          log.log(`[Remote]   reachable at ws://${ip}:${RC_PORT}/rc`)
        log.log('[Remote] Open the Remote panel on the desktop for the phone URL.')
      }
      return ok
    }),
  ]).then(([proxyUp, relayUp]) => ({ proxy: proxyUp, relay: relayUp }))

  function close() {
    for (const client of relay.wss.clients)
      client.terminate()
    relay.wss.close()
    relay.server.close()
    proxy.close()
  }

  return { ready, close }
}

// Run directly (`node es-proxy.mjs`): start straight away. Imported — by the
// desktop main process — the caller decides when.
const runDirectly = !process.versions.electron
  && !!process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (runDirectly)
  startProxy()
