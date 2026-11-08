// Web views for plugins: real web pages inside the main window.
//
// An <iframe> can't show most sites (X-Frame-Options, CSP frame-ancestors), so
// a plugin that wants a page gets a WebContentsView instead: a separate
// browser surface the main process lays over the window, where the page asks.
// The page reports a rect in CSS pixels; this side scales it by the page's own
// zoom (Settings → Interface size) and places the view there. A native view
// draws over the whole page, so the page also says when to hide it: whenever
// one of its dialogs, menus or toasts would be under it (src/plugins/webview.ts).
//
// The pages run sandboxed, with no preload and no Node, in a session of their
// own (persist:browsing): cookies and logins stay between runs and never mix
// with the app's. They can't send anything to the app. See webviewRules.mjs
// for what they may do: no permissions but full screen and the clipboard, new
// windows open in the same view, http and https only.

import { session, WebContentsView } from 'electron'
import { BROWSING_PARTITION, forwardedKey, MAX_VIEWS, permissionAllowed, plainUserAgent, popupAction, scaleRect, webUrl } from './webviewRules.mjs'

export { BROWSING_PARTITION }

/** Input that counts as the user being there, for the idle stop. */
const ACTIVITY = new Set(['mouseDown', 'keyDown', 'mouseWheel', 'touchStart'])

let sessionReady = false

/** The browsing session's rules, set once. */
function setupSession(app) {
  if (sessionReady)
    return
  sessionReady = true
  const ses = session.fromPartition(BROWSING_PARTITION)
  ses.setUserAgent(plainUserAgent(ses.getUserAgent() || app.userAgentFallback))
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(permissionAllowed(permission)))
  ses.setPermissionCheckHandler((_wc, permission) => permissionAllowed(permission))
  // HID, serial and USB pickers: never. (Bluetooth is per webContents and
  // refused when nothing handles it.)
  ses.setDevicePermissionHandler(() => false)
  ses.on('select-hid-device', (event, _details, callback) => {
    event.preventDefault()
    callback('')
  })
  ses.on('select-serial-port', (event, _ports, _wc, callback) => {
    event.preventDefault()
    callback('')
  })
  ses.on('select-usb-device', (event, _details, callback) => {
    event.preventDefault()
    callback()
  })
}

/**
 * @param {object} o
 * @param {Electron.IpcMain} o.ipcMain
 * @param {(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => boolean} o.allowed  only the main window
 * @param {() => Electron.BrowserWindow | null} o.window
 * @param {Electron.App} o.app
 * @param {() => string} o.background  the colour a view shows before its page paints
 */
export function setupWebviews({ ipcMain, allowed, window, app, background }) {
  setupSession(app)

  /**
   * id → { view, wc, css: { x, y, width, height, radius } | null, fullscreen }.
   * `css` null means the page wants it hidden.
   */
  const views = new Map()
  let nextId = 1
  let panicked = false

  const win = () => {
    const w = window()
    return w && !w.isDestroyed() ? w : null
  }

  function send(id, patch) {
    win()?.webContents.send('ph:web:state', id, patch)
  }

  function nav(wc) {
    try {
      return { canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward() }
    }
    catch {
      return {}
    }
  }

  /** Place (or hide) a view as the page last asked, at the page's zoom right now. */
  function apply(v) {
    const w = win()
    if (!w || v.wc.isDestroyed())
      return
    let bounds = null
    if (!panicked) {
      const size = w.getContentBounds()
      bounds = v.fullscreen
        ? { x: 0, y: 0, width: size.width, height: size.height }
        : scaleRect(v.css, w.webContents.getZoomFactor(), size)
    }
    if (bounds) {
      v.view.setBounds(bounds)
      v.view.setBorderRadius(v.fullscreen ? 0 : Math.round((v.css?.radius ?? 0) * w.webContents.getZoomFactor()))
      v.view.setVisible(true)
    }
    else {
      v.view.setVisible(false)
      // A hidden page keeps the keyboard otherwise, and the app's keys (Esc
      // to panic, or to resume) would go nowhere.
      if (v.wc.isFocused())
        w.webContents.focus()
    }
  }

  function destroy(id) {
    const v = views.get(id)
    if (!v)
      return
    views.delete(id)
    try {
      win()?.contentView.removeChildView(v.view)
    }
    catch {}
    // A WebContentsView's page isn't closed with the view; it would live on.
    if (!v.wc.isDestroyed())
      v.wc.close()
  }

  function destroyAll() {
    for (const id of [...views.keys()])
      destroy(id)
  }

  /** Panic: hide every view, mute it, pause what plays in it and leave full screen. */
  function setPanic(on) {
    panicked = !!on
    for (const v of views.values()) {
      if (v.wc.isDestroyed())
        continue
      v.wc.setAudioMuted(panicked)
      if (panicked) {
        for (const frame of v.wc.mainFrame.framesInSubtree) {
          frame.executeJavaScript('document.querySelectorAll("video, audio").forEach(m => m.pause()); document.fullscreenElement && document.exitFullscreen().catch(() => {})', true).catch(() => {})
        }
      }
      apply(v)
    }
  }

  function create() {
    const w = win()
    if (!w)
      return { error: 'No window' }
    if (views.size >= MAX_VIEWS)
      return { error: `Only ${MAX_VIEWS} web views can be open at once` }
    const id = nextId++
    const view = new WebContentsView({
      webPreferences: {
        partition: BROWSING_PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webviewTag: false,
        spellcheck: false,
        // An alert() loop can't lock up the window: Chromium offers to stop it.
        safeDialogs: true,
      },
    })
    const wc = view.webContents
    // WebRTC finds the machine's own addresses and talks UDP past an HTTP
    // proxy, which is how "what is my IP" pages see the real one. Keep it to
    // the proxy's route (TCP through it when one is set).
    wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    const v = { view, wc, css: null, fullscreen: false }
    views.set(id, v)
    view.setBackgroundColor(background() || '#08080a')
    view.setVisible(false)
    w.contentView.addChildView(view)
    if (panicked)
      wc.setAudioMuted(true)

    wc.setWindowOpenHandler((details) => {
      if (popupAction(details) === 'same-view')
        void wc.loadURL(details.url).catch(() => {})
      return { action: 'deny' }
    })
    const guard = (event, url) => {
      if (!webUrl(url))
        event.preventDefault()
    }
    wc.on('will-navigate', guard)
    wc.on('will-redirect', guard)

    wc.on('before-input-event', (event, input) => {
      const key = forwardedKey(input)
      if (!key)
        return
      event.preventDefault()
      const main = win()
      if (!main)
        return
      // The app takes the keyboard back: what the key opens (the palette,
      // the panic cover) wants it, and so does the next Esc.
      main.webContents.focus()
      // Hidden straight away rather than after the page has heard of it.
      if (key !== 'KeyK')
        setPanic(true)
      main.webContents.send('ph:web:key', key)
    })
    let lastActivity = 0
    wc.on('input-event', (_event, input) => {
      if (!ACTIVITY.has(input.type) || Date.now() - lastActivity < 1000)
        return
      lastActivity = Date.now()
      win()?.webContents.send('ph:web:activity')
    })

    wc.on('did-start-loading', () => send(id, { loading: true, error: null }))
    wc.on('did-stop-loading', () => send(id, { loading: false, ...nav(wc) }))
    wc.on('did-navigate', (_e, url) => send(id, { url, ...nav(wc) }))
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (isMainFrame)
        send(id, { url, ...nav(wc) })
    })
    wc.on('page-title-updated', (_e, title) => send(id, { title }))
    wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
      // -3 is ERR_ABORTED: a navigation replaced by another, or stopped.
      if (isMainFrame && code !== -3)
        send(id, { loading: false, error: { code, description, url }, ...nav(wc) })
    })
    wc.on('render-process-gone', (_e, details) => {
      send(id, { loading: false, error: { code: -1, description: details.reason === 'oom' ? 'The page ran out of memory' : 'The page crashed', url: wc.getURL() } })
    })
    wc.on('media-started-playing', () => send(id, { media: true }))
    wc.on('media-paused', () => send(id, { media: false }))
    wc.on('audio-state-changed', e => send(id, { audible: !!e.audible }))
    wc.on('focus', () => send(id, { focused: true }))
    wc.on('blur', () => send(id, { focused: false }))
    // A video going full screen takes the whole window (Electron makes the
    // window itself full screen); the stage gets it back when it leaves.
    wc.on('enter-html-full-screen', () => {
      v.fullscreen = true
      apply(v)
      send(id, { fullscreen: true })
    })
    wc.on('leave-html-full-screen', () => {
      v.fullscreen = false
      apply(v)
      send(id, { fullscreen: false })
    })
    return { id }
  }

  ipcMain.handle('ph:web:create', event => (allowed(event) ? create() : { error: 'not allowed' }))
  ipcMain.on('ph:web:destroy', (event, id) => {
    if (allowed(event))
      destroy(id)
  })
  // Where the page wants the view, in CSS pixels, or null to hide it.
  ipcMain.on('ph:web:layout', (event, id, rect) => {
    const v = views.get(id)
    if (!v || !allowed(event))
      return
    const ok = rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
    v.css = ok ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height, radius: Number.isFinite(rect.radius) ? Math.max(0, rect.radius) : 0 } : null
    apply(v)
  })
  ipcMain.on('ph:web:nav', (event, id, action, arg) => {
    const v = views.get(id)
    if (!v || !allowed(event) || v.wc.isDestroyed())
      return
    const h = v.wc.navigationHistory
    if (action === 'load') {
      const url = webUrl(arg)
      if (url)
        void v.wc.loadURL(url).catch(() => {})
    }
    else if (action === 'back' && h.canGoBack()) {
      h.goBack()
    }
    else if (action === 'forward' && h.canGoForward()) {
      h.goForward()
    }
    else if (action === 'reload') {
      v.wc.reload()
    }
    else if (action === 'stop') {
      v.wc.stop()
    }
    else if (action === 'zoom' && Number.isFinite(arg)) {
      v.wc.setZoomFactor(Math.max(0.25, Math.min(5, arg)))
    }
  })
  ipcMain.on('ph:web:panic', (event, on) => {
    if (allowed(event))
      setPanic(on)
  })

  // ── Listening to a page ─────────────────────────────────────────────────
  // The Music source can follow the beat of what a page plays. The window
  // asks for one view's sound, then calls getDisplayMedia, which comes here:
  // it gets that page's audio (and its picture, which it drops), nothing
  // else. No system audio, no screen, and only right after asking, so a
  // plugin calling getDisplayMedia on its own is turned away. The page keeps
  // playing out loud while it is listened to.
  let listenFor = null
  let listenReady = false
  function ensureListenHandler() {
    const w = win()
    if (!w || listenReady)
      return
    listenReady = true
    w.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
      const ask = listenFor
      listenFor = null
      const top = win()
      const v = ask && Date.now() < ask.until ? views.get(ask.id) : null
      if (!top || !v || v.wc.isDestroyed() || request.frame?.top !== top.webContents.mainFrame) {
        callback()
        return
      }
      callback({ video: v.wc.mainFrame, audio: v.wc.mainFrame })
    })
  }
  ipcMain.handle('ph:web:listen', (event, id) => {
    if (!allowed(event) || !views.has(id))
      return false
    ensureListenHandler()
    listenFor = { id, until: Date.now() + 5000 }
    return true
  })

  return {
    /** The page's zoom changed: the same CSS rects are other window pixels now. */
    relayout() {
      for (const v of views.values())
        apply(v)
    },
    /** The window's page is going away (a reload, a crash, the window closing): its views go too. */
    destroyAll,
  }
}
