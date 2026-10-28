import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, Menu, screen, session, shell } from 'electron'
import { startProxy } from '../es-proxy.mjs'
import { setupBluetooth, setupDevices } from './devices.mjs'
import { createPresence, sanitiseActivity, validClientId } from './presence.mjs'
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
/** Origin of the page the main window loads; IPC from anything else is ignored. */
let appOrigin = null

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
/** Last presence status, so a page that loads later can still show it. */
let presenceStatus = { status: 'off', detail: undefined }
const presence = createPresence((status, detail) => {
  presenceStatus = { status, detail }
  if (win && !win.isDestroyed())
    win.webContents.send('ph:presence:status', presenceStatus)
})

/** A fetch on Chromium's network stack, through HTTP(S)_PROXY if one is set. */
const envProxy = () => process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || null

/**
 * Chromium ignores HTTP(S)_PROXY, while the proxy server in this process and
 * yt-dlp follow it, or the proxy from Settings → Network. Apply the same one
 * to a session, so the window (forum covers, thumbnails) reaches the sites
 * the server does. Loopback always stays direct.
 */
async function applyProxy(ses, proxy) {
  try {
    if (!proxy) {
      await ses.setProxy({ mode: 'direct' })
      return
    }
    const u = new URL(proxy.includes('://') ? proxy : `http://${proxy}`)
    await ses.setProxy({
      proxyRules: `${u.protocol === 'https:' ? 'https://' : ''}${u.host}`,
      proxyBypassRules: process.env.NO_PROXY || process.env.no_proxy || '<local>',
    })
  }
  catch (err) {
    console.warn('[playhound] Ignoring an unreadable proxy:', err.message)
  }
}

// ── EroScripts sign-in ───────────────────────────────────────────────────────
// The app keeps its own forum session in a persistent partition, signed into
// through the forum's own login page. Sharing a pasted _t cookie with the
// browser could not work for long: Discourse swaps the token every few
// minutes, and whichever side triggered the swap left the other logged out.
const ES_PARTITION = 'persist:eroscripts'
const ES_URL = 'https://discuss.eroscripts.com'
const esSession = () => session.fromPartition(ES_PARTITION)
let esLoginWin = null

async function esSignedIn() {
  try {
    return (await esSession().cookies.get({ url: ES_URL, name: '_t' })).length > 0
  }
  catch {
    return false
  }
}

function esNotify(signedIn) {
  win?.webContents.send('ph:es:session', { signedIn: !!signedIn })
}

function openEsLogin() {
  if (esLoginWin && !esLoginWin.isDestroyed()) {
    esLoginWin.focus()
    return
  }
  esLoginWin = new BrowserWindow({
    parent: win ?? undefined,
    width: 520,
    height: 760,
    title: 'Sign in to EroScripts',
    autoHideMenuBar: true,
    backgroundColor: '#24262b',
    icon: iconPath(),
    webPreferences: { partition: ES_PARTITION, sandbox: true, contextIsolation: true },
  })
  // Signed in once the forum hands out its session cookie: say so and close.
  const onCookie = (_event, cookie, _cause, removed) => {
    if (cookie.name !== '_t' || removed)
      return
    esNotify(true)
    setTimeout(() => esLoginWin?.close(), 900)
  }
  esSession().cookies.on('changed', onCookie)
  esLoginWin.on('closed', () => {
    esSession().cookies.off('changed', onCookie)
    esLoginWin = null
    void esSignedIn().then(esNotify)
  })
  void esLoginWin.loadURL(`${ES_URL}/login`)
}

async function resolverFetch() {
  const ses = session.fromPartition('resolver')
  await applyProxy(ses, envProxy())
  return (url, init) => ses.fetch(url, init)
}
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
      // Only the frameless main window draws a title bar; the phone-preview
      // popup has a native frame and gets null here.
      window: win && event.sender === win.webContents ? windowState() : null,
      presence: win && event.sender === win.webContents ? presenceStatus : null,
    }
  })
  ipcMain.on('ph:win', (event, action) => {
    if (!win || !fromMainWindow(event))
      return
    if (action === 'minimize') {
      win.minimize()
    }
    else if (action === 'toggle-maximize' && !win.isFullScreen()) {
      if (win.isMaximized())
        win.unmaximize()
      else
        win.maximize()
    }
    else if (action === 'close') {
      win.close()
    }
  })
  // Discord Rich Presence: the page decides what to show, this owns the pipe.
  // Only the main window may set it, and its payload is sanitised regardless.
  ipcMain.on('ph:presence', (event, payload) => {
    if (!fromMainWindow(event))
      return
    const id = payload?.clientId
    const activity = sanitiseActivity(payload?.activity)
    presence.set(validClientId(id) ? id : '', activity)
  })
  ipcMain.handle('ph:es:status', async event => (fromMainWindow(event) ? { signedIn: await esSignedIn() } : null))
  ipcMain.handle('ph:es:login', (event) => {
    if (fromMainWindow(event))
      openEsLogin()
  })
  ipcMain.handle('ph:es:logout', async (event) => {
    if (!fromMainWindow(event))
      return
    await esSession().clearStorageData()
    esNotify(false)
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
  proxy = startProxy({
    log: console,
    // yt-dlp, when the user lets playhound fetch it, lives with the app's data.
    binDir: path.join(app.getPath('userData'), 'bin'),
    // Some stream APIs sit behind Cloudflare, which turns Node away but not
    // Chromium. They get their own throwaway session, routed through the same
    // HTTP(S)_PROXY the rest of the resolvers use.
    browserFetch: await resolverFetch(),
    // Forum requests without a pasted cookie go through the app's own session.
    forumFetch: (url, init) => esSession().fetch(url, init),
    // Settings → Network changed the proxy (null: back to the environment's or none).
    onProxy: (proxy) => {
      void applyProxy(session.fromPartition('resolver'), proxy)
      void applyProxy(session.defaultSession, proxy)
      void applyProxy(esSession(), proxy)
    },
  })
  await applyProxy(session.defaultSession, envProxy())
  await applyProxy(esSession(), envProxy())

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

function isOurs(u) {
  try {
    return new URL(u).origin === appOrigin
  }
  catch {
    return false
  }
}

/** The main window's top frame, on our own page — not an iframe, not a popup. */
function fromMainWindow(event) {
  const frame = event.senderFrame
  return !!win && event.sender === win.webContents
    && !!frame && frame === win.webContents.mainFrame && isOurs(frame.url)
}

/** A display other than the main window's, if there is one. */
function otherDisplay() {
  const here = win ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay()
  return { here, other: screen.getAllDisplays().find(d => d.id !== here.id) }
}

/**
 * The face window (/face): placed on a display other than the main window's
 * when there is one, since a second monitor is what it is for. It goes full
 * screen from the page (see did-create-window below) rather than as a window
 * option, so Esc and double-click take it back out like any web page.
 */
function faceWindowOptions() {
  const { here, other } = otherDisplay()
  const area = (other ?? here).workArea
  const width = Math.min(960, area.width)
  const height = Math.min(600, area.height)
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
    frame: true,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    title: 'playhound face',
    icon: iconPath(),
    webPreferences: { sandbox: true, contextIsolation: true },
  }
}

function windowState() {
  return { maximized: !!win?.isMaximized(), fullScreen: !!win?.isFullScreen() }
}

function createWindow(url) {
  appOrigin = new URL(url).origin

  win = new BrowserWindow({
    ...restoreBounds(),
    minWidth: 900,
    minHeight: 560,
    title: 'playhound',
    icon: iconPath(),
    // No OS frame at all: the page draws its own title bar and caption
    // buttons (src/components/shell/TitleBar.vue), so it can follow the theme.
    // Windows still treats the window as resizable (thickFrame stays on), so
    // edge resizing, Aero Snap, Win+arrows and the drag-region double-click
    // to maximise all come from the OS.
    frame: false,
    // Painted before the page is: the theme the app was last closed in, so
    // there is no white frame on launch (index.html takes over from there).
    backgroundColor: state.bg ?? '#08080a',
    show: false,
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

  // The title bar swaps maximise/restore and hides itself in fullscreen.
  // 'restore' covers un-minimising straight back into a maximised window.
  const pushState = () => {
    if (win && !win.isDestroyed())
      win.webContents.send('ph:win:state', windowState())
  }
  for (const ev of ['maximize', 'unmaximize', 'restore', 'enter-full-screen', 'leave-full-screen', 'enter-html-full-screen', 'leave-html-full-screen'])
    win.on(ev, pushState)

  const wc = win.webContents

  // Web Bluetooth (the heart-rate monitor) picks its device per window.
  setupBluetooth(wc, {
    origin: appOrigin,
    lastDevice: () => state.bluetoothDevice,
    rememberDevice: (id) => {
      state.bluetoothDevice = id
      saveState()
    },
  })

  // External links go to the system browser. Our own pages (the remote's
  // "preview on this machine") open as a small phone-sized window.
  wc.setWindowOpenHandler(({ url: target }) => {
    if (isOurs(target) && new URL(target).pathname.endsWith('/face'))
      return { action: 'allow', overrideBrowserWindowOptions: faceWindowOptions() }
    if (isOurs(target)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 420,
          height: 860,
          // Popups would otherwise pick up the main window's frame: false.
          frame: true,
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
  wc.on('did-create-window', (child, { url: target }) => {
    if (!isOurs(target) || !new URL(target).pathname.endsWith('/face') || !otherDisplay().other)
      return
    // As if the user had asked: a page may only go full screen on a gesture.
    child.webContents.once('did-finish-load', () => {
      child.webContents.executeJavaScript('document.documentElement.requestFullscreen().catch(() => {})', true).catch(() => {})
    })
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
  presence.dispose()
  proxy?.close()
  server?.close()
})
