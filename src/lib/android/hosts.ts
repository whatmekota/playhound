import type { ResolvedStream, StreamItem, StreamSource } from '../streamHosts'
import { cookiesOf, nativeFetch, registerMega, registerStream } from './net'

/**
 * Links from a post, made playable in the Android app: the resolvers of
 * server/hosts.mjs, run in the page with nativeFetch in place of Node's
 * fetch, so nothing needs the desktop app's proxy. Each answers the same
 * shape as the proxy's /resolve, with every source already registered on
 * the app's loopback server (net.ts registerStream), so its `url` plays in
 * a <video> with the headers the host wants.
 *
 * Kept in step with server/hosts.mjs by hand; what is parsed out of a page
 * or an answer is in small functions of its own, with tests.
 *
 * yt-dlp is a desktop program: sites only it knows say so.
 */

/** A UA the hosts take; Gofile's website token is computed over it, so it goes on every request. */
export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

const VIDEO = /\.(?:mp4|m4v|webm|mkv|mov|mp3|m4a|aac|ogg|opus|flac|wav)$/i
const MAX_ITEMS = 200

export class ResolveError extends Error {
  constructor(message: string, readonly code: string | null = null) {
    super(message)
  }
}

/** A source before it is registered: how to fetch it. */
export interface PendingSource {
  label: string
  height: number
  kind: 'file' | 'hls'
  target: { type: 'http', url: string, headers: Record<string, string>, name: string } | { type: 'mega', request: string, folder: string | null, key: Uint8Array, size: number, name: string }
}

export interface PendingItem {
  title: string
  size: number | null
  sources: PendingSource[]
}

const one = (title: string, sources: PendingSource[], size: number | null = null): PendingItem => ({ title, size, sources })
const byName = (a: PendingItem, b: PendingItem) => a.title.localeCompare(b.title, undefined, { numeric: true })

function get(url: string, headers: Record<string, string> = {}, init: RequestInit = {}) {
  return nativeFetch(url, { ...init, headers: { 'User-Agent': UA, ...headers } })
}

async function json(url: string, headers: Record<string, string> = {}, init: RequestInit = {}): Promise<any> {
  const res = await get(url, { Accept: 'application/json', ...headers }, init)
  const text = await res.text()
  try {
    return JSON.parse(text)
  }
  catch {
    throw new ResolveError(`${new URL(url).hostname} answered ${res.status} with a page, not data`)
  }
}

async function hex(algo: 'SHA-1' | 'SHA-256', text: string): Promise<string> {
  const d = await crypto.subtle.digest(algo, new TextEncoder().encode(text))
  return Array.from(new Uint8Array(d), b => b.toString(16).padStart(2, '0')).join('')
}

// ─── Pixeldrain ───────────────────────────────────────────────────────────────
const PD_HEADERS = { Referer: 'https://pixeldrain.com/', Origin: 'https://pixeldrain.com' }
const pdSource = (id: string, name: string): PendingSource => ({ label: 'Original', height: 0, kind: 'file', target: { type: 'http', url: `https://pixeldrain.com/api/file/${id}`, headers: PD_HEADERS, name } })

/** The files of a /d/ (filesystem) share, from its ?stat answer. */
export function pixeldrainFsFiles(stat: any): PendingItem[] {
  const node = stat?.path?.[stat.base_index ?? stat.path.length - 1]
  const files: any[] = node?.type === 'dir' ? (stat.children ?? []) : [node].filter(Boolean)
  return files.filter(f => f.type === 'file' && VIDEO.test(f.name)).map(f => one(f.name, [{
    label: 'Original',
    height: 0,
    kind: 'file',
    target: { type: 'http', url: `https://pixeldrain.com/api/filesystem${String(f.path).split('/').map(encodeURIComponent).join('/')}`, headers: PD_HEADERS, name: f.name },
  }], f.file_size ?? null))
}

async function pixeldrain(u: URL): Promise<PendingItem[]> {
  const [, kind, id] = u.pathname.match(/^\/([uld])\/([\w-]+)/) ?? []
  if (kind === 'u') {
    const info = await json(`https://pixeldrain.com/api/file/${id}/info`)
    if (!info?.name)
      throw new ResolveError('Pixeldrain: file not found')
    return [one(info.name, [pdSource(id, info.name)], info.size)]
  }
  if (kind === 'l') {
    const list = await json(`https://pixeldrain.com/api/list/${id}`)
    return (list.files ?? []).filter((f: any) => VIDEO.test(f.name)).map((f: any) => one(f.name, [pdSource(f.id, f.name)], f.size))
  }
  if (kind === 'd')
    return pixeldrainFsFiles(await json(`https://pixeldrain.com/api/filesystem/${u.pathname.slice(3)}?stat`))
  throw new ResolveError('Pixeldrain: unknown link shape')
}

// ─── Gofile ───────────────────────────────────────────────────────────────────
/** What gofile.io/js/wt.obf.js computes (server/hosts.mjs gofileWt). */
export function gofileWt(token: string, now = Date.now(), ua = UA): Promise<string> {
  return hex('SHA-256', `${ua}::en-US::${token}::${Math.floor(now / 1000 / 14400)}::12af056dacea0b`)
}

async function gofile(u: URL): Promise<PendingItem[]> {
  const id = u.pathname.match(/^\/d\/([\w-]+)/)?.[1]
  if (!id)
    throw new ResolveError('Gofile: unknown link shape')
  const acc = await json('https://api.gofile.io/accounts', {}, { method: 'POST' })
  const token = acc?.data?.token
  if (!token)
    throw new ResolveError('Gofile would not hand out a guest token')
  const headers = { 'Authorization': `Bearer ${token}`, 'X-Website-Token': await gofileWt(token), 'X-BL': 'en-US' }
  const items: PendingItem[] = []
  async function walk(folderId: string, depth: number) {
    const res = await json(`https://api.gofile.io/contents/${folderId}`, headers)
    if (res.status !== 'ok') {
      if (depth === 0)
        throw new ResolveError(res.status === 'error-notFound' ? 'Gofile: deleted or expired' : `Gofile: ${res.status}`)
      return
    }
    for (const c of Object.values<any>(res.data.children ?? {})) {
      if (c.type === 'file' && VIDEO.test(c.name) && c.link)
        items.push(one(c.name, [{ label: 'Original', height: 0, kind: 'file', target: { type: 'http', url: c.link, headers: { Cookie: `accountToken=${token}` }, name: c.name } }], c.size))
      else if (c.type === 'folder' && depth < 2)
        await walk(c.id, depth + 1)
    }
  }
  await walk(id, 0)
  return items.sort(byName)
}

// ─── Iwara ────────────────────────────────────────────────────────────────────
/** The X-Version header Iwara's file list wants: SHA-1 of "<file id>_<expires>_<salt>". */
export function iwaraXVersion(fileUrl: string): Promise<string> {
  const f = new URL(fileUrl)
  return hex('SHA-1', `${f.pathname.split('/').pop()}_${f.searchParams.get('expires')}_5nFp9kmbNnHdAFhaqMvt`)
}

/** Iwara's file list as sources, best first; the preview is left out. */
export function iwaraSources(list: any[]): PendingSource[] {
  return list
    .filter(s => s.name !== 'preview' && s.src?.view)
    .map(s => ({ s, height: s.name === 'Source' ? 99999 : Number.parseInt(s.name) || 0 }))
    .sort((a, b) => b.height - a.height)
    .map(({ s, height }) => ({
      label: s.name === 'Source' ? 'Source' : `${s.name}p`,
      height,
      kind: 'file' as const,
      target: { type: 'http' as const, url: `https:${s.src.view}`, headers: { Referer: 'https://www.iwara.tv/' }, name: 'x.mp4' },
    }))
}

async function iwara(u: URL): Promise<PendingItem[]> {
  const id = u.pathname.match(/^\/videos?\/([\w-]+)/)?.[1]
  if (!id)
    throw new ResolveError('Iwara: not a video link')
  const info = await json(`https://api.iwara.tv/video/${id}`)
  if (!info?.fileUrl)
    throw new ResolveError(info?.message === 'errors.privateVideo' ? 'Iwara: private video' : `Iwara: ${info?.message ?? 'no file (its API may have turned the app away)'}`)
  const list = await json(info.fileUrl, { 'X-Version': await iwaraXVersion(info.fileUrl), 'Referer': 'https://www.iwara.tv/' })
  if (!Array.isArray(list))
    throw new ResolveError('Iwara refused the file list')
  return [one(info.title ?? id, iwaraSources(list))]
}

// ─── Rule34Video ──────────────────────────────────────────────────────────────
export const metaTitle = (html: string) => (html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/)?.[1] ?? html.match(/<title>([^<]+)/)?.[1] ?? '').replace(/&amp;/g, '&').trim()

/** The page's download links, one per quality, best first. */
export function rule34Links(html: string): { url: string, height: number }[] {
  const links = [...html.matchAll(/href="(https:\/\/rule34video\.com\/get_file\/[^"]+?\.mp4\/\?[^"]*download=true[^"]*)"/g)].map(m => m[1].replace(/&amp;/g, '&'))
  return [...new Set(links)]
    .map(url => ({ url, height: Number(url.match(/_(\d{3,4})p?\.mp4/)?.[1] ?? 0) }))
    .sort((a, b) => b.height - a.height)
}

async function rule34video(u: URL): Promise<PendingItem[]> {
  const page = await get(u.href)
  if (page.status === 404)
    throw new ResolveError('Rule34Video: video removed')
  const cookie = cookiesOf(page)
  const html = await page.text()
  const sources: PendingSource[] = rule34Links(html).map(({ url, height }) => ({
    label: height ? `${height}p` : 'Video',
    height,
    kind: 'file',
    target: { type: 'http', url, headers: { Cookie: cookie, Referer: u.href }, name: 'x.mp4' },
  }))
  if (!sources.length)
    throw new ResolveError('Rule34Video: no download links on the page')
  return [one(metaTitle(html), sources)]
}

// ─── PMVHaven ─────────────────────────────────────────────────────────────────
/** The original upload's URL in the page's Nuxt payload ("/" written as /). */
export function pmvhavenVideo(html: string): { url: string, title: string } | null {
  const text = html.replace(/\\u002F/g, '/')
  const url = text.match(/https:\/\/[^"\s]+?\/videos\/[^"\s]+?\.mp4(?=")/)?.[0]
  return url ? { url, title: metaTitle(text).replace(/ - PMVHaven$/, '') } : null
}

async function pmvhaven(u: URL): Promise<PendingItem[]> {
  const found = pmvhavenVideo(await (await get(u.href)).text())
  if (!found)
    throw new ResolveError('PMVHaven: no video on the page')
  return [one(found.title, [{ label: 'Original', height: 0, kind: 'file', target: { type: 'http', url: found.url, headers: { Referer: 'https://pmvhaven.com/' }, name: 'x.mp4' } }])]
}

// ─── MEGA ─────────────────────────────────────────────────────────────────────
// megajs reads the link (and its key) and the folder tree; the app asks
// MEGA for a file's download address when it is played and decrypts as it
// streams (net/NetRoutes.kt), so the server gets the request for that
// address and the file's key.
async function mega(u: URL): Promise<PendingItem[]> {
  const { API, File: MegaFile } = await import('megajs')
  const api = new API(false, { fetch: ((url: string, init: RequestInit) => nativeFetch(url, init)) as any })
  const root = MegaFile.fromURL(u.href, { api })
  await root.loadAttributes()
  const files: any[] = []
  const walk = (f: any) => {
    if (f.directory)
      f.children?.forEach(walk)
    else if (VIDEO.test(f.name ?? ''))
      files.push(f)
  }
  walk(root)
  return files.slice(0, MAX_ITEMS).map((f) => {
    const { request, folder } = megaDownloadRequest(f)
    return one(f.name, [{ label: 'Original', height: 0, kind: 'file', target: { type: 'mega', request, folder, key: f.key, size: f.size, name: f.name } }], f.size)
  }).sort(byName)
}

/**
 * The API request for a MEGA file's download address, as megajs's
 * download() makes it: by node, or by node in a shared folder (asked under
 * the folder's handle), else by the public link's id.
 */
export function megaDownloadRequest(f: { nodeId?: string, downloadId?: string | string[] }): { request: string, folder: string | null } {
  const req: Record<string, unknown> = { a: 'g', g: 1, ssl: 2 }
  let folder: string | null = null
  if (f.nodeId) {
    req.n = f.nodeId
  }
  else if (Array.isArray(f.downloadId)) {
    folder = f.downloadId[0]
    req.n = f.downloadId[1]
  }
  else {
    req.p = f.downloadId
  }
  return { request: JSON.stringify(req), folder }
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────
const HOSTS: { re: RegExp, id: string, label: string, fn: (u: URL) => Promise<PendingItem[]> }[] = [
  { re: /(?:^|\.)pixeldrain\.(?:com|net)$/, id: 'pixeldrain', label: 'Pixeldrain', fn: pixeldrain },
  { re: /(?:^|\.)gofile\.io$/, id: 'gofile', label: 'Gofile', fn: gofile },
  { re: /(?:^|\.)iwara\.tv$/, id: 'iwara', label: 'Iwara', fn: iwara },
  { re: /(?:^|\.)rule34video\.com$/, id: 'rule34video', label: 'Rule34Video', fn: rule34video },
  { re: /(?:^|\.)pmvhaven\.com$/, id: 'pmvhaven', label: 'PMVHaven', fn: pmvhaven },
  { re: /(?:^|\.)mega\.(?:nz|io)$/, id: 'mega', label: 'MEGA', fn: mega },
]

/** Hosts the app resolves itself; anything else would need yt-dlp. */
export function resolvesOnAndroid(href: string): boolean {
  try {
    return HOSTS.some(h => h.re.test(new URL(href).hostname))
  }
  catch {
    return false
  }
}

export const YTDLP_DESKTOP_ONLY = 'This site needs yt-dlp, which only runs in the desktop app. Play it there, or download it and add it to the library.'

/** /resolve, done in the app. */
export async function resolveHere(href: string): Promise<ResolvedStream> {
  let u: URL
  try {
    u = new URL(href)
  }
  catch {
    throw new ResolveError('Not a link')
  }
  if (!/^https?:$/.test(u.protocol))
    throw new ResolveError('Only http(s) links')
  const host = HOSTS.find(h => h.re.test(u.hostname))
  if (!host)
    throw new ResolveError(YTDLP_DESKTOP_ONLY, 'desktop-only')
  const pending = (await host.fn(u)).slice(0, MAX_ITEMS)
  if (!pending.length)
    throw new ResolveError(`${host.label}: no video there`)
  const items: StreamItem[] = []
  for (const it of pending) {
    const sources: StreamSource[] = []
    for (const s of it.sources) {
      const t = s.target
      const url = t.type === 'mega'
        ? await registerMega(t.request, t.folder, t.key, t.size, t.name)
        : await registerStream(t.url, t.headers, s.kind, t.name)
      sources.push({ label: s.label, height: s.height, size: it.size, kind: s.kind, url })
    }
    items.push({ title: it.title, size: it.size, sources })
  }
  return { host: host.id, label: host.label, items }
}
