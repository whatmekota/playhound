/**
 * Streams a resolved source to the <video> element, with seeking.
 *
 * A resolver describes how to fetch a video (a "target"); `register` files it
 * under a random key, and `/media/<key>` serves it:
 *
 *   http  forwarded with the headers or cookies the host wants, Range included
 *   mega  decrypted on the fly by megajs; Range maps onto its start/end
 *   hls   the playlist is rewritten so every segment and sub-playlist also
 *         comes through here, with the same headers
 *
 * Keys live for a few hours: long enough to watch, short enough that signed
 * URLs behind them have not expired.
 */

import crypto from 'node:crypto'
import path from 'node:path'
import { Readable } from 'node:stream'
import { netFetch } from './net.mjs'

const TTL_MS = 6 * 60 * 60 * 1000
const targets = new Map()

export function register(target) {
  const now = Date.now()
  for (const [k, t] of targets) {
    if (now - t.at > TTL_MS)
      targets.delete(k)
  }
  const key = crypto.randomBytes(9).toString('base64url')
  targets.set(key, { ...target, at: now })
  return key
}

const TYPES = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.mov': 'video/quicktime', '.ts': 'video/mp2t' }

const PASS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges' }

function fail(res, status, message) {
  if (!res.headersSent) {
    res.writeHead(status, { 'Content-Type': 'text/plain', ...CORS })
    res.end(message)
  }
  else {
    res.destroy()
  }
}

async function serveHttp(req, res, t) {
  const ctl = new AbortController()
  res.on('close', () => ctl.abort())
  const upstream = await netFetch(t.url, {
    headers: { ...t.headers, ...(req.headers.range ? { Range: req.headers.range } : {}) },
    signal: ctl.signal,
  })
  const headers = { ...CORS }
  for (const h of PASS) {
    const v = upstream.headers.get(h)
    if (v)
      headers[h] = v
  }
  // Some hosts label video as octet-stream, which <video> then refuses.
  if (!headers['content-type'] || /octet-stream|text\/plain/.test(headers['content-type']))
    headers['content-type'] = TYPES[path.extname(t.name ?? new URL(t.url).pathname).toLowerCase()] ?? 'video/mp4'
  res.writeHead(upstream.status, headers)
  if (!upstream.body)
    return res.end()
  Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res)
}

function serveMega(req, res, t) {
  const size = t.file.size
  let start = 0
  let end = size - 1
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '')
  if (m) {
    if (m[1])
      start = Number(m[1])
    if (m[2])
      end = Math.min(Number(m[2]), size - 1)
    if (!m[1] && m[2]) {
      start = Math.max(0, size - Number(m[2]))
      end = size - 1
    }
  }
  if (start > end || start >= size) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}`, ...CORS })
    return res.end()
  }
  res.writeHead(m ? 206 : 200, {
    ...CORS,
    'Content-Type': TYPES[path.extname(t.file.name ?? '').toLowerCase()] ?? 'video/mp4',
    'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes',
    ...(m ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
  })
  const stream = t.file.download({ start, end })
  stream.on('error', () => res.destroy())
  res.on('close', () => stream.destroy())
  stream.pipe(res)
}

/** Rewrite every URI in a playlist to come back through /media/<key>/seg. */
function rewritePlaylist(text, base, key) {
  const via = u => `/media/${key}/seg?u=${encodeURIComponent(new URL(u, base).href)}`
  return text.split(/\r?\n/).map((line) => {
    if (!line || line.startsWith('#'))
      return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${via(u)}"`)
    return via(line.trim())
  }).join('\n')
}

async function serveHls(req, res, t, key, sub) {
  const url = sub ?? t.url
  const upstream = await netFetch(url, { headers: t.headers })
  const type = upstream.headers.get('content-type') ?? ''
  const isPlaylist = /mpegurl/i.test(type) || /\.m3u8(?:$|\?)/.test(new URL(url).pathname)
  if (!isPlaylist) {
    // A segment, key or init section: pass it through as it is.
    upstream.body?.cancel().catch(() => {})
    return serveHttp(req, res, { url, headers: t.headers, name: new URL(url).pathname })
  }
  const text = await upstream.text()
  res.writeHead(upstream.status, { ...CORS, 'Content-Type': 'application/vnd.apple.mpegurl' })
  res.end(rewritePlaylist(text, url, key))
}

/** Handle /media/<key>[/seg?u=…]. Returns false when the path is not ours. */
export async function serveMedia(req, res) {
  const m = /^\/media\/([\w-]+)(\/seg)?/.exec(req.url)
  if (!m)
    return false
  const t = targets.get(m[1])
  if (!t) {
    fail(res, 410, 'This stream has expired; open the link again')
    return true
  }
  try {
    if (t.type === 'mega')
      serveMega(req, res, t)
    else if (t.type === 'hls')
      await serveHls(req, res, t, m[1], m[2] ? new URL(req.url, 'http://x').searchParams.get('u') : null)
    else
      await serveHttp(req, res, t)
  }
  catch (err) {
    if (err?.name !== 'AbortError')
      fail(res, 502, err?.message ?? 'Upstream failed')
  }
  return true
}
