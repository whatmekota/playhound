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
export function popupAction(details, from) {
  if (!webUrl(details?.url) || details.disposition === 'background-tab')
    return 'drop'
  let host
  try {
    host = new URL(details.url).hostname
  }
  catch {
    return 'drop'
  }
  if (isAdHost(host))
    return 'drop'
  // A pop-up to another site is how pop-unders work: a click anywhere opens
  // an ad, and following it would throw away the page being watched.
  if (from && !sameSite(host, from))
    return 'drop'
  return 'same-view'
}

// ── Ads ──────────────────────────────────────────────────────────────────────
// A small built-in blocker for the web views: the ad, pop-under and push
// networks that adult sites lean on, plus the big general ones. Requests to
// them are cancelled (ad boxes, their scripts, redirects through them) and
// common ad slots are hidden. Deliberately short: a list that blocks too much
// breaks the players this is for.

/** Ad networks, by domain; their subdomains go too. */
export const AD_DOMAINS = [
  // Adult ad and pop-under networks
  'exoclick.com',
  'exosrv.com',
  'exdynsrv.com',
  'realsrv.com',
  'magsrv.com',
  'pemsrv.com',
  'twinrdsrv.com',
  'twinrdsyn.com',
  'trafficjunky.com',
  'trafficjunky.net',
  'juicyads.com',
  'tsyndicate.com',
  'trafficstars.com',
  'ero-advertising.com',
  'plugrush.com',
  'adxpansion.com',
  'crakrevenue.com',
  'trafficfactory.biz',
  'adspyglass.com',
  'clickaine.com',
  'hilltopads.net',
  'hilltopads.com',
  'clickadu.com',
  'adsterra.com',
  'adsterratools.com',
  'a-ads.com',
  'popads.net',
  'popcash.net',
  'propellerads.com',
  'propellerclick.com',
  'onclickads.net',
  'onclkds.com',
  'adcash.com',
  'admaven.com',
  'ad-maven.com',
  'bidgear.com',
  'adskeeper.com',
  'mgid.com',
  'revcontent.com',
  'richpush.co',
  'pushame.com',
  'evadav.com',
  'galaksion.com',
  'rollerads.com',
  'monetag.com',
  'adnium.com',
  'tubecorporate.com',
  'dtscout.com',
  // General ad and tracking networks
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'adservice.google.com',
  'adnxs.com',
  'taboola.com',
  'outbrain.com',
  'criteo.com',
  'criteo.net',
  'amazon-adsystem.com',
  'adsrvr.org',
  'pubmatic.com',
  'rubiconproject.com',
  'openx.net',
  'smartadserver.com',
  'yieldmo.com',
  'zedo.com',
]
const AD_SET = new Set(AD_DOMAINS)

/** The host is an ad network's, or under one. */
export function isAdHost(host) {
  const parts = String(host).toLowerCase().replace(/\.$/, '').split('.')
  for (let i = 0; i < parts.length - 1; i++) {
    if (AD_SET.has(parts.slice(i).join('.')))
      return true
  }
  return false
}

/** The part of a host that names the site: example.com for www.example.com, example.co.uk for a.example.co.uk. */
export function siteOf(host) {
  const parts = String(host).toLowerCase().replace(/\.$/, '').split('.')
  if (parts.length <= 2)
    return parts.join('.')
  const second = parts.at(-2)
  const take = parts.at(-1).length === 2 && ['co', 'com', 'net', 'org', 'ac', 'gov', 'ne', 'or'].includes(second) ? 3 : 2
  return parts.slice(-take).join('.')
}

/** Two hosts (or a host and a page URL) belong to the same site. */
export function sameSite(host, other) {
  let h = String(other)
  try {
    h = new URL(h).hostname
  }
  catch {}
  return siteOf(host) === siteOf(h)
}

/** Common ad slots, hidden on every page. Kept to names that are ads and nothing else. */
export const AD_CSS = `
ins.adsbygoogle, div[id^="div-gpt-ad"], div[id^="google_ads_"], iframe[id^="google_ads_iframe"],
iframe[src*="exoclick"], iframe[src*="exosrv"], iframe[src*="juicyads"], iframe[src*="trafficjunky"],
iframe[src*="tsyndicate"], iframe[src*="magsrv"], iframe[src*="realsrv"], iframe[src*="adsterra"],
[id^="exo_"], [class*="exo-native"], [class*="exo_wrapper"], [data-ad-slot], [data-adzone], [data-ad-unit],
.adsbox, .ad-banner, .ad-container, .ad-wrapper, .ad-slot, .ad-placeholder, .banner-ad, .sponsored-ad,
.adblock-overlay, #ad-container, #ad-banner, #adContainer, #adBanner
{ display: none !important; }
`

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
