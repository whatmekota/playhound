import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, screen, session, shell } from 'electron'
import { startProxy } from '../es-proxy.mjs'
import { setupBluetooth, setupDevices } from './devices.mjs'
import { setupDevPlugins } from './devplugins.mjs'
import { setupLibraryFiles } from './libfiles.mjs'
import { setupNetBridge } from './netbridge.mjs'
import { setupNetSockets } from './netsocket.mjs'
import { createPluginHttp } from './pluginhttp.mjs'
import { createPresence, sanitiseActivity, validClientId } from './presence.mjs'
import { probe, serveStatic } from './serve.mjs'
import { setupTcodeUdp } from './tcodenet.mjs'
import { createUpdater, UPDATER_SESSION } from './updater.mjs'
import { BROWSING_PARTITION, setupWebviews } from './webview.mjs'

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
/**
 * Plugins' LAN addresses when the app's own server isn't serving the page
 * (development, or a dev server already holding APP_PORT).
 */
const PLUGIN_HTTP_PORT = Number(process.env.PH_PLUGIN_PORT) || 6970
const DEV = !!process.env.PH_DEV
const DEV_URL = process.env.PH_DEV_URL || APP_URL
const MAC = process.platform === 'darwin'

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
// a phone on the sofa can reach. Node cannot ask the OS which adapters are
// physical, so go by name and push the obvious virtual ones to the back
// (Windows names, then Linux bridges and veths, then macOS's awdl/llw/bridge).
const VIRTUAL = /vpn|virtual|vmware|vmnet|vbox|vethernet|hyper-v|wsl|docker|nordlynx|radmin|tap|tun|wireguard|zerotier|tailscale|hamachi|loopback|bluetooth|^(?:virbr|veth|br-|bridge\d|awdl|llw)/i

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
/** The main window's Bluetooth chooser, told by the page what it is about to ask for. */
let bluetooth = null

/** Updates from GitHub Releases (desktop/updater.mjs); made at boot. */
let updater = null
/** Plugins' web views (desktop/webview.mjs); made at boot. */
let webviews = null
/** Plugins' TCP sockets (desktop/netsocket.mjs); made at boot. */
let sockets = null
/** Plugins' addresses on the LAN server (desktop/pluginhttp.mjs); made at boot. */
let pluginHttp = null
/** The library's folders on disk, watched (desktop/libfiles.mjs); made at boot. */
let libFiles = null

/** The pop-out player's window (see popout below), while it is open. */
let popout = null
let popoutClickThrough = false
/** How the click-through key is written, or null when another app holds it. */
let popoutShortcut = null

const POPOUT_NAME = 'ph-popout'
const POPOUT_MIN_OPACITY = 0.2
const POPOUT_KEY = 'CommandOrControl+Alt+P'
const POPOUT_KEY_LABEL = MAC ? '⌘ + ⌥ + P' : 'Ctrl + Alt + P'

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
/** The proxy's login, when its address carries one: Chromium asks for it (see the 'login' handler). */
let proxyLogin = null

async function applyProxy(ses, proxy) {
  try {
    if (!proxy) {
      proxyLogin = null
      await ses.setProxy({ mode: 'direct' })
    }
    else {
      const u = new URL(proxy.includes('://') ? proxy : `http://${proxy}`)
      proxyLogin = u.username ? { host: u.hostname, username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } : null
      await ses.setProxy({
        proxyRules: `${u.protocol === 'https:' ? 'https://' : ''}${u.host}`,
        proxyBypassRules: process.env.NO_PROXY || process.env.no_proxy || '<local>',
      })
    }
    // Open keep-alive connections would otherwise go on taking the old route
    // (a web page reached directly stays direct) until the site drops them.
    await ses.closeAllConnections()
  }
  catch (err) {
    console.warn('[playhound] Ignoring an unreadable proxy:', err.message)
  }
}

// Chromium takes no login in the proxy rules; it asks when the proxy wants
// one. Without this a proxy with a password left web pages failing with 407.
app.on('login', (event, _wc, _details, authInfo, callback) => {
  if (authInfo.isProxy && proxyLogin && authInfo.host === proxyLogin.host) {
    event.preventDefault()
    callback(proxyLogin.username, proxyLogin.password)
  }
})

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
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed())
    win.webContents.send('ph:es:session', { signedIn: !!signedIn })
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

/**
 * macOS: a minimal standard menu, since without one ⌘Q, ⌘C/⌘V, ⌘H and ⌘M do
 * nothing there. No View menu: its zoom and reload keys would take ⌘= and
 * ⌘R from the page, which has its own (Settings → Interface size).
 * Windows and Linux keep no menu at all: the page draws the title bar.
 */
function appMenu() {
  if (!MAC)
    return null
  return Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    {
      role: 'window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'close' },
        { role: 'front' },
      ],
    },
  ])
}

async function boot() {
  Menu.setApplicationMenu(appMenu())

  setupDevices(session.defaultSession, {
    origin: new URL(DEV ? DEV_URL : APP_URL).origin,
    lastPort: () => state.serialPort,
    rememberPort: (name) => {
      state.serialPort = name
      saveState()
    },
    onFolder: p => libFiles?.folder(p),
  })

  ipcMain.on('ph:info', (event) => {
    event.returnValue = {
      version: app.getVersion(),
      platform: process.platform,
      port: APP_PORT,
      lan: lanAddresses(),
      dev: DEV,
      // Only the frameless main window draws a title bar; the phone-preview
      // popup has a native frame and gets null here.
      window: win && event.sender === win.webContents ? windowState() : null,
      presence: win && event.sender === win.webContents ? presenceStatus : null,
      updates: win && event.sender === win.webContents ? updater?.state() ?? null : null,
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
  // Interface size: the page's zoom, which scales everything evenly.
  ipcMain.on('ph:zoom', (event, factor) => {
    if (!win || !fromMainWindow(event) || !Number.isFinite(factor))
      return
    win.webContents.setZoomFactor(Math.max(0.5, Math.min(3, factor)))
    webviews?.relayout()
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
  // The Organizer's Delete: files go to the Recycle Bin (Trash), never
  // straight off the disk. Files only, absolute paths only, main window only.
  ipcMain.handle('ph:trash', async (event, paths) => {
    if (!fromMainWindow(event) || !Array.isArray(paths))
      return { error: 'not allowed' }
    const failed = []
    for (const p of paths.slice(0, 5000)) {
      try {
        if (typeof p !== 'string' || !path.isAbsolute(p) || !fs.statSync(p).isFile())
          throw new Error('Not a file')
        await shell.trashItem(p)
      }
      catch (err) {
        failed.push({ path: String(p), error: err?.message ?? 'Could not move it to the bin' })
      }
    }
    return { failed }
  })
  // The library's folders: watched for new and removed videos, and Show in folder.
  libFiles = setupLibraryFiles({ ipcMain, allowed: fromMainWindow, window: () => win, shell })
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
  ipcMain.on('ph:update', (event, action, arg) => {
    if (!updater || !fromMainWindow(event))
      return
    if (action === 'check')
      updater.check()
    else if (action === 'install')
      updater.install()
    else if (action === 'auto')
      updater.setAuto(!!arg)
  })
  ipcMain.on('ph:popout', (event, o) => {
    if (!fromMainWindow(event) || !popout || popout.isDestroyed())
      return
    if (typeof o?.opacity === 'number' && Number.isFinite(o.opacity))
      popout.setOpacity(Math.max(POPOUT_MIN_OPACITY, Math.min(1, o.opacity)))
    if (typeof o?.clickThrough === 'boolean' && o.clickThrough !== popoutClickThrough)
      setPopoutClickThrough(o.clickThrough)
    if (o?.hidden === true && popout.isVisible())
      popout.hide()
    else if (o?.hidden === false && !popout.isVisible())
      popout.showInactive()
    if (typeof o?.aspect === 'number' && Number.isFinite(o.aspect) && o.aspect > 0.2 && o.aspect < 5)
      fitPopout(o.aspect)
    if (typeof o?.fullScreen === 'boolean')
      setPopoutFullScreen(o.fullScreen, typeof o.display === 'number' ? o.display : null)
  })
  // The screens the pop-out can fill, for "Full screen on …" when there are several.
  ipcMain.handle('ph:popout:displays', (event) => {
    if (!fromMainWindow(event))
      return []
    const here = popout && !popout.isDestroyed() ? screen.getDisplayMatching(popout.getBounds()).id : null
    const primary = screen.getPrimaryDisplay().id
    return screen.getAllDisplays().map((d, i) => ({
      id: d.id,
      label: d.label || `Screen ${i + 1}`,
      size: `${d.size.width} × ${d.size.height}`,
      primary: d.id === primary,
      current: d.id === here,
    }))
  })
  // Plugins' fetch(), so local servers without CORS headers answer.
  setupNetBridge(ipcMain, fromMainWindow)
  // TCode over UDP (ESP32 strokers on WiFi, restim): the page cannot open a UDP socket.
  setupTcodeUdp(ipcMain, fromMainWindow)
  // Plugins' TCP sockets, to apps on this computer and the local network only.
  sockets = setupNetSockets(ipcMain, fromMainWindow)
  // Plugins' answers on the LAN server (a headset browsing the library).
  pluginHttp = createPluginHttp({ ipcMain, allowed: fromMainWindow, window: () => win })
  // Plugins loaded from a folder (Settings → Plugins → Load from folder), reloaded on save.
  setupDevPlugins({ ipcMain, allowed: fromMainWindow, window: () => win, dialog, state, save: saveState })
  // Real web pages inside the window, for plugins (ctx.webview).
  webviews = setupWebviews({ ipcMain, allowed: fromMainWindow, window: () => win, app, background: () => state.bg })
  // Sent synchronously just before requestDevice(), so it lands first.
  ipcMain.on('ph:bt:expect', (event, kind) => {
    if (fromMainWindow(event))
      bluetooth?.expect(kind)
    event.returnValue = true
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
      void applyProxy(session.fromPartition(UPDATER_SESSION, { cache: false }), proxy)
      void applyProxy(session.fromPartition(BROWSING_PARTITION), proxy)
    },
  })
  await applyProxy(session.defaultSession, envProxy())
  await applyProxy(esSession(), envProxy())
  await applyProxy(session.fromPartition(UPDATER_SESSION, { cache: false }), envProxy())
  await applyProxy(session.fromPartition(BROWSING_PARTITION), envProxy())

  updater = createUpdater({
    send: (s) => {
      if (win && !win.isDestroyed())
        win.webContents.send('ph:update:state', s)
    },
    getAuto: () => state.autoUpdate !== false,
    setAuto: (on) => {
      state.autoUpdate = on
      saveState()
    },
  })

  let url = DEV ? DEV_URL : APP_URL
  /** Plugins' paths need a server of their own when ours isn't the one serving. */
  let pluginServerNeeded = DEV
  if (!DEV) {
    try {
      server = await serveStatic(path.join(ROOT, 'dist'), { port: APP_PORT, host: '0.0.0.0', extra: pluginHttp.handle })
      pluginHttp.setPort(APP_PORT)
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
      pluginServerNeeded = true
    }
  }
  if (pluginServerNeeded) {
    await pluginHttp.listen(PLUGIN_HTTP_PORT, '0.0.0.0').catch((err) => {
      console.warn(`[desktop] plugins can't serve on port ${PLUGIN_HTTP_PORT}:`, err.message)
    })
  }

  createWindow(url)
  updater.start()
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

// ── Pop-out player ───────────────────────────────────────────────────────────
// The page opens an empty window (window.open('', POPOUT_NAME)) and moves the
// video into it; this side only gives that window its shape: frameless, over
// everything, see-through on request, and click-through with a key that works
// from any app, since a click-through window cannot be clicked to undo it.

function isPopout(details) {
  return details.frameName === POPOUT_NAME && (details.url === 'about:blank' || details.url === '')
}

/** Where it was last time, or the bottom-right corner of the main window's screen. */
function popoutWindowOptions() {
  const saved = state.popoutBounds
  const onScreen = saved && screen.getAllDisplays().some(({ workArea: w }) =>
    saved.x < w.x + w.width - 40 && saved.x + saved.width > w.x + 40
    && saved.y < w.y + w.height - 40 && saved.y + 40 > w.y)
  let bounds = onScreen ? saved : null
  if (!bounds) {
    const area = (win ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay()).workArea
    const width = 480
    const height = 270
    bounds = { x: area.x + area.width - width - 24, y: area.y + area.height - height - 24, width, height }
  }
  return {
    ...bounds,
    minWidth: 200,
    minHeight: 112,
    frame: false,
    alwaysOnTop: true,
    // Stays in the taskbar, so a pop-out lost behind something can be found.
    skipTaskbar: false,
    backgroundColor: '#000000',
    title: 'playhound',
    icon: iconPath(),
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
  }
}

function pushPopoutState() {
  const fullScreen = !!popout && !popout.isDestroyed() && popout.isFullScreen()
  if (win && !win.isDestroyed())
    win.webContents.send('ph:popout:state', { clickThrough: popoutClickThrough, shortcut: popoutShortcut, fullScreen })
}

/** The video's shape, kept while full screen (which has the screen's) to put back after. */
let popoutAspect = 0

/**
 * Full screen on a screen of its own, while the main window stays usable on
 * another. `displayId`: move to that screen first; otherwise the screen the
 * pop-out is on (where the user dragged it).
 */
function setPopoutFullScreen(on, displayId) {
  if (!popout || popout.isDestroyed() || on === popout.isFullScreen())
    return
  if (!on) {
    popout.setFullScreen(false)
    return
  }
  const target = displayId === null ? null : screen.getAllDisplays().find(d => d.id === displayId)
  if (target && screen.getDisplayMatching(popout.getBounds()).id !== target.id) {
    const b = popout.getBounds()
    const a = target.workArea
    const width = Math.min(b.width, a.width)
    const height = Math.min(b.height, a.height)
    popout.setBounds({ x: Math.round(a.x + (a.width - width) / 2), y: Math.round(a.y + (a.height - height) / 2), width, height })
  }
  // A window held to the video's shape cannot take the screen's.
  popout.setAspectRatio(0)
  popout.setFullScreen(true)
}

function setPopoutClickThrough(on) {
  if (!popout || popout.isDestroyed())
    return
  popoutClickThrough = on
  popout.setIgnoreMouseEvents(on)
  pushPopoutState()
}

/** Keep the window the video's shape, growing or shrinking its height. */
function fitPopout(ratio) {
  popoutAspect = ratio
  if (popout.isFullScreen())
    return
  popout.setAspectRatio(ratio)
  const b = popout.getBounds()
  const height = Math.round(b.width / ratio)
  if (Math.abs(height - b.height) <= 2)
    return
  const area = screen.getDisplayMatching(b).workArea
  const y = Math.max(area.y, Math.min(b.y, area.y + area.height - height))
  popout.setBounds({ x: b.x, y, width: b.width, height })
}

function adoptPopout(child) {
  popout = child
  popoutClickThrough = false
  // Above other apps' always-on-top windows too, and borderless fullscreen games.
  child.setAlwaysOnTop(true, 'screen-saver')
  if (!popoutShortcut && globalShortcut.register(POPOUT_KEY, () => setPopoutClickThrough(!popoutClickThrough)))
    popoutShortcut = POPOUT_KEY_LABEL
  pushPopoutState()
  child.on('enter-full-screen', pushPopoutState)
  child.on('leave-full-screen', () => {
    if (popout === child && popoutAspect)
      fitPopout(popoutAspect)
    pushPopoutState()
  })
  child.on('close', () => {
    if (!child.isFullScreen()) {
      state.popoutBounds = child.getBounds()
      saveState()
    }
  })
  child.on('closed', () => {
    if (popout !== child)
      return
    popout = null
    popoutClickThrough = false
    if (popoutShortcut)
      globalShortcut.unregister(POPOUT_KEY)
    popoutShortcut = null
    pushPopoutState()
  })
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
    // macOS keeps its own traffic lights over the page's bar instead, centred
    // in its 34 px; the bar leaves room for them and draws no buttons.
    ...(MAC
      ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 13, y: 11 } }
      : { frame: false }),
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
    // It lives off this window's page; it cannot outlive it.
    if (popout && !popout.isDestroyed())
      popout.close()
    state.maximized = win.isMaximized()
    // Normal bounds, so un-maximising next time lands where it used to.
    state.bounds = win.getNormalBounds()
    saveState()
  })
  win.on('closed', () => {
    webviews?.destroyAll()
    sockets?.closeAll()
    libFiles?.reset()
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

  // Web Bluetooth (the heart-rate monitor, the Handy) picks its device per window.
  bluetooth = setupBluetooth(wc, {
    origin: appOrigin,
    lastDevice: kind => (kind === 'handy' ? state.handyDevice : state.bluetoothDevice),
    rememberDevice: (kind, id) => {
      if (kind === 'handy')
        state.handyDevice = id
      else
        state.bluetoothDevice = id
      saveState()
    },
  })

  // External links go to the system browser. Our own pages (the remote's
  // "preview on this machine") open as a small phone-sized window.
  wc.setWindowOpenHandler((details) => {
    const target = details.url
    if (isPopout(details))
      return { action: 'allow', overrideBrowserWindowOptions: popoutWindowOptions() }
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
  wc.on('did-create-window', (child, details) => {
    if (isPopout(details)) {
      adoptPopout(child)
      return
    }
    const target = details.url
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

  // No menu means no default accelerators, so DevTools needs its own key
  // (on macOS the usual ⌘⌥I, which the minimal menu does not carry either).
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown')
      return
    const devtools = input.key === 'F12'
      || (input.control && input.shift && input.key.toLowerCase() === 'i')
      || (MAC && input.meta && input.alt && input.code === 'KeyI')
    if (devtools) {
      event.preventDefault()
      wc.toggleDevTools()
    }
  })

  wc.on('render-process-gone', (_event, details) => {
    console.error('[desktop] renderer gone:', details.reason)
    webviews?.destroyAll()
  })
  // A reload (or HMR's full reload) brings up a page that knows none of the
  // views the last one made: they go with it.
  wc.on('did-navigate', () => {
    webviews?.destroyAll()
    sockets?.closeAll()
    pluginHttp?.reset()
    libFiles?.reset()
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

// An error while closing (a page or view sending to a window already gone)
// is no reason for a dialog: the app is going away anyway. Before that,
// errors get the same dialog Electron shows by default.
let quitting = false
app.on('before-quit', () => {
  quitting = true
})
process.on('uncaughtException', (err) => {
  console.error('[desktop] uncaught:', err)
  if (!quitting)
    dialog.showErrorBox('A JavaScript error occurred in the main process', String(err?.stack ?? err))
})

app.on('window-all-closed', () => {
  quitting = true
  app.quit()
})
app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  presence.dispose()
  proxy?.close()
  server?.close()
  pluginHttp?.close()
  sockets?.closeAll()
})
