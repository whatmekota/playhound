import { getCurrentScope, onScopeDispose, shallowReactive, watch } from 'vue'

/**
 * What of playhound's is over the page right now: dialogs, the command
 * palette, menus, toasts, floating windows.
 *
 * Plugins' web views (src/plugins/webview.ts) are native views the desktop
 * app draws on top of the whole page, so nothing in the DOM can cover them.
 * Each such layer says here that it is open, and where, and a web view it
 * would overlap hides until it closes. One place for all of them, so a
 * plugin never has to know which of playhound's layers exist.
 */

export interface Rect { x: number, y: number, width: number, height: number }

/** The whole window, or the box of an element (looked up whenever needed: popovers move). */
export type OccluderArea = 'full' | (() => Element | null | undefined)

/**
 * What a web view under a layer does: 'hide' until it closes (dialogs, menus,
 * toasts), or 'dodge', taking the biggest part of its box beside the layer
 * (a floating window that stays open while you browse, like the emulator).
 */
export type OccluderMode = 'hide' | 'dodge'

interface Layer { area: OccluderArea, mode: OccluderMode }

const open = shallowReactive(new Map<symbol, Layer>())

/** Say a layer is open; returns the call that says it closed. */
export function occlude(area: OccluderArea = 'full', mode: OccluderMode = 'hide'): () => void {
  const key = Symbol('occluder')
  open.set(key, { area, mode: area === 'full' ? 'hide' : mode })
  return () => void open.delete(key)
}

/**
 * In a component: the layer is open while `active()` is true. `area` is
 * 'full' for something that covers the window (a dialog's backdrop), else
 * the element that shows.
 */
export function useOccluder(active: () => boolean, area: OccluderArea = 'full', mode: OccluderMode = 'hide') {
  let close: (() => void) | null = null
  const stop = watch(active, (on) => {
    if (on && !close) {
      close = occlude(area, mode)
    }
    else if (!on && close) {
      close()
      close = null
    }
  }, { immediate: true, flush: 'sync' })
  if (getCurrentScope()) {
    onScopeDispose(() => {
      stop()
      close?.()
      close = null
    })
  }
}

/** How many layers are open; reactive, for watching. */
export function occluderCount(): number {
  return open.size
}

/** Some open layer is an element, which can move without saying so. */
export function occludersMove(): boolean {
  for (const l of open.values()) {
    if (l.area !== 'full')
      return true
  }
  return false
}

export function overlaps(a: Rect, b: Rect): boolean {
  return a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0
    && a.x < b.x + b.width && b.x < a.x + a.width
    && a.y < b.y + b.height && b.y < a.y + a.height
}

/** `r` cut to `bounds`; null when nothing is left. */
export function clipRect(r: Rect, bounds: Rect): Rect | null {
  const x0 = Math.max(r.x, bounds.x)
  const y0 = Math.max(r.y, bounds.y)
  const x1 = Math.min(r.x + r.width, bounds.x + bounds.width)
  const y1 = Math.min(r.y + r.height, bounds.y + bounds.height)
  return x1 - x0 >= 1 && y1 - y0 >= 1 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null
}

function boxOf(area: OccluderArea): Rect | null {
  if (area === 'full')
    return null
  const el = area()
  if (!el || !el.isConnected)
    return null
  const b = el.getBoundingClientRect()
  return { x: b.left, y: b.top, width: b.width, height: b.height }
}

/** Some open layer that hides what is under it is over `r` (page coordinates, CSS pixels). */
export function occluded(r: Rect): boolean {
  for (const l of open.values()) {
    if (l.mode !== 'hide')
      continue
    if (l.area === 'full')
      return true
    const b = boxOf(l.area)
    if (b && overlaps(r, b))
      return true
  }
  return false
}

/** Smaller than this, a page dodging a layer isn't worth showing: it hides instead. */
export const DODGE_MIN = { width: 320, height: 200 }

/**
 * The biggest part of `r` clear of `layer`: the strip left of it, right of
 * it, above or below, whichever has the most room. Null when none is at
 * least DODGE_MIN.
 */
export function dodgeRect(r: Rect, layer: Rect): Rect | null {
  if (!overlaps(r, layer))
    return r
  const right = r.x + r.width
  const bottom = r.y + r.height
  const strips: Rect[] = [
    { x: r.x, y: r.y, width: layer.x - r.x, height: r.height },
    { x: layer.x + layer.width, y: r.y, width: right - (layer.x + layer.width), height: r.height },
    { x: r.x, y: r.y, width: r.width, height: layer.y - r.y },
    { x: r.x, y: layer.y + layer.height, width: r.width, height: bottom - (layer.y + layer.height) },
  ]
  let best: Rect | null = null
  for (const s of strips) {
    if (s.width < DODGE_MIN.width || s.height < DODGE_MIN.height)
      continue
    if (!best || s.width * s.height > best.width * best.height)
      best = s
  }
  return best && { x: Math.round(best.x), y: Math.round(best.y), width: Math.round(best.width), height: Math.round(best.height) }
}

/** `r` moved clear of every open dodge layer over it, or null when too little is left. */
export function dodged(r: Rect): Rect | null {
  let out: Rect | null = r
  for (const l of open.values()) {
    if (l.mode !== 'dodge' || !out)
      continue
    const b = boxOf(l.area)
    if (b)
      out = dodgeRect(out, b)
  }
  return out
}
