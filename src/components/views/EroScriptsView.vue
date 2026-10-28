<script lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
</script>

<script setup lang="ts">
import type { StreamHost, StreamItem, StreamSource } from '~/lib/streamHosts'
import { useIntersectionObserver } from '@vueuse/core'
import { useFunscript } from '~/composables/useFunscript'
import { downloadPost, downloads } from '~/composables/usePostDownload'
import { installYtdlp, playSource, resolveStream, StreamError, ytdlp } from '~/composables/useStreams'
import { toast } from '~/composables/useToast'
import { classifyPostScripts, scriptsForVideo } from '~/lib/postScripts'
import { detectStreamHost } from '~/lib/streamHosts'
import { usePlayerStore } from '~/stores/playerStore'
import { useUiStore } from '~/stores/uiStore'

// ─── Types ────────────────────────────────────────────────────────────────────
interface ESTag { id: number, name: string, slug: string }

interface ESTopic {
  id: number
  title: string
  slug: string
  views: number
  like_count: number
  created_at: string
  category_id: number
  tags: (string | ESTag)[]
  image_url: string | null
  funscriptUrls?: FunscriptEntry[]
  videoLinks?: VideoLink[]
  loading?: boolean
}

interface FunscriptEntry {
  url: string
  filename: string
  /** null = unknown, '' = detecting */
  axis: string | null
  axisDetected: boolean
}

interface ESPost {
  id: number
  cooked: string
  attachments?: { url: string, original_filename: string }[]
  link_counts?: { url: string, title?: string }[]
}

interface PdFile { id: string, name: string, size: number, mime_type: string }

interface VideoLink {
  host: StreamHost
  originalUrl: string
  title?: string
  state: 'idle' | 'resolving' | 'ready' | 'error' | 'needs-ytdlp'
  error?: string
  /** Resolved videos (a folder gives several), each with its qualities. */
  items: StreamItem[]
  item: number
  source: number
}

defineOptions({ name: 'EroScriptsView' })
// Browse state lives at module scope so leaving the view and coming back finds
// the same results, scroll aside, instead of refetching from page one.
const topics = ref<ESTopic[]>([])
const page = ref(0)
const hasMore = ref(true)
const sort = ref<'latest' | 'top' | 'hot'>('latest')
const availableTags = ref<ESTag[]>([])
const activeTag = ref<ESTag | null>(null)
const query = ref('')
const searchResults = ref<ESTopic[]>([])
const searchedFor = ref('')
const openTopic = ref<ESTopic | null>(null)

const BASE = 'https://discuss.eroscripts.com'
const PROXY = 'http://localhost:7071'
const SCRIPTS_PATH = '/c/scripts/free-scripts/14/l'
const SCRIPTS_TAG_BASE = '/tags/c/scripts/free-scripts/14'

const { loadScriptFiles } = useFunscript()
const player = usePlayerStore()
const ui = useUiStore()

function lsGet(key: string) {
  try {
    return localStorage.getItem(key)
  }
  catch {
    return null
  }
}
function lsSet(key: string, value: string | null) {
  try {
    if (value === null)
      localStorage.removeItem(key)
    else
      localStorage.setItem(key, value)
  }
  catch {}
}

// ─── Session cookie ───────────────────────────────────────────────────────────
const COOKIE_KEY = 'ph:eroscripts.cookie'
const sessionCookie = ref(lsGet(COOKIE_KEY) ?? '')
const cookieOpen = ref(false)
const cookieDraft = ref('')

function openCookie() {
  cookieDraft.value = sessionCookie.value.replace(/^_t=/, '')
  cookieOpen.value = true
}
function saveCookie() {
  const v = cookieDraft.value.trim()
  if (!v)
    return
  sessionCookie.value = v.startsWith('_t=') ? v : `_t=${v}`
  lsSet(COOKIE_KEY, sessionCookie.value)
  cookieOpen.value = false
  toast.success('Session saved', { icon: 'i-carbon-key', detail: 'It lasts about a month' })
  void reload()
}
function forgetCookie() {
  sessionCookie.value = ''
  lsSet(COOKIE_KEY, null)
  cookieOpen.value = false
}

// ─── Proxy ────────────────────────────────────────────────────────────────────
/** A TypeError from fetch means nothing answered on the proxy port. */
const proxyDown = ref(false)
const error = ref<string | null>(null)
/** The last error was the forum treating us as logged out. */
const needsSession = ref(false)

async function apiFetch(path: string) {
  const res = await fetch(`${PROXY}${path}`, {
    headers: {
      Accept: 'application/json',
      ...(sessionCookie.value ? { 'X-ES-Cookie': sessionCookie.value } : {}),
    },
  })
  proxyDown.value = false
  needsSession.value = false
  if (!res.ok) {
    // Free Scripts is hidden from logged-out visitors, and Discourse says so
    // with a 404 rather than a 403: an expired cookie looks like a dead link.
    const loggedOut = res.status === 403 || (res.status === 404 && /\/c\/|\/latest\.json|\/top\.json|\/tags\//.test(path))
    needsSession.value = loggedOut
    throw new Error(loggedOut
      ? sessionCookie.value
        ? 'EroScripts treats you as logged out: the session cookie has expired. Paste a fresh one'
        : 'Free Scripts is only shown to logged-in members: add your EroScripts session cookie'
      : res.status === 502 || res.status === 504
        ? 'Could not reach EroScripts. If it is blocked on your network, set a proxy in Settings → Network'
        : `EroScripts answered HTTP ${res.status}`)
  }
  return res.json()
}

function fail(e: any, fallback: string) {
  if (e instanceof TypeError)
    proxyDown.value = true
  else
    error.value = e?.message ?? fallback
}

/** Proxy-aware fetch for script and file URLs: only the proxy gets the cookie. */
function proxyFetch(url: string) {
  return fetch(url, {
    headers: url.startsWith(PROXY) && sessionCookie.value ? { 'X-ES-Cookie': sessionCookie.value } : {},
  })
}

const copied = ref(false)
async function copyCommand() {
  try {
    await navigator.clipboard.writeText('pnpm dev:proxy')
    copied.value = true
    setTimeout(() => (copied.value = false), 1500)
  }
  catch {}
}

// ─── View mode ────────────────────────────────────────────────────────────────
const viewMode = ref<'grid' | 'list'>(lsGet('ph:ui.eroscripts.view') === 'list' ? 'list' : 'grid')
watch(viewMode, v => lsSet('ph:ui.eroscripts.view', v))

// ─── Browse ───────────────────────────────────────────────────────────────────
const loading = ref(false)

async function loadTopics(reset = false) {
  if (loading.value)
    return
  if (reset) {
    page.value = 0
    hasMore.value = true
  }
  loading.value = true
  error.value = null
  try {
    const slug = sort.value
    const pageParam = page.value > 0 ? `?page=${page.value}` : ''
    const endpoint = activeTag.value
      ? `${SCRIPTS_TAG_BASE}/${activeTag.value.slug}/${activeTag.value.id}/l/${slug}.json${pageParam}`
      : `${SCRIPTS_PATH}/${slug}.json${pageParam}`
    const data = await apiFetch(endpoint)
    const list: ESTopic[] = data?.topic_list?.topics ?? []
    if (reset && !activeTag.value && data?.topic_list?.top_tags?.length)
      availableTags.value = data.topic_list.top_tags
    if (reset)
      topics.value = list
    else
      topics.value = [...topics.value, ...list]
    if (list.length === 0)
      hasMore.value = false
    else
      page.value++
  }
  catch (e) {
    fail(e, 'Could not load scripts')
  }
  finally {
    loading.value = false
  }
}

function reload() {
  return searching.value ? doSearch() : loadTopics(true)
}

function selectTag(tag: ESTag | null) {
  activeTag.value = activeTag.value?.id === tag?.id ? null : tag
  void loadTopics(true)
}
watch(sort, () => void loadTopics(true))

onMounted(() => {
  if (!topics.value.length)
    void loadTopics(true)
})

const tagFilter = ref('')
const shownTags = computed(() => {
  const q = tagFilter.value.toLowerCase().trim()
  return q ? availableTags.value.filter(t => t.name.toLowerCase().includes(q)) : availableTags.value
})

// ─── Search ───────────────────────────────────────────────────────────────────
const searchLoading = ref(false)
const searching = computed(() => !!query.value.trim())
let searchTimer: ReturnType<typeof setTimeout> | undefined

watch(query, (q) => {
  clearTimeout(searchTimer)
  if (!q.trim()) {
    searchResults.value = []
    searchedFor.value = ''
    return
  }
  searchTimer = setTimeout(doSearch, 450)
})

async function doSearch() {
  clearTimeout(searchTimer)
  const q = query.value.trim()
  if (!q)
    return
  searchLoading.value = true
  error.value = null
  try {
    const data = await apiFetch(`/search.json?q=${encodeURIComponent(q)}&category=scripts`)
    searchResults.value = (data?.topics ?? []) as ESTopic[]
    searchedFor.value = q
  }
  catch (e) {
    fail(e, 'Search failed')
  }
  finally {
    searchLoading.value = false
  }
}

const items = computed(() => (searching.value ? searchResults.value : topics.value))
const busy = computed(() => (searching.value ? searchLoading.value : loading.value))

// Infinite scroll: fetch the next page as the bottom comes into view.
const sentinel = ref<HTMLElement | null>(null)
useIntersectionObserver(sentinel, ([e]) => {
  if (e?.isIntersecting && !searching.value && hasMore.value && !loading.value && topics.value.length && !proxyDown.value)
    void loadTopics(false)
}, { rootMargin: '400px' })

// ─── Axis detection ───────────────────────────────────────────────────────────
const AXIS_NAMES: Record<string, string> = {
  L0: 'Stroke',
  L1: 'Surge',
  L2: 'Sway',
  R0: 'Twist',
  R1: 'Roll',
  R2: 'Pitch',
  A10V: 'Vibe',
}
const AXIS_WORD_MAP: Record<string, string> = {
  STROKE: 'L0',
  SURGE: 'L1',
  SWAY: 'L2',
  TWIST: 'R0',
  ROLL: 'R1',
  PITCH: 'R2',
  VIBRAT: 'A10V',
  VIBE: 'A10V',
}

function guessAxisFromFilename(name: string): string {
  const upper = name.toUpperCase().replace('.FUNSCRIPT', '')
  // Exact axis code: _L0, .L0, (L0), -L0, " L0"
  for (const axis of Object.keys(AXIS_NAMES)) {
    if (new RegExp(`[^A-Z0-9]${axis}([^A-Z0-9]|$)`).test(upper) || upper.endsWith(axis))
      return axis
  }
  // A word: .roll. .pitch. _twist_
  for (const [word, axis] of Object.entries(AXIS_WORD_MAP)) {
    if (new RegExp(`[^A-Z]${word}[^A-Z]|^${word}[^A-Z]|[^A-Z]${word}$`).test(upper))
      return axis
  }
  // No hint at all is the plain stroke script, which needs no fetch to confirm.
  return 'L0'
}

function axisLabel(axis: string) {
  const upper = axis.toUpperCase()
  return AXIS_NAMES[upper] ? `${upper} · ${AXIS_NAMES[upper]}` : axis
}

async function detectAxis(entry: FunscriptEntry) {
  if (entry.axisDetected)
    return
  entry.axis = ''
  try {
    const res = await proxyFetch(entry.url)
    if (!res.ok)
      throw new Error(`HTTP ${res.status}`)
    const json = await res.json()
    if (Array.isArray(json.axes) && json.axes.length > 0)
      entry.axis = json.axes.map((a: any) => String(a.id ?? a.name ?? '').toUpperCase()).filter(Boolean).join('+') || 'L0'
    else if (typeof json.axes === 'string')
      entry.axis = json.axes.toUpperCase()
    else if (Array.isArray(json.actions))
      entry.axis = 'L0'
    else if (json.metadata?.axes)
      entry.axis = String(json.metadata.axes).toUpperCase()
    else
      entry.axis = null
  }
  catch {
    entry.axis = null
  }
  finally {
    entry.axisDetected = true
  }
}

// ─── Links in a post ──────────────────────────────────────────────────────────
// Relative hrefs in Discourse HTML resolve against this dev server's origin, and
// forum URLs need the session cookie, so both are routed through the proxy.
function toProxyUrl(url: string): string {
  try {
    const u = new URL(url)
    if ((u.hostname === 'localhost' && u.port !== '7071') || u.hostname === 'discuss.eroscripts.com')
      return `${PROXY}${u.pathname}${u.search}`
    return url
  }
  catch {
    return url
  }
}

function detectVideoLinks(html: string): VideoLink[] {
  const div = document.createElement('div')
  div.innerHTML = html
  const hrefs = [...new Set(Array.from(div.querySelectorAll('a[href]'), a => (a as HTMLAnchorElement).href))]
  const links: VideoLink[] = []
  for (const href of hrefs) {
    const host = detectStreamHost(href)
    if (host)
      links.push({ host, originalUrl: href, state: 'idle', items: [], item: 0, source: 0 })
  }
  return links
}

/** The source a link would play right now. */
const chosenSource = (v: VideoLink): StreamSource | null => v.items[v.item]?.sources[v.source] ?? null
const chosenTitle = (v: VideoLink, fallback: string) => (v.items.length > 1 ? v.items[v.item]?.title : null) ?? v.title ?? v.items[0]?.title ?? fallback

/** Ask the proxy to turn the link into streams. Safe to call repeatedly. */
async function resolveVideoLink(link: VideoLink) {
  if (link.state === 'resolving' || link.state === 'ready')
    return
  link.state = 'resolving'
  link.error = undefined
  try {
    const r = await resolveStream(link.originalUrl)
    link.items = r.items
    link.item = 0
    link.source = 0
    link.title ??= r.items.length === 1 ? r.items[0].title.replace(/\.[a-z0-9]{2,4}$/i, '') : undefined
    link.state = 'ready'
  }
  catch (e: any) {
    link.error = e?.message ?? 'Could not resolve'
    link.state = e instanceof StreamError && e.code === 'needs-ytdlp' ? 'needs-ytdlp' : 'error'
  }
}

function retryLink(link: VideoLink) {
  link.state = 'idle'
  void resolveVideoLink(link)
}

function chooseItem(link: VideoLink, i: number) {
  link.item = i
  link.source = 0
}

/** Fetch yt-dlp (on the user's say-so) and try the link again. */
async function getYtdlp(link: VideoLink) {
  try {
    await installYtdlp()
    toast.success('yt-dlp is ready', { detail: ytdlp.value?.version ?? undefined, icon: 'i-carbon-checkmark' })
    link.state = 'idle'
    await resolveVideoLink(link)
  }
  catch (e: any) {
    toast.error('Could not get yt-dlp', { detail: e?.message })
  }
}

/** Pixeldrain folders often hold the scripts too: add any .funscript inside. */
async function addPixeldrainFolderScripts(topic: ESTopic, link: VideoLink) {
  const id = link.originalUrl.match(/pixeldrain\.com\/l\/([A-Z0-9]+)/i)?.[1]
  if (!id)
    return
  try {
    // The list API is public; no proxy or cookie needed.
    const files: PdFile[] = (await fetch(`https://pixeldrain.com/api/list/${id}`).then(r => r.json())).files ?? []
    for (const sf of files.filter(f => /\.funscript$/i.test(f.name))) {
      const url = `${PROXY}/pd/${sf.id}`
      if (!topic.funscriptUrls!.some(e => e.url === url))
        topic.funscriptUrls!.push({ url, filename: sf.name, axis: guessAxisFromFilename(sf.name), axisDetected: true })
    }
  }
  catch {}
}

// ─── Topic detail ─────────────────────────────────────────────────────────────
async function loadDetail(topic: ESTopic) {
  if (topic.funscriptUrls !== undefined || topic.loading)
    return
  topic.loading = true
  try {
    const data = await apiFetch(`/t/${topic.slug}/${topic.id}.json`)
    const first: ESPost | undefined = data?.post_stream?.posts?.[0]
    if (!first) {
      topic.funscriptUrls = []
      topic.videoLinks = []
      return
    }

    const div = document.createElement('div')
    div.innerHTML = first.cooked

    // Anchor text usually carries the real filename; the href is often a hash.
    const anchors = Array.from(div.querySelectorAll<HTMLAnchorElement>('a[href]'))
      .filter(a => /\.funscript(?:\?|$)/i.test(a.href))
      .map((a) => {
        const text = a.textContent?.trim() ?? ''
        const name = text.toLowerCase().endsWith('.funscript')
          ? text
          : decodeURIComponent(a.href.split('/').pop()?.split('?')[0] ?? 'script.funscript')
        return { url: a.href, name }
      })
    // Files uploaded straight to the forum.
    const attachments = (first.attachments ?? [])
      .filter(a => a.original_filename.toLowerCase().endsWith('.funscript'))
      .map(a => ({ url: a.url.startsWith('http') ? a.url : BASE + a.url, name: a.original_filename }))

    const seen = new Set<string>()
    const entries: FunscriptEntry[] = []
    for (const { url, name } of [...anchors, ...attachments]) {
      const proxied = toProxyUrl(url)
      if (seen.has(proxied))
        continue
      seen.add(proxied)
      entries.push({ url: proxied, filename: name, axis: guessAxisFromFilename(name), axisDetected: true })
    }
    topic.funscriptUrls = entries
    topic.videoLinks = detectVideoLinks(first.cooked)

    // Link titles from the forum's link crawler beat a bare URL.
    for (const lc of first.link_counts ?? []) {
      const vl = lc.title && topic.videoLinks.find(v => v.originalUrl === lc.url)
      if (vl)
        vl.title = lc.title!.replace(/\s*~\s*\w+$/, '').replace(/\.[a-z0-9]{2,4}$/i, '').trim()
    }

    // Hosts with a resolver of our own are resolved straight away (it only
    // reads metadata); yt-dlp ones wait for a click so a post does not start
    // a handful of processes. Pixeldrain folders may hold the scripts too.
    for (const vl of topic.videoLinks) {
      if (!vl.host.ytdlp)
        void resolveVideoLink(vl)
      if (vl.host.id === 'pixeldrain')
        void addPixeldrainFolderScripts(topic, vl)
    }
  }
  catch (e) {
    fail(e, 'Could not load the post')
    topic.funscriptUrls = undefined
  }
  finally {
    topic.loading = false
  }
}

function openDetail(topic: ESTopic) {
  openTopic.value = topic
  void loadDetail(topic)
}

/** The link "Play" uses: one that is ready, else one that may still work. */
const primarySource = computed(() => {
  const links = openTopic.value?.videoLinks ?? []
  return links.find(v => v.state === 'ready')
    ?? links.find(v => v.state !== 'error' && !v.host.ytdlp)
    ?? links.find(v => v.state !== 'error')
    ?? null
})
const primaryScripts = computed(() => (openTopic.value && primarySource.value ? scriptsFor(openTopic.value, primarySource.value).length : 0))

// ─── Downloads & playback ─────────────────────────────────────────────────────
const saving = reactive(new Set<string>())

async function fetchScript(entry: FunscriptEntry): Promise<File> {
  const res = await proxyFetch(entry.url)
  if (!res.ok)
    throw new Error(`HTTP ${res.status} for ${entry.filename}`)
  return new File([await res.text()], entry.filename, { type: 'application/json' })
}

async function saveScript(entry: FunscriptEntry) {
  saving.add(entry.url)
  try {
    const file = await fetchScript(entry)
    const a = document.createElement('a')
    a.href = URL.createObjectURL(file)
    a.download = entry.filename
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }
  catch (e: any) {
    toast.error('Download failed', { detail: e?.message })
  }
  finally {
    saving.delete(entry.url)
  }
}

async function useWithCurrent(entry: FunscriptEntry) {
  saving.add(entry.url)
  try {
    const file = await fetchScript(entry)
    await loadScriptFiles([file], player.videoPath?.replace(/\.[^.]+$/, '') ?? '')
    toast.success('Script loaded onto the current video', { detail: entry.filename, icon: 'i-carbon-chart-line' })
  }
  catch (e: any) {
    toast.error('Could not load that script', { detail: e?.message })
  }
  finally {
    saving.delete(entry.url)
  }
}

interface Job { topicId: number, step: string, done: number, total: number }
const job = ref<Job | null>(null)

const isPd = (url: string) => url.startsWith(`${PROXY}/pd/`)
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

/**
 * The post's scripts that go with this video, each with its axis. Names are
 * only compared among the scripts: the video's name rarely matches theirs.
 */
function scriptsFor(topic: ESTopic, link: VideoLink): { entry: FunscriptEntry, suffix: string }[] {
  const all = topic.funscriptUrls ?? []
  if (!all.length)
    return []
  // Where this video sits among every video in the post.
  let index = 0
  let count = 0
  for (const vl of topic.videoLinks ?? []) {
    if (vl === link)
      index = count + (vl.items.length > 1 ? vl.item : 0)
    count += Math.max(1, vl.items.length)
  }
  const picked = scriptsForVideo(classifyPostScripts(all.map(e => e.filename)), { title: chosenTitle(link, ''), index, count })
  return picked.map(p => ({ entry: all.find(e => e.filename === p.filename)!, suffix: p.suffix }))
}

/**
 * The scripts' files, in the order given. A free Pixeldrain account gets one
 * download at a time, so those go one by one with a pause to let the
 * connection close; the rest in parallel.
 */
async function fetchScriptsInOrder(entries: FunscriptEntry[], onEach?: () => void): Promise<File[]> {
  const out: File[] = Array.from({ length: entries.length })
  await Promise.all(entries.map(async (e, i) => {
    if (!isPd(e.url)) {
      out[i] = await fetchScript(e)
      onEach?.()
    }
  }))
  const pd = entries.map((e, i) => [e, i] as const).filter(([e]) => isPd(e.url))
  for (const [k, [e, i]] of pd.entries()) {
    out[i] = await fetchScript(e)
    onEach?.()
    if (k < pd.length - 1)
      await wait(300)
  }
  return out
}

async function play(topic: ESTopic, link: VideoLink, withScripts: boolean) {
  const chosen = withScripts ? scriptsFor(topic, link) : []
  const entries = chosen.map(c => c.entry)
  job.value = { topicId: topic.id, step: 'Finding the stream', done: 0, total: entries.length + 1 }
  try {
    await resolveVideoLink(link)
    const source = chosenSource(link)
    if (!source)
      throw new Error(link.state === 'needs-ytdlp' ? 'This site needs yt-dlp — get it from the source below' : (link.error ?? 'No stream for this source'))

    if (entries.length) {
      job.value.step = `Downloading scripts · 0 of ${entries.length}`
      const files = await fetchScriptsInOrder(entries, () => {
        job.value!.done++
        job.value!.step = `Downloading scripts · ${job.value!.done} of ${entries.length}`
      })
      await loadScriptFiles(files, '', chosen.map(c => c.suffix))
      // Let Pixeldrain release the download slot before the video asks for one.
      if (entries.some(e => isPd(e.url)) && link.host.id === 'pixeldrain')
        await wait(500)
    }

    job.value.step = 'Opening the stream'
    await playSource(chosenTitle(link, topic.title), source)
    job.value.done = job.value.total
    toast.success(entries.length ? `Playing with ${entries.length} script${entries.length === 1 ? '' : 's'}` : 'Playing', {
      detail: chosenTitle(link, topic.title),
      icon: 'i-carbon-play-filled-alt',
      key: 'es-play',
      action: ui.onPlayer ? undefined : { label: 'Open player', run: () => ui.openView('player') },
    })
  }
  catch (e: any) {
    toast.error('Could not play that', { detail: e?.message, key: 'es-play' })
  }
  finally {
    setTimeout(() => {
      if (job.value?.topicId === topic.id)
        job.value = null
    }, 600)
  }
}

// ─── Saving ───────────────────────────────────────────────────────────────────
const dlKey = (link: VideoLink) => `${link.originalUrl}#${link.item}`
const dlJob = (link: VideoLink) => downloads.get(dlKey(link))
const dlActive = (link: VideoLink) => ['scripts', 'video'].includes(dlJob(link)?.phase ?? '')
function dlTip(topic: ESTopic, link: VideoLink) {
  if (chosenSource(link)?.kind === 'hls')
    return 'This source streams in pieces (HLS), which cannot be saved as one file yet'
  return scriptsFor(topic, link).length ? 'Save the video and its scripts, all under the video\'s name' : 'Save the video'
}

/** Save the video with its scripts, all under the video's name, so the library pairs them. */
async function download(topic: ESTopic, link: VideoLink) {
  const source = chosenSource(link)
  if (!source || dlActive(link))
    return
  const chosen = scriptsFor(topic, link)
  const title = chosenTitle(link, topic.title)
  const key = dlKey(link)
  const job = await downloadPost({
    key,
    title,
    source,
    scripts: chosen.map(c => ({ filename: c.entry.filename, base: '', suffix: c.suffix })),
    fetchScripts: async () => {
      const files = await fetchScriptsInOrder(chosen.map(c => c.entry))
      if (chosen.some(c => isPd(c.entry.url)) && link.host.id === 'pixeldrain')
        await wait(500)
      return files
    },
  })
  if (job.phase === 'done') {
    toast.success(chosen.length ? `Saved with ${chosen.length} script${chosen.length === 1 ? '' : 's'}` : 'Saved', {
      detail: `${title} · in ${job.folder}`,
      icon: 'i-carbon-download',
      key: `es-dl-${key}`,
    })
    downloads.delete(key)
  }
  else if (job.error === 'Cancelled') {
    downloads.delete(key)
  }
  else {
    toast.error('Could not save that', { detail: job.error, key: `es-dl-${key}` })
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const tagName = (t: string | ESTag) => (typeof t === 'string' ? t : t.name)
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
const fmtNum = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
const fmtSize = (b: number) => (b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(1)} GB` : `${(b / (1 << 20)).toFixed(1)} MB`)
const postUrl = (t: ESTopic) => `${BASE}/t/${t.slug}/${t.id}`
const openExternal = (url: string) => window.open(url, '_blank', 'noopener')

/** Covers that fail to load fall back to the placeholder instead of a broken image. */
const brokenCovers = reactive(new Set<number>())

// ─── Keyboard ─────────────────────────────────────────────────────────────────
// Captured on the document so Esc closes the sheet instead of reaching the
// shell, where a bare Esc is the panic key.
function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape' || !openTopic.value || cookieOpen.value || (e.target as HTMLElement).closest?.('input, textarea, select'))
    return
  e.stopPropagation()
  openTopic.value = null
}
onMounted(() => document.addEventListener('keydown', onKey, true))
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey, true)
  clearTimeout(searchTimer)
})
</script>

<template>
  <div class="bg-surface-950 flex flex-col h-full min-h-0 relative">
    <!-- Header -->
    <header class="px-6 pb-4 pt-5 flex shrink-0 gap-4 items-end">
      <div class="flex-1 min-w-0">
        <h1 class="h-view">
          EroScripts
        </h1>
        <p class="text-[12.5px] text-fg-muted mt-0.5">
          Free scripts from discuss.eroscripts.com, fetched through the local proxy.
        </p>
      </div>
      <div class="flex shrink-0 gap-1.5 items-center">
        <UiButton size="md" variant="ghost" icon="i-carbon-key" @click="openCookie">
          {{ sessionCookie ? 'Session' : 'Sign in' }}
          <UiBadge :tone="sessionCookie ? 'ok' : 'warn'" size="xs" dot>
            {{ sessionCookie ? 'set' : 'needed' }}
          </UiBadge>
        </UiButton>
        <UiIconButton icon="i-carbon-renew" label="Refresh" size="md" :disabled="busy" @click="reload" />
        <UiIconButton icon="i-carbon-launch" label="Open EroScripts in the browser" size="md" @click="openExternal(BASE)" />
      </div>
    </header>

    <!-- Toolbar -->
    <div class="px-6 pb-3 flex shrink-0 flex-col gap-2.5">
      <div class="flex flex-wrap gap-2 items-center">
        <UiInput
          v-model="query"
          size="md"
          icon="i-carbon-search"
          placeholder="Search scripts"
          clearable
          class="flex-1 max-w-[420px] min-w-[200px]"
          @enter="doSearch"
        >
          <template #suffix>
            <UiSpinner v-if="searchLoading" :size="13" class="text-fg-faint mr-2" />
          </template>
        </UiInput>
        <UiSegmented
          v-if="!searching"
          v-model="sort"
          size="md"
          :options="[
            { value: 'latest', label: 'Latest', icon: 'i-carbon-time' },
            { value: 'top', label: 'Top', icon: 'i-carbon-trophy' },
            { value: 'hot', label: 'Hot', icon: 'i-carbon-fire' },
          ]"
        />
        <span v-else-if="searchedFor" class="text-[12.5px] text-fg-muted">
          {{ searchResults.length }} result{{ searchResults.length === 1 ? '' : 's' }} for “{{ searchedFor }}”
        </span>
        <div class="flex-1" />
        <UiSegmented
          v-model="viewMode"
          size="md"
          :options="[
            { value: 'grid', icon: 'i-carbon-grid', title: 'Grid' },
            { value: 'list', icon: 'i-carbon-list', title: 'List' },
          ]"
        />
      </div>

      <!-- Tags -->
      <div v-if="!searching && availableTags.length" class="flex gap-2 min-w-0 items-center">
        <UiInput v-model="tagFilter" icon="i-carbon-tag" placeholder="Tags" clearable class="shrink-0 w-36" />
        <div class="tag-strip py-0.5 flex flex-1 gap-1.5 min-w-0 overflow-x-auto">
          <button
            type="button"
            class="text-[12px] font-medium px-3 focusable border rounded-full shrink-0 h-7 whitespace-nowrap pressable"
            :class="!activeTag ? 'border-accent/60 bg-accent-soft text-accent-300' : 'border-edge-strong text-fg-muted hover:text-fg hover:border-fg/30'"
            @click="selectTag(null)"
          >
            All
          </button>
          <button
            v-for="t in shownTags"
            :key="t.id"
            type="button"
            class="text-[12px] font-medium px-3 focusable border rounded-full shrink-0 h-7 whitespace-nowrap pressable"
            :class="activeTag?.id === t.id ? 'border-accent/60 bg-accent-soft text-accent-300' : 'border-edge-strong text-fg-muted hover:text-fg hover:border-fg/30'"
            @click="selectTag(t)"
          >
            {{ t.name }}
          </button>
          <span v-if="tagFilter && !shownTags.length" class="hint self-center">No tag matches</span>
        </div>
      </div>
    </div>

    <!-- Body: results and the detail sheet -->
    <div class="border-t border-edge flex flex-1 min-h-0">
      <div class="scroll-y flex-1 min-w-0">
        <!-- Proxy not running -->
        <div v-if="proxyDown" class="center h-full">
          <UiEmpty size="lg" icon="i-carbon-plug" title="The proxy is not running">
            <template #description>
              <p class="text-[12.5px] text-fg-muted leading-relaxed">
                EroScripts does not allow the browser to call it directly, so a small local proxy does it on
                port 7071. Start it next to the dev server:
              </p>
              <button
                v-tip="copied ? 'Copied' : 'Copy'"
                type="button"
                class="group text-[13px] text-fg font-mono mx-auto mt-3 px-3 focusable border border-edge-strong rounded-[var(--radius-md)] bg-surface-900 flex gap-3 h-9 items-center"
                @click="copyCommand"
              >
                <span class="text-fg-faint">$</span> pnpm dev:proxy
                <span :class="copied ? 'i-carbon-checkmark text-ok' : 'i-carbon-copy text-fg-faint group-hover:text-fg'" />
              </button>
            </template>
            <UiButton variant="primary" icon="i-carbon-renew" :loading="busy" @click="reload">
              Try again
            </UiButton>
            <UiButton variant="ghost" icon="i-carbon-launch" @click="openExternal(BASE)">
              Open the site
            </UiButton>
          </UiEmpty>
        </div>

        <div v-else class="px-6 pb-[240px] pt-4">
          <!-- Error -->
          <Transition name="t-collapse">
            <div v-if="error">
              <div class="min-h-0 overflow-hidden">
                <div class="mb-4 px-3 py-2 border border-danger/25 rounded-[var(--radius-md)] bg-danger/8 flex gap-3 items-center">
                  <span class="i-carbon-warning-filled text-danger shrink-0" />
                  <span class="text-[12.5px] text-fg flex-1">{{ error }}</span>
                  <UiButton v-if="!sessionCookie || needsSession" size="xs" icon="i-carbon-key" @click="openCookie">
                    {{ sessionCookie ? 'New session' : 'Set session' }}
                  </UiButton>
                  <UiButton size="xs" variant="ghost" @click="reload">
                    Retry
                  </UiButton>
                  <UiIconButton icon="i-carbon-close" label="Dismiss" size="xs" @click="error = null" />
                </div>
              </div>
            </div>
          </Transition>

          <!-- First load -->
          <div v-if="busy && !items.length" :class="viewMode === 'grid' ? 'es-grid' : 'flex flex-col gap-2'">
            <template v-for="i in 12" :key="i">
              <div v-if="viewMode === 'grid'" class="flex flex-col gap-2">
                <div class="skeleton rounded-[var(--radius-lg)] aspect-video" />
                <div class="skeleton rounded h-3.5 w-4/5" />
                <div class="skeleton rounded h-3 w-2/5" />
              </div>
              <div v-else class="skeleton rounded-[var(--radius-md)] h-16" />
            </template>
          </div>

          <UiEmpty
            v-else-if="searching && searchedFor && !searchResults.length && !searchLoading"
            icon="i-carbon-search"
            :title="`Nothing for “${searchedFor}”`"
            description="Try fewer words, or the performer or studio name on its own."
          />
          <UiEmpty
            v-else-if="!busy && !items.length && !error && !searching"
            icon="i-carbon-document-blank"
            title="No scripts here"
            :description="activeTag ? `Nothing tagged ${activeTag.name} under ${sort}.` : 'The forum returned an empty list.'"
          >
            <UiButton v-if="activeTag" @click="selectTag(null)">
              Clear tag
            </UiButton>
          </UiEmpty>

          <!-- Grid -->
          <div v-else-if="viewMode === 'grid'" class="es-grid">
            <button
              v-for="t in items"
              :key="t.id"
              type="button"
              class="group text-left focusable rounded-[var(--radius-lg)] flex flex-col gap-2 animate-fade-in"
              @click="openDetail(t)"
            >
              <div
                class="rounded-[var(--radius-lg)] bg-surface-800 w-full aspect-video ring-1 transition-[box-shadow,transform] duration-200 relative overflow-hidden group-hover:shadow-[var(--shadow-lg)] group-hover:-translate-y-0.5"
                :class="openTopic?.id === t.id ? 'ring-2 ring-accent' : 'ring-edge'"
              >
                <img
                  v-if="t.image_url && !brokenCovers.has(t.id)"
                  :src="t.image_url"
                  alt=""
                  loading="lazy"
                  class="h-full w-full transition-transform duration-500 object-cover group-hover:scale-[1.03]"
                  @error="brokenCovers.add(t.id)"
                >
                <div v-else class="text-fg-faint center h-full w-full">
                  <span class="i-carbon-chart-line text-[28px]" />
                </div>
                <div class="text-[11px] text-white px-2 py-1.5 bg-[linear-gradient(to_top,rgba(0,0,0,0.7),transparent)] opacity-0 flex gap-2.5 transition-opacity bottom-0 left-0 right-0 absolute group-hover:opacity-100">
                  <span class="flex gap-1 items-center"><span class="i-carbon-favorite" />{{ fmtNum(t.like_count) }}</span>
                  <span class="flex gap-1 items-center"><span class="i-carbon-view" />{{ fmtNum(t.views) }}</span>
                </div>
              </div>
              <div class="px-0.5 flex flex-col gap-1 min-w-0">
                <p class="text-[13px] text-fg leading-snug font-medium line-clamp-2">
                  {{ t.title }}
                </p>
                <p class="text-[11.5px] text-fg-faint flex gap-2 items-center">
                  <span>{{ fmtDate(t.created_at) }}</span>
                  <span v-if="t.tags?.length" class="truncate">· {{ t.tags.slice(0, 3).map(tagName).join(', ') }}</span>
                </p>
              </div>
            </button>
          </div>

          <!-- List -->
          <div v-else class="flex flex-col gap-0.5">
            <button
              v-for="t in items"
              :key="t.id"
              type="button"
              class="group p-2 text-left focusable rounded-[var(--radius-md)] flex gap-3 transition-colors animate-fade-in items-center"
              :class="openTopic?.id === t.id ? 'bg-accent-soft' : 'hover:bg-fg/4'"
              @click="openDetail(t)"
            >
              <div class="rounded-[var(--radius-sm)] bg-surface-800 shrink-0 h-[54px] w-24 overflow-hidden">
                <img
                  v-if="t.image_url && !brokenCovers.has(t.id)"
                  :src="t.image_url"
                  alt=""
                  loading="lazy"
                  class="h-full w-full object-cover"
                  @error="brokenCovers.add(t.id)"
                >
                <div v-else class="text-fg-faint center h-full w-full">
                  <span class="i-carbon-chart-line text-[18px]" />
                </div>
              </div>
              <div class="flex flex-1 flex-col gap-1 min-w-0">
                <p class="text-[13px] text-fg font-medium truncate">
                  {{ t.title }}
                </p>
                <div class="text-[11.5px] text-fg-faint flex gap-3 items-center">
                  <span>{{ fmtDate(t.created_at) }}</span>
                  <span class="flex gap-1 items-center"><span class="i-carbon-favorite" />{{ fmtNum(t.like_count) }}</span>
                  <span class="flex gap-1 items-center"><span class="i-carbon-view" />{{ fmtNum(t.views) }}</span>
                  <span class="flex gap-1 min-w-0">
                    <UiBadge v-for="tag in (t.tags ?? []).slice(0, 4)" :key="tagName(tag)" size="xs">{{ tagName(tag) }}</UiBadge>
                  </span>
                </div>
              </div>
              <span class="i-carbon-chevron-right text-fg-faint shrink-0 transition-transform group-hover:translate-x-0.5" />
            </button>
          </div>

          <!-- Paging -->
          <div v-if="!searching && items.length" ref="sentinel" class="py-6 flex justify-center">
            <UiSpinner v-if="loading" :size="18" class="text-accent-300" />
            <UiButton v-else-if="hasMore" variant="ghost" @click="loadTopics(false)">
              Load more
            </UiButton>
            <span v-else class="hint">That is everything</span>
          </div>
        </div>
      </div>

      <!-- Detail sheet -->
      <Transition name="t-slide-right">
        <aside v-if="openTopic" class="border-l border-edge bg-surface-900 flex shrink-0 flex-col w-[420px]">
          <div class="pl-4 pr-2 border-b border-edge flex shrink-0 gap-2 h-11 items-center">
            <span class="eyebrow flex-1">Script</span>
            <UiIconButton icon="i-carbon-launch" label="Open the post" size="sm" @click="openExternal(postUrl(openTopic))" />
            <UiIconButton icon="i-carbon-close" label="Close" kbd="Esc" size="sm" @click="openTopic = null" />
          </div>

          <div :key="openTopic.id" class="p-4 pb-[240px] scroll-y flex flex-1 flex-col gap-5 animate-fade-in">
            <!-- Cover and title -->
            <div class="flex flex-col gap-3">
              <div v-if="openTopic.image_url && !brokenCovers.has(openTopic.id)" class="rounded-[var(--radius-lg)] bg-surface-800 aspect-video ring-1 ring-edge overflow-hidden">
                <img :src="openTopic.image_url" alt="" class="h-full w-full object-cover" @error="brokenCovers.add(openTopic.id)">
              </div>
              <h2 class="text-[16px] text-fg leading-snug tracking-[-0.01em] font-semibold">
                {{ openTopic.title }}
              </h2>
              <div class="text-[12px] text-fg-muted flex flex-wrap gap-x-4 gap-y-1 items-center">
                <span class="flex gap-1.5 items-center"><span class="i-carbon-calendar" />{{ fmtDate(openTopic.created_at) }}</span>
                <span class="flex gap-1.5 items-center"><span class="i-carbon-favorite" />{{ fmtNum(openTopic.like_count) }}</span>
                <span class="flex gap-1.5 items-center"><span class="i-carbon-view" />{{ fmtNum(openTopic.views) }}</span>
              </div>
              <div v-if="openTopic.tags?.length" class="flex flex-wrap gap-1">
                <UiBadge v-for="tag in openTopic.tags" :key="tagName(tag)" size="xs">
                  {{ tagName(tag) }}
                </UiBadge>
              </div>
            </div>

            <!-- Loading the post -->
            <div v-if="openTopic.loading || openTopic.funscriptUrls === undefined" class="flex flex-col gap-2">
              <div class="skeleton rounded-[var(--radius-md)] h-10" />
              <div class="skeleton rounded-[var(--radius-md)] h-20" />
              <div class="skeleton rounded-[var(--radius-md)] h-9" />
              <div class="skeleton rounded-[var(--radius-md)] h-9" />
            </div>

            <template v-else>
              <!-- Primary action -->
              <div class="flex flex-col gap-2">
                <template v-if="job?.topicId === openTopic.id">
                  <div class="text-[12.5px] text-fg flex gap-2 items-center">
                    <UiSpinner :size="13" class="text-accent-300" />
                    {{ job.step }}
                  </div>
                  <UiProgress :value="job.total ? job.done / job.total : undefined" />
                </template>
                <template v-else-if="primarySource">
                  <UiButton
                    variant="primary"
                    size="lg"
                    block
                    icon="i-carbon-play-filled-alt"
                    :disabled="!!job"
                    @click="play(openTopic, primarySource, true)"
                  >
                    {{ primaryScripts ? `Play with ${primaryScripts} script${primaryScripts === 1 ? '' : 's'}` : 'Play video' }}
                  </UiButton>
                  <p class="hint text-center">
                    from {{ primarySource.title || primarySource.host.label }}
                  </p>
                </template>
                <p v-else-if="openTopic.funscriptUrls.length" class="hint">
                  No streamable video in this post — save the scripts and play the video from your library, or
                  load them onto whatever is playing.
                </p>
              </div>

              <!-- Video sources -->
              <section v-if="openTopic.videoLinks?.length" class="flex flex-col gap-2">
                <h3 class="eyebrow">
                  Video sources
                </h3>
                <div v-for="vl in openTopic.videoLinks" :key="vl.originalUrl" class="card overflow-hidden">
                  <div class="p-2.5 flex gap-2.5 items-center">
                    <div class="text-fg-muted rounded-[var(--radius-md)] bg-surface-800 center shrink-0 h-8 w-8">
                      <span :class="vl.host.icon" class="text-[16px]" />
                    </div>
                    <div class="flex flex-1 flex-col min-w-0">
                      <span class="text-[12.5px] text-fg font-medium truncate">{{ vl.title || vl.host.label }}</span>
                      <span v-if="vl.title || vl.items.length > 1" class="text-[11px] text-fg-faint truncate">
                        {{ vl.host.label }}<template v-if="vl.items.length > 1"> · {{ vl.items.length }} videos</template>
                      </span>
                    </div>
                    <UiBadge v-if="vl.state === 'ready'" tone="ok" size="xs" dot>
                      Streams
                    </UiBadge>
                    <UiBadge v-else-if="vl.state === 'resolving'" tone="info" size="xs">
                      <UiSpinner :size="9" /> Resolving
                    </UiBadge>
                    <UiBadge v-else-if="vl.state === 'needs-ytdlp'" size="xs" icon="i-carbon-download">
                      Needs yt-dlp
                    </UiBadge>
                    <UiBadge v-else-if="vl.state === 'error'" tone="danger" size="xs">
                      Failed
                    </UiBadge>
                  </div>
                  <p v-if="vl.state === 'error'" class="text-[11.5px] text-danger px-2.5 pb-2 -mt-1">
                    {{ vl.error }}
                  </p>
                  <p v-else-if="vl.state === 'needs-ytdlp'" class="hint px-2.5 pb-2 -mt-1">
                    {{ vl.host.label }} streams through yt-dlp, a free open-source downloader. playhound can fetch the official release (about 20 MB) and keep it up to date.
                  </p>

                  <!-- A folder: pick which video -->
                  <div v-if="vl.items.length > 1" class="px-1.5 pb-1.5 flex flex-col gap-0.5 max-h-48 overflow-y-auto">
                    <button
                      v-for="(it, i) in vl.items"
                      :key="i"
                      type="button"
                      class="text-[11.5px] px-2 text-left focusable rounded-[var(--radius-sm)] flex gap-2 h-7 transition-colors items-center"
                      :class="vl.item === i ? 'bg-accent-soft text-fg' : 'text-fg-muted hover:bg-fg/5 hover:text-fg'"
                      @click="chooseItem(vl, i)"
                    >
                      <span class="i-carbon-video shrink-0" />
                      <span v-tip="it.title" class="flex-1 truncate">{{ it.title }}</span>
                      <span v-if="it.size" class="num shrink-0">{{ fmtSize(it.size) }}</span>
                      <span v-if="vl.item === i" class="i-carbon-checkmark text-accent-300 shrink-0" />
                    </button>
                  </div>

                  <!-- Qualities -->
                  <div v-if="(vl.items[vl.item]?.sources.length ?? 0) > 1" class="px-2.5 pb-2 flex flex-wrap gap-1">
                    <button
                      v-for="(src, i) in vl.items[vl.item].sources"
                      :key="i"
                      type="button"
                      class="text-[11px] font-mono px-1.5 focusable rounded-[var(--radius-xs)] h-5 transition-colors"
                      :class="vl.source === i ? 'bg-accent-soft text-fg' : 'bg-fg/6 text-fg-muted hover:text-fg hover:bg-fg/10'"
                      @click="vl.source = i"
                    >
                      {{ src.label }}
                    </button>
                  </div>

                  <div class="px-2.5 py-2 border-t border-edge flex flex-wrap gap-1.5 items-center">
                    <UiButton v-if="vl.state === 'idle' || vl.state === 'error'" size="xs" icon="i-carbon-flash" @click="retryLink(vl)">
                      {{ vl.state === 'error' ? 'Retry' : 'Resolve' }}
                    </UiButton>
                    <UiButton v-if="vl.state === 'needs-ytdlp'" size="xs" icon="i-carbon-download" :loading="!!ytdlp?.installing" @click="getYtdlp(vl)">
                      Get yt-dlp
                    </UiButton>
                    <UiButton v-if="vl.state === 'ready'" size="xs" icon="i-carbon-play" :disabled="!!job" @click="play(openTopic, vl, false)">
                      Play
                    </UiButton>
                    <UiButton
                      v-if="vl.state === 'ready' && openTopic.funscriptUrls.length"
                      size="xs"
                      variant="subtle"
                      icon="i-carbon-play-filled-alt"
                      :disabled="!!job"
                      @click="play(openTopic, vl, true)"
                    >
                      Play + scripts
                    </UiButton>
                    <UiButton
                      v-if="vl.state === 'ready'"
                      v-tip="dlTip(openTopic, vl)"
                      size="xs"
                      variant="ghost"
                      icon="i-carbon-download"
                      :disabled="dlActive(vl) || chosenSource(vl)?.kind === 'hls'"
                      @click="download(openTopic, vl)"
                    >
                      Download
                    </UiButton>
                    <UiButton size="xs" variant="ghost" icon-right="i-carbon-launch" class="ml-auto" @click="openExternal(vl.originalUrl)">
                      Open
                    </UiButton>
                  </div>

                  <!-- Saving -->
                  <div v-if="dlJob(vl)" class="px-2.5 py-2 border-t border-edge flex flex-col gap-1.5">
                    <div class="text-[11.5px] flex gap-2 items-center">
                      <span class="flex-1 truncate" :class="dlJob(vl)!.phase === 'error' ? 'text-danger' : 'text-fg-muted'">
                        <template v-if="dlJob(vl)!.phase === 'scripts'">Fetching the scripts…</template>
                        <template v-else-if="dlJob(vl)!.phase === 'video'">
                          Saving to {{ dlJob(vl)!.folder }} · <span class="num">{{ fmtSize(dlJob(vl)!.received) }}<template v-if="dlJob(vl)!.total"> of {{ fmtSize(dlJob(vl)!.total!) }}</template></span>
                        </template>
                        <template v-else-if="dlJob(vl)!.phase === 'error'">{{ dlJob(vl)!.error }}</template>
                      </span>
                      <UiButton v-if="dlActive(vl)" size="xs" variant="ghost" @click="dlJob(vl)!.cancel()">
                        Cancel
                      </UiButton>
                      <UiIconButton v-else icon="i-carbon-close" label="Dismiss" size="xs" @click="downloads.delete(dlKey(vl))" />
                    </div>
                    <UiProgress v-if="dlActive(vl)" :value="dlJob(vl)!.phase === 'video' && dlJob(vl)!.total ? dlJob(vl)!.received / dlJob(vl)!.total! : undefined" />
                  </div>
                </div>
              </section>

              <!-- Scripts -->
              <section class="flex flex-col gap-2">
                <h3 class="eyebrow">
                  Scripts <span v-if="openTopic.funscriptUrls.length" class="text-fg-faint num">· {{ openTopic.funscriptUrls.length }}</span>
                </h3>
                <p v-if="!openTopic.funscriptUrls.length" class="hint">
                  No direct .funscript links in this post. Some authors link a download page instead —
                  <button type="button" class="text-accent-300 hover:underline" @click="openExternal(postUrl(openTopic))">
                    open the post
                  </button>.
                </p>
                <TransitionGroup v-else name="t-list" tag="div" class="flex flex-col gap-1 relative">
                  <div
                    v-for="entry in openTopic.funscriptUrls"
                    :key="entry.url"
                    class="pl-2 pr-1 well flex gap-2 h-10 items-center"
                  >
                    <span v-if="entry.axis === ''" class="center w-14"><UiSpinner :size="12" class="text-fg-faint" /></span>
                    <span v-else-if="entry.axis" v-tip="axisLabel(entry.axis)" class="center w-14">
                      <UiBadge tone="accent" size="xs" class="num">{{ entry.axis }}</UiBadge>
                    </span>
                    <UiButton v-else size="xs" variant="ghost" class="w-14" @click="entry.axisDetected = false; detectAxis(entry)">
                      Detect
                    </UiButton>
                    <span v-tip="entry.filename" class="text-[12px] text-fg flex-1 truncate">{{ entry.filename }}</span>
                    <UiSpinner v-if="saving.has(entry.url)" :size="13" class="text-fg-faint mx-2" />
                    <template v-else>
                      <UiIconButton
                        v-if="player.videoUrl"
                        icon="i-carbon-chart-line"
                        label="Use with the current video"
                        size="sm"
                        @click="useWithCurrent(entry)"
                      />
                      <UiIconButton icon="i-carbon-download" label="Save file" size="sm" @click="saveScript(entry)" />
                    </template>
                  </div>
                </TransitionGroup>
              </section>
            </template>
          </div>
        </aside>
      </Transition>
    </div>

    <!-- Session cookie -->
    <UiModal v-model:open="cookieOpen" title="EroScripts session" subtitle="Lets the proxy fetch posts and files as you." icon="i-carbon-key" width="480px">
      <div class="flex flex-col gap-4">
        <ol class="text-[12.5px] text-fg-muted leading-relaxed flex flex-col gap-1.5">
          <li class="flex gap-2.5">
            <span class="text-[11px] text-accent-300 font-semibold rounded-full bg-accent-soft center shrink-0 h-5 w-5">1</span>
            <span>Open <button type="button" class="text-accent-300 hover:underline" @click="openExternal(BASE)">discuss.eroscripts.com</button> and log in.</span>
          </li>
          <li class="flex gap-2.5">
            <span class="text-[11px] text-accent-300 font-semibold rounded-full bg-accent-soft center shrink-0 h-5 w-5">2</span>
            <span>Press <UiKbd>F12</UiKbd> → Application → Cookies → <code class="text-[12px] font-mono">discuss.eroscripts.com</code>.</span>
          </li>
          <li class="flex gap-2.5">
            <span class="text-[11px] text-accent-300 font-semibold rounded-full bg-accent-soft center shrink-0 h-5 w-5">3</span>
            <span>Copy the value of <code class="text-[12px] font-mono">_t</code> and paste it here. The <code class="text-[12px] font-mono">_t=</code> prefix is optional.</span>
          </li>
        </ol>
        <UiInput v-model="cookieDraft" mono size="md" placeholder="Paste the _t value" autofocus @enter="saveCookie" />
        <p class="hint">
          Stored in this browser only. It expires after about a month; come back here when posts stop loading.
        </p>
      </div>
      <template #footer>
        <UiButton v-if="sessionCookie" variant="ghost" class="mr-auto" @click="forgetCookie">
          Forget
        </UiButton>
        <UiButton variant="ghost" @click="cookieOpen = false">
          Cancel
        </UiButton>
        <UiButton variant="primary" :disabled="!cookieDraft.trim()" @click="saveCookie">
          Save
        </UiButton>
      </template>
    </UiModal>
  </div>
</template>

<style scoped>
.es-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 20px 16px;
}
.tag-strip {
  scrollbar-width: none;
  mask-image: linear-gradient(to right, black calc(100% - 32px), transparent);
}
.tag-strip::-webkit-scrollbar {
  display: none;
}
</style>
