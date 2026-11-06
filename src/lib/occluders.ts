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

const open = shallowReactive(new Map<symbol, OccluderArea>())

/** Say a layer is open; returns the call that says it closed. */
export function occlude(area: OccluderArea = 'full'): () => void {
  const key = Symbol('occluder')
  open.set(key, area)
  return () => void open.delete(key)
}

/**
 * In a component: the layer is open while `active()` is true. `area` is
 * 'full' for something that covers the window (a dialog's backdrop), else
 * the element that shows.
 */
export function useOccluder(active: () => boolean, area: OccluderArea = 'full') {
  let close: (() => void) | null = null
  const stop = watch(active, (on) => {
    if (on && !close) {
      close = occlude(area)
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
  for (const a of open.values()) {
    if (a !== 'full')
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

/** Some open layer is over `r` (page coordinates, CSS pixels). */
export function occluded(r: Rect): boolean {
  for (const a of open.values()) {
    if (a === 'full')
      return true
    const el = a()
    if (!el || !el.isConnected)
      continue
    const b = el.getBoundingClientRect()
    if (overlaps(r, { x: b.left, y: b.top, width: b.width, height: b.height }))
      return true
  }
  return false
}
