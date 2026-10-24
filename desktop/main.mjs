import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, Menu, screen, session, shell } from 'electron'
import { startProxy } from '../es-proxy.mjs'
import { setupDevices } from './devices.mjs'
import { probe, serveStatic } from './serve.mjs'

/**
 * playhound desktop shell.
 *
 * Electron rather than a system-webview shell (Tauri / WebView2) because the
 * app leans on Chromium-only APIs — Web Serial for TCode, the File System
 * Access API for the library — and on es-proxy.mjs, which is Node. Electron
 * ships the same Chromium the browser flow used and runs the proxy in-process.
 *
 * Production: serves dist/ on 0.0.0.0:6969 (the phone remote opens the same
 * app across the LAN), starts the EroScripts proxy (:7071) and the remote
 * relay (:7072), and opens a window on http://localhost:6969.
 * Development (PH_DEV=1, set by desktop/dev.mjs): the window loads the Vite
 * dev server instead, so HMR works as usual.
 */

const APP_PORT = 6969
const APP_URL = `http://localhost:${APP_PORT}`
const DEV = !!process.env.PH_DEV
const DEV_URL = process.env.PH_DEV_URL || APP_URL

// The repo root in development, the app.asar root once packaged — the layout
// under it (desktop/, dist/) is the same in both.
const ROOT = fileURLToPath(new URL('..', import.meta.url))

// A dev run gets its own profile, so hacking on the app never touches the
// library, playlists and settings of the copy used day to day.
if (DEV)
  app.setPath('userData', `${app.getPath('userData')}-dev`)

app.setAppUserModelId('local.playhound')
// Nothing here is a web page the user stumbled on: let audio start without
// a click, so the phone remote can resume a session on a desktop nobody touched.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

// ── Small persisted state (window bounds, last theme colour, serial port) ────

const STATE_FILE = path.join(app.getPath('userData'), 'desktop-state.json')

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  }
  catch {
    return {}
  }
}
const state = readState()
function saveState() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
  }
  catch {}
}

/** Saved bounds, unless the monitor they were on has gone away. */
function restoreBounds() {
  const b = state.bounds
  if (!b)
    return { width: 1440, height: 900 }
  const visible = screen.getAllDisplays().some(({ workArea: w }) =>
    b.x < w.x + w.width - 80 && b.x + b.width > w.x + 80
    && b.y < w.y + w.height - 40 && b.y + 40 > w.y)
  return visible ? b : { width: b.width, height: b.height }
}

function toHex(color) {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color ?? '')
  if (!m)
    return /^#[0-9a-f]{6}$/i.test(color ?? '') ? color : null
  return `#${m.slice(1, 4).map(n => Number(n).toString(16).padStart(2, '0')).join('')}`
}

// ── LAN addresses (the phone needs one; "localhost" means nothing to it) ─────

// This kind of box tends to carry a pile of VPN and VM adapters, none of which
// a phone on the sofa can reach. Node cannot ask Windows which adapters are
// physical, so go by name and push the obvious virtual ones to the back.
const VIRTUAL = /vpn|virtual|vmware|vmnet|vbox|vethernet|hyper-v|wsl|docker|nordlynx|radmin|tap|tun|wireguard|zerotier|tailscale|hamachi|loopback|bluetooth/i

function lanAddresses() {
  const out = []
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal && !ni.address.startsWith('169.254.'))
        out.push({ name, address: ni.address, virtual: VIRTUAL.test(name) })
    }
  }
  const privateNet = a => /^(?:192\.168\.|10\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(a)
  return out
    .sort((a, b) => Number(a.virtual) - Number(b.virtual) || Number(!privateNet(a.address)) - Number(!privateNet(b.address)))
    .map(({ name, address }) => ({ name, address }))
}

// ── Single instance ──────────────────────────────────────────────────────────

let win = null

if (!app.requestSingleInstanceLock()) {
  // Another playhound already owns the window and the ports; it gets focused
  // through 'second-instance' below.
  app.exit(0)
}
else {
  app.on('second-instance', () => {
    if (!win)
      return
    if (win.isMinimized())
      win.restore()
    win.show()
    win.focus()
  })
  app.whenReady().then(boot)
}

// ── Boot ─────────────────────────────────────────────────────────────────────

let proxy = null
let server = null

async function boot() {
  Menu.setApplicationMenu(null)

  setupDevices(session.defaultSession, {
    origin: new URL(DEV ? DEV_URL : APP_URL).origin,
    lastPort: () => state.serialPort,
    rememberPort: (name) => {
      state.serialPort = name
      saveState()
    },
  })

  ipcMain.on('ph:info', (event) => {
    event.returnValue = {
      version: app.getVersion(),
      port: APP_PORT,
      lan: lanAddresses(),
      dev: DEV,
    }
  })
  ipcMain.on('ph:bg', (_event, color) => {
    const hex = toHex(color)
    if (!hex || hex === state.bg)
      return
    state.bg = hex
    win?.setBackgroundColor(hex)
    saveState()
  })

  // Relay + EroScripts proxy. A busy port only means another copy (usually
  // `pnpm dev:proxy`) is already serving it, which is just as good.
  proxy = startProxy({ log: console })

  let url = DEV ? DEV_URL : APP_URL
  if (!DEV) {
    try {
      server = await serveStatic(path.join(ROOT, 'dist'), { port: APP_PORT, host: '0.0.0.0' })
    }
    catch (err) {
      if (err.code !== 'EADDRINUSE')
        throw err
      // Not another desktop instance (the lock above handles those). If it is
      // playhound all the same — start.bat's dev server — use it rather than
      // refusing to start.
      const who = await probe(APP_URL)
      if (who === 'none' || who === 'other') {
        dialog.showErrorBox('playhound', `Port ${APP_PORT} is already in use by another program, so playhound cannot start.\n\nClose whatever is using it and try again.`)
        app.exit(1)
        return
      }
      console.warn(`[desktop] ${APP_URL} is already serving playhound (${who}); using that`)
      url = APP_URL
    }
  }

  createWindow(url)
}

// ── Window ───────────────────────────────────────────────────────────────────

function iconPath() {
  const candidates = [
    path.join(ROOT, 'desktop', 'icon.png'), // packaged (copied in by build.mjs)
    path.join(ROOT, '.desktop', 'icons', 'icon.png'), // dev (made by dev.mjs)
  ]
  return candidates.find(p => fs.existsSync(p))
}

function createWindow(url) {
  const origin = new URL(url).origin
  const isOurs = (u) => {
    try {
      return new URL(u).origin === origin
    }
    catch {
      return false
    }
  }

  win = new BrowserWindow({
    ...restoreBounds(),
    minWidth: 900,
    minHeight: 560,
    title: 'playhound',
    icon: iconPath(),
    // Painted before the page is: the theme the app was last closed in, so
    // there is no white frame on launch (index.html takes over from there).
    backgroundColor: state.bg ?? '#08080a',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(ROOT, 'desktop', 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // This window drives hardware: a minimised or covered window must keep
      // its timers and frames running, or the device stalls mid-stroke.
      backgroundThrottling: false,
      spellcheck: false,
    },
  })

  if (state.maximized)
    win.maximize()
  win.once('ready-to-show', () => win?.show())

  win.on('close', () => {
    if (!win)
      return
    state.maximized = win.isMaximized()
    // Normal bounds, so un-maximising next time lands where it used to.
    state.bounds = win.getNormalBounds()
    saveState()
  })
  win.on('closed', () => {
    win = null
  })

  const wc = win.webContents

  // External links go to the system browser. Our own pages (the remote's
  // "preview on this machine") open as a small phone-sized window.
  wc.setWindowOpenHandler(({ url: target }) => {
    if (isOurs(target)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 420,
          height: 860,
          autoHideMenuBar: true,
          backgroundColor: state.bg ?? '#08080a',
          icon: iconPath(),
          webPreferences: { sandbox: true, contextIsolation: true },
        },
      }
    }
    openExternal(target)
    return { action: 'deny' }
  })
  wc.on('will-navigate', (event, target) => {
    if (!isOurs(target)) {
      event.preventDefault()
      openExternal(target)
    }
  })

  // No menu means no default accelerators, so DevTools needs its own key.
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown')
      return
    const devtools = input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')
    if (devtools) {
      event.preventDefault()
      wc.toggleDevTools()
    }
  })

  wc.on('render-process-gone', (_event, details) => {
    console.error('[desktop] renderer gone:', details.reason)
  })

  win.loadURL(url).catch((err) => {
    console.error('[desktop] could not load', url, err)
    if (DEV)
      dialog.showErrorBox('playhound', `Could not reach the dev server at ${url}.\n\nStart it with pnpm app (not electron directly).`)
  })
}

function openExternal(target) {
  if (/^(?:https?|mailto):/i.test(target))
    void shell.openExternal(target)
}

// ── Shutdown ─────────────────────────────────────────────────────────────────

app.on('window-all-closed', () => app.quit())
app.on('will-quit', () => {
  proxy?.close()
  server?.close()
})
