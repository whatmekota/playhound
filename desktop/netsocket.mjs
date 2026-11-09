// TCP sockets for plugins, opened from the main process.
//
// HereSphere and DeoVR say where their video is over a plain TCP connection
// (port 23554), which a page can't open. A plugin asks for one here, and only
// to this computer or the local network (desktop/lanRules.mjs): a `.local`
// name is looked up first and refused if any address it gives is outside,
// and the connection then goes to the address that was checked.
//
// Each socket talks over its own MessagePort: the page sends `send` and
// `close`; this side sends `open`, `data`, then one `close` (with an error,
// if that is why).

import { Buffer } from 'node:buffer'
import dns from 'node:dns/promises'
import net from 'node:net'
import { allowedAddresses, checkHost, portOf } from './lanRules.mjs'

/** Open at once, across plugins. */
export const MAX_SOCKETS = 16
/** One send, bytes. */
const MAX_WRITE = 4 * 1024 * 1024
const CONNECT_TIMEOUT_MS = 8000

/**
 * @param {Electron.IpcMain} ipcMain
 * @param {(event: Electron.IpcMainEvent) => boolean} allowed  only the main window
 */
export function setupNetSockets(ipcMain, allowed) {
  /** @type {Set<import('node:net').Socket>} */
  const open = new Set()

  ipcMain.on('ph:net:socket', async (event, req) => {
    const port = event.ports?.[0]
    if (!port)
      return
    let portClosed = false
    const send = (m) => {
      if (!portClosed)
        port.postMessage(m)
    }
    const refuse = (message) => {
      send({ type: 'close', error: message })
      portClosed = true
      port.close()
    }
    if (!allowed(event))
      return refuse('not allowed')
    if (open.size >= MAX_SOCKETS)
      return refuse(`Too many connections are open (${MAX_SOCKETS})`)
    const tcpPort = portOf(req?.port)
    if (!tcpPort)
      return refuse('port must be a whole number from 1 to 65535')
    const host = String(req?.host ?? '')
    const check = checkHost(host)
    if (!check.ok)
      return refuse(check.reason)
    let address = check.address
    if (check.lookup) {
      const found = allowedAddresses(await dns.lookup(host, { all: true }).catch(() => []))
      if (!found)
        return refuse(`${host} didn't lead to an address on your network`)
      address = found[0]
    }

    const sock = net.connect({ host: address, port: tcpPort })
    open.add(sock)
    sock.setNoDelay(true)
    let error = null
    const timer = setTimeout(() => sock.destroy(new Error(`No answer from ${host}:${tcpPort}`)), CONNECT_TIMEOUT_MS)

    port.on('message', (e) => {
      const m = e.data
      if (m?.type === 'send') {
        const data = m.data
        if (!(data instanceof Uint8Array) || data.byteLength > MAX_WRITE)
          return
        sock.write(Buffer.from(data.buffer, data.byteOffset, data.byteLength))
      }
      else if (m?.type === 'close') {
        sock.end()
        // Ended politely; gone for good shortly after either way.
        setTimeout(() => sock.destroy(), 1000).unref?.()
      }
    })
    // The page went away (closed, reloaded, the plugin's port dropped).
    port.on('close', () => {
      portClosed = true
      sock.destroy()
    })
    port.start()

    sock.on('connect', () => {
      clearTimeout(timer)
      send({ type: 'open', address, port: tcpPort })
    })
    // A copy: a view would carry the whole buffer it sits in across.
    sock.on('data', buf => send({ type: 'data', data: new Uint8Array(buf) }))
    sock.on('error', (err) => {
      error = err?.code === 'ECONNREFUSED' ? `${host}:${tcpPort} refused the connection` : String(err?.message || err)
    })
    sock.on('close', () => {
      clearTimeout(timer)
      open.delete(sock)
      send({ type: 'close', error })
      if (!portClosed) {
        portClosed = true
        port.close()
      }
    })
  })

  return {
    /** Close every socket (the page reloaded or went away). */
    closeAll() {
      for (const s of open)
        s.destroy()
      open.clear()
    },
  }
}
