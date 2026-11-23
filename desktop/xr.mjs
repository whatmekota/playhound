import { Buffer } from 'node:buffer'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import forge from 'node-forge'
import { WebSocketServer } from 'ws'
import { serveStatic } from './serve.mjs'
import { codeMatches, COOKIE, hashToken, MAX_TRIES, mediaType, newCode, newToken, pairCookie, parseRange, readCookie } from './xrRules.mjs'

/**
 * The headset player's server: the app's pages over HTTPS on the LAN.
 *
 * HTTPS because a headset's browser only offers WebXR to a secure page, and
 * http://<LAN address> is not one (only localhost is): over plain http the
 * page doesn't even see navigator.xr. The certificate is our own, made here
 * once, so the headset warns about it the first time and is let through.
 *
 * - `/` sends the headset to `/xr`, the player page (src/pages/xr.vue)
 * - `/xr/pair`: the 6-digit code shown in the app pairs a headset, which then
 *   carries a cookie (HttpOnly, Secure) that opens everything else
 * - `/xr/media/<id>`: the videos the main window has offered, with Range
 * - `/xr/ws`: the headset page's line to the main window
 *
 * Off until switched on in the app. Not in the Android app: it has no
 * desktop shell, and this lives in the desktop's main process.
 */

export const XR_PORT = 6943
/** About as long as browsers accept a server certificate for. */
const CERT_DAYS = 397
/** A certificate this close to its end is made again. */
const RENEW_DAYS = 30
const MAX_PAIR_BODY = 1024

/** A self-signed certificate for these addresses (and localhost). */
export function makeCertificate(addresses, now = Date.now()) {
  // The key from Node's own crypto: native and quick. Forge only signs.
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  })
  const c = forge.pki.createCertificate()
  c.publicKey = forge.pki.publicKeyFromPem(publicKey)
  // Positive, and random so a new one never repeats an old serial.
  c.serialNumber = `01${crypto.randomBytes(15).toString('hex')}`
  const notAfter = now + CERT_DAYS * 864e5
  c.validity.notBefore = new Date(now - 864e5)
  c.validity.notAfter = new Date(notAfter)
  const name = [{ name: 'commonName', value: 'playhound' }, { name: 'organizationName', value: 'playhound on this computer' }]
  c.setSubject(name)
  c.setIssuer(name)
  c.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', critical: true, digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [...addresses.map(ip => ({ type: 7, ip })), { type: 2, value: 'localhost' }] },
  ])
  c.sign(forge.pki.privateKeyFromPem(privateKey), forge.md.sha256.create())
  return { key: privateKey, cert: forge.pki.certificateToPem(c), notAfter }
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers })
  res.end(JSON.stringify(body))
}

function readSmallBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const parts = []
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_PAIR_BODY) {
        reject(new Error('too large'))
        req.destroy()
        return
      }
      parts.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * @param {object} o
 * @param {Electron.IpcMain} o.ipcMain
 * @param {(e: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => boolean} o.allowed  Main window only.
 * @param {() => Electron.BrowserWindow | null} o.window
 * @param {string} o.dataDir  Where the certificate and paired headsets are kept (userData).
 * @param {string} o.distDir  The built app, served in a build.
 * @param {string | null} o.devUrl  The dev server, proxied in development.
 * @param {() => { address: string }[]} o.lanAddresses
 */
export function createXrServer({ ipcMain, allowed, window, dataDir, distDir, devUrl, lanAddresses }) {
  const dir = path.join(dataDir, 'xr')
  /** @type {import('node:https').Server | null} */
  let server = null
  /** @type {WebSocketServer | null} */
  let wss = null
  let error = ''
  let code = newCode()
  let tries = 0
  /** Hashes of the tokens paired headsets carry. */
  const paired = loadPaired()
  /** Id → the file it is, as the main window offered it. */
  let media = new Map()
  const sockets = new Set()

  function loadPaired() {
    try {
      const list = JSON.parse(fs.readFileSync(path.join(dir, 'paired.json'), 'utf8'))
      return new Set(Array.isArray(list) ? list.filter(h => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h)) : [])
    }
    catch {
      return new Set()
    }
  }
  function savePaired() {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'paired.json'), JSON.stringify([...paired]))
  }

  /** Ours, made again when it's nearly out of date or the addresses changed. */
  function certificate() {
    const addresses = [...new Set(lanAddresses().map(a => a.address))].sort()
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, 'cert.json'), 'utf8'))
      const fresh = meta.notAfter - Date.now() > RENEW_DAYS * 864e5 && addresses.every(a => meta.addresses.includes(a))
      if (fresh)
        return { key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) }
    }
    catch {}
    const made = makeCertificate(addresses)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'key.pem'), made.key, { mode: 0o600 })
    fs.writeFileSync(path.join(dir, 'cert.pem'), made.cert)
    fs.writeFileSync(path.join(dir, 'cert.json'), JSON.stringify({ addresses, notAfter: made.notAfter }))
    return { key: made.key, cert: made.cert }
  }

  const authed = (req) => {
    const token = readCookie(req.headers.cookie, COOKIE)
    return !!token && paired.has(hashToken(token))
  }

  function state() {
    return {
      on: !!server,
      port: XR_PORT,
      urls: lanAddresses().map(a => `https://${a.address}:${XR_PORT}`),
      code,
      paired: paired.size,
      headsets: sockets.size,
      error,
    }
  }

  function tell() {
    const w = window()
    if (w && !w.isDestroyed())
      w.webContents.send('ph:xr:state', state())
  }

  /** Our own paths; false for the pages (served or proxied after). */
  async function handle(req, res) {
    let url
    try {
      url = new URL(req.url ?? '/', 'https://localhost')
    }
    catch {
      return false
    }
    const p = url.pathname
    if (p === '/') {
      res.writeHead(302, { Location: '/xr' })
      res.end()
      return true
    }
    if (!p.startsWith('/xr/'))
      return false

    if (p === '/xr/hello') {
      json(res, 200, { paired: authed(req) })
      return true
    }

    if (p === '/xr/pair') {
      if (req.method !== 'POST') {
        json(res, 405, { error: 'POST only' })
        return true
      }
      let typed = ''
      try {
        typed = String(JSON.parse(await readSmallBody(req))?.code ?? '')
      }
      catch {}
      if (codeMatches(typed, code)) {
        const { token, hash } = newToken()
        paired.add(hash)
        savePaired()
        // One code pairs one headset.
        code = newCode()
        tries = 0
        json(res, 200, { paired: true }, { 'Set-Cookie': pairCookie(token) })
      }
      else {
        // Guessing gets nowhere: a few wrong tries and the code is a new one.
        if (++tries >= MAX_TRIES) {
          code = newCode()
          tries = 0
        }
        json(res, 403, { paired: false })
      }
      tell()
      return true
    }

    if (p.startsWith('/xr/media/')) {
      if (!authed(req)) {
        json(res, 401, { error: 'Not paired' })
        return true
      }
      const id = decodeURIComponent(p.slice('/xr/media/'.length))
      const m = media.get(id)
      const stat = m ? await fs.promises.stat(m.path).catch(() => null) : null
      if (!stat?.isFile()) {
        json(res, 404, { error: 'No such video here' })
        return true
      }
      const range = parseRange(req.headers.range, stat.size)
      if (range === 'bad') {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` })
        res.end()
        return true
      }
      const headers = { 'Content-Type': mediaType(m.name), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' }
      if (range) {
        res.writeHead(206, { ...headers, 'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}`, 'Content-Length': range.end - range.start + 1 })
      }
      else {
        res.writeHead(200, { ...headers, 'Content-Length': stat.size })
      }
      if (req.method === 'HEAD') {
        res.end()
        return true
      }
      fs.createReadStream(m.path, range ?? {})
        .on('error', () => res.destroy())
        .pipe(res)
      return true
    }

    json(res, 404, { error: 'Not found' })
    return true
  }

  /** Development: Vite serves the pages; everything else is ours. */
  function proxyToDev(req, res) {
    const target = new URL(req.url ?? '/', devUrl)
    const up = http.request(target, { method: req.method, headers: { ...req.headers, host: target.host } }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers)
      r.pipe(res)
    })
    up.on('error', () => {
      if (!res.headersSent)
        res.writeHead(502)
      res.end()
    })
    req.pipe(up)
  }

  function listenDev(tls) {
    const s = https.createServer(tls, (req, res) => {
      handle(req, res).then((done) => {
        if (!done)
          proxyToDev(req, res)
      }, () => {
        if (!res.headersSent)
          res.writeHead(500)
        res.end()
      })
    })
    return new Promise((resolve, reject) => {
      s.once('error', reject)
      s.listen(XR_PORT, '0.0.0.0', () => {
        s.off('error', reject)
        resolve(s)
      })
    })
  }

  function connected(ws) {
    sockets.add(ws)
    tell()
    ws.on('message', (data) => {
      let msg
      try {
        msg = JSON.parse(String(data))
      }
      catch {
        return
      }
      const w = window()
      if (w && !w.isDestroyed())
        w.webContents.send('ph:xr:message', msg)
    })
    ws.on('close', () => {
      sockets.delete(ws)
      tell()
    })
    ws.on('error', () => {})
  }

  async function start() {
    if (server)
      return
    const tls = certificate()
    const s = devUrl ? await listenDev(tls) : await serveStatic(distDir, { port: XR_PORT, host: '0.0.0.0', extra: handle, tls })
    wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 })
    s.on('upgrade', (req, socket, head) => {
      let p = ''
      try {
        p = new URL(req.url ?? '/', 'https://localhost').pathname
      }
      catch {}
      if (p !== '/xr/ws' || !authed(req)) {
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket, head, ws => connected(ws))
    })
    server = s
  }

  async function stop() {
    for (const ws of sockets)
      ws.terminate()
    sockets.clear()
    wss?.close()
    wss = null
    const s = server
    server = null
    if (s) {
      await new Promise((resolve) => {
        s.close(() => resolve())
        s.closeAllConnections?.()
      })
    }
  }

  ipcMain.handle('ph:xr:start', async (event, on) => {
    if (!allowed(event))
      return null
    error = ''
    try {
      await (on ? start() : stop())
    }
    catch (err) {
      error = err?.code === 'EADDRINUSE' ? `Port ${XR_PORT} is taken by another program` : String(err?.message ?? err)
      server = null
    }
    tell()
    return state()
  })
  ipcMain.handle('ph:xr:state', event => (allowed(event) ? state() : null))
  ipcMain.handle('ph:xr:code', (event) => {
    if (!allowed(event))
      return null
    code = newCode()
    tries = 0
    tell()
    return state()
  })
  ipcMain.handle('ph:xr:forget', (event) => {
    if (!allowed(event))
      return null
    paired.clear()
    savePaired()
    for (const ws of sockets)
      ws.close(4001, 'Forgotten')
    tell()
    return state()
  })
  ipcMain.handle('ph:xr:media', (event, list) => {
    if (!allowed(event))
      return false
    const next = new Map()
    for (const m of Array.isArray(list) ? list.slice(0, 100_000) : []) {
      if (m && typeof m.id === 'string' && typeof m.path === 'string' && m.path)
        next.set(m.id, { path: m.path, name: String(m.name ?? '') })
    }
    media = next
    return true
  })
  ipcMain.on('ph:xr:send', (event, msg) => {
    if (!allowed(event))
      return
    const data = JSON.stringify(msg)
    for (const ws of sockets) {
      if (ws.readyState === ws.OPEN)
        ws.send(data)
    }
  })

  return { close: stop }
}
