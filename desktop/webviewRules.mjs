// The rules desktop/webview.mjs applies to plugins' web views, kept free of
// Electron so they can be tested on their own.

/** Where the pages keep their cookies and logins: on disk, apart from the app's own session. */
export const BROWSING_PARTITION = 'persist:browsing'

/** Web views open at once, across all plugins. Each is a whole renderer process. */
export const MAX_VIEWS = 4

/** The URL as a string if it is a web page (http or https), else null. */
export function webUrl(u) {
  try {
    const url = new URL(String(u))
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  }
  catch {
    return null
  }
}

/**
 * A rect the page measured, in CSS pixels, as window pixels for setBounds:
 * scaled by the page's zoom (Settings → Interface size) and kept inside the
 * window. Edges are rounded rather than the size, so two views side by side
 * don't leave a gap or overlap. Null when nothing of it is left to show.
 *
 * @param {{ x: number, y: number, width: number, height: number }} rect
 * @param {number} zoom
 * @param {{ width: number, height: number }} [limit]  the window's content size
 */
export function scaleRect(rect, zoom, limit) {
  if (!rect || ![rect.x, rect.y, rect.width, rect.height, zoom].every(Number.isFinite) || zoom <= 0)
    return null
  let x0 = Math.round(rect.x * zoom)
  let y0 = Math.round(rect.y * zoom)
  let x1 = Math.round((rect.x + rect.width) * zoom)
  let y1 = Math.round((rect.y + rect.height) * zoom)
  x0 = Math.max(0, x0)
  y0 = Math.max(0, y0)
  if (limit) {
    x1 = Math.min(limit.width, x1)
    y1 = Math.min(limit.height, y1)
  }
  if (x1 - x0 < 1 || y1 - y0 < 1)
    return null
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

/**
 * What a page in a web view may have without asking anyone: going full
 * screen (video players) and writing to the clipboard (copy buttons).
 * Everything else (camera, microphone, location, notifications, MIDI, USB,
 * opening other apps…) is refused: nobody is there to ask, since the page
 * belongs to a plugin, and playhound has no business granting it.
 */
const ALLOWED_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write'])

export function permissionAllowed(permission) {
  return ALLOWED_PERMISSIONS.has(permission)
}

/**
 * A page asked for a new window or tab (a target=_blank link, window.open).
 * There are no tabs and no other windows: a web page opens in the same view.
 * Nothing goes to the system browser either, unlike links from playhound's
 * own pages, because a site's popups and the pages it links to are no
 * business of the user's default browser (and its history). Background tabs
 * are dropped: that is how pop-under ads open.
 *
 * @param {{ url: string, disposition?: string }} details
 * @returns {'same-view' | 'drop'} what to do with it
 */
export function popupAction(details) {
  if (!webUrl(details?.url))
    return 'drop'
  return details.disposition === 'background-tab' ? 'drop' : 'same-view'
}

/**
 * Keys pressed inside a web page that belong to playhound: panic (Esc and `,
 * as in the app) and the command palette (Ctrl or ⌘ K). Without this, a
 * click into the page would leave panic out of reach of the keyboard.
 *
 * @param {{ type: string, key?: string, code?: string, control?: boolean, meta?: boolean, alt?: boolean, shift?: boolean, isAutoRepeat?: boolean }} input
 * @returns {'Escape' | 'Backquote' | 'KeyK' | null} the key, if it is one of these
 */
export function forwardedKey(input) {
  if (!input || input.type !== 'keyDown' || input.isAutoRepeat)
    return null
  const mods = !!(input.control || input.meta || input.alt)
  if (input.code === 'Escape' && !mods)
    return 'Escape'
  if (input.code === 'Backquote' && !mods && !input.shift)
    return 'Backquote'
  if (input.code === 'KeyK' && (input.control || input.meta) && !input.alt && !input.shift)
    return 'KeyK'
  return null
}

/** Electron's user agent without the parts that say "Electron" and "playhound": sites see plain Chrome. */
export function plainUserAgent(ua) {
  return String(ua).replace(/\s(?:Electron|playhound)\/\S+/gi, '')
}
