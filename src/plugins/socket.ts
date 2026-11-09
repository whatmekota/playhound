import type { NetSocket } from './types'
import { desktop } from '~/lib/browserApi'

/**
 * Plugins' TCP sockets, on this side. The desktop app opens them from its
 * main process (desktop/netsocket.mjs), and only to this computer or the
 * local network: what HereSphere's and DeoVR's timestamp servers need. A
 * page can't open one, so in a browser there are none.
 */

export const SOCKETS_NEED_DESKTOP = 'Network connections need the playhound desktop app'

export function socketsAvailable(): boolean {
  return !!desktop?.net?.socket
}

const encoder = new TextEncoder()

/**
 * Connect, resolving once connected; rejects saying why not (a host off the
 * network, nobody listening, no desktop app). Data that arrives before
 * anyone listens is kept for the first `onData`.
 */
export function openSocket(opts: { host: string, port: number }): Promise<NetSocket> {
  const api = desktop?.net?.socket
  if (!api)
    return Promise.reject(new Error(SOCKETS_NEED_DESKTOP))
  if (!opts || typeof opts.host !== 'string' || !Number.isInteger(opts.port))
    return Promise.reject(new TypeError('net.socket takes { host, port }'))

  return new Promise<NetSocket>((resolve, reject) => {
    const dataFns = new Set<(d: Uint8Array) => void>()
    const closeFns = new Set<(e: string | null) => void>()
    let early: Uint8Array[] | null = []
    let closed = false
    let opened = false
    let remote = { address: '', port: opts.port }
    const call = <T>(fns: Set<(v: T) => void>, v: T) => {
      for (const fn of fns) {
        try {
          fn(v)
        }
        catch (err) {
          console.error('[plugins] socket listener failed', err)
        }
      }
    }
    let link: { send: (d: Uint8Array) => void, close: () => void } | null = null
    const handle: NetSocket = {
      get closed() {
        return closed
      },
      get remote() {
        return { ...remote }
      },
      send(data) {
        if (closed)
          throw new Error('The connection is closed')
        const bytes = typeof data === 'string' ? encoder.encode(data) : data instanceof Uint8Array ? data : null
        if (!bytes)
          throw new TypeError('socket.send takes a string or a Uint8Array')
        link?.send(bytes)
      },
      onData(fn) {
        if (typeof fn !== 'function')
          throw new TypeError('socket.onData takes a function')
        dataFns.add(fn)
        if (early) {
          const kept = early
          early = null
          for (const d of kept)
            call(dataFns, d)
        }
        return () => void dataFns.delete(fn)
      },
      onClose(fn) {
        if (typeof fn !== 'function')
          throw new TypeError('socket.onClose takes a function')
        closeFns.add(fn)
        return () => void closeFns.delete(fn)
      },
      close() {
        if (closed)
          return
        // Closed for the caller at once: a send() from now on is refused, not lost in between.
        closed = true
        link?.close()
      },
    }
    link = api(opts, {
      open(address, port) {
        opened = true
        remote = { address, port }
        resolve(handle)
      },
      data(d) {
        if (early)
          early.push(d)
        else
          call(dataFns, d)
      },
      close(error) {
        closed = true
        if (!opened) {
          reject(new Error(error ?? `Could not connect to ${opts.host}:${opts.port}`))
          return
        }
        call(closeFns, error)
      },
    })
  })
}
