/**
 * Outgoing requests for the stream resolvers.
 *
 * Everything goes through undici with the HTTP(S)_PROXY / NO_PROXY the user has
 * set, because some of these hosts are only reachable through one. A few APIs
 * sit behind Cloudflare, which turns away Node's own TLS fingerprint; for those
 * `getText` falls back to a real browser stack (Electron's `net.fetch`, handed
 * in by the desktop app) or, when running from source, the system's curl.
 */

import { execFile } from 'node:child_process'
import process from 'node:process'
import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici'

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

// The proxy agent is still marked experimental in undici 7; its warning is
// noise in the app's console, so swallow just that one.
const emitWarning = process.emitWarning
process.emitWarning = function (warning, ...rest) {
  if (String(warning?.message ?? warning).includes('EnvHttpProxyAgent'))
    return
  return emitWarning.call(process, warning, ...rest)
}
const agent = new EnvHttpProxyAgent()
process.emitWarning = emitWarning

/** fetch through the user's proxy, with a browser User-Agent unless one is given. */
export function netFetch(url, init = {}) {
  return undiciFetch(url, {
    redirect: 'follow',
    ...init,
    dispatcher: agent,
    headers: { 'User-Agent': UA, ...init.headers },
  })
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
  args.push(url)
  return new Promise((resolve, reject) => {
    // curl reads HTTP(S)_PROXY from the environment by itself.
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
