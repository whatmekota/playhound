// Plugins' addresses on the LAN server, so a headset on the same network can
// browse the library (an XTP-style setup) and stream from it.
//
// Two kinds of path are passed to the page, and nothing else:
//   /plugins/<id>/…   a plugin's own answers, while it is switched on
//   /ph-files/<token>  one library video or script the page handed out a
//                      link to (an unguessable token, gone when the plugin
//                      that asked for it is switched off)
// The page decides every answer and streams the bytes itself (a library file
// is a File the page holds, not a path here), so this side never reads the
// disk and can only serve what the page chose to. When no plugin serves
// anything, these paths are a plain 404 without asking the page.
//
// Each request goes to the page over a MessagePort: `head`, then a `chunk`
// for each `pull` this side sends when the connection can take more, then
// `end` (or `error`). `abort` means the client went away.

import { Buffer } from 'node:buffer'
import http from 'node:http'
import { MessageChannelMain } from 'electron'
import { aliasPath, PLUGIN_ID, ROOT_ALIASES } from './pluginhttpRules.mjs'

export const PLUGIN_PATH = /^\/plugins\/[a-z0-9][a-z0-9-]{0,47}(?:\/|$)/
export const FILE_PATH = /^\/ph-files\/[\w-]{16,64}(?:\/|$)/
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'])
const MAX_BODY = 1024 * 1024
const ANSWER_MS = 20_000

/** Whether a request path is one of ours. */
export function isPluginPath(pathname) {
  return PLUGIN_PATH.test(pathname) || FILE_PATH.test(pathname)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error('too large'))
        req.destroy()
        return
      }
      parts.push(c)
    })
    req.on('end', () => resolve(size ? new Uint8Array(Buffer.concat(parts)) : null))
    req.on('error', reject)
  })
}

/**
 * @param {{ ipcMain: Electron.IpcMain, allowed: (e: Electron.IpcMainInvokeEvent) => boolean, window: () => Electron.BrowserWindow | null }} o
 */
export function createPluginHttp({ ipcMain, allowed, window }) {
  /** Some plugin serves something; otherwise our paths are answered 404 here. */
  let open = false
  /** Where it can be reached, for the page to build links with. */
  let port = null
  let standalone = null

  /** Root alias → the plugin that answers it. */
  let aliases = new Map()

  ipcMain.handle('ph:http:open', (event, on, list) => {
    if (!allowed(event))
      return null
    open = !!on
    const next = new Map()
    for (const a of Array.isArray(list) ? list : []) {
      if (a && ROOT_ALIASES.has(a.name) && typeof a.owner === 'string' && PLUGIN_ID.test(a.owner) && !next.has(a.name))
        next.set(a.name, a.owner)
    }
    aliases = next
    return { port }
  })

  /** Answer one of our paths; false for anything else. */
  async function handle(req, res) {
    let url
    try {
      url = new URL(req.url ?? '/', 'http://localhost')
    }
    catch {
      return false
    }
    url.pathname = aliasPath(url.pathname, aliases)
    if (!isPluginPath(url.pathname))
      return false
    const win = window()
    if (!open || !win || win.isDestroyed()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Nothing is shared here right now')
      return true
    }
    if (!METHODS.has(req.method ?? 'GET')) {
      res.writeHead(405)
      res.end()
      return true
    }
    let body = null
    try {
      body = await readBody(req)
    }
    catch {
      if (!res.headersSent)
        res.writeHead(413)
      res.end()
      return true
    }

    const { port1, port2 } = new MessageChannelMain()
    let finished = false
    let timer = null
    const finish = () => {
      if (finished)
        return
      finished = true
      clearTimeout(timer)
      try {
        port1.close()
      }
      catch {}
    }
    timer = setTimeout(() => {
      if (!res.headersSent) {
        res.writeHead(504, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('The plugin did not answer')
      }
      else {
        res.destroy()
      }
      finish()
    }, ANSWER_MS)
    const pull = () => {
      if (!finished)
        port1.postMessage({ type: 'pull' })
    }
    res.on('close', () => {
      if (!finished) {
        try {
          port1.postMessage({ type: 'abort' })
        }
        catch {}
      }
      finish()
    })
    port1.on('message', (e) => {
      const m = e.data
      if (finished)
        return
      if (m?.type === 'head') {
        clearTimeout(timer)
        const headers = {}
        for (const [k, v] of Array.isArray(m.headers) ? m.headers : []) {
          if (typeof k === 'string' && /^[\w-]+$/.test(k))
            headers[k] = String(v).replace(/[\r\n]/g, ' ')
        }
        res.writeHead(Number(m.status) || 200, headers)
        if (req.method === 'HEAD') {
          res.end()
          finish()
          return
        }
        pull()
      }
      else if (m?.type === 'chunk' && m.data instanceof Uint8Array) {
        if (res.write(Buffer.from(m.data.buffer, m.data.byteOffset, m.data.byteLength)))
          pull()
        else
          res.once('drain', pull)
      }
      else if (m?.type === 'end') {
        res.end()
        finish()
      }
      else if (m?.type === 'error') {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end(String(m.message ?? 'Failed'))
        }
        else {
          res.destroy()
        }
        finish()
      }
    })
    port1.start()
    const headers = []
    for (let i = 0; i + 1 < req.rawHeaders.length && i < 200; i += 2)
      headers.push([req.rawHeaders[i], req.rawHeaders[i + 1]])
    win.webContents.postMessage('ph:http:request', {
      method: req.method,
      url: url.pathname + url.search,
      headers,
      body,
      remote: req.socket.remoteAddress ?? '',
    }, [port2])
    return true
  }

  return {
    handle,
    /** The LAN server took our paths on this port. */
    setPort(p) {
      port = p
    },
    /**
     * A server of our own, for when the app's server isn't ours to extend
     * (development, where Vite serves the page). Resolves once it listens.
     */
    listen(p, host) {
      const server = http.createServer((req, res) => {
        handle(req, res).then((done) => {
          if (!done) {
            res.writeHead(404)
            res.end()
          }
        }, () => {
          if (!res.headersSent)
            res.writeHead(500)
          res.end()
        })
      })
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(p, host, () => {
          server.off('error', reject)
          standalone = server
          port = p
          resolve(server)
        })
      })
    },
    /** The page reloaded: nothing is shared until it says so again. */
    reset() {
      open = false
    },
    close() {
      open = false
      standalone?.close()
    },
  }
}
