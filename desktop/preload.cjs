// Sandboxed preload: the only bridge between the page and the desktop shell.
// Kept tiny on purpose — the app itself must behave identically in a browser,
// so this only *adds* information the browser cannot give it.

const { contextBridge, ipcRenderer } = require('electron')

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
    })
  : null

/**
 * window.playhoundDesktop — undefined in a plain browser.
 * `lan` lists this machine's IPv4 addresses, physical adapters first: the page
 * itself runs on localhost, which a phone cannot open.
 */
contextBridge.exposeInMainWorld('playhoundDesktop', Object.freeze({
  version: info.version,
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
