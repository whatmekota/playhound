/**
 * EroScripts proxy server — runs alongside Vite dev server.
 * Forwards requests to discuss.eroscripts.com with the user's _t session cookie,
 * bypassing CORS entirely since the request is made server-side.
 *
 * Usage: node es-proxy.mjs
 * Listens on http://localhost:7071
 */

import http from 'node:http'
import https from 'node:https'

const PORT = 7071
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

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Accept, X-ES-Cookie, Range')

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

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
  const esHeaders = {
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://discuss.eroscripts.com/',
    'Origin': 'https://discuss.eroscripts.com',
    'Host': TARGET,
    ...(userCookie ? { Cookie: userCookie } : {}),
  }
  makeRequest(TARGET, req.url, esHeaders, res)
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[ES Proxy] Running at http://localhost:${PORT}`)
  console.log(`[ES Proxy] EroScripts → https://${TARGET}`)
  console.log(`[ES Proxy] Pixeldrain → /pd/:id`)
})
