/**
 * Outgoing requests for the stream resolvers.
 *
 * Everything goes through the proxy from playhound's Settings → Network, or,
 * with none set there, the HTTP(S)_PROXY / NO_PROXY of the environment: some
 * of these hosts are only reachable through one. A few APIs
 * sit behind Cloudflare, which turns away Node's own TLS fingerprint; for those
 * `getText` falls back to a real browser stack (Electron's `net.fetch`, handed
 * in by the desktop app) or, when running from source, the system's curl.
 */

import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import http from 'node:http'
import https from 'node:https'
import process from 'node:process'
import tls from 'node:tls'
import { EnvHttpProxyAgent, ProxyAgent, fetch as undiciFetch } from 'undici'

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

// The proxy agent is still marked experimental in undici 7; its warning is
// noise in the app's console, so swallow just that one.
const emitWarning = process.emitWarning
process.emitWarning = function (warning, ...rest) {
  if (String(warning?.message ?? warning).includes('EnvHttpProxyAgent'))
    return
  return emitWarning.call(process, warning, ...rest)
}
const envAgent = new EnvHttpProxyAgent()
process.emitWarning = emitWarning

// ── Which proxy ──────────────────────────────────────────────────────────────

/** From the app's settings; empty follows the environment. */
let configured = ''
let configuredAgent = null
/** The CONNECT tunnel for node:https (see httpsAgentFor), rebuilt when the proxy changes. */
let tunnel = null
let tunnelFor = ''
const listeners = new Set()

function envProxyRaw() {
  return process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || ''
}

/** `host:port` or a URL, as an http(s) proxy URL. Throws on anything else. */
export function normaliseProxy(raw) {
  const text = String(raw ?? '').trim()
  if (!text)
    return ''
  let url
  try {
    url = new URL(text.includes('://') ? text : `http://${text}`)
  }
  catch {
    throw new Error('That is not a proxy address. Try http://127.0.0.1:8080')
  }
  if (!['http:', 'https:'].includes(url.protocol))
    throw new Error(`${url.protocol.replace(':', '').toUpperCase()} proxies are not supported; use its HTTP port`)
  if (!url.port)
    throw new Error('The proxy needs a port, like http://127.0.0.1:8080')
  return `${url.protocol}//${url.username ? `${url.username}:${url.password}@` : ''}${url.host}`
}

/** What is set, what the environment says, and which one is in use. */
export function proxyInfo() {
  const env = envProxyRaw() || null
  return { configured: configured || null, env, effective: configured || env }
}

/** Use this proxy for everything, or '' to go back to the environment's. */
export function setProxy(raw) {
  const next = normaliseProxy(raw)
  if (next === configured)
    return proxyInfo()
  configured = next
  configuredAgent?.close().catch(() => {})
  configuredAgent = next ? new ProxyAgent(next) : null
  tunnel = null
  for (const fn of listeners)
    fn(proxyInfo().effective)
  return proxyInfo()
}

/** Called with the effective proxy URL (or null) whenever it changes. */
export function onProxyChange(fn) {
  listeners.add(fn)
}

/** fetch through the user's proxy, with a browser User-Agent unless one is given. */
export function netFetch(url, init = {}) {
  return undiciFetch(url, {
    redirect: 'follow',
    ...init,
    dispatcher: configuredAgent ?? envAgent,
    headers: { 'User-Agent': UA, ...init.headers },
  })
}

// ── node:https through the same proxy ─────────────────────────────────────────
// The EroScripts and Pixeldrain routes in es-proxy.mjs stream with node:https,
// which ignores HTTP(S)_PROXY. Where the forum is only reachable through one,
// that was a timeout and a 502, so they get an agent that tunnels with CONNECT.

function activeProxy() {
  const raw = configured || envProxyRaw()
  if (!raw)
    return null
  try {
    return new URL(raw.includes('://') ? raw : `http://${raw}`)
  }
  catch {
    return null
  }
}

/** NO_PROXY: `*`, or host suffixes such as `example.com` / `.example.com`. Only for the environment's proxy. */
function bypassed(hostname) {
  if (configured)
    return false
  const list = (process.env.NO_PROXY || process.env.no_proxy || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  const host = hostname.toLowerCase()
  return list.some(e => e === '*' || host === e.replace(/^\./, '') || host.endsWith(e.startsWith('.') ? e : `.${e}`))
}

class TunnelAgent extends https.Agent {
  constructor(proxy) {
    super({ keepAlive: true })
    this.proxy = proxy
  }

  createConnection(options, done) {
    const target = `${options.host}:${options.port || 443}`
    const auth = this.proxy.username ? { 'Proxy-Authorization': `Basic ${Buffer.from(`${decodeURIComponent(this.proxy.username)}:${decodeURIComponent(this.proxy.password)}`).toString('base64')}` } : {}
    const req = http.request({
      host: this.proxy.hostname,
      port: this.proxy.port || 80,
      method: 'CONNECT',
      path: target,
      headers: { Host: target, ...auth },
    })
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        done(new Error(`Proxy refused ${target}: HTTP ${res.statusCode}`))
        return
      }
      done(null, tls.connect({ socket, servername: options.servername || options.host }))
    })
    req.once('error', done)
    req.end()
  }
}

/** The agent for a node:https request to `hostname`: a proxy tunnel, or undefined to go direct. */
export function httpsAgentFor(hostname) {
  const proxy = activeProxy()
  if (!proxy || bypassed(hostname))
    return undefined
  if (!tunnel || tunnelFor !== proxy.href) {
    tunnel = new TunnelAgent(proxy)
    tunnelFor = proxy.href
  }
  return tunnel
}

let browserFetch = null

/**
 * Hand in a fetch that runs on a real browser network stack (the desktop app
 * passes Electron's `net.fetch`). Used only when Cloudflare refuses Node.
 */
export function setBrowserFetch(fn) {
  browserFetch = fn
}

function isChallenge(res) {
  return res.status === 403 && (res.headers.get('cf-mitigated') === 'challenge' || /cloudflare/i.test(res.headers.get('server') ?? ''))
}

function curl(url, headers) {
  const args = ['-sS', '-L', '--max-time', '25', '-A', headers['User-Agent'] ?? UA, '-w', '\n%{http_code}']
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== 'user-agent')
      args.push('-H', `${k}: ${v}`)
  }
  // curl reads HTTP(S)_PROXY from the environment by itself; a proxy set in
  // the app has to be passed.
  if (configured)
    args.push('-x', configured)
  args.push(url)
  return new Promise((resolve, reject) => {
    execFile('curl', args, { maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err)
        return reject(new Error(`curl: ${err.message}`))
      const cut = stdout.lastIndexOf('\n')
      resolve({ status: Number(stdout.slice(cut + 1)), text: stdout.slice(0, cut) })
    })
  })
}

/**
 * GET a page or an API answer as text, getting past a Cloudflare challenge if
 * there is one. Resolves to { status, text, headers? }.
 */
export async function getText(url, headers = {}) {
  const res = await netFetch(url, { headers })
  if (!isChallenge(res))
    return { status: res.status, text: await res.text(), headers: res.headers }
  res.body?.cancel().catch(() => {})
  if (browserFetch) {
    const b = await browserFetch(url, { headers: { 'User-Agent': UA, ...headers } })
    return { status: b.status, text: await b.text(), headers: b.headers }
  }
  return curl(url, { 'User-Agent': UA, ...headers })
}

/** `getText`, parsed as JSON, with a readable error when it is not JSON. */
export async function getJson(url, headers = {}) {
  const { status, text } = await getText(url, { Accept: 'application/json', ...headers })
  try {
    return { status, data: JSON.parse(text) }
  }
  catch {
    throw new Error(`${new URL(url).hostname} answered ${status} with a page, not data`)
  }
}

/** Cookies a response set, as one Cookie header value. */
export function cookiesOf(res) {
  return (res.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ')
}
