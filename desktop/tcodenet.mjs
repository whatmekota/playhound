// TCode over UDP, for the page (src/composables/useTCodeNet.ts).
//
// A page cannot open a UDP socket, so the main process holds one per
// connection the page asks for: `open` resolves the host and connects the
// socket (so errors such as "port unreachable" come back), `send` writes one
// datagram, `close` lets it go. Errors and replies go back to the window
// that opened the socket, tagged with its id. Sockets die with their window.

import { Buffer } from 'node:buffer'
import dgram from 'node:dgram'
import dns from 'node:dns/promises'

const MAX_TEXT = 1024
/** A host name or an IP address; nothing that could be a URL or a path. */
const HOST = /^[\w.:%-]{1,253}$/

/**
 * @param {Electron.IpcMain} ipcMain
 * @param {(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => boolean} allowed  only the main window
 */
export function setupTcodeUdp(ipcMain, allowed) {
  /** @type {Map<number, { socket: dgram.Socket, sender: Electron.WebContents, say: (err: any) => string }>} */
  const sockets = new Map()
  let nextId = 1

  function close(id) {
    const s = sockets.get(id)
    if (!s)
      return
    sockets.delete(id)
    try {
      s.socket.close()
    }
    catch {}
  }

  function tell(id, channel, ...args) {
    const s = sockets.get(id)
    if (s && !s.sender.isDestroyed())
      s.sender.send(channel, id, ...args)
  }

  ipcMain.handle('ph:tcode:udp:open', async (event, req) => {
    if (!allowed(event))
      return { error: 'not allowed' }
    const host = String(req?.host ?? '')
    const port = Number(req?.port)
    if (!HOST.test(host))
      return { error: 'That is not a host name or an IP address' }
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      return { error: 'The port must be between 1 and 65535' }
    let address
    const name = host.replace(/^\[|\]$/g, '')
    try {
      // The system resolver, so tcode.local works wherever mDNS does. IPv4
      // first: the ESP32 firmware has no IPv6, and `localhost` resolving to
      // ::1 would miss a server listening on 127.0.0.1.
      address = await dns.lookup(name, { family: 4 }).catch(() => dns.lookup(name))
    }
    catch {
      return { error: `Could not find ${host} on the network` }
    }
    const socket = dgram.createSocket(address.family === 6 ? 'udp6' : 'udp4')
    const id = nextId++
    const sender = event.sender
    try {
      await new Promise((resolve, reject) => {
        socket.once('error', reject)
        socket.connect(port, address.address, () => {
          socket.off('error', reject)
          resolve()
        })
      })
    }
    catch (err) {
      try {
        socket.close()
      }
      catch {}
      return { error: String(err?.message || err) }
    }
    /** Socket errors in words: a refused port is the common one (restim not running). */
    const say = err => (err?.code === 'ECONNREFUSED' ? `Nothing is listening on ${host}:${port}` : String(err?.message || err))
    sockets.set(id, { socket, sender, say })
    socket.on('error', (err) => {
      tell(id, 'ph:tcode:udp:error', say(err))
      close(id)
    })
    socket.on('message', (msg) => {
      tell(id, 'ph:tcode:udp:message', msg.toString('utf8').slice(0, 512))
    })
    sender.once('destroyed', () => close(id))
    return { id, address: address.address }
  })

  ipcMain.on('ph:tcode:udp:send', (event, id, text) => {
    const s = sockets.get(Number(id))
    if (!s || s.sender !== event.sender || typeof text !== 'string' || text.length > MAX_TEXT)
      return
    s.socket.send(Buffer.from(text, 'utf8'), (err) => {
      // With a callback, a failed send is reported here, not as an 'error' event.
      if (err) {
        tell(Number(id), 'ph:tcode:udp:error', s.say(err))
        close(Number(id))
      }
    })
  })

  ipcMain.on('ph:tcode:udp:close', (event, id) => {
    const s = sockets.get(Number(id))
    if (s && s.sender === event.sender)
      close(Number(id))
  })
}
