<script setup lang="ts">
import type { VideoMeta } from '~/lib/idb'
import type { VideoEntry } from '~/stores/libraryStore'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { openFolderWithHandle, reopenFromHandle } from '~/lib/browserApi'
import { handleDb, thumbDb, videoMetaDb } from '~/lib/idb'
import { useLibraryStore } from '~/stores/libraryStore'
import { usePlaylistStore } from '~/stores/playlistStore'

const emit = defineEmits<{
  select: [entry: VideoEntry]
  /** Fired alongside select — passes the full current sorted list as the queue */
  queue: [entries: VideoEntry[], selected: VideoEntry]
}>()
const library = useLibraryStore()
const plStore = usePlaylistStore()
const HANDLE_KEY = 'lastDirHandle'

// ─── View / sort / filter state ───────────────────────────────────────────────
const viewMode = ref<'grid' | 'list'>('grid')
const search = ref('')
const filterScripted = ref(false)
const filterMultiAxis = ref(false)
const filterFavorites = ref(false)

type SortKey = 'name' | 'size' | 'date' | 'duration'
const LS_SORT = 'mwhoplayer:librarySort'
function loadSort() {
  try { return JSON.parse(localStorage.getItem(LS_SORT) ?? '{}') }
  catch { return {} }
}
const savedSort = loadSort()
const sortKey = ref<SortKey>(savedSort.key ?? 'name')
const sortAsc = ref<boolean>(savedSort.asc ?? true)

const SORT_LABELS: Record<SortKey, string> = { name: 'Name', size: 'Size', date: 'Date', duration: 'Duration' }

function cycleSort(key: SortKey) {
  if (sortKey.value === key) {
    sortAsc.value = !sortAsc.value
  }
  else { sortKey.value = key; sortAsc.value = true }
  localStorage.setItem(LS_SORT, JSON.stringify({ key: sortKey.value, asc: sortAsc.value }))
}

const sortedFiltered = computed(() => {
  let list = library.videos.slice()
  if (search.value.trim())
    list = list.filter(v => v.basename.toLowerCase().includes(search.value.toLowerCase()))
  if (filterScripted.value)
    list = list.filter(v => v.hasScript)
  if (filterMultiAxis.value)
    list = list.filter(v => v.scriptCount > 1 || v.scriptType === 'merged')
  if (filterFavorites.value)
    list = list.filter(v => v.starred)
  list.sort((a, b) => {
    let cmp = 0
    if (sortKey.value === 'name')
      cmp = a.basename.localeCompare(b.basename, undefined, { sensitivity: 'base' })
    if (sortKey.value === 'size')
      cmp = a.file.size - b.file.size
    if (sortKey.value === 'date')
      cmp = (a.file.lastModified ?? 0) - (b.file.lastModified ?? 0)
    if (sortKey.value === 'duration')
      cmp = (a.duration ?? 0) - (b.duration ?? 0)
    return sortAsc.value ? cmp : -cmp
  })
  return list
})

// ─── Script badge helpers ─────────────────────────────────────────────────────
/**
 * Returns [bgClass, textContent, title] for the script badge.
 * none   → grey dash
 * single → accent purple pill  "✦"
 * multi  → blue-purple gradient  "3✦"
 * merged → teal-purple gradient  "5✦ M"
 */
function scriptBadge(entry: VideoEntry): { cls: string, text: string, title: string } {
  const t = entry.scriptType
  if (!entry.hasScript || t === 'none') {
    return { cls: 'bg-white/5 text-white/20', text: '—', title: 'No script' }
  }
  if (t === 'merged') {
    return {
      cls: 'badge-merged text-white font-bold',
      text: `${entry.scriptCount}✦`,
      title: `Merged multi-axis script (${entry.scriptCount} axes)`,
    }
  }
  if (t === 'multi' || entry.scriptCount > 1) {
    return {
      cls: 'badge-multi text-white font-bold',
      text: `${entry.scriptCount}✦`,
      title: `Multi-axis (${entry.scriptCount} script files)`,
    }
  }
  // single
  return { cls: 'badge-single text-white', text: '✦', title: 'Scripted' }
}

// ─── Thumbnails ───────────────────────────────────────────────────────────────
const generating = new Set<string>()

async function ensureThumb(entry: VideoEntry) {
  if (entry.thumbnailUrl || generating.has(entry.name))
    return
  generating.add(entry.name)
  const cached = await thumbDb.get(entry.name)
  if (cached) {
    entry.thumbnailUrl = cached
    // Still need duration if not set
    if (entry.duration === null)
      await ensureDuration(entry)
    generating.delete(entry.name)
    return
  }

  const url = URL.createObjectURL(entry.file)
  const video = document.createElement('video')
  video.preload = 'metadata'; video.muted = true; video.playsInline = true; video.src = url

  await new Promise<void>((resolve) => {
    video.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(video.duration))
        entry.duration = video.duration
      video.currentTime = Math.min(video.duration * 0.1, 10)
    }, { once: true })
    video.addEventListener('seeked', () => {
      try {
        const c = document.createElement('canvas')
        c.width = 320; c.height = 180
        c.getContext('2d')!.drawImage(video, 0, 0, 320, 180)
        const dataUrl = c.toDataURL('image/jpeg', 0.7)
        entry.thumbnailUrl = dataUrl
        thumbDb.set(entry.name, dataUrl)
      }
      catch {}
      video.pause(); video.removeAttribute('src'); video.load()
      URL.revokeObjectURL(url); generating.delete(entry.name); resolve()
    }, { once: true })
    video.addEventListener('error', () => {
      video.removeAttribute('src'); URL.revokeObjectURL(url); generating.delete(entry.name); resolve()
    }, { once: true })
  })
}

// Load duration without generating a thumbnail (for already-cached entries)
async function ensureDuration(entry: VideoEntry) {
  if (entry.duration !== null)
    return
  const url = URL.createObjectURL(entry.file)
  const video = document.createElement('video')
  video.preload = 'metadata'; video.muted = true; video.src = url
  await new Promise<void>((resolve) => {
    video.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(video.duration))
        entry.duration = video.duration
      video.removeAttribute('src'); URL.revokeObjectURL(url); resolve()
    }, { once: true })
    video.addEventListener('error', () => {
      video.removeAttribute('src'); URL.revokeObjectURL(url); resolve()
    }, { once: true })
  })
}

function formatDuration(secs: number | null): string {
  if (secs === null || !Number.isFinite(secs))
    return ''
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = Math.floor(secs % 60)
  if (h > 0)
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

async function warmCachedThumbs() {
  for (const entry of library.videos) {
    if (!entry.thumbnailUrl) {
      const cached = await thumbDb.get(entry.name)
      if (cached)
        entry.thumbnailUrl = cached
    }
  }
  // Kick off duration loading after thumbs are warm
  loadAllDurations()
}

// Load durations for all entries in background — cheap, no seek/canvas needed
async function loadAllDurations() {
  const BATCH = 8
  const pending = library.videos.filter(v => v.duration === null)
  for (let i = 0; i < pending.length; i += BATCH) {
    await waitIdle(200)
    await Promise.all(pending.slice(i, i + BATCH).map(ensureDuration))
  }
}

// ─── Bulk thumbs ──────────────────────────────────────────────────────────────
const bulkLoading = ref(false)
const bulkCancelled = ref(false)
const bulkProgress = ref({ done: 0, total: 0 })

function waitIdle(t = 500): Promise<void> {
  return new Promise(r => ('requestIdleCallback' in window)
    ? (window as any).requestIdleCallback(() => r(), { timeout: t })
    : setTimeout(r, 16))
}

async function loadAllThumbs() {
  const pending = library.videos.filter(v => !v.thumbnailUrl)
  if (!pending.length || bulkLoading.value)
    return
  bulkLoading.value = true; bulkCancelled.value = false
  bulkProgress.value = { done: 0, total: pending.length }
  for (const entry of pending) {
    if (bulkCancelled.value)
      break
    await ensureThumb(entry); bulkProgress.value.done++
    await waitIdle(800)
  }
  bulkLoading.value = false; bulkCancelled.value = false
}
function cancelBulk() { bulkCancelled.value = true }

// ─── Folder ───────────────────────────────────────────────────────────────────
const restoring = ref(false)
const isWatching = ref(false)
const watchNewCount = ref(0)
let watchTimer: ReturnType<typeof setInterval> | null = null
const WATCH_INTERVAL_MS = 30_000

async function pickFolder() {
  const { files, handle } = await openFolderWithHandle()
  if (!files.length)
    return
  await library.setFiles(files)
  if (handle) {
    await handleDb.set(HANDLE_KEY, handle)
    startWatching(handle)
  }
  warmCachedThumbs()
}

async function restoreFolder() {
  const handle = await handleDb.get(HANDLE_KEY)
  if (!handle)
    return
  restoring.value = true
  try {
    const files = await reopenFromHandle(handle)
    if (files?.length) {
      await library.setFiles(files)
      warmCachedThumbs()
      startWatching(handle)
    }
  }
  finally { restoring.value = false }
}

function startWatching(handle: FileSystemDirectoryHandle) {
  stopWatching()
  isWatching.value = true
  watchNewCount.value = 0
  watchTimer = setInterval(async () => {
    const files = await reopenFromHandle(handle)
    if (!files)
      return
    const prevNames = new Set(library.videos.map(v => v.name))
    const videoExts = /\.(?:mp4|mkv|webm|avi|mov|m4v|wmv|flv)$/i
    const newVideos = files.filter(f => videoExts.test(f.name) && !prevNames.has(f.name))
    if (newVideos.length) {
      watchNewCount.value += newVideos.length
      await library.setFiles(files)
      warmCachedThumbs()
    }
  }, WATCH_INTERVAL_MS)
}

function stopWatching() {
  isWatching.value = false
  watchNewCount.value = 0
  if (watchTimer) { clearInterval(watchTimer); watchTimer = null }
}

onUnmounted(() => { stopWatching() })

// ─── Context menu ─────────────────────────────────────────────────────────────
const ctxMenu = ref<{ x: number, y: number, entry: VideoEntry } | null>(null)
let lastCtxTs = 0

function openCtx(e: MouseEvent, entry: VideoEntry) {
  e.preventDefault(); e.stopPropagation()
  lastCtxTs = e.timeStamp
  ctxMenu.value = { x: e.clientX, y: e.clientY, entry }
}
function closeCtx() { ctxMenu.value = null }

// ─── Metadata modal ───────────────────────────────────────────────────────────
const metaModal = ref<{ entry: VideoEntry, draft: VideoMeta } | null>(null)

async function openMeta(entry: VideoEntry) {
  closeCtx()
  // Load user overrides from IndexedDB, merge with scriptMeta
  const stored = await videoMetaDb.get(entry.name) ?? {}
  const base: VideoMeta = { ...(entry.scriptMeta ?? {}), ...stored }
  // Ensure tags is always an array
  if (!Array.isArray(base.tags))
    base.tags = []
  metaModal.value = { entry, draft: { ...base } }
}

async function saveMeta() {
  if (!metaModal.value)
    return
  const { entry, draft } = metaModal.value
  await videoMetaDb.set(entry.name, draft)
  entry.userMeta = { ...draft }
  metaModal.value = null
}

function addTag(draft: VideoMeta, tagStr: string) {
  const t = tagStr.trim().toLowerCase()
  if (!t)
    return
  if (!Array.isArray(draft.tags))
    draft.tags = []
  if (!draft.tags.includes(t))
    draft.tags.push(t)
}

function removeTag(draft: VideoMeta, tag: string) {
  if (!Array.isArray(draft.tags))
    return
  draft.tags = draft.tags.filter(t => t !== tag)
}

const newTagInput = ref('')

function onTagKeydown(e: KeyboardEvent, draft: VideoMeta) {
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault()
    addTag(draft, newTagInput.value)
    newTagInput.value = ''
  }
}

/** Effective metadata: user overrides > script meta */
function effectiveMeta(entry: VideoEntry): VideoMeta {
  return { ...(entry.scriptMeta ?? {}), ...(entry.userMeta ?? {}) }
}

function hasMeta(entry: VideoEntry) {
  const m = effectiveMeta(entry)
  return !!(m.tags?.length || m.creator || m.date || m.url || m.notes || m.rating)
}

// Load user meta into entries when library loads
watch(() => library.videos.length, async () => {
  for (const entry of library.videos) {
    if (!entry.userMeta) {
      const stored = await videoMetaDb.get(entry.name)
      if (stored)
        entry.userMeta = stored
    }
  }
  // Load durations in background whenever library changes
  loadAllDurations()
})

onMounted(async () => {
  if (!library.hasVideos)
    await restoreFolder()
  else warmCachedThumbs()
  window.addEventListener('click', closeCtx)
  window.addEventListener('contextmenu', (e: MouseEvent) => {
    if (e.timeStamp !== lastCtxTs)
      closeCtx()
  })
})
onUnmounted(() => {
  window.removeEventListener('click', closeCtx)
  stopWatching()
})
</script>

<template>
  <div class="text-xs flex flex-col h-full min-h-0">
    <!-- ══ Toolbar row ════════════════════════════════════════════════════════ -->
    <div class="px-2 py-1.5 border-b border-white/5 flex shrink-0 gap-1 items-center">
      <span class="font-medium flex-1 min-w-0 truncate" style="color:var(--text-muted)">
        {{ library.folderName || "" }}
        <span v-if="library.hasVideos" style="color:var(--text-faint)"> [{{ sortedFiltered.length }}/{{ library.videos.length }}]</span>
      </span>

      <!-- Grid/List toggle -->
      <button class="btn-ghost px-1.5 py-1" :class="viewMode === 'grid' ? 'text-accent-400' : ''" title="Grid view" @click="viewMode = 'grid'">
        <svg class="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M3 3h7v7H3zm0 11h7v7H3zm11-11h7v7h-7zm0 11h7v7h-7z" /></svg>
      </button>
      <button class="btn-ghost px-1.5 py-1" :class="viewMode === 'list' ? 'text-accent-400' : ''" title="List view" @click="viewMode = 'list'">
        <svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 10h16M4 14h16M4 18h16" /></svg>
      </button>

      <div class="mx-0.5 bg-white/10 h-3.5 w-px" />

      <!-- Bulk thumbs -->
      <button v-if="library.hasVideos && !bulkLoading" class="btn-ghost px-1.5 py-1" style="color:var(--text-faint)" title="Load all previews" @click="loadAllThumbs">
        <svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
      </button>
      <span v-else-if="bulkLoading" class="font-mono flex shrink-0 gap-1 items-center" style="color:var(--text-muted)">
        {{ bulkProgress.done }}/{{ bulkProgress.total }}
        <button class="text-red-400/70 px-0.5 hover:text-red-400" @click="cancelBulk">✕</button>
      </span>

      <!-- Open folder -->
      <button class="btn-primary ml-0.5 px-2 py-1 shrink-0" @click="pickFolder">
        <svg class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" /></svg>
        Open
      </button>

      <!-- Watch indicator -->
      <button
        v-if="isWatching"
        class="group text-[10px] text-emerald-400 px-1.5 py-1 border border-emerald-700/40 rounded bg-emerald-900/30 flex gap-1 transition-colors items-center hover:text-red-400 hover:border-red-700/40 hover:bg-red-900/30"
        title="Folder watching active — click to stop"
        @click="stopWatching"
      >
        <span class="rounded-full bg-emerald-400 h-1.5 w-1.5 animate-pulse group-hover:bg-red-400" />
        <span class="group-hover:hidden">{{ watchNewCount > 0 ? `+${watchNewCount}` : 'Watching' }}</span>
        <span class="hidden group-hover:inline">Stop</span>
      </button>
    </div>

    <!-- ══ Always-visible search + filters + sort ════════════════════════════ -->
    <div class="px-2 pb-1.5 pt-2 border-b border-white/5 flex shrink-0 flex-col gap-1.5">
      <!-- Search -->
      <input v-model="search" type="text" placeholder="Search…" class="input py-1 h-7 w-full">

      <!-- Filter chips + sort in one row -->
      <div class="flex flex-wrap gap-1 items-center">
        <!-- Filter chips -->
        <button
          class="chip" :class="filterScripted ? 'chip-active' : ''"
          @click="filterScripted = !filterScripted"
        >
          ✦ Scripted
        </button>
        <button
          class="chip" :class="filterMultiAxis ? 'chip-active' : ''"
          @click="filterMultiAxis = !filterMultiAxis"
        >
          ⊞ Multi
        </button>
        <button
          class="chip" :class="filterFavorites ? 'chip-active' : ''"
          @click="filterFavorites = !filterFavorites"
        >
          ★ Favs
        </button>

        <!-- Spacer -->
        <div class="flex-1" />

        <!-- Sort -->
        <div class="flex gap-0.5 items-center">
          <button
            v-for="key in (['name', 'size', 'date', 'duration'] as SortKey[])"
            :key="key"
            class="chip" :class="sortKey === key ? 'chip-active' : ''"
            @click="cycleSort(key)"
          >
            {{ SORT_LABELS[key] }}
            <svg v-if="sortKey === key" class="ml-0.5 h-2.5 w-2.5 inline-block transition-transform" :class="sortAsc ? '' : 'rotate-180'" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 15l7-7 7 7" />
            </svg>
          </button>
        </div>
      </div>
    </div>

    <!-- ══ Status ═════════════════════════════════════════════════════════════ -->
    <div v-if="restoring || library.scanning" class="px-3 py-2 flex shrink-0 gap-2 items-center">
      <div class="rounded-full bg-accent-500 shrink-0 h-2 w-2 animate-pulse" />
      <span class="text-[11px] text-white/40">
        {{ restoring ? 'Restoring folder…' : `Scanning ${library.totalFiles.toLocaleString()} files…` }}
      </span>
    </div>

    <!-- ══ Empty ══════════════════════════════════════════════════════════════ -->
    <div v-else-if="!library.hasVideos" class="px-4 text-center flex flex-1 flex-col gap-3 items-center justify-center" style="color:var(--text-faint)">
      <svg class="opacity-20 h-12 w-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
      </svg>
      <div>
        <p class="text-sm text-white/50 font-medium mb-1">
          Open a folder to begin
        </p>
        <p class="text-[11px] opacity-60">
          Scripts are matched automatically.
        </p>
      </div>
      <button class="btn-primary px-3 py-1.5" @click="pickFolder">
        Open Folder
      </button>
    </div>

    <!-- ══ Grid ═══════════════════════════════════════════════════════════════ -->
    <div v-else-if="viewMode === 'grid'" class="p-2 flex-1 overflow-y-auto">
      <div class="gap-2 grid grid-cols-2">
        <button
          v-for="entry in sortedFiltered" :key="entry.name"
          class="group text-left border rounded-lg bg-surface-800 flex flex-col transition-all relative overflow-hidden hover:bg-surface-700"
          :class="[
            entry.scriptType === 'merged' ? 'border-glow-merged'
            : entry.scriptType === 'multi' || entry.scriptCount > 1 ? 'border-glow-multi'
              : 'border-white/5 hover:border-accent-500/30',
          ]"
          @click="emit('select', entry); emit('queue', sortedFiltered, entry); ensureThumb(entry)"
          @mouseenter="ensureThumb(entry)"
          @contextmenu.prevent="openCtx($event, entry)"
        >
          <button
            class="p-0.5 rounded transition-opacity left-1 top-1 absolute z-10"
            :class="plStore.isFavorite(entry.name) ? 'opacity-100 text-yellow-400' : 'opacity-0 group-hover:opacity-60 text-white'"
            @click.stop="plStore.toggleFavorite(entry.name)"
          >
            <svg class="h-3.5 w-3.5" :fill="plStore.isFavorite(entry.name) ? 'currentColor' : 'none'" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" /></svg>
          </button>

          <!-- Thumb -->
          <div class="bg-surface-900 aspect-video relative overflow-hidden">
            <img v-if="entry.thumbnailUrl" :src="entry.thumbnailUrl" class="h-full w-full object-cover" alt="">
            <div v-else class="flex h-full w-full items-center justify-center">
              <svg class="text-white/10 h-6 w-6 transition-colors group-hover:text-white/20" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
            </div>
            <!-- Script badge (top-right of thumb) -->
            <div class="right-1 top-1 absolute">
              <span
                class="text-[9px] px-1.5 py-0.5 rounded-full"
                :class="scriptBadge(entry).cls"
                :title="scriptBadge(entry).title"
              >{{ scriptBadge(entry).text }}</span>
            </div>
            <!-- Duration overlay -->
            <div v-if="entry.duration" class="text-[9px] text-white/80 leading-tight font-mono px-1 rounded bg-black/70 bottom-1 left-1 absolute">
              {{ formatDuration(entry.duration) }}
            </div>
            <!-- Tags row (bottom of thumb, shown on hover) -->
            <div v-if="hasMeta(entry)" class="px-1.5 py-1 opacity-0 flex flex-wrap gap-0.5 transition-opacity inset-x-0 bottom-0 absolute from-black/80 to-transparent bg-gradient-to-t group-hover:opacity-100">
              <span
                v-for="tag in (effectiveMeta(entry).tags ?? []).slice(0, 4)" :key="tag"
                class="text-[8px] text-white/70 px-1 py-0 rounded bg-black/50"
              >{{ tag }}</span>
            </div>
          </div>

          <div class="px-2 py-1.5">
            <p class="text-[11px] text-white/70 truncate transition-colors group-hover:text-white" :title="entry.name">
              {{ entry.basename }}
            </p>
            <div class="mt-0.5 flex gap-1 items-center">
              <p v-if="entry.duration" class="text-[10px] text-white/40 font-mono">
                {{ formatDuration(entry.duration) }}
              </p>
              <p class="text-[10px] text-white/20">
                {{ (entry.file.size / 1024 / 1024).toFixed(0) }} MB
              </p>
              <span v-if="effectiveMeta(entry).creator" class="text-[9px] text-white/20 truncate">· {{ effectiveMeta(entry).creator }}</span>
            </div>
          </div>
        </button>
      </div>
    </div>

    <!-- ══ List ═══════════════════════════════════════════════════════════════ -->
    <div v-else class="flex-1 overflow-y-auto">
      <div
        v-for="entry in sortedFiltered" :key="entry.name"
        class="group px-3 py-2 border-b border-white/[0.04] flex gap-2.5 cursor-pointer transition-colors items-center relative hover:bg-white/5"
        :class="[
          entry.scriptType === 'merged' ? 'border-l-2 border-l-teal-400/50'
          : entry.scriptType === 'multi' || entry.scriptCount > 1 ? 'border-l-2 border-l-indigo-400/50' : '',
        ]"
        @click="emit('select', entry); emit('queue', sortedFiltered, entry); ensureThumb(entry)"
        @mouseenter="ensureThumb(entry)"
        @contextmenu.prevent="openCtx($event, entry)"
      >
        <div class="rounded bg-surface-800 shrink-0 h-8 w-14 overflow-hidden">
          <img v-if="entry.thumbnailUrl" :src="entry.thumbnailUrl" class="h-full w-full object-cover" alt="">
          <div v-else class="flex h-full w-full items-center justify-center">
            <svg class="text-white/20 h-4 w-4" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
          </div>
        </div>
        <div class="flex-1 min-w-0">
          <p class="text-[11px] text-white/70 truncate transition-colors group-hover:text-white" :title="entry.name">
            {{ entry.basename }}
          </p>
          <div class="mt-0.5 flex flex-wrap gap-1 items-center">
            <p v-if="entry.duration" class="text-[10px] text-white/40 font-mono">
              {{ formatDuration(entry.duration) }}
            </p>
            <p class="text-[10px] text-white/25">
              {{ (entry.file.size / 1024 / 1024).toFixed(0) }} MB
            </p>
            <span v-if="effectiveMeta(entry).creator" class="text-[9px] text-white/20">· {{ effectiveMeta(entry).creator }}</span>
            <span
              v-for="tag in (effectiveMeta(entry).tags ?? []).slice(0, 3)" :key="tag"
              class="text-[8px] text-white/30 px-1 py-px rounded bg-white/5"
            >{{ tag }}</span>
          </div>
        </div>

        <button
          class="p-0.5 shrink-0 transition-all"
          :class="plStore.isFavorite(entry.name) ? 'text-yellow-400' : 'opacity-0 group-hover:opacity-40 text-white'"
          @click.stop="plStore.toggleFavorite(entry.name)"
        >
          <svg class="h-3.5 w-3.5" :fill="plStore.isFavorite(entry.name) ? 'currentColor' : 'none'" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" /></svg>
        </button>

        <!-- Colored script badge -->
        <span
          class="text-[9px] px-1.5 py-0.5 rounded-full shrink-0"
          :class="scriptBadge(entry).cls"
          :title="scriptBadge(entry).title"
        >{{ scriptBadge(entry).text }}</span>
      </div>
    </div>

    <!-- ══ Context menu ═══════════════════════════════════════════════════════ -->
    <Teleport to="body">
      <div
        v-if="ctxMenu"
        class="py-1 border rounded-xl min-w-[200px] shadow-2xl fixed z-[999]"
        style="background:var(--bg-850); border-color:var(--border)"
        :style="{ top: `${ctxMenu.y}px`, left: `${ctxMenu.x}px` }"
        @click.stop
      >
        <div class="text-[11px] font-medium px-3 py-1.5 max-w-[240px] truncate" style="color:var(--text-faint)">
          {{ ctxMenu.entry.basename }}
        </div>

        <!-- Metadata preview in context menu -->
        <template v-if="hasMeta(ctxMenu.entry)">
          <div class="mx-2 my-1 h-px" style="background:var(--border)" />
          <div class="text-[10px] px-3 py-1 space-y-0.5" style="color:var(--text-faint)">
            <div v-if="effectiveMeta(ctxMenu.entry).creator">
              <span class="text-white/30">By</span> {{ effectiveMeta(ctxMenu.entry).creator }}
            </div>
            <div v-if="effectiveMeta(ctxMenu.entry).date">
              {{ effectiveMeta(ctxMenu.entry).date }}
            </div>
            <div v-if="(effectiveMeta(ctxMenu.entry).tags ?? []).length" class="pt-0.5 flex flex-wrap gap-0.5">
              <span
                v-for="tag in (effectiveMeta(ctxMenu.entry).tags ?? []).slice(0, 6)" :key="tag"
                class="text-[8px] text-white/40 px-1 py-px rounded bg-white/5"
              >{{ tag }}</span>
            </div>
          </div>
        </template>

        <div class="mx-2 my-1 h-px" style="background:var(--border)" />

        <!-- Edit metadata -->
        <button class="text-xs px-3 py-1.5 text-left flex gap-2 w-full transition-colors items-center hover:bg-white/5" @click="openMeta(ctxMenu!.entry)">
          <svg class="text-blue-400 h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
          Edit info & tags
        </button>

        <button class="text-xs px-3 py-1.5 text-left flex gap-2 w-full transition-colors items-center hover:bg-white/5" @click="plStore.toggleFavorite(ctxMenu!.entry.name); closeCtx()">
          <svg class="text-yellow-400 h-3.5 w-3.5" :fill="plStore.isFavorite(ctxMenu.entry.name) ? 'currentColor' : 'none'" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" /></svg>
          {{ plStore.isFavorite(ctxMenu.entry.name) ? 'Remove from favorites' : 'Add to favorites' }}
        </button>

        <template v-for="pl in plStore.playlists.filter(p => p.id !== 'favorites')" :key="pl.id">
          <button
            class="text-xs px-3 py-1.5 text-left flex gap-2 w-full transition-colors items-center hover:bg-white/5"
            @click="plStore.isInPlaylist(pl.id, ctxMenu!.entry.name) ? plStore.removeFromPlaylist(pl.id, ctxMenu!.entry.name) : plStore.addToPlaylist(pl.id, ctxMenu!.entry.name); closeCtx()"
          >
            <svg class="h-3.5 w-3.5" :fill="plStore.isInPlaylist(pl.id, ctxMenu.entry.name) ? 'currentColor' : 'none'" viewBox="0 0 24 24" stroke="currentColor" style="color:var(--accent)"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" /></svg>
            {{ plStore.isInPlaylist(pl.id, ctxMenu.entry.name) ? `Remove from "${pl.name}"` : `Add to "${pl.name}"` }}
          </button>
        </template>
        <p v-if="!plStore.playlists.filter(p => p.id !== 'favorites').length" class="text-[11px] px-3 py-1.5 italic" style="color:var(--text-faint)">
          No playlists yet
        </p>
      </div>
    </Teleport>

    <!-- ══ Metadata edit modal ════════════════════════════════════════════════ -->
    <Teleport to="body">
      <Transition name="fade">
        <div v-if="metaModal" class="p-4 flex items-center inset-0 justify-center fixed z-[1000]" style="background:rgba(0,0,0,0.7)" @click.self="metaModal = null">
          <div
            class="text-xs border rounded-2xl flex flex-col gap-0 max-w-sm w-full shadow-2xl overflow-hidden"
            style="background:var(--bg-900); border-color:var(--border)"
          >
            <!-- Header -->
            <div class="px-4 py-3 border-b flex items-center justify-between" style="border-color:var(--border)">
              <span class="text-sm text-white/80 font-semibold">Edit Info</span>
              <button class="btn-ghost p-1" @click="metaModal = null">
                <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>

            <!-- Filename -->
            <div class="text-[11px] px-4 py-2 border-b truncate" style="color:var(--text-faint); border-color:var(--border)">
              {{ metaModal.entry.basename }}
            </div>

            <!-- Fields -->
            <div class="px-4 py-3 flex flex-col gap-3 max-h-[60vh] overflow-y-auto">
              <!-- Creator -->
              <div>
                <label class="text-white/50 mb-1 block">Creator</label>
                <input v-model="metaModal.draft.creator" type="text" class="input py-1 h-7 w-full" placeholder="e.g. syujidougu">
              </div>

              <!-- URL -->
              <div>
                <label class="text-white/50 mb-1 block">Source URL</label>
                <input v-model="metaModal.draft.url" type="url" class="input py-1 h-7 w-full" placeholder="https://…">
              </div>

              <!-- Date -->
              <div>
                <label class="text-white/50 mb-1 block">Date</label>
                <input v-model="metaModal.draft.date" type="text" class="input py-1 h-7 w-full" placeholder="2024-10-05">
              </div>

              <!-- Rating -->
              <div>
                <label class="text-white/50 mb-1 block">Rating</label>
                <div class="flex gap-1 items-center">
                  <button
                    v-for="n in 5" :key="n"
                    class="text-lg transition-colors"
                    :class="(metaModal.draft.rating ?? 0) >= n ? 'text-yellow-400' : 'text-white/15 hover:text-white/40'"
                    @click="metaModal.draft.rating = metaModal.draft.rating === n ? 0 : n"
                  >
                    ★
                  </button>
                </div>
              </div>

              <!-- Tags -->
              <div>
                <label class="text-white/50 mb-1 block">Tags</label>
                <div class="mb-1.5 flex flex-wrap gap-1">
                  <span
                    v-for="tag in (metaModal.draft.tags ?? [])" :key="tag"
                    class="text-accent-300 text-[10px] px-1.5 py-0.5 rounded-full bg-accent-600/25 flex gap-0.5 items-center"
                  >
                    {{ tag }}
                    <button class="ml-0.5 transition-colors hover:text-red-400" @click="removeTag(metaModal!.draft, tag)">✕</button>
                  </span>
                </div>
                <input
                  v-model="newTagInput"
                  type="text"
                  class="input py-1 h-7 w-full"
                  placeholder="Add tag, press Enter…"
                  @keydown="onTagKeydown($event, metaModal!.draft)"
                >
              </div>

              <!-- Notes -->
              <div>
                <label class="text-white/50 mb-1 block">Notes</label>
                <textarea v-model="metaModal.draft.notes" class="input text-[11px] py-1.5 w-full resize-none" rows="3" placeholder="Personal notes…" />
              </div>
            </div>

            <!-- Footer -->
            <div class="px-4 py-3 border-t flex gap-2" style="border-color:var(--border)">
              <button class="btn-ghost text-sm py-1.5 flex-1" @click="metaModal = null">
                Cancel
              </button>
              <button class="btn-primary text-sm py-1.5 flex-1" @click="saveMeta">
                Save
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
/* ── Script badge variants ─────────────────────────────────────────── */
.badge-single {
  background: var(--accent-dim, rgba(99, 102, 241, 0.35));
  border: 1px solid rgba(99, 102, 241, 0.4);
}
.badge-multi {
  background: linear-gradient(135deg, rgba(99, 102, 241, 0.5) 0%, rgba(139, 92, 246, 0.5) 100%);
  border: 1px solid rgba(139, 92, 246, 0.5);
}
.badge-merged {
  background: linear-gradient(135deg, rgba(20, 184, 166, 0.55) 0%, rgba(139, 92, 246, 0.55) 100%);
  border: 1px solid rgba(20, 184, 166, 0.5);
  box-shadow: 0 0 6px rgba(20, 184, 166, 0.3);
}

/* ── Card border glows ─────────────────────────────────────────────── */
.border-glow-multi {
  border: 1px solid rgba(139, 92, 246, 0.35);
  box-shadow: 0 0 0 1px rgba(139, 92, 246, 0.15);
}
.border-glow-multi:hover {
  border-color: rgba(139, 92, 246, 0.6);
  box-shadow:
    0 0 0 1px rgba(139, 92, 246, 0.25),
    0 0 12px rgba(139, 92, 246, 0.15);
}
.border-glow-merged {
  border: 1px solid rgba(20, 184, 166, 0.4);
  box-shadow:
    0 0 0 1px rgba(20, 184, 166, 0.15),
    0 0 10px rgba(20, 184, 166, 0.1);
}
.border-glow-merged:hover {
  border-color: rgba(20, 184, 166, 0.7);
  box-shadow:
    0 0 0 1px rgba(20, 184, 166, 0.3),
    0 0 16px rgba(20, 184, 166, 0.2);
}

/* ── Filter / sort chips ──────────────────────────────────────────── */
.chip {
  padding: 0.15rem 0.5rem;
  border-radius: 9999px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.4);
  font-size: 11px;
  transition: all 0.15s;
  white-space: nowrap;
  cursor: pointer;
}
.chip:hover {
  color: rgba(255, 255, 255, 0.7);
  border-color: rgba(255, 255, 255, 0.2);
}
.chip-active {
  border-color: var(--accent, rgb(99, 102, 241));
  color: white;
  font-weight: 600;
  background: var(--accent-dim, rgba(99, 102, 241, 0.2));
}

/* ── Modal fade ───────────────────────────────────────────────────── */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
