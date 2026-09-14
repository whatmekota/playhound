<script setup lang="ts">
import { ref, computed, watch, onMounted, nextTick } from 'vue'
import { useFunscript } from '~/composables/useFunscript'
import { usePlayerStore } from '~/stores/playerStore'

// ─── Types ────────────────────────────────────────────────────────────────────
interface ESTopic {
  id: number
  title: string
  slug: string
  views: number
  like_count: number
  created_at: string
  category_id: number
  tags: (string | { id: number; slug: string; name: string })[]
  image_url: string | null
  funscriptUrls?: FunscriptEntry[]
  videoLinks?: VideoLink[]
  loading?: boolean
}

interface FunscriptEntry {
  url: string
  filename: string
  axis: string | null       // null = unknown, '' = detecting
  axisDetected: boolean
}

interface ESPost {
  id: number
  cooked: string
  attachments?: { url: string; original_filename: string }[]
}

type Platform = 'pixeldrain' | 'iwara' | 'pmvhaven' | 'hanime1' | 'pornhub' | 'rule34video' | 'twitter' | 'gofile' | 'mega' | 'other'

interface PdFile { id: string; name: string; size: number; mime_type: string }

interface VideoLink {
  platform: Platform
  label: string
  originalUrl: string
  streamUrl: string | null
  resolving: boolean
  title?: string
  error?: string
  _pdId?: string
  _pdFolder?: boolean
  pdFolderFiles?: PdFile[]   // resolved folder contents
}

const BASE   = 'https://discuss.eroscripts.com'
const PROXY  = 'http://localhost:7071'
const SCRIPTS_PATH    = '/c/scripts/free-scripts/14/l'
const SCRIPTS_TAG_BASE = '/tags/c/scripts/free-scripts/14'

const { loadScriptFiles } = useFunscript()
const playerStore = usePlayerStore()

// ─── Session cookie ───────────────────────────────────────────────────────────
const LS_COOKIE_KEY = 'es:cookie'
const sessionCookie   = ref(localStorage.getItem(LS_COOKIE_KEY) ?? '')
const showCookieSetup = ref(!sessionCookie.value)
const cookieDraft     = ref(sessionCookie.value.replace(/^_t=/, ''))

function saveCookie() {
  const v = cookieDraft.value.trim()
  const normalized = v.startsWith('_t=') ? v : `_t=${v}`
  sessionCookie.value = normalized
  localStorage.setItem(LS_COOKIE_KEY, normalized)
  showCookieSetup.value = false
  loadTopics(true)
}

// ─── API ──────────────────────────────────────────────────────────────────────
async function apiFetch(path: string) {
  const res = await fetch(`${PROXY}${path}`, {
    headers: {
      'Accept': 'application/json',
      ...(sessionCookie.value ? { 'X-ES-Cookie': sessionCookie.value } : {}),
    },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

// ─── View ─────────────────────────────────────────────────────────────────────
const viewMode  = ref<'list' | 'grid'>((localStorage.getItem('es:view') as any) ?? 'list')
watch(viewMode, v => localStorage.setItem('es:view', v))

// ─── Browse state ─────────────────────────────────────────────────────────────
const tab        = ref<'browse' | 'search'>('browse')
const sort       = ref<'latest' | 'top' | 'hot'>('latest')
const topics     = ref<ESTopic[]>([])
const loading    = ref(false)
const corsBlocked = ref(false)
const error      = ref<string | null>(null)
const page       = ref(0)
const hasMore    = ref(true)

interface ESTag { id: number; name: string; slug: string }
const availableTags = ref<ESTag[]>([])
const activeTag     = ref<ESTag | null>(null)
const tagSearch     = ref('')
const filteredTags  = computed(() => {
  const q = tagSearch.value.toLowerCase().trim()
  return q ? availableTags.value.filter(t => t.name.toLowerCase().includes(q)) : availableTags.value
})

const search        = ref('')
const searchResults = ref<ESTopic[]>([])
const searchLoading = ref(false)
const searchDone    = ref(false)

const expandedId          = ref<number | null>(null)
const downloadingScript   = ref<string | null>(null)
const loadingIntoPlayer   = ref<number | null>(null)

let searchTimer: ReturnType<typeof setTimeout> | null = null

// ─── Browse ───────────────────────────────────────────────────────────────────
async function loadTopics(reset = false) {
  if (loading.value) return
  if (reset) { page.value = 0; hasMore.value = true; topics.value = [] }
  loading.value = true; error.value = null; corsBlocked.value = false
  try {
    const slug     = sort.value === 'top' ? 'top' : sort.value === 'hot' ? 'hot' : 'latest'
    const pageParam = page.value > 0 ? `?page=${page.value}` : ''
    const endpoint = activeTag.value
      ? `${SCRIPTS_TAG_BASE}/${activeTag.value.slug}/${activeTag.value.id}/l/${slug}.json${pageParam}`
      : `${SCRIPTS_PATH}/${slug}.json${pageParam}`
    const data = await apiFetch(endpoint)
    const list: ESTopic[] = data?.topic_list?.topics ?? []
    if (reset && !activeTag.value && data?.topic_list?.top_tags?.length)
      availableTags.value = data.topic_list.top_tags
    if (list.length === 0) hasMore.value = false
    else { topics.value = reset ? list : [...topics.value, ...list]; page.value++ }
  } catch (e: any) {
    if (e instanceof TypeError) corsBlocked.value = true
    else error.value = e?.message ?? 'Failed to load'
  } finally { loading.value = false }
}

function selectTag(tag: ESTag | null) { activeTag.value = tag; loadTopics(true) }
watch(sort, () => loadTopics(true))
onMounted(() => loadTopics(true))

// ─── Search ───────────────────────────────────────────────────────────────────
function onSearchInput() {
  if (searchTimer) clearTimeout(searchTimer)
  searchDone.value = false
  if (!search.value.trim()) { searchResults.value = []; return }
  searchTimer = window.setTimeout(doSearch, 500)
}
async function doSearch() {
  const q = search.value.trim(); if (!q) return
  searchLoading.value = true; searchDone.value = false; error.value = null
  try {
    const data = await apiFetch(`/search.json?q=${encodeURIComponent(q)}&category=scripts`)
    searchResults.value = (data?.topics ?? []) as ESTopic[]
    searchDone.value = true
  } catch (e: any) {
    if (e instanceof TypeError) corsBlocked.value = true
    else error.value = e?.message ?? 'Search failed'
  } finally { searchLoading.value = false }
}

// ─── Axis detection ───────────────────────────────────────────────────────────
const AXIS_NAMES: Record<string, string> = {
  L0: 'Stroke', L1: 'Surge', L2: 'Sway',
  R0: 'Twist',  R1: 'Roll',  R2: 'Pitch',
  A10V: 'Vibe',
}

const AXIS_WORD_MAP: Record<string, string> = {
  STROKE: 'L0', SURGE: 'L1', SWAY: 'L2',
  TWIST: 'R0',  ROLL: 'R1',  PITCH: 'R2',
  VIBRAT: 'A10V', VIBE: 'A10V',
}

function guessAxisFromFilename(name: string): string | null {
  const upper = name.toUpperCase().replace('.FUNSCRIPT', '')

  // Exact axis code match: _L0, .L0, (L0), -L0, " L0"
  for (const axis of Object.keys(AXIS_NAMES)) {
    if (new RegExp(`[^A-Z0-9]${axis}([^A-Z0-9]|$)`).test(upper)) return axis
    if (upper.endsWith(axis)) return axis
  }

  // Word match: .roll. .pitch. _twist_ etc.
  for (const [word, axis] of Object.entries(AXIS_WORD_MAP)) {
    if (new RegExp(`[^A-Z]${word}[^A-Z]|^${word}[^A-Z]|[^A-Z]${word}$`).test(upper)) return axis
  }

  // No axis hint found → assume L0 (stroke), no fetch needed
  return 'L0'
}

function axisLabel(axis: string | null): string {
  if (!axis) return '?'
  const upper = axis.toUpperCase()
  return AXIS_NAMES[upper] ? `${upper} · ${AXIS_NAMES[upper]}` : axis
}

async function detectAxis(entry: FunscriptEntry) {
  if (entry.axisDetected) return
  entry.axis = ''   // show detecting…
  try {
    const res = await proxyFetch(entry.url)
    if (!res.ok) throw new Error()
    const json = await res.json()

    // Multi-axis format: root "axes" is an array [{id, actions}]
    if (Array.isArray(json.axes) && json.axes.length > 0) {
      entry.axis = json.axes.map((a: any) => String(a.id ?? a.name ?? '').toUpperCase()).filter(Boolean).join('+') || 'L0'
    }
    // Single string axes field e.g. "L0"
    else if (json.axes && typeof json.axes === 'string') {
      entry.axis = json.axes.toUpperCase()
    }
    // Root-level actions array = standard stroke script = L0
    else if (Array.isArray(json.actions)) {
      entry.axis = 'L0'
    }
    // metadata.axes fallback
    else if (json.metadata?.axes) {
      entry.axis = String(json.metadata.axes).toUpperCase()
    }
    else {
      entry.axis = null
    }
  } catch {
    entry.axis = null
  } finally {
    entry.axisDetected = true
  }
}

// ─── URL rewriting ────────────────────────────────────────────────────────────
// The browser resolves relative hrefs from Discourse HTML against localhost:6969.
// All of these must go through the proxy (which sends the session cookie).
function toProxyUrl(url: string): string {
  try {
    const u = new URL(url)
    if (u.hostname === 'localhost' && u.port !== '7071') {
      return `http://localhost:7071${u.pathname}${u.search}`
    }
    // Also route any discuss.eroscripts.com URLs through proxy (need cookie)
    if (u.hostname === 'discuss.eroscripts.com') {
      return `http://localhost:7071${u.pathname}${u.search}`
    }
    return url
  } catch { return url }
}
function detectVideoLinks(html: string): VideoLink[] {
  const div = document.createElement('div')
  div.innerHTML = html
  const hrefs = Array.from(div.querySelectorAll('a[href]')).map(a => (a as HTMLAnchorElement).href)
  const links: VideoLink[] = []
  const seen  = new Set<string>()

  for (const href of hrefs) {
    if (seen.has(href)) continue
    seen.add(href)

    // Pixeldrain /u/ — stream via proxy (video element uses /pd-stream/, scripts use /pd/)
    const pdU = href.match(/pixeldrain\.com\/u\/([A-Za-z0-9]+)/)
    if (pdU) {
      links.push({ platform: 'pixeldrain', label: 'Pixeldrain', originalUrl: href,
        streamUrl: `http://localhost:7071/pd-stream/${pdU[1]}`, resolving: false })
      continue
    }
    // Pixeldrain /l/ — folder, resolve via API
    const pdL = href.match(/pixeldrain\.com\/l\/([A-Za-z0-9]+)/)
    if (pdL) {
      links.push({ platform: 'pixeldrain', label: 'Pixeldrain (folder)', originalUrl: href,
        streamUrl: null, resolving: false, _pdId: pdL[1], _pdFolder: true } as any)
      continue
    }

    // Iwara
    if (/iwara\.tv\/video/i.test(href)) {
      links.push({ platform: 'iwara', label: 'Iwara', originalUrl: href, streamUrl: null, resolving: false })
      continue
    }
    // PMVHaven
    if (/pmvhaven\.com\/video/i.test(href)) {
      links.push({ platform: 'pmvhaven', label: 'PMVHaven', originalUrl: href, streamUrl: null, resolving: false })
      continue
    }
    // Gofile
    if (/gofile\.io\/(d|f)\//i.test(href)) {
      links.push({ platform: 'gofile', label: 'Gofile', originalUrl: href, streamUrl: null, resolving: false })
      continue
    }
    // MEGA
    if (/mega\.nz\//i.test(href)) {
      links.push({ platform: 'mega', label: 'MEGA', originalUrl: href, streamUrl: null, resolving: false,
        error: 'MEGA uses client-side encryption — open in browser' })
      continue
    }
    // X / Twitter
    if (/(?:twitter\.com|x\.com)\/.+\/status\//i.test(href)) {
      links.push({ platform: 'twitter', label: 'X / Twitter', originalUrl: href, streamUrl: null, resolving: false,
        error: 'No public API — open in browser' })
      continue
    }
    // Rule34Video
    if (/rule34video\.com\/videos\//i.test(href)) {
      links.push({ platform: 'rule34video', label: 'Rule34Video', originalUrl: href, streamUrl: null, resolving: false,
        error: 'CORS blocked — open in browser' })
      continue
    }
    // Hanime1
    if (/hanime1\.me\/watch/i.test(href)) {
      links.push({ platform: 'hanime1', label: 'Hanime1', originalUrl: href, streamUrl: null, resolving: false,
        error: 'CORS blocked — open in browser' })
      continue
    }
    // Pornhub
    if (/pornhub\.com\/view_video/i.test(href)) {
      links.push({ platform: 'pornhub', label: 'Pornhub', originalUrl: href, streamUrl: null, resolving: false,
        error: 'No public API — open in browser' })
    }
  }
  return links
}
const canResolve = (v: VideoLink) => ['iwara', 'pmvhaven', 'gofile'].includes(v.platform) || (v.platform === 'pixeldrain' && !!(v as any)._pdFolder)

async function resolveVideoLink(link: VideoLink) {
  if (link.streamUrl || link.resolving || link.error) return
  link.resolving = true; link.error = undefined
  try {
    if      ((link as any)._pdFolder)      await resolvePixeldrainFolder(link)
    else if (link.platform === 'iwara')    await resolveIwara(link)
    else if (link.platform === 'pmvhaven') await resolvePmvhaven(link)
    else if (link.platform === 'gofile')   await resolveGofile(link)
    else link.error = 'Direct stream not available — open in browser'
  } catch (e: any) { link.error = e?.message ?? 'Failed to resolve' }
  finally { link.resolving = false }
}

async function resolvePixeldrainFolder(link: VideoLink) {
  const id = (link as any)._pdId
  if (!id) { link.error = 'No folder ID'; return }
  // Pixeldrain list API is public, no auth needed
  const res = await fetch(`https://pixeldrain.com/api/list/${id}`)
  if (!res.ok) { link.error = `Pixeldrain API: HTTP ${res.status}`; return }
  const data = await res.json()
  const files: PdFile[] = data.files ?? []
  if (!files.length) { link.error = 'Folder is empty'; return }
  link.pdFolderFiles = files
  link.label = `Pixeldrain folder (${files.length} files)`
  // Find first video file and set as default streamUrl
  const videoFile = files.find(f => /\.(mp4|mkv|webm|mov|avi)/i.test(f.name))
  if (videoFile) {
    link.streamUrl = `http://localhost:7071/pd-stream/${videoFile.id}`
    link.title = videoFile.name.replace(/\.[^.]+$/, '')
  } else {
    link.error = 'No video file found in folder'
  }
}


async function resolveIwara(link: VideoLink) {
  const videoId = link.originalUrl.match(/\/video(?:s)?\/([A-Za-z0-9]+)/)?.[1]
  if (!videoId) { link.error = 'Could not parse Iwara video ID'; return }
  const info = await fetch(`https://api.iwara.tv/video/${videoId}`).then(r => r.json())
  link.title = info?.title
  const fileRes = await fetch(`https://api.iwara.tv/video/${videoId}/file`, {
    headers: { 'X-Version': info?.fileUrl?.split('?')[1] ?? '' },
  })
  if (!fileRes.ok) { link.error = 'Iwara API blocked (CORS)'; return }
  const files = await fileRes.json()
  const src = (files as any[]).sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0]
  if (src?.src?.download) link.streamUrl = src.src.download
  else link.error = 'No stream URL found'
}

async function resolvePmvhaven(link: VideoLink) {
  const slug = link.originalUrl.match(/pmvhaven\.com\/video\/([^/?#]+)/)?.[1]
  if (!slug) { link.error = 'Could not parse PMVHaven slug'; return }
  const data = await fetch(`https://pmvhaven.com/api/v2/videoInput?video=${encodeURIComponent(slug)}&mode=InitVideo`).then(r => r.json())
  link.title = data?.title
  const source = (data?.video?.sources as any[] ?? [])[0]
  if (source?.src) link.streamUrl = source.src
  else link.error = 'No stream URL in API response'
}

async function resolveGofile(link: VideoLink) {
  const contentId = link.originalUrl.match(/gofile\.io\/(?:d|f)\/([A-Za-z0-9]+)/)?.[1]
  if (!contentId) { link.error = 'Could not parse Gofile ID'; return }
  const acc = await fetch('https://api.gofile.io/accounts', { method: 'POST' }).then(r => r.json())
  const token = acc?.data?.token
  if (!token) { link.error = 'Could not get Gofile token'; return }
  const data = await fetch(`https://api.gofile.io/contents/${contentId}?wt=4fd6sg89d7s6&token=${token}`).then(r => r.json())
  if (data?.status !== 'ok') { link.error = 'Gofile: not found or private'; return }
  link.title = data?.data?.name
  const children = Object.values(data?.data?.children ?? {}) as any[]
  const vid = children.find(c => c.type === 'file' && /\.(mp4|mkv|webm|mov)/i.test(c.name))
  if (vid?.link) link.streamUrl = vid.link
  else link.error = 'No video file found in Gofile folder'
}

// ─── Expand topic ─────────────────────────────────────────────────────────────
async function toggleExpand(topic: ESTopic) {
  if (expandedId.value === topic.id) { expandedId.value = null; return }
  expandedId.value = topic.id
  if (topic.funscriptUrls !== undefined) return
  topic.loading = true
  try {
    const data  = await apiFetch(`/t/${topic.slug}/${topic.id}.json`)
    const posts: ESPost[] = data?.post_stream?.posts ?? []
    const first = posts[0]
    if (!first) { topic.funscriptUrls = []; topic.videoLinks = []; return }

    const div = document.createElement('div')
    div.innerHTML = first.cooked

    // Script links from <a> tags — use textContent as filename (contains real name)
    const scriptAnchors = Array.from(div.querySelectorAll('a[href]'))
      .filter(a => /\.funscript(\?|$)/i.test((a as HTMLAnchorElement).href))
      .map(a => ({
        url: (a as HTMLAnchorElement).href,
        name: (() => {
          const text = a.textContent?.trim() ?? ''
          return text.toLowerCase().endsWith('.funscript') ? text
            : decodeURIComponent((a as HTMLAnchorElement).href.split('/').pop()?.split('?')[0] ?? 'script.funscript')
        })(),
      }))

    // Attachments uploaded directly to Discourse
    const attachUrls = (first.attachments ?? [])
      .filter(a => a.original_filename.toLowerCase().endsWith('.funscript'))
      .map(a => ({ url: a.url.startsWith('http') ? a.url : BASE + a.url, name: a.original_filename }))

    const seen = new Set<string>()
    const entries: FunscriptEntry[] = []

    for (const { url, name } of scriptAnchors) {
      const proxyUrl = toProxyUrl(url)
      if (seen.has(proxyUrl)) continue; seen.add(proxyUrl)
      const guessed = guessAxisFromFilename(name)
      entries.push({ url: proxyUrl, filename: name, axis: guessed, axisDetected: guessed !== null })
    }
    for (const { url, name } of attachUrls) {
      const proxyUrl = toProxyUrl(url)
      if (seen.has(proxyUrl)) continue; seen.add(proxyUrl)
      const guessed = guessAxisFromFilename(name)
      entries.push({ url: proxyUrl, filename: name, axis: guessed, axisDetected: guessed !== null })
    }

    topic.funscriptUrls = entries
    topic.funscriptUrls = entries
    topic.videoLinks    = detectVideoLinks(first.cooked)

    // Enrich video link titles from link_counts
    const linkCounts: { url: string; title?: string }[] = data?.post_stream?.posts?.[0]?.link_counts ?? []
    for (const lc of linkCounts) {
      if (!lc.title) continue
      const vl = topic.videoLinks.find(v => v.originalUrl === lc.url)
      if (vl) vl.title = lc.title.replace(/\s*~\s*\w+$/, '').replace(/\.[a-z0-9]{2,4}$/i, '').trim()
    }

    // Auto-resolve pixeldrain folders — then match scripts inside them
    const folderLinks = topic.videoLinks.filter(v => (v as any)._pdFolder)
    for (const fl of folderLinks) {
      resolvePixeldrainFolder(fl).then(() => {
        if (!fl.pdFolderFiles) return
        // Find funscript files in the folder and add them to entries if not already present
        const scriptFiles = fl.pdFolderFiles.filter(f => /\.funscript$/i.test(f.name))
        for (const sf of scriptFiles) {
          const url = `http://localhost:7071/pd/${sf.id}`
          if (topic.funscriptUrls!.some(e => e.url === url)) continue
          const guessed = guessAxisFromFilename(sf.name)
          topic.funscriptUrls!.push({ url, filename: sf.name, axis: guessed, axisDetected: true })
        }
      })
    }

    // Auto-detect axes only for entries that still have no axis after filename guessing
    // (shouldn't happen now since we default to L0, but kept as safety net)
    const undetected = entries.filter(e => !e.axisDetected)
    if (undetected.length > 0) Promise.all(undetected.map(e => detectAxis(e)))
  } catch { topic.funscriptUrls = []; topic.videoLinks = [] }
  finally { topic.loading = false }
}

// ─── Proxy-aware fetch ────────────────────────────────────────────────────────
function proxyFetch(url: string) {
  const isProxy = url.startsWith('http://localhost:7071')
  return fetch(url, {
    headers: isProxy && sessionCookie.value ? { 'X-ES-Cookie': sessionCookie.value } : {},
  })
}

// ─── Download script ──────────────────────────────────────────────────────────
async function downloadScript(entry: FunscriptEntry) {
  downloadingScript.value = entry.url
  try {
    const res = await proxyFetch(entry.url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const text = await res.text()
    const blob = new Blob([text], { type: 'application/json' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = entry.filename; a.click()
    URL.revokeObjectURL(a.href)
  } catch (e: any) { error.value = `Download failed: ${e?.message}` }
  finally { downloadingScript.value = null }
}

// ─── Load into player ─────────────────────────────────────────────────────────
async function setVideoForce(name: string, url: string) {
  // Clear first to force v-if recreation of <video> element, then set on next tick
  if (playerStore.videoUrl?.startsWith('blob:')) URL.revokeObjectURL(playerStore.videoUrl)
  playerStore.setVideo('', '')
  await nextTick()
  playerStore.setVideo(name, url)
}

async function loadIntoPlayer(topic: ESTopic, entries: FunscriptEntry[], videoLink: VideoLink) {
  loadingIntoPlayer.value = topic.id
  try {
    if (!videoLink.streamUrl && !videoLink.error) await resolveVideoLink(videoLink)
    if (!videoLink.streamUrl) throw new Error(videoLink.error ?? 'No stream URL')

    // Download scripts — pixeldrain must be sequential (free account = 1 concurrent dl)
    const scriptFiles: File[] = []
    const isPixeldrain = (url: string) => url.includes('localhost:7071/pd/')
    const pdEntries    = entries.filter(e => isPixeldrain(e.url))
    const otherEntries = entries.filter(e => !isPixeldrain(e.url))

    // Non-pixeldrain in parallel
    const otherFiles = await Promise.all(otherEntries.map(async entry => {
      const r = await proxyFetch(entry.url)
      if (!r.ok) throw new Error(`Script fetch failed: HTTP ${r.status} (${entry.filename})`)
      return new File([await r.text()], entry.filename, { type: 'application/json' })
    }))
    scriptFiles.push(...otherFiles)

    // Pixeldrain sequentially — pause between each to let connection close
    for (const entry of pdEntries) {
      const r = await proxyFetch(entry.url)
      if (!r.ok) throw new Error(`Script fetch failed: HTTP ${r.status} (${entry.filename})`)
      scriptFiles.push(new File([await r.text()], entry.filename, { type: 'application/json' }))
      // Small delay to ensure connection is released before next request
      if (pdEntries.indexOf(entry) < pdEntries.length - 1) await new Promise(r => setTimeout(r, 300))
    }

    await loadScriptFiles(scriptFiles, topic.title)
    // Extra delay before opening video stream so pixeldrain releases the script download slots
    if (pdEntries.length > 0 && videoLink.streamUrl?.includes('localhost:7071/pd/')) {
      await new Promise(r => setTimeout(r, 500))
    }
    await setVideoForce(videoLink.title ?? topic.title, videoLink.streamUrl)
  } catch (e: any) { error.value = `Load failed: ${e?.message}` }
  finally { loadingIntoPlayer.value = null }
}

async function streamVideo(videoLink: VideoLink) {
  if (!videoLink.streamUrl && !videoLink.error) await resolveVideoLink(videoLink)
  if (!videoLink.streamUrl) return
  await setVideoForce(videoLink.title ?? videoLink.originalUrl, videoLink.streamUrl)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const tagLabel = (tag: string | { id: number; slug: string; name: string }) =>
  typeof tag === 'string' ? tag : tag.name

function openInBrowser(url: string) { window.open(url, '_blank', 'noopener') }
function formatDate(iso: string) { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) }
function formatNum(n: number) { return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n) }

const PLATFORM_ICON: Record<string, string> = {
  pixeldrain: '🌩', iwara: '🎌', pmvhaven: '🎵', hanime1: '🔞',
  pornhub: '🟠', rule34video: '🔴', twitter: '𝕏', gofile: '📦', mega: '☁️', other: '🔗',
}
// const canResolve = (v: VideoLink) => ['iwara', 'pmvhaven', 'gofile'].includes(v.platform)
const browserOnly = (v: VideoLink) => ['mega', 'twitter', 'pornhub', 'hanime1', 'rule34video'].includes(v.platform)

const listItems = computed(() => tab.value === 'search' ? searchResults.value : topics.value)
</script>

<template>
  <div class="flex flex-col h-full min-h-0 text-xs">

    <!-- ── Header ──────────────────────────────────────────────────────────── -->
    <div class="flex items-center gap-1.5 px-3 py-2 border-b border-white/5 shrink-0">
      <span class="text-[11px] font-semibold text-white/70 flex-1">EroScripts</span>
      <!-- Grid / List toggle -->
      <div class="flex rounded overflow-hidden border border-white/10">
        <button class="px-1.5 py-1 transition-colors"
          :class="viewMode==='list' ? 'bg-white/15 text-white' : 'text-white/30 hover:text-white/60'"
          title="List view" @click="viewMode='list'">
          <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 10h16M4 14h16M4 18h16"/></svg>
        </button>
        <button class="px-1.5 py-1 transition-colors"
          :class="viewMode==='grid' ? 'bg-white/15 text-white' : 'text-white/30 hover:text-white/60'"
          title="Grid view" @click="viewMode='grid'">
          <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"/></svg>
        </button>
      </div>
      <button class="text-[10px] px-1.5 py-0.5 rounded transition-colors shrink-0"
        :class="sessionCookie ? 'text-emerald-400 bg-emerald-900/20 hover:bg-emerald-900/40' : 'text-amber-400 bg-amber-900/20 hover:bg-amber-900/40'"
        @click="showCookieSetup = !showCookieSetup">
        {{ sessionCookie ? '🔑' : '⚠ Setup' }}
      </button>
      <a :href="BASE" target="_blank" rel="noopener" class="text-[10px] text-white/25 hover:text-accent-400 transition-colors">↗</a>
    </div>

    <!-- ── Cookie setup ───────────────────────────────────────────────────── -->
    <Transition name="slide-down">
      <div v-if="showCookieSetup" class="px-3 py-3 border-b border-white/5 shrink-0 flex flex-col gap-2 bg-black/20">
        <p class="text-[11px] font-medium text-white/70">EroScripts Session Cookie</p>
        <p class="text-[10px] text-white/35 leading-relaxed">
          1. Open <a href="https://discuss.eroscripts.com" target="_blank" class="text-accent-400 hover:underline">discuss.eroscripts.com</a> and log in<br>
          2. <kbd class="bg-white/10 px-1 rounded">F12</kbd> → Application → Cookies → <code class="bg-white/10 px-1 rounded">discuss.eroscripts.com</code><br>
          3. Copy the <strong class="text-white/60">value</strong> of <code class="bg-white/10 px-1 rounded">_t</code> (no <code class="bg-white/10 px-0.5 rounded">_t=</code> prefix needed)
        </p>
        <div class="flex gap-1.5">
          <input v-model="cookieDraft" class="input flex-1 text-xs py-1 font-mono" placeholder="paste value here…" @keydown.enter="saveCookie" />
          <button class="btn-primary text-[11px] px-2 py-1 shrink-0" @click="saveCookie">Save</button>
        </div>
        <p v-if="sessionCookie" class="text-[10px] text-emerald-400/70">✓ Saved — expires ~1 month</p>
      </div>
    </Transition>

    <!-- ── Tabs ──────────────────────────────────────────────────────────── -->
    <div class="flex border-b border-white/5 shrink-0">
      <button v-for="t in (['browse','search'] as const)" :key="t"
        class="flex-1 py-1.5 text-[11px] font-medium transition-colors capitalize border-b-2 -mb-px"
        :class="tab===t ? 'text-accent-400 border-accent-500' : 'text-white/30 border-transparent hover:text-white/60'"
        @click="tab=t">{{ t }}</button>
    </div>

    <!-- ── Proxy not running ──────────────────────────────────────────────── -->
    <div v-if="corsBlocked" class="px-3 py-4 flex flex-col gap-2.5 text-center">
      <p class="text-amber-400 text-[11px] font-medium">⚠ Proxy not running</p>
      <p class="text-white/35 text-[10px] leading-relaxed">Launch via <code class="bg-white/10 px-1 rounded">start.bat</code> — it starts the proxy automatically.</p>
      <a :href="BASE" target="_blank" rel="noopener" class="btn-primary text-[11px] px-3 py-1.5 text-center">Open EroScripts ↗</a>
    </div>

    <div v-else-if="error" class="px-3 py-2 text-red-400 text-[11px] flex items-center gap-2">
      <span class="flex-1">{{ error }}</span>
      <button class="text-white/30 hover:text-white/60" @click="error=null">✕</button>
    </div>

    <template v-else>
      <!-- ── Browse controls ───────────────────────────────────────────────── -->
      <div v-if="tab==='browse'" class="flex items-center gap-1 px-2 py-1.5 border-b border-white/5 shrink-0">
        <button v-for="s in (['latest','top','hot'] as const)" :key="s"
          class="chip" :class="sort===s?'chip-active':''" @click="sort=s">{{ s }}</button>
        <div class="flex-1" />
        <button class="btn-ghost px-1.5 py-1" @click="loadTopics(true)">
          <svg class="w-3 h-3" :class="loading?'animate-spin':''" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
          </svg>
        </button>
      </div>

      <!-- ── Tag bar with search ───────────────────────────────────────────── -->
      <div v-if="tab==='browse' && availableTags.length > 0" class="border-b border-white/5 shrink-0">
        <div class="px-2 pt-1.5 pb-1">
          <input v-model="tagSearch" class="input w-full py-0.5 h-6 text-[11px]" placeholder="Filter tags…" />
        </div>
        <div class="flex items-center gap-1 px-2 pb-1.5 overflow-x-auto scrollbar-none">
          <button class="chip shrink-0" :class="activeTag===null?'chip-active':''" @click="selectTag(null)">All</button>
          <button v-for="tag in filteredTags" :key="tag.id"
            class="chip shrink-0" :class="activeTag?.id===tag.id?'chip-active':''"
            @click="selectTag(tag)">{{ tag.name }}</button>
          <span v-if="tagSearch && filteredTags.length===0" class="text-[10px] text-white/25 px-1 shrink-0">No match</span>
        </div>
      </div>

      <!-- ── Search bar ────────────────────────────────────────────────────── -->
      <div v-if="tab==='search'" class="px-2 py-2 border-b border-white/5 shrink-0 flex gap-1">
        <input v-model="search" class="input flex-1 py-1 h-7 text-xs" placeholder="Search scripts…"
          @input="onSearchInput" @keydown.enter="doSearch" />
        <button class="btn-ghost px-2 py-1" :disabled="searchLoading" @click="doSearch">
          <svg class="w-3.5 h-3.5" :class="searchLoading?'animate-spin':''" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
          </svg>
        </button>
      </div>

      <!-- ── Loading skeletons ─────────────────────────────────────────────── -->
      <div v-if="loading && listItems.length === 0" class="flex-1 p-2"
        :class="viewMode==='grid' ? 'grid grid-cols-2 gap-2 content-start' : 'flex flex-col gap-2'">
        <div v-for="i in 8" :key="i" class="rounded-lg bg-white/5 animate-pulse"
          :class="viewMode==='grid' ? 'aspect-video' : 'h-14'" />
      </div>

      <div v-else-if="tab==='search' && searchDone && searchResults.length===0"
        class="flex-1 flex items-center justify-center text-white/30">No results for "{{ search }}"</div>

      <!-- ── Topic list / grid ─────────────────────────────────────────────── -->
      <div v-else class="flex-1 overflow-y-auto">

        <!-- GRID -->
        <div v-if="viewMode==='grid'" class="grid grid-cols-2 gap-2 p-2">
          <div v-for="topic in listItems" :key="topic.id"
            class="relative rounded-lg overflow-hidden bg-surface-800 cursor-pointer border border-white/5 hover:border-accent-500/40 transition-colors group"
            @click="toggleExpand(topic)">
            <div class="aspect-video bg-surface-900">
              <img v-if="topic.image_url" :src="topic.image_url" class="w-full h-full object-cover" alt="" />
              <div v-else class="w-full h-full flex items-center justify-center opacity-10">
                <svg class="w-8 h-8" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
              </div>
            </div>
            <!-- Hover title overlay -->
            <div class="absolute inset-0 bg-gradient-to-t from-black/85 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex flex-col justify-end p-1.5 pointer-events-none">
              <p class="text-[10px] text-white font-medium line-clamp-2 leading-tight">{{ topic.title }}</p>
              <div class="flex gap-1.5 mt-0.5">
                <span class="text-[8px] text-white/50">♥ {{ formatNum(topic.like_count) }}</span>
                <span class="text-[8px] text-white/50">👁 {{ formatNum(topic.views) }}</span>
              </div>
            </div>
            <!-- Expanded overlay for grid -->
            <Transition name="fade-quick">
              <div v-if="expandedId===topic.id"
                class="absolute inset-0 bg-black/92 overflow-y-auto p-2 flex flex-col gap-1.5 z-10">
                <div class="flex items-start justify-between gap-1 mb-0.5">
                  <p class="text-[10px] text-white/70 font-medium line-clamp-2 flex-1 leading-tight">{{ topic.title }}</p>
                  <button class="text-white/30 hover:text-white shrink-0 text-sm leading-none" @click.stop="expandedId=null">✕</button>
                </div>
                <div v-if="topic.loading" class="flex items-center gap-1.5 text-white/30 text-[10px]">
                  <div class="w-2.5 h-2.5 rounded-full border border-white/20 border-t-white/60 animate-spin" />Fetching…
                </div>
                <template v-else>
                  <div v-for="vl in topic.videoLinks" :key="vl.originalUrl" class="flex items-center gap-1 min-w-0">
                    <span class="text-xs shrink-0">{{ PLATFORM_ICON[vl.platform] }}</span>
                    <span class="text-[9px] text-white/50 flex-1 truncate">{{ vl.label }}</span>
                    <button v-if="vl.streamUrl" class="text-[9px] px-1.5 py-0.5 rounded bg-white/10 hover:bg-white/20 shrink-0" @click.stop="streamVideo(vl)">▶</button>
                    <button v-if="vl.streamUrl && topic.funscriptUrls?.length" class="text-[9px] px-1.5 py-0.5 rounded bg-accent-600 hover:bg-accent-500 text-white shrink-0" @click.stop="loadIntoPlayer(topic, topic.funscriptUrls!, vl)">▶+S</button>
                    <button v-else-if="canResolve(vl) && !vl.error" class="text-[9px] px-1.5 py-0.5 rounded bg-white/10 hover:bg-white/20 shrink-0" @click.stop="resolveVideoLink(vl)">↻</button>
                    <button class="text-[9px] px-1 py-0.5 rounded bg-white/5 hover:bg-white/10 shrink-0" @click.stop="openInBrowser(vl.originalUrl)">↗</button>
                  </div>
                  <div v-for="entry in topic.funscriptUrls" :key="entry.url"
                    class="flex items-center gap-1 bg-accent-600/20 rounded px-1.5 py-1 min-w-0">
                    <!-- Axis badge -->
                    <span v-if="entry.axis" class="text-[8px] text-accent-300 bg-accent-900/40 px-1 rounded shrink-0 font-mono">{{ entry.axis }}</span>
                    <button v-else-if="!entry.axisDetected" class="text-[8px] text-white/25 hover:text-white/60 shrink-0" title="Detect axis" @click.stop="detectAxis(entry)">?</button>
                    <span v-else class="text-[8px] text-white/20 shrink-0">?</span>
                    <span class="text-[9px] text-accent-200 flex-1 truncate">{{ entry.filename }}</span>
                    <button class="text-[9px] px-1 py-0.5 rounded bg-white/10 hover:bg-white/20 shrink-0" @click.stop="downloadScript(entry)">↓</button>
                  </div>
                  <button v-if="!topic.funscriptUrls?.length && !topic.videoLinks?.length" class="text-[9px] text-white/25 mt-1" @click.stop="openInBrowser(`${BASE}/t/${topic.slug}/${topic.id}`)">Open post ↗</button>
                </template>
              </div>
            </Transition>
          </div>
        </div>

        <!-- LIST -->
        <template v-else>
          <div v-for="topic in listItems" :key="topic.id" class="border-b border-white/[0.05]">
            <!-- Row -->
            <div class="flex items-start gap-2 px-3 py-2.5 hover:bg-white/5 transition-colors cursor-pointer" @click="toggleExpand(topic)">
              <div class="w-12 h-8 rounded shrink-0 bg-surface-800 overflow-hidden mt-0.5">
                <img v-if="topic.image_url" :src="topic.image_url" class="w-full h-full object-cover" alt="" />
                <div v-else class="w-full h-full flex items-center justify-center opacity-20">
                  <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                </div>
              </div>
              <div class="flex-1 min-w-0">
                <p class="text-[11px] text-white/80 leading-tight line-clamp-2">{{ topic.title }}</p>
                <div class="flex items-center gap-2 mt-1 flex-wrap">
                  <span class="text-[9px] text-white/25">{{ formatDate(topic.created_at) }}</span>
                  <span class="text-[9px] text-white/25">👁 {{ formatNum(topic.views) }}</span>
                  <span class="text-[9px] text-white/25">♥ {{ formatNum(topic.like_count) }}</span>
                  <span v-for="tag in topic.tags.slice(0,3)" :key="tagLabel(tag)"
                    class="text-[8px] px-1 py-px rounded bg-white/5 text-white/30">{{ tagLabel(tag) }}</span>
                </div>
              </div>
              <svg class="w-3 h-3 text-white/20 shrink-0 mt-1 transition-transform" :class="expandedId===topic.id?'rotate-180':''"
                fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
              </svg>
            </div>

            <!-- Expanded -->
            <Transition name="slide-down">
              <div v-if="expandedId===topic.id" class="bg-black/25 border-t border-white/5">
                <div v-if="topic.loading" class="flex items-center gap-2 px-3 py-3 text-white/30 text-[11px]">
                  <div class="w-3 h-3 rounded-full border border-white/20 border-t-white/60 animate-spin" />Fetching post…
                </div>
                <template v-else>

                  <!-- Video sources -->
                  <div v-if="topic.videoLinks && topic.videoLinks.length > 0" class="px-3 pt-2.5 pb-2">
                    <p class="text-[10px] text-white/35 mb-1.5 font-medium uppercase tracking-wider">Video Sources</p>
                    <div class="flex flex-col gap-1.5">
                      <div v-for="vl in topic.videoLinks" :key="vl.originalUrl"
                        class="rounded-lg border border-white/8 bg-surface-800/60 overflow-hidden">
                        <div class="flex items-center gap-1.5 px-2 py-1.5">
                          <span class="text-sm leading-none">{{ PLATFORM_ICON[vl.platform] }}</span>
                          <span class="text-[11px] font-medium text-white/70 flex-1">{{ vl.label }}</span>
                          <span v-if="vl.streamUrl" class="text-[9px] text-emerald-400 bg-emerald-900/30 px-1.5 py-0.5 rounded-full">✓ streamable</span>
                          <span v-else-if="vl.resolving" class="text-[9px] text-white/30 animate-pulse">resolving…</span>
                          <span v-else-if="browserOnly(vl) || vl.error" class="text-[9px] text-white/25">browser only</span>
                        </div>
                        <p v-if="vl.error && !browserOnly(vl)" class="px-2 pb-1.5 text-[10px] text-red-400/70">{{ vl.error }}</p>

                        <!-- Folder file list (pixeldrain /l/ folders) -->
                        <div v-if="vl.pdFolderFiles && vl.pdFolderFiles.length > 0" class="px-2 pb-2">
                          <p class="text-[9px] text-white/25 mb-1 uppercase tracking-wider">Files in folder</p>
                          <div class="flex flex-col gap-0.5 max-h-36 overflow-y-auto">
                            <div v-for="f in vl.pdFolderFiles" :key="f.id"
                              class="flex items-center gap-1.5 rounded px-1.5 py-1 text-[10px]"
                              :class="/\.(mp4|mkv|webm|mov|avi)/i.test(f.name) ? 'bg-white/5 hover:bg-white/10' : /\.funscript$/i.test(f.name) ? 'bg-accent-900/20' : 'bg-white/3 opacity-40'">
                              <span class="shrink-0">{{ /\.(mp4|mkv|webm|mov|avi)/i.test(f.name) ? '🎬' : /\.funscript$/i.test(f.name) ? '📜' : '📄' }}</span>
                              <span class="flex-1 truncate text-white/60" :title="f.name">{{ f.name }}</span>
                              <span class="text-white/20 shrink-0 text-[9px]">{{ (f.size / 1048576).toFixed(1) }}MB</span>
                              <!-- Video file: set as active stream -->
                              <button v-if="/\.(mp4|mkv|webm|mov|avi)/i.test(f.name)"
                                class="shrink-0 text-[9px] px-1.5 py-0.5 rounded transition-colors"
                                :class="vl.streamUrl === `http://localhost:7071/pd-stream/${f.id}` ? 'bg-emerald-700 text-white' : 'bg-white/10 hover:bg-white/20 text-white/60'"
                                @click.stop="vl.streamUrl = `http://localhost:7071/pd-stream/${f.id}`; vl.title = f.name.replace(/\.[^.]+$/, '')">
                                {{ vl.streamUrl === `http://localhost:7071/pd-stream/${f.id}` ? '✓' : 'Select' }}
                              </button>
                            </div>
                          </div>
                        </div>

                        <div class="flex gap-1 px-2 pb-1.5 flex-wrap">
                          <button v-if="canResolve(vl) && !vl.streamUrl && !vl.error"
                            class="btn-ghost text-[10px] px-2 py-0.5 flex items-center gap-1" @click.stop="resolveVideoLink(vl)">
                            <svg class="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>Resolve
                          </button>
                          <button v-if="vl.streamUrl" class="btn-ghost text-[10px] px-2 py-0.5 flex items-center gap-1 text-white/60" @click.stop="streamVideo(vl)">
                            <svg class="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>Play
                          </button>
                          <template v-if="vl.streamUrl && topic.funscriptUrls?.length">
                            <button
                              class="text-[10px] px-2 py-0.5 rounded bg-accent-600 hover:bg-accent-500 text-white transition-colors flex items-center gap-1"
                              :disabled="loadingIntoPlayer===topic.id"
                              @click.stop="loadIntoPlayer(topic, topic.funscriptUrls!, vl)">
                              <svg v-if="loadingIntoPlayer===topic.id" class="w-2.5 h-2.5 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9"/></svg>
                              <svg v-else class="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                              ▶ Play + {{ topic.funscriptUrls!.length > 1 ? `${topic.funscriptUrls!.length} Scripts` : 'Script' }}
                            </button>
                          </template>
                          <button class="btn-ghost text-[10px] px-2 py-0.5 flex items-center gap-1 ml-auto" @click.stop="openInBrowser(vl.originalUrl)">
                            <svg class="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>↗
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>

                  <!-- Funscripts -->
                  <div v-if="topic.funscriptUrls !== undefined" class="px-3 pt-2 pb-2.5">
                    <p class="text-[10px] text-white/35 mb-1.5 font-medium uppercase tracking-wider">
                      Funscripts <span class="text-white/20 normal-case font-normal ml-1">{{ topic.funscriptUrls.length ? `(${topic.funscriptUrls.length})` : '' }}</span>
                    </p>
                    <div v-if="topic.funscriptUrls.length === 0" class="text-[10px] text-white/25 italic">No direct .funscript links found.</div>
                    <div v-else class="flex flex-col gap-1">
                      <div v-for="entry in topic.funscriptUrls" :key="entry.url"
                        class="flex items-center gap-1.5 bg-surface-800/60 rounded-lg px-2 py-1.5 border border-white/5">
                        <!-- Axis badge -->
                        <div class="shrink-0 w-14 flex justify-center">
                          <span v-if="entry.axis === ''" class="text-[8px] text-white/25 animate-pulse">detecting…</span>
                          <span v-else-if="entry.axis" class="text-[9px] font-mono font-bold text-accent-300 bg-accent-900/40 px-1.5 py-0.5 rounded" :title="axisLabel(entry.axis)">{{ entry.axis }}</span>
                          <button v-else class="text-[9px] text-white/25 hover:text-white/60 border border-white/10 hover:border-white/30 px-1.5 py-0.5 rounded transition-colors"
                            title="Click to detect axis from file content"
                            @click.stop="detectAxis(entry)">detect</button>
                        </div>
                        <span class="text-[10px] text-white/55 flex-1 truncate" :title="entry.url">{{ entry.filename }}</span>
                        <button class="text-[10px] px-1.5 py-0.5 rounded bg-white/10 hover:bg-white/15 text-white/60 transition-colors shrink-0 flex items-center gap-1"
                          :disabled="downloadingScript===entry.url" @click.stop="downloadScript(entry)">
                          <svg v-if="downloadingScript===entry.url" class="w-2 h-2 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9"/></svg>
                          <svg v-else class="w-2 h-2" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
                          Save
                        </button>
                      </div>
                    </div>
                  </div>

                  <div class="px-3 pb-2.5">
                    <button class="btn-ghost w-full text-[11px] py-1 flex items-center justify-center gap-1.5"
                      @click.stop="openInBrowser(`${BASE}/t/${topic.slug}/${topic.id}`)">
                      <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>
                      Open full post
                    </button>
                  </div>
                </template>
              </div>
            </Transition>
          </div>
        </template>

        <!-- Load more -->
        <div v-if="tab==='browse' && hasMore && !loading && listItems.length > 0" class="p-3 text-center">
          <button class="btn-ghost text-xs px-4 py-1.5" @click="loadTopics(false)">Load more</button>
        </div>
        <div v-if="loading && listItems.length > 0" class="p-3 flex justify-center">
          <div class="w-4 h-4 rounded-full border border-white/20 border-t-accent-400 animate-spin" />
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.scrollbar-none { scrollbar-width: none; }
.scrollbar-none::-webkit-scrollbar { display: none; }
.chip {
  padding: 0.15rem 0.5rem; border-radius: 9999px; border: 1px solid rgba(255,255,255,0.1);
  color: rgba(255,255,255,0.4); font-size: 11px; transition: all 0.15s;
  white-space: nowrap; cursor: pointer; text-transform: capitalize;
}
.chip:hover { color: rgba(255,255,255,0.7); border-color: rgba(255,255,255,0.2); }
.chip-active { border-color: var(--accent,rgb(99,102,241)); color:white; font-weight:600; background:var(--accent-dim,rgba(99,102,241,0.2)); }
.line-clamp-2 { display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.slide-down-enter-active, .slide-down-leave-active { transition: all 0.2s ease; overflow: hidden; }
.slide-down-enter-from, .slide-down-leave-to { opacity: 0; max-height: 0; }
.slide-down-enter-to, .slide-down-leave-from { opacity: 1; max-height: 900px; }
.fade-quick-enter-active, .fade-quick-leave-active { transition: opacity 0.15s; }
.fade-quick-enter-from, .fade-quick-leave-to { opacity: 0; }
</style>
