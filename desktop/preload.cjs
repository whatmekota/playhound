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
