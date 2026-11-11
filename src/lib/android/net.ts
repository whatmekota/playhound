import { registerPlugin } from '@capacitor/core'
import { getMediaBase, setMediaBase } from './nativeFile'

/**
 * The internet in the Android app, without the desktop app's Node proxy
 * (es-proxy.mjs). The page cannot make cross-origin requests with the
 * cookies, referers and headers file hosts and the forum want, so the app's
 * loopback server does them (android/…/net/NetRoutes.kt):
 *
 * - nativeFetch: fetch() through the server's "p" route. Any URL, any
 *   headers, the body as given; answers a real Response streamed back, with
 *   `url` set to where redirects ended and `setCookies` to what the server
 *   set (a page never sees Set-Cookie). A request that does not get through
 *   rejects with a TypeError, as fetch does.
 * - registerStream / registerMega: an address for <video> that plays a
 *   stream with the headers it needs (Range included), or decrypts a MEGA
 *   file as it plays.
 * - the proxy from Settings → Network, and the EroScripts session (the
 *   forum's own login page in a WebView of the app).
 */

interface PhNetPlugin {
  server: () => Promise<{ base: string }>
  register: (o: { url: string, headers: Record<string, string>, kind: 'file' | 'hls', name?: string }) => Promise<{ url: string }>
  registerMega: (o: { request: string, folder: string | null, key: string, size: number, name: string }) => Promise<{ url: string }>
  setProxy: (o: { proxy: string }) => Promise<ProxyAnswer>
  getProxy: () => Promise<ProxyAnswer>
  forumStatus: () => Promise<{ signedIn: boolean }>
  forumLogin: () => Promise<{ signedIn: boolean, cancelled: boolean }>
  forumLogout: () => Promise<{ signedIn: boolean }>
}

interface ProxyAnswer {
  configured: string | null
  env: string | null
  effective: string | null
}

export const PhNet = registerPlugin<PhNetPlugin>('PhNet')

let starting: Promise<string> | null = null

/** The loopback server's base address (the same server the media files stream from). */
export function netBase(): Promise<string> {
  const known = getMediaBase()
  if (known)
    return Promise.resolve(known)
  starting ??= PhNet.server().then(({ base }) => {
    setMediaBase(base)
    return base
  }, (err) => {
    starting = null
    throw err
  })
  return starting
}

export interface NativeRequestInit extends RequestInit {
  /** Send and keep the cookies of the app's cookie store (the forum session). */
  jar?: boolean
}

export interface NativeResponse extends Response {
  /** What the server set, as Set-Cookie lines. */
  readonly setCookies: string[]
}

/** Headers in any of the forms fetch takes, as a plain object. */
export function headerObject(h: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!h)
    return out
  if (h instanceof Headers)
    h.forEach((v, k) => (out[k] = v))
  else if (Array.isArray(h))
    h.forEach(([k, v]) => (out[k] = v))
  else
    Object.assign(out, h)
  return out
}

/** The request as the server's "p" route wants it: URL, our own headers. */
export function proxyRequest(base: string, url: string, method: string, headers: Record<string, string>, jar = false): { url: string, headers: Record<string, string> } {
  const own: Record<string, string> = {
    'X-Ph-Method': method,
    'X-Ph-Headers': encodeURIComponent(JSON.stringify(headers)),
  }
  if (jar)
    own['X-Ph-Jar'] = '1'
  return { url: `${base}p?u=${encodeURIComponent(url)}`, headers: own }
}

const NULL_BODY = new Set([101, 103, 204, 205, 304])

/** fetch(), made by the app: no CORS, any headers (see the top of this file). */
export async function nativeFetch(input: string | URL | Request, init: NativeRequestInit = {}): Promise<NativeResponse> {
  const req = input instanceof Request ? input : null
  const url = req ? req.url : String(input)
  const method = (init.method ?? req?.method ?? 'GET').toUpperCase()
  const headers = { ...headerObject(req?.headers), ...headerObject(init.headers) }
  let body: ArrayBuffer | undefined
  if (init.body != null && method !== 'GET' && method !== 'HEAD') {
    // Through a Request, so FormData and URLSearchParams get their bytes and type.
    const r = new Request('http://localhost/', { method: 'POST', body: init.body })
    body = await r.arrayBuffer()
    const type = r.headers.get('content-type')
    if (type && !Object.keys(headers).some(k => k.toLowerCase() === 'content-type'))
      headers['Content-Type'] = type
  }
  else if (req && method !== 'GET' && method !== 'HEAD') {
    body = await req.clone().arrayBuffer()
  }
  const base = await netBase()
  const p = proxyRequest(base, url, method, headers, !!init.jar)
  let res: Response
  try {
    res = await fetch(p.url, {
      // To the server, a method it reads a body for; the real one is in X-Ph-Method.
      method: body ? 'POST' : method === 'HEAD' ? 'HEAD' : 'GET',
      headers: p.headers,
      body,
      signal: init.signal ?? req?.signal,
      cache: 'no-store',
    })
  }
  catch (err) {
    if ((err as Error)?.name === 'AbortError')
      throw err
    throw new TypeError(`The app's network bridge did not answer: ${(err as Error)?.message ?? err}`)
  }
  if (res.headers.get('x-ph-error')) {
    const why = await res.json().then(b => b?.error as string | undefined, () => undefined)
    throw new TypeError(why ?? `Could not reach ${new URL(url).hostname}`)
  }
  const out = new Headers()
  res.headers.forEach((v, k) => {
    if (!k.startsWith('x-ph-') && !k.startsWith('access-control-'))
      out.append(k, v)
  })
  const finalUrl = decodeURIComponent(res.headers.get('x-ph-url') ?? encodeURIComponent(url))
  const cookies = res.headers.get('x-ph-set-cookie')
  const setCookies: string[] = cookies ? JSON.parse(decodeURIComponent(cookies)) : []
  const wrapped = new Response(NULL_BODY.has(res.status) ? null : res.body, { status: res.status < 200 ? 200 : res.status, statusText: res.statusText, headers: out })
  Object.defineProperty(wrapped, 'url', { value: finalUrl })
  Object.defineProperty(wrapped, 'redirected', { value: finalUrl !== url })
  Object.defineProperty(wrapped, 'setCookies', { value: setCookies })
  return wrapped as NativeResponse
}

/** The cookies a response set, as one Cookie header value (server/net.mjs cookiesOf). */
export function cookiesOf(res: Response): string {
  return ((res as NativeResponse).setCookies ?? []).map(c => c.split(';')[0]).join('; ')
}

/** An address for <video> that fetches `url` with these headers (Range included). */
export async function registerStream(url: string, headers: Record<string, string>, kind: 'file' | 'hls' = 'file', name?: string): Promise<string> {
  return (await PhNet.register({ url, headers, kind, name })).url
}

/**
 * An address for <video> that plays a MEGA file: the app asks MEGA for its
 * download address with `request` when it is played, and decrypts it with
 * its 32-byte key.
 */
export async function registerMega(request: string, folder: string | null, key: Uint8Array, size: number, name: string): Promise<string> {
  let bin = ''
  for (const b of key)
    bin += String.fromCharCode(b)
  return (await PhNet.registerMega({ request, folder, key: btoa(bin), size, name })).url
}

// ── Settings → Network ───────────────────────────────────────────────────────

export function setNetProxy(proxy: string): Promise<ProxyAnswer> {
  return PhNet.setProxy({ proxy })
}

export function getNetProxy(): Promise<ProxyAnswer> {
  return PhNet.getProxy()
}

// ── EroScripts ───────────────────────────────────────────────────────────────

type Listener = (s: { signedIn: boolean }) => void
const listeners = new Set<Listener>()
const tell = (signedIn: boolean) => listeners.forEach(fn => fn({ signedIn }))

/**
 * The forum session, in the shape of the desktop app's (DesktopEroScripts in
 * browserApi.ts), so the EroScripts view signs in the same way in both.
 */
export const androidEroScripts = {
  status: () => PhNet.forumStatus().catch(() => null),
  async login() {
    const r = await PhNet.forumLogin()
    tell(r.signedIn)
  },
  async logout() {
    await PhNet.forumLogout()
    tell(false)
  },
  onChange(cb: Listener) {
    listeners.add(cb)
    return () => listeners.delete(cb)
  },
}

/**
 * A request the EroScripts view would make of the desktop app's local proxy
 * ("http://localhost:7071/…"), made here instead, as es-proxy.mjs makes it:
 * /pd/<id> is a Pixeldrain file, anything else a forum path. A pasted
 * cookie arrives as X-ES-Cookie; without one the app's own session is used.
 */
export function forumProxyFetch(proxyUrl: string, init: { headers?: Record<string, string>, signal?: AbortSignal } = {}): Promise<NativeResponse> {
  const u = new URL(proxyUrl)
  const path = u.pathname + u.search
  const given = { ...init.headers }
  const pasted = given['X-ES-Cookie'] ?? given['x-es-cookie']
  delete given['X-ES-Cookie']
  delete given['x-es-cookie']
  const pd = /^\/pd\/([A-Za-z0-9]+)/.exec(path)
  if (pd) {
    return nativeFetch(`https://pixeldrain.com/api/file/${pd[1]}?download`, {
      headers: { Referer: 'https://pixeldrain.com/', Origin: 'https://pixeldrain.com', ...given },
      signal: init.signal,
    })
  }
  return nativeFetch(`https://discuss.eroscripts.com${path}`, {
    headers: {
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://discuss.eroscripts.com/',
      'Origin': 'https://discuss.eroscripts.com',
      ...given,
      ...(pasted ? { Cookie: pasted } : {}),
    },
    jar: !pasted,
    signal: init.signal,
  })
}
