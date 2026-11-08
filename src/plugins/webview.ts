import type { WebViewHandle, WebViewOptions, WebViewState } from './types'
import type { Rect } from '~/lib/occluders'
import { effectScope, ref, watch } from 'vue'
import { desktop } from '~/lib/browserApi'
import { clipRect, occluded, occluderCount, occludersMove, useOccluder } from '~/lib/occluders'
import { useSafetyStore } from '~/stores/safetyStore'
import { useUiStore } from '~/stores/uiStore'

/**
 * Plugins' web views, on this side: where each one goes and when it hides.
 *
 * The desktop app draws a web view as a native layer over the whole page
 * (desktop/webview.mjs), so this keeps it glued to the element the plugin
 * attached it to, and hides it when that element isn't showing (its page left
 * the stage, the plugin was switched off), when any of playhound's own layers
 * would be under it (src/lib/occluders.ts), and always on panic.
 *
 * Measuring is event-driven: a resize, a scroll, a transition starting, a
 * layer opening or closing starts a short run of measuring every frame,
 * which goes on until nothing has moved for a while (or as long as a layer
 * that can move, a menu or a floating window, is open).
 */

/** Views open at once, across plugins (the desktop app holds to the same number). */
export const MAX_WEBVIEWS = 4

/** Frames with nothing moving before measuring stops. */
const SETTLE_FRAMES = 20

/** The URL as a string if it is a web page (http or https), else null. */
export function webUrl(u: unknown): string | null {
  try {
    const url = new URL(String(u))
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  }
  catch {
    return null
  }
}

/** Where a view goes, in CSS pixels, or null to hide it. */
export type Placement = (Rect & { radius: number }) | null

/**
 * Where a view attached to an element with this box goes: the box cut to
 * the window, or null when it isn't to be seen (panic, not showing, covered).
 */
export function placementFor(o: { box: Rect | null, viewport: Rect, panicked: boolean, covered: (r: Rect) => boolean, radius?: number }): Placement {
  if (o.panicked || !o.box)
    return null
  const r = clipRect(o.box, o.viewport)
  if (!r || o.covered(r))
    return null
  return { ...r, radius: o.radius ?? 0 }
}

function samePlacement(a: Placement, b: Placement) {
  return a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height && a.radius === b.radius)
}

interface Entry {
  /** The desktop app's id, once it has made the view. */
  id: number | null
  el: HTMLElement | null
  ro: ResizeObserver | null
  state: WebViewState
  listeners: Set<(s: WebViewState) => void>
  /** Calls made before the view existed, run once it does. */
  queue: ((id: number) => void)[]
  /** What was last sent: undefined before anything was. */
  sent: Placement | undefined
  destroyed: boolean
  owner: string
}

const entries = new Set<Entry>()

/**
 * A plugin's page is placed somewhere in the window (shown, or only hidden for
 * a moment by something over it). Reactive: the toasts move out of its way.
 */
export const webviewPlaced = ref(false)

/**
 * The view whose page is making sound, if any: the Music source listens to
 * it when no video is playing (src/composables/useVideoBeat.ts). The one that
 * started last wins. Reactive.
 */
export const audiblePage = ref<number | null>(null)
let audibleOrder: number[] = []

function updateAudible(e: Entry) {
  if (e.id === null)
    return
  audibleOrder = audibleOrder.filter(id => id !== e.id)
  if (e.state.audible && !e.destroyed)
    audibleOrder.push(e.id)
  const next = audibleOrder.at(-1) ?? null
  if (audiblePage.value !== next)
    audiblePage.value = next
}

/** The element a view is glued to is in the page and visible. */
function hasBox(e: Entry): boolean {
  const el = e.el
  if (e.destroyed || !el || !el.isConnected || (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })))
    return false
  const b = el.getBoundingClientRect()
  return b.width > 0 && b.height > 0
}

function updatePlaced() {
  let any = false
  for (const e of entries) {
    if (hasBox(e)) {
      any = true
      break
    }
  }
  if (webviewPlaced.value !== any)
    webviewPlaced.value = any
}
const byId = new Map<number, Entry>()

function blank(): WebViewState {
  return {
    url: '',
    title: '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    error: null,
    media: false,
    audible: false,
    fullscreen: false,
    focused: false,
    shown: false,
  }
}

let started = false
let raf = 0
let still = 0

function emit(e: Entry) {
  const s = { ...e.state }
  for (const fn of e.listeners) {
    try {
      fn(s)
    }
    catch (err) {
      console.error(`[plugin ${e.owner}] webview onState failed`, err)
    }
  }
}

function patch(e: Entry, p: Partial<WebViewState>) {
  let changed = false
  for (const [k, v] of Object.entries(p) as [keyof WebViewState, unknown][]) {
    if (!(k in e.state) || JSON.stringify(e.state[k]) === JSON.stringify(v)) {
      continue
    }(e.state as any)[k] = v
    changed = true
  }
  if (changed)
    emit(e)
  if ('audible' in p)
    updateAudible(e)
}

/** Where this entry's view goes right now. */
function measure(e: Entry, panicked: boolean): Placement {
  const el = e.el
  let box: Rect | null = null
  let radius = 0
  if (el && hasBox(e)) {
    const b = el.getBoundingClientRect()
    box = { x: b.left, y: b.top, width: b.width, height: b.height }
    radius = Number.parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0
  }
  return placementFor({
    box,
    viewport: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
    panicked,
    covered: occluded,
    radius,
  })
}

/** Measure every view and tell the desktop app about those that moved; true if any did. */
function layoutAll(): boolean {
  const web = desktop?.web
  if (!web)
    return false
  const panicked = useSafetyStore().panicked
  let moved = false
  for (const e of entries) {
    if (e.id === null || e.destroyed)
      continue
    const p = measure(e, panicked)
    if (e.sent !== undefined && samePlacement(p, e.sent))
      continue
    e.sent = p
    moved = true
    web.layout(e.id, p)
    patch(e, { shown: !!p })
  }
  updatePlaced()
  return moved
}

function frame() {
  raf = 0
  if (!entries.size)
    return
  still = layoutAll() ? 0 : still + 1
  if (still < SETTLE_FRAMES || occludersMove())
    raf = requestAnimationFrame(frame)
}

/** Something may have moved: measure every frame until it settles. */
function schedule() {
  still = 0
  if (!raf && entries.size)
    raf = requestAnimationFrame(frame)
}

function start() {
  if (started || !desktop?.web)
    return
  started = true
  // Its own scope: the first view is usually made while a plugin's page
  // mounts, and these watchers must not stop when that page goes.
  effectScope(true).run(() => listen(desktop!.web!))
}

function listen(web: NonNullable<typeof desktop>['web'] & object) {
  const safety = useSafetyStore()

  web.onState((id, p) => {
    const e = byId.get(id)
    if (e)
      patch(e, p as Partial<WebViewState>)
  })

  // A key of the app's pressed in a page: as if pressed in the app. The
  // desktop app has already hidden the views for a panic key, and handed the
  // keyboard back.
  web.onKey((key) => {
    const init: KeyboardEventInit = { key: key === 'Backquote' ? '`' : key === 'KeyK' ? 'k' : 'Escape', code: key, bubbles: true, cancelable: true }
    if (key === 'KeyK') {
      init.ctrlKey = desktop?.platform !== 'darwin'
      init.metaKey = desktop?.platform === 'darwin'
    }
    document.body.dispatchEvent(new KeyboardEvent('keydown', init))
    // It didn't panic after all (it never should, but then the views must come back).
    if (key !== 'KeyK' && !safety.panicked)
      web.panic(false)
  })
  // Clicking and typing in a page is the user being there, for the idle stop.
  web.onActivity(() => window.dispatchEvent(new Event('ph:webview-activity')))

  // Panic first, in the same tick, before anything else gets to run.
  watch(() => safety.panicked, (on) => {
    web.panic(on)
    if (on)
      layoutAll()
    schedule()
  }, { flush: 'sync' })
  // The shell's own layers that are flags in the ui store rather than
  // components of their own: the command palette, and the "drop to play"
  // cover (a file dragged over a page would otherwise land in the page).
  const ui = useUiStore()
  useOccluder(() => ui.paletteOpen)
  useOccluder(() => ui.dragging)
  watch(occluderCount, () => {
    layoutAll()
    schedule()
  }, { flush: 'post' })

  window.addEventListener('resize', schedule)
  document.addEventListener('scroll', schedule, { capture: true, passive: true })
  document.addEventListener('transitionrun', schedule, true)
  document.addEventListener('animationstart', schedule, true)
}

/** The keyboard is in one of the pages: focus that left the app went there. */
export function webviewFocused(): boolean {
  for (const e of entries) {
    if (e.state.focused)
      return true
  }
  return false
}

/** Make a web view for a plugin (`owner`, its id); see WebViewHandle in types.ts. */
export function createWebview(owner: string, opts: WebViewOptions = {}): WebViewHandle {
  const web = desktop?.web
  if (!web)
    throw new Error('Web pages need the playhound desktop app')
  if ([...entries].filter(e => !e.destroyed).length >= MAX_WEBVIEWS)
    throw new Error(`Only ${MAX_WEBVIEWS} web views can be open at once`)
  if (opts.url !== undefined && !webUrl(opts.url))
    throw new TypeError(`webview: "${String(opts.url)}" isn't a web address (http or https)`)
  start()

  const e: Entry = { id: null, el: null, ro: null, state: blank(), listeners: new Set(), queue: [], sent: undefined, destroyed: false, owner }
  entries.add(e)

  const run = (fn: (id: number) => void) => {
    if (e.destroyed)
      return
    if (e.id === null)
      e.queue.push(fn)
    else
      fn(e.id)
  }

  void web.create().then((res) => {
    if (res.error !== undefined) {
      patch(e, { error: { code: -1, description: res.error, url: '' } })
      entries.delete(e)
      updatePlaced()
      updatePlaced()
      e.destroyed = true
      return
    }
    if (e.destroyed) {
      web.destroy(res.id)
      return
    }
    e.id = res.id
    byId.set(res.id, e)
    for (const fn of e.queue.splice(0))
      fn(res.id)
    layoutAll()
    schedule()
  })

  if (opts.zoom !== undefined)
    run(id => web.nav(id, 'zoom', opts.zoom))
  if (opts.url !== undefined)
    run(id => web.nav(id, 'load', webUrl(opts.url)!))

  function detach() {
    e.ro?.disconnect()
    e.ro = null
    e.el = null
  }

  function destroy() {
    if (e.destroyed)
      return
    detach()
    e.destroyed = true
    entries.delete(e)
    updatePlaced()
    updateAudible(e)
    if (e.id !== null) {
      byId.delete(e.id)
      web!.destroy(e.id)
    }
    e.listeners.clear()
  }

  const live = (name: string) => {
    if (e.destroyed)
      throw new Error(`webview.${name}: this view was destroyed`)
  }

  return Object.freeze({
    attach(el: HTMLElement | null) {
      live('attach')
      if (el !== null && !(el instanceof HTMLElement))
        throw new TypeError('webview.attach takes an element (or null)')
      detach()
      e.el = el
      if (el) {
        e.ro = new ResizeObserver(schedule)
        e.ro.observe(el)
      }
      layoutAll()
      schedule()
    },
    navigate(url: string) {
      live('navigate')
      const href = webUrl(url)
      if (!href)
        throw new TypeError(`webview.navigate: "${String(url)}" isn't a web address (http or https)`)
      run(id => web.nav(id, 'load', href))
    },
    back: () => run(id => web.nav(id, 'back')),
    forward: () => run(id => web.nav(id, 'forward')),
    reload: () => run(id => web.nav(id, 'reload')),
    stop: () => run(id => web.nav(id, 'stop')),
    setZoom(factor: number) {
      if (typeof factor === 'number' && Number.isFinite(factor))
        run(id => web.nav(id, 'zoom', factor))
    },
    state: () => ({ ...e.state }),
    onState(fn: (s: WebViewState) => void) {
      if (typeof fn !== 'function')
        throw new TypeError('webview.onState takes a function')
      e.listeners.add(fn)
      return () => void e.listeners.delete(fn)
    },
    destroy,
    get destroyed() {
      return e.destroyed
    },
  })
}
