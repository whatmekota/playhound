import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

/**
 * The built app over plain http, the way `vite preview` would serve it.
 *
 * Not a file:// or custom-protocol page on purpose: the phone remote has to
 * open the same app from across the LAN, and storage, the File System Access
 * handles and serial grants are all keyed to the origin — keeping it at
 * http://localhost:6969 makes the desktop app the same origin the browser
 * flow always used.
 */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.vrm': 'model/gltf-binary',
}

/**
 * Serve `root` with an SPA fallback, so a deep link such as /remote gets
 * index.html and the router takes it from there.
 *
 * Resolves with the listening server; rejects with the listen error (EADDRINUSE
 * when another instance or a dev server holds the port).
 */
export function serveStatic(root, { port, host }) {
  const base = path.resolve(root)
  const index = path.join(base, 'index.html')

  async function handle(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' })
      res.end()
      return
    }

    let pathname
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
    }
    catch {
      res.writeHead(400)
      res.end()
      return
    }

    const file = path.join(base, pathname)
    if (file !== base && !file.startsWith(base + path.sep)) {
      res.writeHead(403)
      res.end()
      return
    }

    const stat = await fs.promises.stat(file).catch(() => null)
    if (stat?.isFile()) {
      send(req, res, file, stat.size)
      return
    }

    // Routes have no extension. A missing *asset* gets a real 404 instead, so
    // a stale chunk fails loudly rather than being parsed as HTML.
    if (!path.extname(pathname)) {
      const s = await fs.promises.stat(index).catch(() => null)
      if (s) {
        send(req, res, index, s.size)
        return
      }
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Not found')
  }

  function send(req, res, file, size) {
    const ext = path.extname(file).toLowerCase()
    // Vite fingerprints everything under /assets; index.html must always be
    // re-read so a rebuilt app is picked up on the next launch.
    const immutable = file.startsWith(path.join(base, 'assets') + path.sep)
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': size,
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    fs.createReadStream(file)
      .on('error', () => res.destroy())
      .pipe(res)
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent)
        res.writeHead(500)
      res.end()
    })
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve(server)
    })
  })
}

/** Whether something already answering at `url` is playhound, and if so which kind. */
export async function probe(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) })
    const html = await res.text()
    if (!html.includes('<title>playhound</title>'))
      return 'other'
    return html.includes('/@vite/client') ? 'vite' : 'built'
  }
  catch {
    return 'none'
  }
}
