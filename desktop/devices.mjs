import { BrowserWindow, dialog } from 'electron'

/**
 * Permissions, serial port and Bluetooth device choice, and the File System
 * Access prompts.
 *
 * Chrome answers these with its own permission bubbles and port chooser;
 * Electron has none of that UI and leaves every decision to the app. The app
 * only ever loads its own origin, so the rule is simple: our origin gets what
 * it asks for, anything else (an embedded third-party frame) gets nothing.
 */

/** USB-serial bridges the OSR2 and its relatives ship with, most likely first. */
const SERIAL_VENDORS = {
  0x10C4: 'Silicon Labs CP210x',
  0x1A86: 'WCH CH340',
  0x303A: 'Espressif',
  0x0403: 'FTDI',
  0x2341: 'Arduino',
  0x2E8A: 'Raspberry Pi',
  0x239A: 'Adafruit',
  0x16C0: 'Teensy',
}

function originOf(url) {
  try {
    return new URL(url).origin
  }
  catch {
    return ''
  }
}

/**
 * @param {Electron.Session} ses
 * @param {object} opts
 * @param {string} opts.origin  The app's origin, e.g. http://localhost:6969
 * @param {() => string | undefined} opts.lastPort  portName picked last time
 * @param {(portName: string) => void} opts.rememberPort
 */
export function setupDevices(ses, { origin, lastPort, rememberPort }) {
  const ours = url => originOf(url) === origin

  // Every permission check goes through here once a handler is set — including
  // the File System Access grant on a handle restored from IndexedDB. Saying
  // yes for our origin is what lets the remembered library folder come back at
  // startup without the "reconnect" click the browser needs.
  ses.setPermissionCheckHandler((_wc, _permission, requestingOrigin) => ours(requestingOrigin))

  ses.setPermissionRequestHandler((wc, _permission, callback, details) => {
    callback(ours(details.requestingUrl || wc?.getURL() || ''))
  })

  // getPorts() and reopening a port the page already chose.
  ses.setDevicePermissionHandler(details => details.deviceType === 'serial' && ours(details.origin))

  ses.on('select-serial-port', (event, portList, webContents, callback) => {
    event.preventDefault()
    const win = BrowserWindow.fromWebContents(webContents) ?? undefined
    choosePort(ses, portList, win, lastPort())
      .then((port) => {
        if (port)
          rememberPort(port.portName)
        callback(port?.portId ?? '')
      })
      .catch(() => callback(''))
  })

  // Web Bluetooth pairing that needs a yes (Windows and Linux; macOS asks on
  // its own). Heart-rate straps rarely do, but a watch sometimes will.
  if (typeof ses.setBluetoothPairingHandler === 'function') {
    ses.setBluetoothPairingHandler((details, callback) => {
      if (!details.frame || !ours(details.frame.url)) {
        callback({ confirmed: false })
        return
      }
      confirmPairing(details)
        .then(callback)
        .catch(() => callback({ confirmed: false }))
    })
  }

  // Chrome refuses some folders outright (the profile root, Windows, AppData)
  // and shows its own explanation; here that explanation has to come from us.
  ses.on('file-system-access-restricted', async (_event, details, callback) => {
    const win = BrowserWindow.fromWebContents(details.webContents) ?? undefined
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      title: 'playhound',
      message: 'That folder is protected',
      detail: `${details.path}\n\nIt holds system or app files, so the library cannot use it. Pick the folder your videos are in instead.`,
      buttons: ['Choose another folder', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    callback(response === 0 ? 'tryAgain' : 'deny')
  })
}

async function confirmPairing(details) {
  const win = BrowserWindow.getFocusedWindow() ?? undefined
  if (details.pairingKind === 'providePin') {
    // Electron has no text prompt to ask for one; pairing in Windows'
    // Bluetooth settings first does the same job.
    await dialog.showMessageBox(win, {
      type: 'info',
      title: 'playhound',
      message: 'This device wants a PIN',
      detail: 'Pair it in Windows Settings > Bluetooth & devices first, then connect again here.',
      buttons: ['OK'],
      noLink: true,
    })
    return { confirmed: false }
  }
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    title: 'playhound',
    message: 'Pair with this Bluetooth device?',
    detail: details.pairingKind === 'confirmPin' ? `Check the device shows ${details.pin}.` : undefined,
    buttons: ['Pair', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })
  return { confirmed: response === 0 }
}

/** How long to listen before deciding, once something has turned up. */
const BT_SETTLE_MS = 2500
/** And in all, before saying nothing was found. */
const BT_SCAN_MS = 10_000

/**
 * Choose a device for navigator.bluetooth.requestDevice().
 *
 * Chrome shows a live list that fills in as devices advertise; Electron
 * instead fires 'select-bluetooth-device' again and again with whatever has
 * been seen so far, until the app calls back exactly once. So: the device
 * used last time is taken the moment it shows up; otherwise listen for a
 * short while after the first one appears, then take the only one or ask
 * with a native list. The page's filter (heart_rate) has already been
 * applied, so everything listed is a monitor.
 *
 * Only our own page gets a choice; anything else is cancelled.
 *
 * @param {Electron.WebContents} wc
 * @param {object} opts
 * @param {string} opts.origin
 * @param {() => string | undefined} opts.lastDevice  deviceId picked last time
 * @param {(deviceId: string) => void} opts.rememberDevice
 */
export function setupBluetooth(wc, { origin, lastDevice, rememberDevice }) {
  /** @type {null | { callback: (id: string) => void, seen: Map<string, Electron.BluetoothDevice>, startedAt: number, settle: any, limit: any, deciding: boolean }} */
  let pending = null

  function finish(id) {
    if (!pending)
      return
    clearTimeout(pending.settle)
    clearTimeout(pending.limit)
    const { callback } = pending
    pending = null
    if (id)
      rememberDevice(id)
    callback(id)
  }

  async function decide() {
    if (!pending || pending.deciding)
      return
    pending.deciding = true
    clearTimeout(pending.settle)
    clearTimeout(pending.limit)
    const list = [...pending.seen.values()]
    const win = BrowserWindow.fromWebContents(wc) ?? undefined
    if (!list.length) {
      await dialog.showMessageBox(win, {
        type: 'info',
        title: 'playhound',
        message: 'No heart-rate monitor found',
        detail: 'Make sure it is awake and broadcasting heart rate (on a watch that usually means starting a workout with heart-rate sharing on), and that it is not connected to a phone app.',
        buttons: ['OK'],
        noLink: true,
      })
      finish('')
      return
    }
    if (list.length === 1) {
      finish(list[0].deviceId)
      return
    }
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      title: 'playhound',
      message: 'Which heart-rate monitor?',
      // Command links on Windows: the second line is the small print.
      buttons: [...list.map(d => `${d.deviceName || 'Unnamed device'}\n${d.deviceId}`), 'Cancel'],
      defaultId: 0,
      cancelId: list.length,
    })
    finish(list[response]?.deviceId ?? '')
  }

  wc.on('select-bluetooth-device', (event, deviceList, callback) => {
    event.preventDefault()
    if (originOf(wc.getURL()) !== origin) {
      callback('')
      return
    }
    // A request the page gave up on never called back; do not inherit it.
    if (pending && Date.now() - pending.startedAt > BT_SCAN_MS + 60_000)
      pending = null
    if (!pending) {
      pending = { callback, seen: new Map(), startedAt: Date.now(), settle: null, limit: null, deciding: false }
      pending.limit = setTimeout(() => void decide(), BT_SCAN_MS)
    }
    pending.callback = callback
    for (const d of deviceList)
      pending.seen.set(d.deviceId, d)
    if (pending.deciding)
      return

    const last = lastDevice()
    if (last && pending.seen.has(last)) {
      finish(last)
      return
    }
    if (pending.seen.size && !pending.settle)
      pending.settle = setTimeout(() => void decide(), BT_SETTLE_MS)
  })
}

function vendorOf(port) {
  // Electron hands the USB ids over as decimal strings ("4292" for 0x10C4).
  const id = Number.parseInt(port.vendorId ?? '', 10)
  return Number.isNaN(id) ? undefined : SERIAL_VENDORS[id]
}

/**
 * Pick a port for requestPort().
 *
 * One port: take it, there is nothing to ask. Several: a native list, with the
 * one used last time (or else the likeliest USB-serial bridge) as the default —
 * the CYD face is an ESP32 on the same kind of bridge, so guessing silently
 * would sometimes stream TCode at the wrong board.
 */
async function choosePort(ses, portList, win, last) {
  let ports = [...portList]

  // Windows can still be enumerating when the request lands; give stragglers
  // a moment rather than reporting "no device" for a board that is plugged in.
  if (!ports.length) {
    const added = (_e, port) => ports.push(port)
    ses.on('serial-port-added', added)
    await new Promise(r => setTimeout(r, 800))
    ses.off('serial-port-added', added)
  }
  ports = ports.filter((p, i) => ports.findIndex(q => q.portId === p.portId) === i)

  if (!ports.length) {
    await dialog.showMessageBox(win, {
      type: 'info',
      title: 'playhound',
      message: 'No serial device found',
      detail: 'Plug the device in over USB and check it shows up as a COM port in Device Manager, then connect again.',
      buttons: ['OK'],
      noLink: true,
    })
    return null
  }
  if (ports.length === 1)
    return ports[0]

  ports.sort((a, b) => Number(!vendorOf(a)) - Number(!vendorOf(b)))
  const lastIdx = ports.findIndex(p => p.portName === last)
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    title: 'playhound',
    message: 'Which serial port is the device on?',
    // Rendered as Windows command links: the first line is the button, the
    // second the small print under it.
    buttons: [
      ...ports.map((p) => {
        const what = [p.displayName, vendorOf(p)].filter(Boolean).join(' · ')
        const tag = p.portName === last ? ' (used last time)' : ''
        return `${p.portName || p.displayName || 'Serial port'}${tag}${what ? `\n${what}` : ''}`
      }),
      'Cancel',
    ],
    defaultId: Math.max(lastIdx, 0),
    cancelId: ports.length,
  })
  return ports[response] ?? null
}
