import { version as packageVersion } from '../../package.json'

/**
 * What the plugin store shows about a plugin beyond its name and version:
 * an icon, screenshots, a longer description, a category, keywords, a
 * homepage and the oldest playhound it runs on. All of it is optional and
 * read from manifest.json; a plugin without any of it still installs and
 * shows, with a generated icon.
 *
 * Images come only from the plugin's own release assets or its zip, named in
 * the manifest: the store never loads a picture from an address a manifest
 * hands it. They're checked here (type, size, dimensions) before they show.
 */

/** This playhound's version. */
export const APP_VERSION: string = packageVersion

export const CATEGORIES = [
  { id: 'partner', label: 'Partner', icon: 'i-carbon-chat-bot' },
  { id: 'sync', label: 'Sync', icon: 'i-carbon-connect' },
  { id: 'library', label: 'Library', icon: 'i-carbon-catalog' },
  { id: 'visuals', label: 'Visuals', icon: 'i-carbon-image' },
  { id: 'devices', label: 'Devices', icon: 'i-carbon-plug' },
  { id: 'tools', label: 'Tools', icon: 'i-carbon-tool-box' },
] as const

export type PluginCategory = typeof CATEGORIES[number]['id']

export const categoryOf = (id: string | undefined) => CATEGORIES.find(c => c.id === id) ?? null

export interface Screenshot {
  /** File name: a release asset, or a file in the zip. */
  file: string
  caption?: string
}

/** The store's fields of a manifest, as read by readStoreFields. */
export interface StoreFields {
  icon?: string
  longDescription?: string
  screenshots?: Screenshot[]
  homepage?: string
  category?: PluginCategory
  keywords?: string[]
  minPlayhound?: string
}

export const LIMITS = {
  descriptionChars: 160,
  longDescriptionChars: 10_000,
  keywords: 10,
  keywordChars: 32,
  screenshots: 6,
  captionChars: 120,
  icon: { pngBytes: 256 * 1024, svgBytes: 64 * 1024, minPx: 64, maxPx: 1024 },
  screenshot: { bytes: 3 * 1024 * 1024, minPx: 320, maxPx: 3840 },
} as const

const ICON_RE = /\.(?:png|svg)$/i
const SHOT_RE = /\.(?:png|jpe?g|webp)$/i
const VERSION_RE = /^v?\d+(?:\.\d+){0,2}$/

/** A file name with nothing that walks out of the release or zip. */
function fileName(v: unknown): string | null {
  if (typeof v !== 'string')
    return null
  const s = v.trim().replace(/^\.?\//, '')
  if (!s || s.includes('..') || s.includes('\\') || /^[a-z][\w+.-]*:/i.test(s))
    return null
  return s
}

function isHttps(v: unknown): v is string {
  if (typeof v !== 'string' || /\s/.test(v.trim()))
    return false
  try {
    const u = new URL(v.trim())
    return u.protocol === 'https:' && u.hostname.includes('.')
  }
  catch {
    return false
  }
}

/**
 * The store fields of a parsed manifest.json. Never throws: a field that is
 * wrong is left out, and `problems` says why, for the plugin's author (dev
 * mode shows them). A plugin installs whatever is wrong here.
 */
export function readStoreFields(m: Record<string, unknown>): { fields: StoreFields, problems: string[] } {
  const fields: StoreFields = {}
  const problems: string[] = []

  if (m.icon !== undefined) {
    const f = fileName(m.icon)
    if (f && ICON_RE.test(f))
      fields.icon = f
    else problems.push('"icon" must be the name of a .png or .svg file')
  }

  if (m.longDescription !== undefined) {
    if (typeof m.longDescription === 'string' && m.longDescription.trim())
      fields.longDescription = m.longDescription.trim().slice(0, LIMITS.longDescriptionChars)
    else problems.push('"longDescription" must be text (Markdown)')
    if (typeof m.longDescription === 'string' && m.longDescription.length > LIMITS.longDescriptionChars)
      problems.push(`"longDescription" is cut at ${LIMITS.longDescriptionChars} characters`)
  }

  if (m.screenshots !== undefined) {
    if (!Array.isArray(m.screenshots)) {
      problems.push('"screenshots" must be a list of file names')
    }
    else {
      const out: Screenshot[] = []
      for (const s of m.screenshots) {
        const raw = s && typeof s === 'object' ? (s as Record<string, unknown>).file : s
        const f = fileName(raw)
        if (!f || !SHOT_RE.test(f)) {
          problems.push(`screenshot ${JSON.stringify(raw)} must be a .png, .jpg or .webp file name`)
          continue
        }
        const caption = s && typeof s === 'object' && typeof (s as Record<string, unknown>).caption === 'string'
          ? ((s as Record<string, unknown>).caption as string).trim().slice(0, LIMITS.captionChars)
          : undefined
        out.push(caption ? { file: f, caption } : { file: f })
      }
      if (out.length > LIMITS.screenshots)
        problems.push(`only the first ${LIMITS.screenshots} screenshots are shown`)
      if (out.length)
        fields.screenshots = out.slice(0, LIMITS.screenshots)
    }
  }

  if (m.homepage !== undefined) {
    if (isHttps(m.homepage))
      fields.homepage = m.homepage.trim()
    else problems.push('"homepage" must be an https:// address')
  }

  if (m.category !== undefined) {
    const c = typeof m.category === 'string' ? categoryOf(m.category.trim().toLowerCase()) : null
    if (c)
      fields.category = c.id
    else problems.push(`"category" must be one of ${CATEGORIES.map(c => c.id).join(', ')}`)
  }

  if (m.keywords !== undefined) {
    if (!Array.isArray(m.keywords)) {
      problems.push('"keywords" must be a list of words')
    }
    else {
      const words = [...new Set(m.keywords
        .filter((k): k is string => typeof k === 'string')
        .map(k => k.trim().toLowerCase())
        .filter(k => k && k.length <= LIMITS.keywordChars))]
      if (words.length !== m.keywords.length)
        problems.push(`"keywords" are words of up to ${LIMITS.keywordChars} characters, each once`)
      if (words.length > LIMITS.keywords)
        problems.push(`only the first ${LIMITS.keywords} keywords count`)
      if (words.length)
        fields.keywords = words.slice(0, LIMITS.keywords)
    }
  }

  if (m.minPlayhound !== undefined) {
    if (typeof m.minPlayhound === 'string' && VERSION_RE.test(m.minPlayhound.trim()))
      fields.minPlayhound = m.minPlayhound.trim().replace(/^v/, '')
    else problems.push('"minPlayhound" must be a version, like "2.2.0"')
  }

  if (typeof m.description === 'string' && m.description.length > LIMITS.descriptionChars)
    problems.push(`"description" is one line; the store cuts it after about ${LIMITS.descriptionChars} characters. Put the rest in "longDescription"`)

  return { fields, problems }
}

// ─── Versions ────────────────────────────────────────────────────────────────

/** 1.10.0 > 1.9.2; a pre-release sorts below its release. Same rules as the app's own updater. */
export function newer(a: string, b: string): boolean {
  const parse = (v: string) => String(v).replace(/^v/, '').split('-')
  const [ma, pa] = parse(a)
  const [mb, pb] = parse(b)
  const xa = ma.split('.').map(Number)
  const xb = mb.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((xa[i] || 0) !== (xb[i] || 0))
      return (xa[i] || 0) > (xb[i] || 0)
  }
  return !pa && !!pb
}

/**
 * playhound `app` is new enough for a plugin that needs `min`. A beta of a
 * version counts as that version (2.2.0-beta.1 runs plugins made for 2.2.0:
 * the betas are how they get tested before the release).
 */
export function meetsMin(min: string, app: string = APP_VERSION): boolean {
  return !newer(String(min).replace(/^v/, '').split('-')[0], String(app).replace(/^v/, '').split('-')[0])
}

/** "2.2.0" → "2.2", "2.2.1" stays: how a version reads in a sentence. */
export const shortVersion = (v: string) => v.replace(/^v/, '').replace(/(\.0)+$/, '').replace(/^(\d+)$/, '$1.0')

/**
 * Why this playhound can't run a plugin, or null if it can: a newer plugin
 * API than it speaks, or a newer playhound than it is.
 */
export function incompatibility(m: { api?: number, minPlayhound?: string }, api: number, app: string = APP_VERSION): string | null {
  if (m.minPlayhound && !meetsMin(m.minPlayhound, app))
    return `Needs playhound ${shortVersion(m.minPlayhound)} or newer`
  if ((m.api ?? 1) > api)
    return `Needs a newer playhound (plugin API ${m.api})`
  return null
}

// ─── Images ──────────────────────────────────────────────────────────────────

export type ImageType = 'png' | 'jpeg' | 'webp' | 'svg'
export const IMAGE_MIME: Record<ImageType, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml' }

/** What an image file is, from its first bytes; width and height where the format says (not SVG). */
export function imageInfo(b: Uint8Array): { type: ImageType, width: number | null, height: number | null } | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const at = (i: number, ...sig: number[]) => sig.every((x, k) => b[i + k] === x)
  if (b.length >= 24 && at(0, 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A))
    return { type: 'png', width: v.getUint32(16), height: v.getUint32(20) }
  if (b.length >= 4 && at(0, 0xFF, 0xD8)) {
    let p = 2
    while (p + 9 < b.length) {
      if (b[p] !== 0xFF) {
        p++
        continue
      }
      const marker = b[p + 1]
      // SOF0-15, except DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC)
        return { type: 'jpeg', width: v.getUint16(p + 7), height: v.getUint16(p + 5) }
      if (marker === 0xFF) {
        p++
        continue
      }
      if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) {
        p += 2
        continue
      }
      p += 2 + v.getUint16(p + 2)
    }
    return { type: 'jpeg', width: null, height: null }
  }
  if (b.length >= 30 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) {
    const chunk = String.fromCharCode(b[12], b[13], b[14], b[15])
    if (chunk === 'VP8 ')
      return { type: 'webp', width: v.getUint16(26, true) & 0x3FFF, height: v.getUint16(28, true) & 0x3FFF }
    if (chunk === 'VP8L') {
      const bits = v.getUint32(21, true)
      return { type: 'webp', width: (bits & 0x3FFF) + 1, height: ((bits >> 14) & 0x3FFF) + 1 }
    }
    if (chunk === 'VP8X') {
      const u24 = (i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)
      return { type: 'webp', width: u24(24) + 1, height: u24(27) + 1 }
    }
    return { type: 'webp', width: null, height: null }
  }
  // TextDecoder drops a byte-order mark.
  const head = new TextDecoder().decode(b.subarray(0, 1024)).trimStart()
  if (/^<(?:\?xml|svg|!--)/i.test(head) && /<svg[\s>]/i.test(new TextDecoder().decode(b.subarray(0, 8192))))
    return { type: 'svg', width: null, height: null }
  return null
}

function kb(n: number): string {
  return `${Math.round(n / 1024)} KB`
}

/** Whether a file makes a good icon or screenshot; the image type if so, why not otherwise. */
export function checkImage(b: Uint8Array, role: 'icon' | 'screenshot'): { ok: true, type: ImageType } | { ok: false, problem: string } {
  const info = imageInfo(b)
  if (role === 'icon') {
    const L = LIMITS.icon
    if (!info || (info.type !== 'png' && info.type !== 'svg'))
      return { ok: false, problem: 'the icon must be a PNG or SVG' }
    if (info.type === 'svg')
      return b.length > L.svgBytes ? { ok: false, problem: `an SVG icon must be under ${kb(L.svgBytes)}` } : { ok: true, type: 'svg' }
    if (b.length > L.pngBytes)
      return { ok: false, problem: `a PNG icon must be under ${kb(L.pngBytes)}` }
    if (info.width !== info.height)
      return { ok: false, problem: `the icon must be square (it is ${info.width}×${info.height})` }
    if (info.width! < L.minPx || info.width! > L.maxPx)
      return { ok: false, problem: `the icon must be ${L.minPx} to ${L.maxPx} px (256 is best)` }
    return { ok: true, type: 'png' }
  }
  const L = LIMITS.screenshot
  if (!info || info.type === 'svg')
    return { ok: false, problem: 'a screenshot must be a PNG, JPEG or WebP' }
  if (b.length > L.bytes)
    return { ok: false, problem: `a screenshot must be under ${L.bytes / 1024 / 1024} MB` }
  if (info.width === null || info.height === null)
    return { ok: false, problem: 'couldn\'t read the screenshot\'s size' }
  if (Math.min(info.width, info.height) < L.minPx || Math.max(info.width, info.height) > L.maxPx)
    return { ok: false, problem: `a screenshot must be ${L.minPx} to ${L.maxPx} px a side` }
  return { ok: true, type: info.type }
}

// ─── Release assets ──────────────────────────────────────────────────────────

/** An image attached to a release. */
export interface ImageAsset {
  name: string
  url: string
  size: number
}

export const isImageAsset = (name: string) => ICON_RE.test(name) || SHOT_RE.test(name)

function byName(assets: ImageAsset[], name: string): ImageAsset | null {
  const base = name.split('/').pop()!.toLowerCase()
  return assets.find(a => a.name.toLowerCase() === base) ?? null
}

/**
 * The release assets the store shows for a plugin: its icon (the one the
 * manifest names, else icon.png / icon.svg) and its screenshots (the ones
 * the manifest names, else screenshot*.png / .jpg / .webp in name order).
 * Ones too big to be accepted are left out before anything is downloaded.
 */
export function storeImages(m: Pick<StoreFields, 'icon' | 'screenshots'> | null, assets: ImageAsset[]): { icon: ImageAsset | null, screenshots: { asset: ImageAsset, caption?: string }[] } {
  const fits = (a: ImageAsset | null, max: number) => (a && a.size <= max ? a : null)
  const iconAsset = m?.icon ? byName(assets, m.icon) : (byName(assets, 'icon.svg') ?? byName(assets, 'icon.png'))
  const iconMax = iconAsset && /\.svg$/i.test(iconAsset.name) ? LIMITS.icon.svgBytes : LIMITS.icon.pngBytes
  const icon = fits(iconAsset, iconMax)

  const named = m?.screenshots
    ? m.screenshots.map(s => ({ asset: byName(assets, s.file), caption: s.caption }))
    : assets
        .filter(a => /^screenshot/i.test(a.name) && SHOT_RE.test(a.name))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
        .map(asset => ({ asset, caption: undefined }))
  const screenshots = named
    .filter((s): s is { asset: ImageAsset, caption: string | undefined } => !!fits(s.asset, LIMITS.screenshot.bytes))
    .slice(0, LIMITS.screenshots)
    .map(s => (s.caption ? { asset: s.asset, caption: s.caption } : { asset: s.asset }))
  return { icon, screenshots }
}

// ─── Generated icon ──────────────────────────────────────────────────────────

/** The letters and colour of a plugin's generated icon: one or two letters of its name, a hue from its id. */
export function monogram(id: string, name: string): { letters: string, hue: number } {
  const words = name.trim().split(/[\s_\-.]+/).filter(Boolean)
  const first = (w: string) => Array.from(w.replace(/^[^\p{L}\p{N}]+/u, ''))[0] ?? ''
  let letters = words.length >= 2 ? first(words[0]) + first(words[1]) : first(words[0] ?? id)
  if (!letters)
    letters = first(id) || '?'
  // FNV-1a
  let h = 0x811C9DC5
  for (const ch of id) {
    h ^= ch.codePointAt(0)!
    h = Math.imul(h, 0x01000193)
  }
  return { letters: letters.toUpperCase(), hue: (h >>> 0) % 360 }
}

// ─── Search ──────────────────────────────────────────────────────────────────

export interface Searchable {
  name: string
  repo?: string | null
  description?: string
  author?: string
  category?: string
  keywords?: string[]
}

/** Every word of the query appears somewhere in the plugin's name, description, author, repository, category or keywords. */
export function matchesQuery(p: Searchable, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length)
    return true
  const hay = [p.name, p.repo, p.description, p.author, p.category, ...(p.keywords ?? [])].filter(Boolean).join(' ').toLowerCase()
  return words.every(w => hay.includes(w))
}

/** "3 days ago" and so on, for "updated" lines. */
export function ago(iso: string | number, now = Date.now()): string {
  const t = typeof iso === 'number' ? iso : Date.parse(iso)
  if (!Number.isFinite(t))
    return ''
  const s = Math.max(0, (now - t) / 1000)
  if (s < 3600)
    return s < 120 ? 'just now' : `${Math.floor(s / 60)} min ago`
  if (s < 86400)
    return `${Math.floor(s / 3600)} h ago`
  const d = Math.floor(s / 86400)
  if (d === 1)
    return 'yesterday'
  if (d < 30)
    return `${d} days ago`
  if (d < 365)
    return `${Math.floor(d / 30)} mo ago`
  return `${Math.floor(d / 365)} y ago`
}

/** 1234 → "1.2k". */
export function count(n: number): string {
  if (n < 1000)
    return String(n)
  if (n < 10_000)
    return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return n < 1_000_000 ? `${Math.round(n / 1000)}k` : `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}
