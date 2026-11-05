import { desktop } from '~/lib/browserApi'

/**
 * fetch() for plugins. In the desktop app the request is made by the main
 * process (desktop/netbridge.mjs), so servers that send no CORS headers still
 * answer; the response streams back as it arrives. In a browser it is plain
 * fetch(), CORS and all.
 */
export async function pluginFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const net = desktop?.net
  if (!net)
    return fetch(url, init)

  const req = new Request(url, init)
  if (!/^https?:$/.test(new URL(req.url).protocol))
    return fetch(url, init)
  const body = req.method === 'GET' || req.method === 'HEAD' ? null : new Uint8Array(await req.arrayBuffer())
  const signal = init.signal

  return new Promise<Response>((resolve, reject) => {
    let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null
    let settled = false
    let abort = () => {}
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c
      },
      cancel() {
        abort()
      },
    })
    const fail = (message: string) => {
      const err = message === 'aborted' ? new DOMException('The operation was aborted.', 'AbortError') : new TypeError(`Failed to fetch: ${message}`)
      if (!settled) {
        settled = true
        reject(err)
      }
      else {
        try {
          ctrl?.error(err)
        }
        catch {}
      }
    }
    abort = net.fetch({ url: req.url, method: req.method, headers: [...req.headers], body: body?.byteLength ? body : null }, {
      head(status, statusText, headers) {
        settled = true
        // A Response can't carry a body for these.
        const empty = status === 204 || status === 205 || status === 304
        resolve(new Response(empty ? null : stream, { status, statusText, headers }))
      },
      chunk(data) {
        try {
          ctrl?.enqueue(new Uint8Array(data))
        }
        catch {}
      },
      end() {
        try {
          ctrl?.close()
        }
        catch {}
      },
      error: fail,
    })
    // Fail here at once; the main process is told too, and stops reading.
    const onAbort = () => {
      abort()
      fail('aborted')
    }
    if (signal) {
      if (signal.aborted)
        onAbort()
      else
        signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}
