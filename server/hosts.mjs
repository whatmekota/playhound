/**
 * Turn a link from a post into something playable.
 *
 * `resolve(url)` answers with
 *   { host, label, items: [{ title, size, sources: [{ label, height, kind, target }] }] }
 * where each item is one video (a folder link gives several), sources run best
 * first, kind is 'file' or 'hls', and target says how media.mjs fetches it.
 *
 * Hosts with their own resolver were each worked out against real links from
 * EroScripts posts; anything else goes to yt-dlp.
 */

import crypto from 'node:crypto'
import { API, File as MegaFile } from 'megajs'
import { cookiesOf, getJson, netFetch, UA } from './net.mjs'
import { extract as ytdlp } from './ytdlp.mjs'

const VIDEO = /\.(?:mp4|m4v|webm|mkv|mov)$/i
const MAX_ITEMS = 200

class ResolveError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
  }
}

const one = (title, sources, size = null) => ({ title, size, sources })
const byName = (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true })

// ─── Pixeldrain ───────────────────────────────────────────────────────────────
const PD_HEADERS = { Referer: 'https://pixeldrain.com/', Origin: 'https://pixeldrain.com' }
const pdSource = (id, name) => ({ label: 'Original', height: 0, kind: 'file', target: { type: 'http', url: `https://pixeldrain.com/api/file/${id}`, headers: PD_HEADERS, name } })

async function pixeldrain(u) {
  const [, kind, id] = u.pathname.match(/^\/([uld])\/([\w-]+)/) ?? []
  if (kind === 'u') {
    const info = await netFetch(`https://pixeldrain.com/api/file/${id}/info`).then(r => r.json())
    if (!info?.name)
      throw new ResolveError('Pixeldrain: file not found')
    return [one(info.name, [pdSource(id, info.name)], info.size)]
  }
  if (kind === 'l') {
    const list = await netFetch(`https://pixeldrain.com/api/list/${id}`).then(r => r.json())
    return (list.files ?? []).filter(f => VIDEO.test(f.name)).map(f => one(f.name, [pdSource(f.id, f.name)], f.size))
  }
  if (kind === 'd') {
    // Filesystem shares: list the folder (or stat the file) under /api/filesystem.
    const rest = u.pathname.slice(3)
    const stat = await netFetch(`https://pixeldrain.com/api/filesystem/${rest}?stat`).then(r => r.json())
    const node = stat?.path?.[stat.base_index ?? stat.path.length - 1]
    const files = node?.type === 'dir' ? (stat.children ?? []) : [node].filter(Boolean)
    return files.filter(f => f.type === 'file' && VIDEO.test(f.name)).map(f => one(f.name, [{
      label: 'Original',
      height: 0,
      kind: 'file',
      target: { type: 'http', url: `https://pixeldrain.com/api/filesystem${f.path.split('/').map(encodeURIComponent).join('/')}`, headers: PD_HEADERS, name: f.name },
    }], f.file_size))
  }
  throw new ResolveError('Pixeldrain: unknown link shape')
}

// ─── Gofile ───────────────────────────────────────────────────────────────────
// The website token is what gofile.io/js/wt.obf.js computes: a SHA-256 over the
// User-Agent, language, account token and a four-hour window, with a salt.
function gofileWt(token) {
  return crypto.createHash('sha256')
    .update(`${UA}::en-US::${token}::${Math.floor(Date.now() / 1000 / 14400)}::12af056dacea0b`)
    .digest('hex')
}

async function gofile(u) {
  const id = u.pathname.match(/^\/d\/([\w-]+)/)?.[1]
  if (!id)
    throw new ResolveError('Gofile: unknown link shape')
  const acc = await netFetch('https://api.gofile.io/accounts', { method: 'POST' }).then(r => r.json())
  const token = acc?.data?.token
  if (!token)
    throw new ResolveError('Gofile would not hand out a guest token')
  const headers = { 'Authorization': `Bearer ${token}`, 'X-Website-Token': gofileWt(token), 'X-BL': 'en-US' }
  const items = []
  async function walk(folderId, depth) {
    const res = await netFetch(`https://api.gofile.io/contents/${folderId}`, { headers }).then(r => r.json())
    if (res.status !== 'ok') {
      if (depth === 0)
        throw new ResolveError(res.status === 'error-notFound' ? 'Gofile: deleted or expired' : `Gofile: ${res.status}`)
      return
    }
    for (const c of Object.values(res.data.children ?? {})) {
      if (c.type === 'file' && VIDEO.test(c.name) && c.link) {
        items.push(one(c.name, [{ label: 'Original', height: 0, kind: 'file', target: { type: 'http', url: c.link, headers: { Cookie: `accountToken=${token}` }, name: c.name } }], c.size))
      }
      else if (c.type === 'folder' && depth < 2) {
        await walk(c.id, depth + 1)
      }
    }
  }
  await walk(id, 0)
  return items.sort(byName)
}

// ─── Iwara ────────────────────────────────────────────────────────────────────
// The file list wants X-Version: SHA-1 of "<file id>_<expires>_<salt>", the
// same scheme yt-dlp uses. The API sits behind Cloudflare; getJson copes.
async function iwara(u) {
  const id = u.pathname.match(/^\/videos?\/([\w-]+)/)?.[1]
  if (!id)
    throw new ResolveError('Iwara: not a video link')
  const { data: info } = await getJson(`https://api.iwara.tv/video/${id}`)
  if (!info?.fileUrl)
    throw new ResolveError(info?.message === 'errors.privateVideo' ? 'Iwara: private video' : `Iwara: ${info?.message ?? 'no file'}`)
  const f = new URL(info.fileUrl)
  const xv = crypto.createHash('sha1').update(`${f.pathname.split('/').pop()}_${f.searchParams.get('expires')}_5nFp9kmbNnHdAFhaqMvt`).digest('hex')
  const { data: list } = await getJson(info.fileUrl, { 'X-Version': xv, 'Referer': 'https://www.iwara.tv/' })
  if (!Array.isArray(list))
    throw new ResolveError('Iwara refused the file list')
  const sources = list
    .filter(s => s.name !== 'preview' && s.src?.view)
    .map(s => ({ s, height: s.name === 'Source' ? 99999 : Number.parseInt(s.name) || 0 }))
    .sort((a, b) => b.height - a.height)
    .map(({ s, height }) => ({
      label: s.name === 'Source' ? 'Source' : `${s.name}p`,
      height,
      kind: 'file',
      target: { type: 'http', url: `https:${s.src.view}`, headers: { Referer: 'https://www.iwara.tv/' }, name: 'x.mp4' },
    }))
  return [one(info.title ?? id, sources)]
}

// ─── Rule34Video ──────────────────────────────────────────────────────────────
// The page lists a download link per quality; they only work with the session
// cookie the page itself set.
const metaTitle = html => (html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/)?.[1] ?? html.match(/<title>([^<]+)/)?.[1] ?? '').replace(/&amp;/g, '&').trim()

async function rule34video(u) {
  const page = await netFetch(u.href)
  const cookie = cookiesOf(page)
  const html = await page.text()
  if (page.status === 404)
    throw new ResolveError('Rule34Video: video removed')
  const links = [...html.matchAll(/href="(https:\/\/rule34video\.com\/get_file\/[^"]+?\.mp4\/\?[^"]*download=true[^"]*)"/g)].map(m => m[1].replace(/&amp;/g, '&'))
  const sources = [...new Set(links)].map((url) => {
    const height = Number(url.match(/_(\d{3,4})p?\.mp4/)?.[1] ?? 0)
    return { label: height ? `${height}p` : 'Video', height, kind: 'file', target: { type: 'http', url, headers: { Cookie: cookie, Referer: u.href }, name: 'x.mp4' } }
  }).sort((a, b) => b.height - a.height)
  if (!sources.length)
    throw new ResolveError('Rule34Video: no download links on the page')
  return [one(metaTitle(html), sources)]
}

// ─── PMVHaven ─────────────────────────────────────────────────────────────────
// The original upload sits on their S3 bucket; its URL is in the page's Nuxt
// payload with "/" escaped as /.
async function pmvhaven(u) {
  const html = (await netFetch(u.href).then(r => r.text())).replace(/\\u002F/g, '/')
  const original = html.match(/https:\/\/[^"\s]+?\/videos\/[^"\s]+?\.mp4(?=")/)?.[0]
  if (!original)
    throw new ResolveError('PMVHaven: no video on the page')
  return [one(metaTitle(html).replace(/ - PMVHaven$/, ''), [{ label: 'Original', height: 0, kind: 'file', target: { type: 'http', url: original, headers: { Referer: 'https://pmvhaven.com/' }, name: 'x.mp4' } }])]
}

// ─── MEGA ─────────────────────────────────────────────────────────────────────
// The key is in the link; megajs decrypts as it streams. Folders are walked
// for their videos. Anonymous MEGA has a transfer quota per IP.
const megaApi = new API(false, { fetch: (url, init) => netFetch(url, init) })

async function mega(u) {
  const root = MegaFile.fromURL(u.href, { api: megaApi })
  await root.loadAttributes()
  const files = []
  const walk = (f) => {
    if (f.directory)
      f.children?.forEach(walk)
    else if (VIDEO.test(f.name ?? ''))
      files.push(f)
  }
  walk(root)
  return files.slice(0, MAX_ITEMS).map(f => one(f.name, [{ label: 'Original', height: 0, kind: 'file', target: { type: 'mega', file: f } }], f.size)).sort(byName)
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────
const HOSTS = [
  { re: /(?:^|\.)pixeldrain\.(?:com|net)$/, id: 'pixeldrain', label: 'Pixeldrain', fn: pixeldrain },
  { re: /(?:^|\.)gofile\.io$/, id: 'gofile', label: 'Gofile', fn: gofile },
  { re: /(?:^|\.)iwara\.tv$/, id: 'iwara', label: 'Iwara', fn: iwara },
  { re: /(?:^|\.)rule34video\.com$/, id: 'rule34video', label: 'Rule34Video', fn: rule34video },
  { re: /(?:^|\.)pmvhaven\.com$/, id: 'pmvhaven', label: 'PMVHaven', fn: pmvhaven },
  { re: /(?:^|\.)mega\.(?:nz|io)$/, id: 'mega', label: 'MEGA', fn: mega },
]

export async function resolve(href) {
  let u
  try {
    u = new URL(href)
  }
  catch {
    throw new ResolveError('Not a link')
  }
  if (!/^https?:$/.test(u.protocol))
    throw new ResolveError('Only http(s) links')
  const host = HOSTS.find(h => h.re.test(u.hostname))
  if (host) {
    const items = (await host.fn(u)).slice(0, MAX_ITEMS)
    if (!items.length)
      throw new ResolveError(`${host.label}: no video there`)
    return { host: host.id, label: host.label, items }
  }
  // Everything else: yt-dlp knows far more sites than we ever will.
  const { title, sources } = await ytdlp(u.href)
  return { host: 'ytdlp', label: u.hostname.replace(/^www\./, ''), items: [one(title ?? u.hostname, sources)] }
}

export { ResolveError }
