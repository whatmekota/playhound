// Sandboxed preload: the only bridge between the page and the desktop shell.
// Kept tiny on purpose — the app itself must behave identically in a browser,
// so this only *adds* information the browser cannot give it.

const { contextBridge, ipcRenderer, webUtils } = require('electron')

const info = ipcRenderer.sendSync('ph:info')

// ── Window controls (main window only) ──────────────────────────────────────
// The main window is frameless and the page draws the title bar, so it needs
// minimise / maximise / close and to know when the window changes state.
// Null in any other window (the phone-preview popup has a native frame).

let winState = info.window ? { ...info.window } : null
const listeners = new Set()

if (winState) {
  ipcRenderer.on('ph:win:state', (_event, s) => {
    winState = { maximized: !!s?.maximized, fullScreen: !!s?.fullScreen }
    for (const cb of listeners) {
      try {
        cb({ ...winState })
      }
      catch (err) {
        console.error('[playhound] window state listener failed', err)
      }
    }
  })
}

const windowApi = winState
  ? Object.freeze({
      minimize: () => ipcRenderer.send('ph:win', 'minimize'),
      /** Zoom the whole page, 1 = 100%: Settings → Interface size. */
      setZoom: factor => ipcRenderer.send('ph:zoom', Number(factor)),
      toggleMaximize: () => ipcRenderer.send('ph:win', 'toggle-maximize'),
      close: () => ipcRenderer.send('ph:win', 'close'),
      /** { maximized, fullScreen } right now. */
      state: () => ({ ...winState }),
      /** Calls `cb({ maximized, fullScreen })` on every change; returns an unsubscribe. */
      onStateChange: (cb) => {
        if (typeof cb !== 'function')
          return () => {}
        listeners.add(cb)
        return () => void listeners.delete(cb)
      },
    })
  : null

// ── Discord Rich Presence (main window only) ────────────────────────────────
// The page decides what to show; the main process owns the connection.

let presenceStatus = info.presence ? { ...info.presence } : null
const presenceListeners = new Set()
if (presenceStatus) {
  ipcRenderer.on('ph:presence:status', (_event, s) => {
    presenceStatus = { status: String(s?.status ?? 'off'), detail: s?.detail ? String(s.detail) : undefined }
    for (const cb of presenceListeners) {
      try {
        cb({ ...presenceStatus })
      }
      catch (err) {
        console.error('[playhound] presence listener failed', err)
      }
    }
  })
}

const presenceApi = presenceStatus
  ? Object.freeze({
      /** Show `activity` for Discord application `clientId`, or clear with null. */
      set: (clientId, activity) => ipcRenderer.send('ph:presence', { clientId: String(clientId ?? ''), activity: activity ?? null }),
      /** { status, detail } right now: off | connecting | connected | no-discord | error. */
      status: () => ({ ...presenceStatus }),
      /** Calls `cb({ status, detail })` on every change; returns an unsubscribe. */
      onStatus: (cb) => {
        if (typeof cb !== 'function')
          return () => {}
        presenceListeners.add(cb)
        return () => void presenceListeners.delete(cb)
      },
    })
  : null

// ── EroScripts sign-in (main window only) ───────────────────────────────────
// The app's own forum session; the main process opens the login window.
const esListeners = new Set()
if (winState) {
  ipcRenderer.on('ph:es:session', (_event, s) => {
    for (const cb of esListeners) {
      try {
        cb({ signedIn: !!s?.signedIn })
      }
      catch (err) {
        console.error('[playhound] EroScripts session listener failed', err)
      }
    }
  })
}
const eroscriptsApi = winState
  ? Object.freeze({
      /** { signedIn } of the app's own forum session. */
      status: () => ipcRenderer.invoke('ph:es:status'),
      /** Open the forum's login page in a window of the app. */
      login: () => ipcRenderer.invoke('ph:es:login'),
      /** Forget the app's forum session. */
      logout: () => ipcRenderer.invoke('ph:es:logout'),
      /** Calls `cb({ signedIn })` when signing in or out; returns an unsubscribe. */
      onChange: (cb) => {
        if (typeof cb !== 'function')
          return () => {}
        esListeners.add(cb)
        return () => void esListeners.delete(cb)
      },
    })
  : null

// ── Pop-out player (main window only) ───────────────────────────────────────
// The page opens the window itself (window.open into an empty document it
// fills); the main process gives it its shape: on top, frameless, see-through.
const popoutListeners = new Set()
if (winState) {
  ipcRenderer.on('ph:popout:state', (_event, s) => {
    const state = { clickThrough: !!s?.clickThrough, shortcut: typeof s?.shortcut === 'string' ? s.shortcut : null }
    for (const cb of popoutListeners) {
      try {
        cb(state)
      }
      catch (err) {
        console.error('[playhound] pop-out listener failed', err)
      }
    }
  })
}
const popoutApi = winState
  ? Object.freeze({
      /** { opacity, clickThrough, hidden, aspect }, any subset. */
      set: (opts) => {
        const o = {}
        if (typeof opts?.opacity === 'number')
          o.opacity = opts.opacity
        if (typeof opts?.clickThrough === 'boolean')
          o.clickThrough = opts.clickThrough
        if (typeof opts?.hidden === 'boolean')
          o.hidden = opts.hidden
        if (typeof opts?.aspect === 'number')
          o.aspect = opts.aspect
        ipcRenderer.send('ph:popout', o)
      },
      /** Calls `cb({ clickThrough, shortcut })` when the global key flips it; returns an unsubscribe. */
      onState: (cb) => {
        if (typeof cb !== 'function')
          return () => {}
        popoutListeners.add(cb)
        return () => void popoutListeners.delete(cb)
      },
    })
  : null

// ── Updates (main window only) ──────────────────────────────────────────────
// The main process checks GitHub Releases (desktop/updater.mjs); the page
// shows the state and asks for a check or a restart.
let updateState = info.updates ? { ...info.updates } : null
const updateListeners = new Set()
if (updateState) {
  ipcRenderer.on('ph:update:state', (_event, s) => {
    updateState = { ...s }
    for (const cb of updateListeners) {
      try {
        cb({ ...updateState })
      }
      catch (err) {
        console.error('[playhound] update listener failed', err)
      }
    }
  })
}
const updatesApi = updateState
  ? Object.freeze({
      /** { status, current, version, percent, error, portable, auto, url } right now. */
      state: () => ({ ...updateState }),
      /** Calls `cb(state)` on every change; returns an unsubscribe. */
      onState: (cb) => {
        if (typeof cb !== 'function')
          return () => {}
        updateListeners.add(cb)
        return () => void updateListeners.delete(cb)
      },
      check: () => ipcRenderer.send('ph:update', 'check'),
      /** Quit, install the downloaded update and start again. */
      install: () => ipcRenderer.send('ph:update', 'install'),
      setAuto: on => ipcRenderer.send('ph:update', 'auto', !!on),
    })
  : null

// ── Network for plugins ─────────────────────────────────────────────────────
// fetch() made by the main process (desktop/netbridge.mjs), streamed back
// through callbacks: the page turns it into a Response.
const netApi = winState
  ? Object.freeze({
      /**
       * req: { url, method, headers: [[k, v]], body: Uint8Array | null }
       * on: { head(status, statusText, headers), chunk(Uint8Array), end(), error(message) }
       * Returns an abort function.
       */
      fetch: (req, on) => {
        const { port1, port2 } = new MessageChannel()
        port1.onmessage = (e) => {
          const m = e.data
          try {
            if (m.type === 'head')
              on.head(m.status, m.statusText, m.headers)
            else if (m.type === 'chunk')
              on.chunk(m.data)
            else if (m.type === 'end')
              on.end()
            else if (m.type === 'error')
              on.error(m.message)
          }
          catch (err) {
            console.error('[playhound] net callback failed', err)
          }
          if (m.type === 'end' || m.type === 'error')
            port1.close()
        }
        ipcRenderer.postMessage('ph:net:fetch', {
          url: String(req.url),
          method: String(req.method || 'GET'),
          headers: Array.isArray(req.headers) ? req.headers.map(([k, v]) => [String(k), String(v)]) : [],
          body: req.body instanceof Uint8Array ? req.body : null,
        }, [port2])
        return () => {
          try {
            port1.postMessage({ type: 'abort' })
          }
          catch {}
        }
      },
      /**
       * A TCP connection to this computer or the local network
       * (desktop/netsocket.mjs). req: { host, port }
       * on: { open(address, port), data(Uint8Array), close(error | null) }
       * Returns { send(Uint8Array), close() }.
       */
      socket: (req, on) => {
        const { port1, port2 } = new MessageChannel()
        let closed = false
        port1.onmessage = (e) => {
          const m = e.data
          try {
            if (m.type === 'open')
              on.open(String(m.address), Number(m.port))
            else if (m.type === 'data')
              on.data(m.data)
            else if (m.type === 'close')
              on.close(m.error ? String(m.error) : null)
          }
          catch (err) {
            console.error('[playhound] socket callback failed', err)
          }
          if (m.type === 'close') {
            closed = true
            port1.close()
          }
        }
        ipcRenderer.postMessage('ph:net:socket', { host: String(req?.host ?? ''), port: Number(req?.port) }, [port2])
        return {
          send: (data) => {
            if (!closed && data instanceof Uint8Array)
              port1.postMessage({ type: 'send', data })
          },
          close: () => {
            if (!closed)
              port1.postMessage({ type: 'close' })
          },
        }
      },
    })
  : null

// ── Plugins' answers on the LAN server ──────────────────────────────────────
// A request to /plugins/<id>/… or /ph-files/… on the app's server comes here
// (desktop/pluginhttp.mjs); the page answers it, pulled a chunk at a time.
const httpListeners = new Set()
if (winState) {
  ipcRenderer.on('ph:http:request', (e, req) => {
    const port = e.ports?.[0]
    if (!port)
      return
    const pullers = new Set()
    const aborters = new Set()
    let done = false
    port.onmessage = (ev) => {
      const t = ev.data?.type
      for (const cb of t === 'pull' ? pullers : t === 'abort' ? aborters : []) {
        try {
          cb()
        }
        catch (err) {
          console.error('[playhound] http callback failed', err)
        }
      }
      if (t === 'abort') {
        done = true
        port.close()
      }
    }
    const post = (m) => {
      if (!done)
        port.postMessage(m)
      if (m.type === 'end' || m.type === 'error') {
        done = true
        port.close()
      }
    }
    const reply = Object.freeze({
      head: (status, headers) => post({ type: 'head', status: Number(status), headers: Array.isArray(headers) ? headers.map(([k, v]) => [String(k), String(v)]) : [] }),
      chunk: (data) => {
        if (data instanceof Uint8Array)
          post({ type: 'chunk', data })
      },
      end: () => post({ type: 'end' }),
      error: message => post({ type: 'error', message: String(message ?? '') }),
      onPull: (cb) => {
        if (typeof cb === 'function')
          pullers.add(cb)
      },
      onAbort: (cb) => {
        if (typeof cb === 'function')
          aborters.add(cb)
      },
    })
    const request = Object.freeze({
      method: String(req?.method ?? 'GET'),
      url: String(req?.url ?? '/'),
      headers: Array.isArray(req?.headers) ? req.headers.map(([k, v]) => [String(k), String(v)]) : [],
      body: req?.body instanceof Uint8Array ? req.body : null,
      remote: String(req?.remote ?? ''),
    })
    if (!httpListeners.size) {
      reply.error('Nothing is listening')
      return
    }
    for (const cb of httpListeners) {
      try {
        cb(request, reply)
      }
      catch (err) {
        console.error('[playhound] http listener failed', err)
        reply.error('Failed')
      }
    }
  })
}
const httpApi = winState
  ? Object.freeze({
      /** Say whether any plugin serves anything; resolves { port } (null until a server took our paths). */
      setOpen: on => ipcRenderer.invoke('ph:http:open', !!on),
      /** Calls `cb(request, reply)` for each request; returns an unsubscribe. */
      onRequest: (cb) => {
        if (typeof cb !== 'function')
          return () => {}
        httpListeners.add(cb)
        return () => void httpListeners.delete(cb)
      },
    })
  : null

// ── TCode over UDP (main window only) ───────────────────────────────────────
// The main process holds the socket (desktop/tcodenet.mjs); errors and replies
// come back tagged with the socket's id.
const udpErrorListeners = new Set()
const udpMessageListeners = new Set()
if (winState) {
  ipcRenderer.on('ph:tcode:udp:error', (_event, id, message) => fanOut(udpErrorListeners, 'udp error', Number(id), String(message)))
  ipcRenderer.on('ph:tcode:udp:message', (_event, id, text) => fanOut(udpMessageListeners, 'udp message', Number(id), String(text)))
}
const tcodeApi = winState
  ? Object.freeze({
      /** Resolve and connect: { id, address } or { error }. */
      udpOpen: (host, port) => ipcRenderer.invoke('ph:tcode:udp:open', { host: String(host), port: Number(port) }),
      /** One datagram. */
      udpSend: (id, text) => ipcRenderer.send('ph:tcode:udp:send', Number(id), String(text)),
      udpClose: id => ipcRenderer.send('ph:tcode:udp:close', Number(id)),
      /** Calls `cb(id, message)` when a socket fails (it is closed then); returns an unsubscribe. */
      onUdpError: cb => listen(udpErrorListeners)(cb),
      /** Calls `cb(id, text)` for a reply from the device; returns an unsubscribe. */
      onUdpMessage: cb => listen(udpMessageListeners)(cb),
    })
  : null

// ── Plugin dev mode ─────────────────────────────────────────────────────────
// Plugins loaded from a folder the user picked; the main process reads and
// watches it (desktop/devplugins.mjs) and says when something in it changed.
const devListeners = new Set()
if (winState) {
  ipcRenderer.on('ph:plugins:dev:changed', (_event, folder) => {
    for (const cb of devListeners) {
      try {
        cb(String(folder))
      }
      catch (err) {
        console.error('[playhound] dev plugin listener failed', err)
      }
    }
  })
}
const pluginsApi = winState
  ? Object.freeze({
      /** The folders loaded before, to load again at startup. */
      devFolders: () => ipcRenderer.invoke('ph:plugins:dev:list'),
      /** The folder dialog; the picked folder (remembered), or null. */
      pickDevFolder: () => ipcRenderer.invoke('ph:plugins:dev:pick'),
      /** { files: [{ path, data }] } or { error }. Starts watching the folder. */
      readDevFolder: folder => ipcRenderer.invoke('ph:plugins:dev:read', String(folder)),
      /** Stop watching a folder and forget it. */
      forgetDevFolder: folder => ipcRenderer.invoke('ph:plugins:dev:forget', String(folder)),
      /** Calls `cb(folder)` when a file in a loaded folder changed; returns an unsubscribe. */
      onDevChange: (cb) => {
        if (typeof cb !== 'function')
          return () => {}
        devListeners.add(cb)
        return () => void devListeners.delete(cb)
      },
    })
  : null

// ── Web views for plugins (main window only) ────────────────────────────────
// Real web pages the main process lays over the window (desktop/webview.mjs).
// The page says where each one goes and when to hide it; the main process
// says what happens in it.
const webStateListeners = new Set()
const webKeyListeners = new Set()
const webActivityListeners = new Set()
function fanOut(set, label, ...args) {
  for (const cb of set) {
    try {
      cb(...args)
    }
    catch (err) {
      console.error(`[playhound] ${label} listener failed`, err)
    }
  }
}
if (winState) {
  ipcRenderer.on('ph:web:state', (_event, id, patch) => fanOut(webStateListeners, 'web view', Number(id), { ...patch }))
  ipcRenderer.on('ph:web:key', (_event, key) => fanOut(webKeyListeners, 'web view key', String(key)))
  ipcRenderer.on('ph:web:activity', () => fanOut(webActivityListeners, 'web view activity'))
}
function listen(set) {
  return (cb) => {
    if (typeof cb !== 'function')
      return () => {}
    set.add(cb)
    return () => void set.delete(cb)
  }
}
const webApi = winState
  ? Object.freeze({
      /** A new view, hidden until laid out: { id } or { error }. */
      create: () => ipcRenderer.invoke('ph:web:create'),
      destroy: id => ipcRenderer.send('ph:web:destroy', Number(id)),
      /** Where it goes, in CSS pixels ({ x, y, width, height, radius }), or null to hide it. */
      layout: (id, rect) => ipcRenderer.send('ph:web:layout', Number(id), rect
        ? { x: Number(rect.x), y: Number(rect.y), width: Number(rect.width), height: Number(rect.height), radius: Number(rect.radius ?? 0) }
        : null),
      /** 'load' (with a URL), 'back', 'forward', 'reload', 'stop', or 'zoom' (with a factor). */
      nav: (id, action, arg) => ipcRenderer.send('ph:web:nav', Number(id), String(action), action === 'zoom' ? Number(arg) : arg === undefined ? undefined : String(arg)),
      /** Panic on or off: every view hidden, muted and paused. */
      panic: on => ipcRenderer.send('ph:web:panic', !!on),
      /** Let the next getDisplayMedia() hand over this view's sound (the Music source listening to a page). */
      listen: id => ipcRenderer.invoke('ph:web:listen', Number(id)),
      /** Calls `cb(id, patch)` when something about a view changes; returns an unsubscribe. */
      onState: listen(webStateListeners),
      /** Calls `cb(key)` with a key of the app's pressed inside a page ('Escape', 'Backquote', 'KeyK'). */
      onKey: listen(webKeyListeners),
      /** Calls `cb()` (at most once a second) while the user clicks or types in a page. */
      onActivity: listen(webActivityListeners),
    })
  : null

/**
 * window.playhoundDesktop — undefined in a plain browser.
 * `lan` lists this machine's IPv4 addresses, physical adapters first: the page
 * itself runs on localhost, which a phone cannot open.
 */
contextBridge.exposeInMainWorld('playhoundDesktop', Object.freeze({
  version: info.version,
  /** 'win32', 'darwin' or 'linux': how to draw the title bar and write keys. */
  platform: info.platform,
  port: info.port,
  dev: info.dev,
  lan: Object.freeze(info.lan.map(a => Object.freeze({ ...a }))),
  window: windowApi,
  presence: presenceApi,
  eroscripts: eroscriptsApi,
  bluetooth: winState
    ? Object.freeze({
        /** What the next requestDevice() is for: 'heart' or 'handy'. */
        expect: kind => void ipcRenderer.sendSync('ph:bt:expect', kind === 'handy' ? 'handy' : 'heart'),
      })
    : undefined,
  popout: popoutApi ?? undefined,
  updates: updatesApi ?? undefined,
  net: netApi ?? undefined,
  http: httpApi ?? undefined,
  plugins: pluginsApi ?? undefined,
  web: webApi ?? undefined,
  tcode: tcodeApi ?? undefined,
  files: winState
    ? Object.freeze({
        /** Where a File is on disk, or '' when it has no path there. */
        pathOf: (file) => {
          try {
            return webUtils.getPathForFile(file) || ''
          }
          catch {
            return ''
          }
        },
        /** Move files (absolute paths) to the Recycle Bin / Trash: { failed: [{ path, error }] }. */
        trash: paths => ipcRenderer.invoke('ph:trash', Array.isArray(paths) ? paths.map(String) : []),
      })
    : undefined,
}))

// Hand the theme's background to the main process whenever it changes, so the
// next launch paints the right colour before the page has loaded (index.html
// and the theme store keep it on <html>'s inline style).
window.addEventListener('DOMContentLoaded', () => {
  const root = document.documentElement
  const report = () => {
    const bg = root.style.backgroundColor || getComputedStyle(root).backgroundColor
    if (bg)
      ipcRenderer.send('ph:bg', bg)
  }
  report()
  new MutationObserver(report).observe(root, { attributes: true, attributeFilter: ['style', 'data-theme'] })
})
