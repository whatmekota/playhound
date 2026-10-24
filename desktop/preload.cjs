// Sandboxed preload: the only bridge between the page and the desktop shell.
// Kept tiny on purpose — the app itself must behave identically in a browser,
// so this only *adds* information the browser cannot give it.

const { contextBridge, ipcRenderer } = require('electron')

const info = ipcRenderer.sendSync('ph:info')

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
