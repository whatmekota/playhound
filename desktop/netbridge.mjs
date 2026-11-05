// fetch() for plugins, made from the main process.
//
// A page can't read a response from a server that doesn't send CORS headers,
// and the local servers plugins talk to (a TTS server, LM Studio) mostly
// don't. Here the request goes out from the app's own session instead, and
// the response streams back over a MessagePort: one `head` message, then
// `chunk`s, then `end` or `error`. The page can `abort` at any time.

import { session } from 'electron'

const MAX_BODY = 32 * 1024 * 1024

/**
 * @param {Electron.IpcMain} ipcMain
 * @param {(event: Electron.IpcMainEvent) => boolean} allowed  only the main window
 */
export function setupNetBridge(ipcMain, allowed) {
  ipcMain.on('ph:net:fetch', async (event, req) => {
    const port = event.ports?.[0]
    if (!port)
      return
    if (!allowed(event)) {
      port.postMessage({ type: 'error', message: 'not allowed' })
      port.close()
      return
    }
    const ctrl = new AbortController()
    let closed = false
    /** The body being read, so an abort stops a response that is still trickling in. */
    let reader = null
    const stop = () => {
      ctrl.abort()
      reader?.cancel().catch(() => {})
    }
    port.on('message', (e) => {
      if (e.data?.type === 'abort')
        stop()
    })
    port.on('close', () => {
      closed = true
      stop()
    })
    port.start()
    const send = (m) => {
      if (!closed)
        port.postMessage(m)
    }
    try {
      const url = new URL(String(req?.url ?? ''))
      if (url.protocol !== 'http:' && url.protocol !== 'https:')
        throw new Error(`${url.protocol} is not allowed`)
      const body = req.body instanceof Uint8Array || req.body instanceof ArrayBuffer ? req.body : null
      if (body && body.byteLength > MAX_BODY)
        throw new Error('request body too large')
      const res = await session.defaultSession.fetch(url.href, {
        method: String(req.method || 'GET'),
        headers: Array.isArray(req.headers) ? req.headers : [],
        body: body ?? undefined,
        signal: ctrl.signal,
        redirect: 'follow',
      })
      send({ type: 'head', status: res.status, statusText: res.statusText, headers: [...res.headers] })
      if (res.body) {
        reader = res.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done || closed || ctrl.signal.aborted)
            break
          send({ type: 'chunk', data: value })
        }
      }
      send(ctrl.signal.aborted ? { type: 'error', message: 'aborted' } : { type: 'end' })
    }
    catch (err) {
      send({ type: 'error', message: ctrl.signal.aborted ? 'aborted' : String(err?.message || err) })
    }
    finally {
      if (!closed)
        port.close()
    }
  })
}
