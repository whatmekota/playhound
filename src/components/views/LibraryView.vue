<script setup lang="ts">
import type { MenuItem } from '~/components/ui/menu'
import type { VideoMeta } from '~/lib/idb'
import type { VideoEntry } from '~/stores/libraryStore'
import type { Playlist } from '~/stores/playlistStore'
import { refDebounced, useElementSize, useLocalStorage, watchDebounced } from '@vueuse/core'
import { computed, nextTick, onActivated, onDeactivated, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiContextMenu from '~/components/ui/UiContextMenu.vue'
import UiEmpty from '~/components/ui/UiEmpty.vue'
import UiIconButton from '~/components/ui/UiIconButton.vue'
import UiInput from '~/components/ui/UiInput.vue'
import UiKbd from '~/components/ui/UiKbd.vue'
import UiMenu from '~/components/ui/UiMenu.vue'
import UiModal from '~/components/ui/UiModal.vue'
import UiPopover from '~/components/ui/UiPopover.vue'
import UiProgress from '~/components/ui/UiProgress.vue'
import UiSegmented from '~/components/ui/UiSegmented.vue'
import UiSlider from '~/components/ui/UiSlider.vue'
import UiSpinner from '~/components/ui/UiSpinner.vue'
import { toast } from '~/composables/useToast'
import { effectiveMeta, formatDate, formatSize, plural, scriptBadge } from '~/lib/entryInfo'
import { videoMetaDb } from '~/lib/idb'
import { cancelGenerateAll, generateAllThumbs, hydrateLibrary, thumbBusy, thumbFailed, thumbJob, thumbsFor } from '~/lib/thumbs'
import { formatTime } from '~/lib/time'
import { useLibraryStore } from '~/stores/libraryStore'
import { usePlaybackStore } from '~/stores/playbackStore'
import { usePlayerStore } from '~/stores/playerStore'
import { usePlaylistStore } from '~/stores/playlistStore'
import { useQueueStore } from '~/stores/queueStore'
import { useUiStore } from '~/stores/uiStore'

defineOptions({ name: 'LibraryView' })

const library = useLibraryStore()
const playback = usePlaybackStore()
const queue = useQueueStore()
const player = usePlayerStore()
const plStore = usePlaylistStore()
const ui = useUiStore()

const scroller = ref<HTMLElement | null>(null)

// ─── Preferences ──────────────────────────────────────────────────────────────
type SortKey = 'name' | 'size' | 'date' | 'duration'
type FilterKey = 'scripted' | 'multi' | 'starred' | 'unscripted'

// Legacy key kept so the saved sort survives the rename.
const sort = useLocalStorage<{ key: SortKey, asc: boolean }>('ph:library.sort', { key: 'name', asc: true }, { mergeDefaults: true })
const viewMode = useLocalStorage<'grid' | 'list'>('ph:library.view', 'grid')
/** Minimum card width in px; the grid fits as many columns as that allows. */
const cardSize = useLocalStorage('ph:library.cardSize', 220)

const SORT_LABELS: Record<SortKey, string> = { name: 'Name', size: 'Size', date: 'Date modified', duration: 'Duration' }

function setSort(key: SortKey, asc?: boolean) {
  if (asc !== undefined)
    sort.value = { key, asc }
  else if (sort.value.key === key)
    sort.value = { key, asc: !sort.value.asc }
  // Newest and longest first is what anyone sorting by those wants.
  else
    sort.value = { key, asc: key === 'name' }
}

// ─── Search, filters, sort ────────────────────────────────────────────────────
const search = ref('')
const query = refDebounced(search, 120)
const filters = ref(new Set<FilterKey>())

function toggleFilter(f: FilterKey) {
  const next = new Set(filters.value)
  if (next.has(f)) {
    next.delete(f)
  }
  else {
    next.add(f)
    // Scripted and unscripted cannot both hold.
    if (f === 'scripted')
      next.delete('unscripted')
    if (f === 'unscripted') {
      next.delete('scripted')
      next.delete('multi')
    }
    if (f === 'multi')
      next.delete('unscripted')
  }
  filters.value = next
}

function clearFilters() {
  filters.value = new Set()
  search.value = ''
}

const isMulti = (v: VideoEntry) => v.scriptCount > 1 || v.scriptType === 'merged'

const counts = computed(() => {
  let scripted = 0
  let multi = 0
  let starred = 0
  for (const v of library.videos) {
    if (v.hasScript)
      scripted++
    if (isMulti(v))
      multi++
    if (v.starred)
      starred++
  }
  return { scripted, multi, starred, unscripted: library.videos.length - scripted }
})

const FILTERS: { key: FilterKey, label: string, icon: string }[] = [
  { key: 'scripted', label: 'Scripted', icon: 'i-carbon-chart-line-smooth' },
  { key: 'multi', label: 'Multi-axis', icon: 'i-carbon-chart-multi-line' },
  { key: 'starred', label: 'Starred', icon: 'i-carbon-star' },
  { key: 'unscripted', label: 'No script', icon: 'i-carbon-subtract-alt' },
]

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

const sortedFiltered = computed(() => {
  const q = query.value.trim().toLowerCase()
  const f = filters.value
  const list = library.videos.filter((v) => {
    if (f.has('scripted') && !v.hasScript)
      return false
    if (f.has('unscripted') && v.hasScript)
      return false
    // Axis count, so a merged single file counts and alternate takes do not.
    if (f.has('multi') && !isMulti(v))
      return false
    if (f.has('starred') && !v.starred)
      return false
    if (q) {
      if (v.basename.toLowerCase().includes(q))
        return true
      const m = effectiveMeta(v)
      return !!(m.creator?.toLowerCase().includes(q) || m.tags?.some(t => t.includes(q)))
    }
    return true
  })
  const { key, asc } = sort.value
  list.sort((a, b) => {
    let cmp = 0
    if (key === 'name')
      cmp = collator.compare(a.basename, b.basename)
    else if (key === 'size')
      cmp = a.file.size - b.file.size
    else if (key === 'date')
      cmp = (a.file.lastModified ?? 0) - (b.file.lastModified ?? 0)
    else if (key === 'duration')
      cmp = (a.duration ?? 0) - (b.duration ?? 0)
    return asc ? cmp : -cmp
  })
  return list
})

const filtering = computed(() => !!query.value.trim() || filters.value.size > 0)

// ─── Now playing ──────────────────────────────────────────────────────────────
const currentName = computed(() => playback.currentEntry?.name ?? queue.current?.name ?? null)

// ─── Playing ──────────────────────────────────────────────────────────────────
function playEntry(entry: VideoEntry) {
  void playback.play(entry, sortedFiltered.value, 'Library')
}

function playAll() {
  const list = sortedFiltered.value
  if (!list.length)
    return
  // "Play" means in order, the way every music player treats it.
  if (queue.shuffle)
    queue.setShuffle(false)
  void playback.play(list[0], list, 'Library')
}

function shuffleAll() {
  const list = sortedFiltered.value
  if (!list.length)
    return
  if (!queue.shuffle)
    queue.setShuffle(true)
  void playback.play(list[Math.floor(Math.random() * list.length)], list, 'Library')
}

function playList(entries: VideoEntry[], label = 'Selection') {
  if (entries.length)
    void playback.play(entries[0], entries, label)
}

// ─── Selection ────────────────────────────────────────────────────────────────
const selected = shallowRef(new Set<string>())
let anchor: string | null = null

const selectedEntries = computed(() => {
  if (!selected.value.size)
    return []
  return sortedFiltered.value.filter(v => selected.value.has(v.name))
    .concat(library.videos.filter(v => selected.value.has(v.name) && !sortedFiltered.value.includes(v)))
})

function toggleSelect(entry: VideoEntry) {
  const next = new Set(selected.value)
  if (next.has(entry.name))
    next.delete(entry.name)
  else
    next.add(entry.name)
  selected.value = next
  anchor = entry.name
}

function selectRange(entry: VideoEntry) {
  const list = sortedFiltered.value
  const a = anchor ? list.findIndex(v => v.name === anchor) : -1
  const b = list.findIndex(v => v.name === entry.name)
  if (a < 0 || b < 0) {
    toggleSelect(entry)
    return
  }
  const next = new Set(selected.value)
  for (let i = Math.min(a, b); i <= Math.max(a, b); i++)
    next.add(list[i].name)
  selected.value = next
}

function clearSelection() {
  selected.value = new Set()
  anchor = null
}

function selectAll() {
  selected.value = new Set(sortedFiltered.value.map(v => v.name))
}

function onItemClick(e: MouseEvent, entry: VideoEntry) {
  if (e.ctrlKey || e.metaKey)
    return toggleSelect(entry)
  if (e.shiftKey)
    return selectRange(entry)
  if (selected.value.size)
    clearSelection()
  playEntry(entry)
}

// ─── Stars & playlists ────────────────────────────────────────────────────────
function setStar(entries: VideoEntry[], on: boolean) {
  for (const e of entries) {
    if (e.starred !== on)
      library.toggleStar(e)
  }
  toast(on ? (entries.length === 1 ? 'Starred' : `Starred ${entries.length} videos`) : (entries.length === 1 ? 'Unstarred' : `Unstarred ${entries.length} videos`), {
    icon: on ? 'i-carbon-star-filled' : 'i-carbon-star',
    key: 'star',
  })
}

function inPlaylist(pl: Playlist, entries: VideoEntry[]) {
  return entries.every(e => plStore.isInPlaylist(pl.id, e.name))
}

function togglePlaylist(pl: Playlist, entries: VideoEntry[]) {
  if (inPlaylist(pl, entries)) {
    for (const e of entries)
      plStore.removeFromPlaylist(pl.id, e.name)
    toast(`Removed from ${pl.name}`, { icon: 'i-carbon-playlist', key: 'playlist' })
  }
  else {
    for (const e of entries)
      plStore.addToPlaylist(pl.id, e.name)
    toast(`Added to ${pl.name}`, {
      detail: entries.length === 1 ? entries[0].basename : plural(entries.length, 'video'),
      icon: 'i-carbon-playlist',
      key: 'playlist',
      action: { label: 'Open', run: () => ui.openView('playlists') },
    })
  }
}

function playlistItems(entries: VideoEntry[]): MenuItem[] {
  return [
    ...plStore.playlists.map(pl => ({
      label: pl.name,
      icon: pl.id === 'favorites' ? 'i-carbon-favorite' : 'i-carbon-playlist',
      checked: inPlaylist(pl, entries),
      run: () => togglePlaylist(pl, entries),
    })),
    { separator: true },
    { label: 'New playlist…', icon: 'i-carbon-add', run: () => askNewPlaylist(entries) },
  ]
}

// New playlist from a selection
const newPl = ref<{ entries: VideoEntry[], name: string } | null>(null)
const newPlOpen = computed({
  get: () => !!newPl.value,
  set: (v) => {
    if (!v)
      newPl.value = null
  },
})
const newPlInput = ref<InstanceType<typeof UiInput> | null>(null)

function askNewPlaylist(entries: VideoEntry[]) {
  newPl.value = { entries, name: '' }
  void nextTick(() => newPlInput.value?.focus())
}

function createPlaylist() {
  if (!newPl.value)
    return
  const name = newPl.value.name.trim() || `Playlist ${plStore.playlists.length}`
  const pl = plStore.createPlaylist(name)
  for (const e of newPl.value.entries)
    plStore.addToPlaylist(pl.id, e.name)
  toast.success(`Created ${name}`, {
    detail: plural(newPl.value.entries.length, 'video'),
    icon: 'i-carbon-playlist',
    action: { label: 'Open', run: () => ui.openView('playlists') },
  })
  newPl.value = null
}

// ─── Context menu ─────────────────────────────────────────────────────────────
const ctx = ref<{ x: number, y: number, items: MenuItem[] } | null>(null)

function openCtx(e: MouseEvent, entry: VideoEntry) {
  // Right-clicking inside the selection acts on all of it; outside, on that one video.
  const targets = selected.value.has(entry.name) && selected.value.size > 1 ? selectedEntries.value : [entry]
  ctx.value = { x: e.clientX, y: e.clientY, items: menuFor(targets, { x: e.clientX, y: e.clientY }) }
}

function menuFor(targets: VideoEntry[], at: { x: number, y: number }): MenuItem[] {
  const one = targets.length === 1 ? targets[0] : null
  const allStarred = targets.every(t => t.starred)
  const items: MenuItem[] = []
  if (!one)
    items.push({ heading: true, label: `${targets.length} selected` })
  items.push(
    { label: 'Play', icon: 'i-carbon-play-filled-alt', run: () => (one ? playEntry(one) : playList(targets)) },
    { label: 'Play next', icon: 'i-carbon-skip-forward', run: () => playback.playNextInQueue(targets) },
    { label: 'Add to queue', icon: 'i-carbon-list-boxes', run: () => playback.addToQueue(targets) },
    { separator: true },
    // The menu closes after an item runs, so the playlist list opens on the next tick in its place.
    { label: 'Add to playlist…', icon: 'i-carbon-playlist', run: () => setTimeout(() => (ctx.value = { ...at, items: [{ heading: true, label: 'Add to playlist' }, ...playlistItems(targets)] })) },
    { label: allStarred ? 'Unstar' : 'Star', icon: allStarred ? 'i-carbon-star-filled' : 'i-carbon-star', run: () => setStar(targets, !allStarred) },
  )
  if (one) {
    items.push(
      { separator: true },
      { label: 'Info & tags…', icon: 'i-carbon-tag-edit', run: () => void openMeta(one) },
      { label: 'Copy file name', icon: 'i-carbon-copy', run: () => void copyName(one) },
    )
  }
  else {
    items.push({ separator: true }, { label: 'Clear selection', icon: 'i-carbon-close', run: clearSelection })
  }
  return items
}

async function copyName(entry: VideoEntry) {
  try {
    await navigator.clipboard.writeText(entry.name)
    toast('File name copied', { icon: 'i-carbon-copy', key: 'copy' })
  }
  catch {
    toast.error('Clipboard is not available')
  }
}

// ─── Info & tags ──────────────────────────────────────────────────────────────
const meta = ref<{ entry: VideoEntry, draft: VideoMeta } | null>(null)
const metaOpen = computed({
  get: () => !!meta.value,
  set: (v) => {
    if (!v)
      meta.value = null
  },
})
const tagInput = ref('')

async function openMeta(entry: VideoEntry) {
  let stored: VideoMeta = {}
  try {
    stored = await videoMetaDb.get(entry.name) ?? {}
  }
  catch {}
  const draft: VideoMeta = { ...(entry.scriptMeta ?? {}), ...stored }
  draft.tags = Array.isArray(draft.tags) ? [...draft.tags] : []
  tagInput.value = ''
  meta.value = { entry, draft }
}

function addTag() {
  if (!meta.value)
    return
  for (const raw of tagInput.value.split(',')) {
    const t = raw.trim().toLowerCase()
    if (t && !meta.value.draft.tags!.includes(t))
      meta.value.draft.tags!.push(t)
  }
  tagInput.value = ''
}

function onTagKey(e: KeyboardEvent) {
  if (e.key === ',' || e.key === 'Enter') {
    e.preventDefault()
    addTag()
  }
  else if (e.key === 'Backspace' && !tagInput.value && meta.value?.draft.tags?.length) {
    meta.value.draft.tags.pop()
  }
}

async function saveMeta() {
  if (!meta.value)
    return
  addTag()
  const { entry, draft } = meta.value
  const clean: VideoMeta = JSON.parse(JSON.stringify(draft))
  try {
    await videoMetaDb.set(entry.name, clean)
    entry.userMeta = clean
    toast.success('Info saved', { detail: entry.basename, key: 'meta' })
    meta.value = null
  }
  catch {
    toast.error('Could not save info')
  }
}

const allTags = computed(() => {
  const set = new Set<string>()
  for (const v of library.videos) {
    for (const t of effectiveMeta(v).tags ?? [])
      set.add(t)
  }
  return [...set].sort()
})

// ─── Folder ───────────────────────────────────────────────────────────────────
const rescanning = ref(false)

async function rescan() {
  rescanning.value = true
  try {
    await library.rescan()
    toast('Library rescanned', { detail: plural(library.videos.length, 'video'), icon: 'i-carbon-renew', key: 'rescan' })
  }
  finally {
    rescanning.value = false
  }
}

function showNew() {
  setSort('date', false)
  library.watchNewCount = 0
  scroller.value?.scrollTo({ top: 0, behavior: 'smooth' })
}

const folderMenu = computed<MenuItem[]>(() => [
  thumbJob.running
    ? { label: 'Stop generating previews', icon: 'i-carbon-stop', run: cancelGenerateAll }
    : { label: 'Generate all previews', icon: 'i-carbon-image', run: () => void generateAllThumbs(library.videos), disabled: !library.hasVideos },
  { separator: true },
  library.isWatching
    ? { label: 'Stop watching folder', icon: 'i-carbon-view-off', run: library.stopWatching }
    : { label: 'Rescan folder', icon: 'i-carbon-renew', run: () => void rescan(), disabled: !library.hasVideos },
  { label: 'Forget folder', icon: 'i-carbon-folder-off', danger: true, run: () => void library.forgetFolder(), disabled: !library.hasVideos && !library.savedFolderName },
])

const sortMenu = computed<MenuItem[]>(() => [
  { heading: true, label: 'Sort by' },
  ...(Object.keys(SORT_LABELS) as SortKey[]).map(k => ({ label: SORT_LABELS[k], checked: sort.value.key === k, run: () => setSort(k, sort.value.asc) })),
  { separator: true },
  { label: 'Ascending', icon: 'i-carbon-sort-ascending', checked: sort.value.asc, run: () => setSort(sort.value.key, true) },
  { label: 'Descending', icon: 'i-carbon-sort-descending', checked: !sort.value.asc, run: () => setSort(sort.value.key, false) },
])

// ─── Windowed grid / list ─────────────────────────────────────────────────────
// Only the rows in view (plus a margin) are rendered, so ten thousand videos
// cost the same as forty. Rows are absolutely placed inside a spacer of the
// full height, which keeps the native scrollbar honest.
const GAP = 16
const ROW_GAP = 22
const INFO_H = 46
const LIST_ROW_H = 48
const OVERSCAN = 2

const { width: innerW, height: viewH } = useElementSize(scroller)
const scrollTop = ref(0)
let scrollRaf = 0

function onScroll() {
  if (scrollRaf)
    return
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0
    scrollTop.value = scroller.value?.scrollTop ?? 0
  })
}

const cols = computed(() => viewMode.value === 'list' ? 1 : Math.max(1, Math.floor((innerW.value + GAP) / (cardSize.value + GAP))))
const cardW = computed(() => (innerW.value - GAP * (cols.value - 1)) / cols.value)
const rowH = computed(() => viewMode.value === 'list' ? LIST_ROW_H : Math.round(cardW.value * 9 / 16 + INFO_H + ROW_GAP))
const rowCount = computed(() => Math.ceil(sortedFiltered.value.length / cols.value))
const totalH = computed(() => rowCount.value * rowH.value)

const rows = computed(() => {
  const h = Math.max(1, rowH.value)
  const first = Math.max(0, Math.floor(scrollTop.value / h) - OVERSCAN)
  const last = Math.min(rowCount.value, Math.ceil((scrollTop.value + Math.max(viewH.value, 400)) / h) + OVERSCAN)
  const list = sortedFiltered.value
  const out: { index: number, top: number, cells: { entry: VideoEntry, index: number }[] }[] = []
  for (let r = first; r < last; r++) {
    const start = r * cols.value
    out.push({
      index: r,
      top: r * h,
      cells: list.slice(start, start + cols.value).map((entry, j) => ({ entry, index: start + j })),
    })
  }
  return out
})

const visibleEntries = computed(() => rows.value.flatMap(r => r.cells.map(c => c.entry)))

// The scroller is re-created when the body switches between states.
watch(scroller, el => (scrollTop.value = el?.scrollTop ?? 0))

// A new search or sort starts at the top.
watch([query, filters, sort], () => scroller.value?.scrollTo({ top: 0 }), { deep: true })

function locateCurrent() {
  const i = sortedFiltered.value.findIndex(v => v.name === currentName.value)
  if (i < 0 || !scroller.value)
    return
  const row = Math.floor(i / cols.value)
  scroller.value.scrollTo({ top: Math.max(0, row * rowH.value - viewH.value / 2 + rowH.value / 2), behavior: 'smooth' })
}
const currentInList = computed(() => !!currentName.value && sortedFiltered.value.some(v => v.name === currentName.value))

// ─── Background work ──────────────────────────────────────────────────────────
const active = ref(true)

watchDebounced([visibleEntries, active], () => {
  // While the view is cached but hidden, drop its pending on-screen requests.
  thumbsFor(active.value ? visibleEntries.value : [])
}, { debounce: 90 })

watch(() => library.loadedAt, () => {
  void hydrateLibrary(library.videos, library.loadedAt)
  clearSelection()
}, { immediate: true })

// ─── Keyboard ─────────────────────────────────────────────────────────────────
const searchInput = ref<InstanceType<typeof UiInput> | null>(null)

function onKey(e: KeyboardEvent) {
  const t = e.target as HTMLElement
  if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
    return
  if (ui.paletteOpen || ui.settingsOpen || meta.value || newPl.value)
    return
  if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault()
    searchInput.value?.focus()
  }
  else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyA' && library.hasVideos) {
    e.preventDefault()
    selectAll()
  }
}

// Inside the shell's KeepAlive these follow activation; the mount hooks cover
// being rendered without it. Adding the same listener twice is a no-op.
onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))
onActivated(() => {
  active.value = true
  window.addEventListener('keydown', onKey)
})
onDeactivated(() => {
  active.value = false
  window.removeEventListener('keydown', onKey)
})

// ─── Helpers for the template ─────────────────────────────────────────────────
function subline(entry: VideoEntry) {
  const m = effectiveMeta(entry)
  return [formatSize(entry.file.size), m.creator].filter(Boolean).join(' · ')
}

const sortLabel = computed(() => SORT_LABELS[sort.value.key].replace(' modified', ''))

/** A click on empty space clears the selection, like a file manager. */
function onBackgroundClick(e: MouseEvent) {
  if (selected.value.size && !(e.target as HTMLElement).closest('.card-item, .list-row'))
    clearSelection()
}
</script>

<template>
  <div class="bg-surface-950 flex flex-col h-full min-h-0 relative">
    <!-- ══ Header ═════════════════════════════════════════════════════════════ -->
    <header class="px-6 pb-3 pt-5 flex shrink-0 gap-4 items-end">
      <div class="flex-1 min-w-0">
        <h1 class="h-view">
          Library
        </h1>
        <div class="text-[12.5px] text-fg-muted mt-1 flex flex-wrap gap-x-2 gap-y-1 min-h-5 items-center">
          <template v-if="library.hasVideos">
            <span class="flex gap-1.5 min-w-0 items-center">
              <span class="i-carbon-folder text-fg-faint shrink-0" />
              <span class="text-fg font-medium truncate">{{ library.folderName }}</span>
            </span>
            <span class="text-fg-faint">·</span>
            <span class="num">{{ plural(library.videos.length, 'video') }}</span>
            <span class="text-fg-faint">·</span>
            <span class="num">{{ counts.scripted.toLocaleString() }} scripted</span>
            <span v-if="filtering" class="text-accent-300 num">· {{ sortedFiltered.length.toLocaleString() }} shown</span>
            <UiBadge
              v-if="library.isWatching"
              v-tip="'Checking the folder for new videos every 30 seconds'"
              tone="ok" size="xs" dot pulse class="ml-1"
            >
              Watching
            </UiBadge>
            <Transition name="t-pop">
              <button
                v-if="library.watchNewCount > 0"
                v-tip="'Show newest first'"
                type="button"
                class="focusable rounded-[var(--radius-xs)] pressable"
                @click="showNew"
              >
                <UiBadge tone="accent" size="xs" icon="i-carbon-new-tab">
                  {{ library.watchNewCount }} new
                </UiBadge>
              </button>
            </Transition>
          </template>
          <span v-else-if="library.savedFolderName" class="flex gap-1.5 items-center">
            <span class="i-carbon-folder text-fg-faint" />{{ library.savedFolderName }}
          </span>
          <span v-else>Your videos and their matched scripts</span>
        </div>
      </div>

      <div class="flex shrink-0 gap-1.5 items-center">
        <UiIconButton
          v-if="library.isWatching"
          icon="i-carbon-renew"
          label="Rescan folder"
          :class="rescanning ? 'animate-spin' : ''"
          :disabled="rescanning"
          @click="rescan"
        />
        <UiButton icon="i-carbon-folder-open" :loading="library.scanning && library.hasVideos" @click="library.pickFolder()">
          {{ library.hasVideos ? 'Change folder' : 'Open folder' }}
        </UiButton>
        <UiPopover placement="bottom" align="end" flush>
          <template #trigger="{ toggle, open }">
            <UiIconButton icon="i-carbon-overflow-menu-horizontal" label="More" :active="open" @click="toggle" />
          </template>
          <template #default="{ close }">
            <div class="p-1">
              <UiMenu :items="folderMenu" @done="close" />
            </div>
          </template>
        </UiPopover>
      </div>
    </header>

    <!-- ══ Toolbar ════════════════════════════════════════════════════════════ -->
    <div v-if="library.hasVideos" class="px-6 pb-3 flex shrink-0 flex-wrap gap-2 items-center">
      <UiInput
        ref="searchInput"
        v-model="search"
        icon="i-carbon-search"
        placeholder="Search names, tags, creators"
        clearable
        class="w-[260px]"
        @escape="searchInput?.el?.blur()"
      >
        <template #suffix>
          <UiKbd v-if="!search" class="mr-1.5">
            /
          </UiKbd>
        </template>
      </UiInput>

      <div class="flex flex-wrap gap-1.5 items-center">
        <button
          v-for="f in FILTERS"
          :key="f.key"
          type="button"
          class="chip focusable pressable"
          :class="filters.has(f.key) ? 'chip-on' : ''"
          :aria-pressed="filters.has(f.key)"
          @click="toggleFilter(f.key)"
        >
          <span :class="filters.has(f.key) && f.key === 'starred' ? 'i-carbon-star-filled' : f.icon" class="text-[13px]" />
          {{ f.label }}
          <span class="text-[11px] num opacity-60">{{ counts[f.key].toLocaleString() }}</span>
        </button>
        <Transition name="t-fade">
          <UiButton v-if="filtering" variant="ghost" size="xs" icon="i-carbon-close" @click="clearFilters">
            Clear
          </UiButton>
        </Transition>
      </div>

      <div class="flex-1" />

      <UiIconButton
        v-if="currentInList"
        icon="i-carbon-center-circle"
        label="Scroll to now playing"
        @click="locateCurrent"
      />

      <UiPopover placement="bottom" align="end" flush>
        <template #trigger="{ toggle, open }">
          <UiButton variant="ghost" :active="open" :icon="sort.asc ? 'i-carbon-sort-ascending' : 'i-carbon-sort-descending'" @click="toggle">
            {{ sortLabel }}
          </UiButton>
        </template>
        <template #default="{ close }">
          <div class="p-1">
            <UiMenu :items="sortMenu" @done="close" />
          </div>
        </template>
      </UiPopover>

      <Transition name="t-fade">
        <div v-if="viewMode === 'grid'" v-tip="'Card size'" class="text-fg-faint flex gap-1.5 w-28 items-center">
          <span class="i-carbon-zoom-out text-[13px] shrink-0" />
          <UiSlider v-model="cardSize" :min="160" :max="380" :step="10" hide-value class="flex-1" />
          <span class="i-carbon-zoom-in text-[13px] shrink-0" />
        </div>
      </Transition>

      <UiSegmented
        v-model="viewMode"
        :options="[
          { value: 'grid', icon: 'i-carbon-grid', title: 'Grid' },
          { value: 'list', icon: 'i-carbon-list', title: 'List' },
        ]"
      />

      <div class="mx-1 divider-x" />

      <UiButton variant="primary" icon="i-carbon-play-filled-alt" :disabled="!sortedFiltered.length" @click="playAll">
        Play all
      </UiButton>
      <UiIconButton icon="i-carbon-shuffle" label="Shuffle all" variant="solid" :disabled="!sortedFiltered.length" @click="shuffleAll" />
    </div>

    <!-- Thumbnail generation / scanning progress -->
    <Transition name="t-collapse">
      <div v-if="thumbJob.running || (library.scanning && library.hasVideos)">
        <div class="min-h-0 overflow-hidden">
          <div class="text-[12px] text-fg-muted px-6 pb-3 flex gap-3 items-center">
            <template v-if="thumbJob.running">
              <span class="i-carbon-image text-accent-300 shrink-0" />
              <span class="num shrink-0">Generating previews {{ thumbJob.done.toLocaleString() }} / {{ thumbJob.total.toLocaleString() }}</span>
              <UiProgress :value="thumbJob.total ? thumbJob.done / thumbJob.total : 0" class="flex-1 max-w-[320px]" />
              <UiButton variant="ghost" size="xs" @click="cancelGenerateAll">
                Stop
              </UiButton>
            </template>
            <template v-else>
              <UiSpinner :size="13" />
              <span class="num">Rescanning {{ library.totalFiles.toLocaleString() }} files…</span>
              <UiProgress class="flex-1 max-w-[320px]" />
            </template>
          </div>
        </div>
      </div>
    </Transition>

    <!-- ══ Body ═══════════════════════════════════════════════════════════════ -->
    <div class="lib-body border-t border-edge flex flex-1 flex-col min-h-0 relative">
      <!-- Restoring the remembered folder -->
      <div v-if="library.restoring && !library.hasVideos" class="center flex-1 min-h-0">
        <UiEmpty icon="i-carbon-folder-open" title="Opening your library" :description="`Reading ${library.savedFolderName || 'the last folder'}…`">
          <UiSpinner :size="18" />
        </UiEmpty>
      </div>

      <!-- First scan: skeleton cards so the layout is there before the data -->
      <div v-else-if="library.scanning && !library.hasVideos" class="px-6 pt-5 flex-1 min-h-0 overflow-hidden">
        <div class="text-[12.5px] text-fg-muted mb-4 flex gap-2 items-center">
          <UiSpinner :size="13" />
          <span class="num">Scanning {{ library.totalFiles.toLocaleString() }} files and matching scripts…</span>
        </div>
        <div class="gap-4 grid" :style="{ gridTemplateColumns: `repeat(auto-fill, minmax(${cardSize}px, 1fr))` }">
          <div v-for="i in 18" :key="i" class="flex flex-col gap-2" :style="{ animationDelay: `${i * 30}ms` }">
            <div class="skeleton rounded-[var(--radius-md)] aspect-video" />
            <div class="skeleton rounded h-3 w-3/4" />
            <div class="skeleton rounded h-2.5 w-1/3" />
          </div>
        </div>
      </div>

      <!-- The browser wants a click before it re-reads the folder -->
      <div v-else-if="library.needsReconnect && !library.hasVideos" class="center flex-1 min-h-0">
        <UiEmpty
          icon="i-carbon-folder-off"
          size="lg"
          :title="`Reconnect “${library.savedFolderName}”`"
          description="The browser asks for permission again after a restart. One click and your library is back, thumbnails and all."
        >
          <UiButton variant="primary" size="lg" icon="i-carbon-unlocked" @click="library.reconnect()">
            Reconnect folder
          </UiButton>
          <UiButton size="lg" icon="i-carbon-folder-open" @click="library.pickFolder()">
            Choose another
          </UiButton>
        </UiEmpty>
      </div>

      <!-- No folder at all -->
      <div v-else-if="!library.hasVideos" class="center flex-1 min-h-0">
        <UiEmpty
          icon="i-carbon-folder-add"
          size="lg"
          title="Open a folder to build your library"
          description="Videos are matched with their .funscript files automatically, including multi-axis and alternate takes. The folder is remembered and watched for new videos."
        >
          <UiButton variant="primary" size="lg" icon="i-carbon-folder-open" @click="library.pickFolder()">
            Open folder
          </UiButton>
          <template #description>
            <p class="hint mt-2">
              You can also drop a folder anywhere on the window.
            </p>
          </template>
        </UiEmpty>
      </div>

      <!-- Nothing matches -->
      <div v-else-if="!sortedFiltered.length" class="center flex-1 min-h-0">
        <UiEmpty
          icon="i-carbon-search"
          title="Nothing matches"
          :description="query ? `No videos match “${query}” with the current filters.` : 'No videos match the current filters.'"
        >
          <UiButton icon="i-carbon-close" @click="clearFilters">
            Clear search and filters
          </UiButton>
        </UiEmpty>
      </div>

      <template v-else>
        <!-- List header -->
        <div v-if="viewMode === 'list'" class="list-cols eyebrow mx-6 px-2 border-b border-edge shrink-0 h-8 items-center">
          <span />
          <span />
          <button type="button" class="sort-head" :class="sort.key === 'name' ? 'text-fg' : ''" @click="setSort('name')">
            Name<span v-if="sort.key === 'name'" :class="sort.asc ? 'i-carbon-arrow-up' : 'i-carbon-arrow-down'" />
          </button>
          <span>Script</span>
          <button type="button" class="sort-head justify-end" :class="sort.key === 'duration' ? 'text-fg' : ''" @click="setSort('duration')">
            <span v-if="sort.key === 'duration'" :class="sort.asc ? 'i-carbon-arrow-up' : 'i-carbon-arrow-down'" />Length
          </button>
          <button type="button" class="sort-head justify-end" :class="sort.key === 'size' ? 'text-fg' : ''" @click="setSort('size')">
            <span v-if="sort.key === 'size'" :class="sort.asc ? 'i-carbon-arrow-up' : 'i-carbon-arrow-down'" />Size
          </button>
          <button type="button" class="sort-head col-date justify-end" :class="sort.key === 'date' ? 'text-fg' : ''" @click="setSort('date')">
            <span v-if="sort.key === 'date'" :class="sort.asc ? 'i-carbon-arrow-up' : 'i-carbon-arrow-down'" />Modified
          </button>
          <span />
        </div>

        <div
          ref="scroller"
          class="px-6 scroll-y flex-1"
          :class="viewMode === 'list' ? 'pt-1' : 'pt-5'"
          @scroll.passive="onScroll"
          @click="onBackgroundClick"
        >
          <div class="relative" :style="{ height: `${totalH}px` }">
            <!-- ── Grid ─────────────────────────────────────────────────────── -->
            <template v-if="viewMode === 'grid'">
              <div
                v-for="row in rows"
                :key="row.index"
                class="grid inset-x-0 absolute"
                :style="{ top: `${row.top}px`, gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, columnGap: `${GAP}px` }"
              >
                <div
                  v-for="{ entry } in row.cells"
                  :key="entry.name"
                  class="card-item group focusable rounded-[var(--radius-md)] cursor-pointer relative"
                  :class="{ 'is-selected': selected.has(entry.name), 'is-current': entry.name === currentName }"
                  tabindex="0"
                  role="button"
                  :aria-label="entry.basename"
                  @click="onItemClick($event, entry)"
                  @dblclick="ui.openView('player')"
                  @keydown.enter="playEntry(entry)"
                  @contextmenu.prevent="openCtx($event, entry)"
                >
                  <div class="thumb rounded-[var(--radius-md)] bg-surface-800 aspect-video relative overflow-hidden" :class="`kind-${entry.scriptType}`">
                    <img
                      v-if="entry.thumbnailUrl"
                      :src="entry.thumbnailUrl"
                      class="thumb-img h-full w-full animate-fade-in inset-0 absolute object-cover"
                      alt=""
                      draggable="false"
                    >
                    <div v-else-if="thumbFailed.has(entry.name)" class="text-fg-faint center inset-0 absolute">
                      <span class="i-carbon-video-off text-[22px]" />
                    </div>
                    <div v-else class="skeleton inset-0 absolute" :class="thumbBusy.has(entry.name) ? '' : 'opacity-60'" />

                    <div class="shade inset-0 absolute" />

                    <!-- Hover: tags and play -->
                    <div class="opacity-0 center transition-opacity duration-200 inset-0 absolute group-hover:opacity-100">
                      <span class="play-btn text-white rounded-full center h-11 w-11">
                        <span class="i-carbon-play-filled-alt text-[20px] ml-0.5" />
                      </span>
                    </div>

                    <!-- Select -->
                    <button
                      type="button"
                      class="select-dot rounded-full center h-6 w-6 transition-opacity left-2 top-2 absolute"
                      :class="selected.has(entry.name) ? 'opacity-100 is-on' : selected.size ? 'opacity-70' : 'opacity-0 group-hover:opacity-80'"
                      :aria-label="selected.has(entry.name) ? 'Deselect' : 'Select'"
                      @click.stop="toggleSelect(entry)"
                    >
                      <span class="i-carbon-checkmark text-[13px]" />
                    </button>

                    <!-- Star -->
                    <button
                      v-tip="entry.starred ? 'Unstar' : 'Star'"
                      type="button"
                      class="star-btn rounded-full center h-7 w-7 transition-[opacity,transform] right-1.5 top-1.5 absolute active:scale-90"
                      :class="entry.starred ? 'opacity-100 is-on' : 'opacity-0 group-hover:opacity-100'"
                      :aria-label="entry.starred ? 'Unstar' : 'Star'"
                      @click.stop="library.toggleStar(entry)"
                    >
                      <span :class="entry.starred ? 'i-carbon-star-filled' : 'i-carbon-star'" class="text-[15px]" />
                    </button>

                    <!-- Bottom row: playing, script, duration -->
                    <div class="flex gap-1 items-center bottom-1.5 left-1.5 right-1.5 absolute">
                      <span v-if="entry.name === currentName" class="chip-over text-accent-300 gap-1 animate-scale-in">
                        <span class="eq" :class="player.isPlaying ? '' : 'paused'"><i /><i /><i /></span>
                      </span>
                      <span
                        v-if="entry.scriptType !== 'none'"
                        v-tip="scriptBadge(entry).title"
                        class="chip-over"
                        :class="entry.scriptType === 'merged' ? 'text-info' : 'text-accent-300'"
                      >
                        <span :class="entry.scriptType === 'single' ? 'i-carbon-chart-line-smooth' : 'i-carbon-chart-multi-line'" class="text-[12px]" />
                        <span v-if="scriptBadge(entry).short" class="text-white num">{{ scriptBadge(entry).short }}</span>
                        <span v-if="entry.scriptType === 'merged'" class="text-[9.5px] text-white/70 font-semibold">M</span>
                      </span>
                      <span
                        v-for="tag in (effectiveMeta(entry).tags ?? []).slice(0, 2)"
                        :key="tag"
                        class="chip-over text-white/85 opacity-0 max-w-[90px] truncate transition-opacity group-hover:opacity-100"
                      >{{ tag }}</span>
                      <span class="flex-1" />
                      <span v-if="entry.duration" class="chip-over text-white num">{{ formatTime(entry.duration) }}</span>
                    </div>
                  </div>

                  <div class="px-0.5 pt-2" :style="{ height: `${INFO_H}px` }">
                    <p class="text-[13px] leading-[18px] font-medium truncate transition-colors" :class="entry.name === currentName ? 'text-accent-300' : 'text-fg'" :title="entry.name">
                      {{ entry.basename }}
                    </p>
                    <p class="text-[11.5px] text-fg-faint leading-4 mt-0.5 flex gap-1.5 items-center">
                      <span class="truncate">{{ subline(entry) }}</span>
                      <span v-if="effectiveMeta(entry).rating" class="text-warn shrink-0">
                        {{ '★'.repeat(effectiveMeta(entry).rating ?? 0) }}
                      </span>
                    </p>
                  </div>
                </div>
              </div>
            </template>

            <!-- ── List ─────────────────────────────────────────────────────── -->
            <template v-else>
              <div
                v-for="row in rows"
                :key="row.index"
                class="inset-x-0 absolute"
                :style="{ top: `${row.top}px`, height: `${LIST_ROW_H}px` }"
              >
                <div
                  v-for="{ entry, index } in row.cells"
                  :key="entry.name"
                  class="list-cols list-row group px-2 focusable rounded-[var(--radius-sm)] h-full cursor-pointer items-center"
                  :class="{ 'is-selected': selected.has(entry.name), 'is-current': entry.name === currentName }"
                  tabindex="0"
                  role="button"
                  :aria-label="entry.basename"
                  @click="onItemClick($event, entry)"
                  @dblclick="ui.openView('player')"
                  @keydown.enter="playEntry(entry)"
                  @contextmenu.prevent="openCtx($event, entry)"
                >
                  <span class="text-[11.5px] text-fg-faint num text-right">
                    <span v-if="entry.name === currentName" class="eq text-accent-300" :class="player.isPlaying ? '' : 'paused'"><i /><i /><i /></span>
                    <button
                      v-else
                      type="button"
                      class="select-box rounded center h-4 w-4"
                      :class="selected.has(entry.name) ? 'is-on' : 'opacity-0 group-hover:opacity-100'"
                      :aria-label="selected.has(entry.name) ? 'Deselect' : 'Select'"
                      @click.stop="toggleSelect(entry)"
                    >
                      <span class="i-carbon-checkmark text-[11px]" />
                    </button>
                    <span v-if="entry.name !== currentName && !selected.has(entry.name)" class="group-hover:hidden">{{ index + 1 }}</span>
                  </span>
                  <span class="rounded-[var(--radius-xs)] bg-surface-800 h-9 w-16 relative overflow-hidden">
                    <img v-if="entry.thumbnailUrl" :src="entry.thumbnailUrl" class="h-full w-full animate-fade-in object-cover" alt="" draggable="false">
                    <span v-else-if="!thumbFailed.has(entry.name)" class="skeleton inset-0 absolute" />
                  </span>
                  <span class="min-w-0">
                    <span class="text-[13px] block truncate" :class="entry.name === currentName ? 'text-accent-300 font-medium' : 'text-fg'" :title="entry.name">{{ entry.basename }}</span>
                    <span class="text-[11.5px] text-fg-faint flex gap-1.5 items-center">
                      <span v-if="effectiveMeta(entry).creator" class="truncate">{{ effectiveMeta(entry).creator }}</span>
                      <span v-for="tag in (effectiveMeta(entry).tags ?? []).slice(0, 3)" :key="tag" class="px-1.5 rounded bg-fg/6 shrink-0">{{ tag }}</span>
                      <span v-if="effectiveMeta(entry).rating" class="text-warn shrink-0">{{ '★'.repeat(effectiveMeta(entry).rating ?? 0) }}</span>
                    </span>
                  </span>
                  <span>
                    <UiBadge
                      v-if="entry.scriptType !== 'none'"
                      v-tip="scriptBadge(entry).title"
                      size="xs"
                      :tone="entry.scriptType === 'merged' ? 'info' : 'accent'"
                      :icon="entry.scriptType === 'single' ? 'i-carbon-chart-line-smooth' : 'i-carbon-chart-multi-line'"
                    >
                      {{ scriptBadge(entry).long }}
                    </UiBadge>
                    <span v-else class="text-[11.5px] text-fg-faint">—</span>
                  </span>
                  <span class="text-[12px] text-fg-muted num text-right">{{ entry.duration ? formatTime(entry.duration) : '' }}</span>
                  <span class="text-[12px] text-fg-muted num text-right">{{ formatSize(entry.file.size) }}</span>
                  <span class="col-date text-[12px] text-fg-faint text-right">{{ formatDate(entry.file.lastModified) }}</span>
                  <button
                    type="button"
                    class="star-inline rounded center h-7 w-7 transition-opacity"
                    :class="entry.starred ? 'text-warn' : 'text-fg-faint opacity-0 group-hover:opacity-100 hover:text-fg'"
                    :aria-label="entry.starred ? 'Unstar' : 'Star'"
                    @click.stop="library.toggleStar(entry)"
                  >
                    <span :class="entry.starred ? 'i-carbon-star-filled' : 'i-carbon-star'" class="text-[14px]" />
                  </button>
                </div>
              </div>
            </template>
          </div>
          <!-- Room for the mini player and the selection bar -->
          <div class="h-28" />
        </div>
      </template>
    </div>

    <!-- ══ Selection bar ══════════════════════════════════════════════════════ -->
    <div class="flex pointer-events-none inset-x-0 bottom-5 justify-center absolute z-20">
      <Transition name="t-slide-up">
        <div
          v-if="selected.size"
          class="p-1.5 pl-4 pop flex gap-1 pointer-events-auto ring-1 ring-edge-strong items-center"
        >
          <span class="text-[13px] text-fg font-medium num mr-2 whitespace-nowrap">{{ selected.size.toLocaleString() }} selected</span>
          <UiButton variant="primary" icon="i-carbon-play-filled-alt" @click="playList(selectedEntries)">
            Play
          </UiButton>
          <UiButton variant="ghost" icon="i-carbon-skip-forward" @click="playback.playNextInQueue(selectedEntries)">
            Play next
          </UiButton>
          <UiButton variant="ghost" icon="i-carbon-list-boxes" @click="playback.addToQueue(selectedEntries)">
            Queue
          </UiButton>
          <UiPopover placement="top" flush>
            <template #trigger="{ toggle, open }">
              <UiButton variant="ghost" icon="i-carbon-playlist" :active="open" @click="toggle">
                Playlist
              </UiButton>
            </template>
            <template #default="{ close }">
              <div class="p-1">
                <UiMenu :items="playlistItems(selectedEntries)" @done="close" />
              </div>
            </template>
          </UiPopover>
          <UiIconButton
            :icon="selectedEntries.every(e => e.starred) ? 'i-carbon-star-filled' : 'i-carbon-star'"
            :label="selectedEntries.every(e => e.starred) ? 'Unstar' : 'Star'"
            @click="setStar(selectedEntries, !selectedEntries.every(e => e.starred))"
          />
          <div class="mx-1 divider-x" />
          <UiButton variant="ghost" size="sm" @click="selectAll">
            All
          </UiButton>
          <UiIconButton icon="i-carbon-close" label="Clear selection" @click="clearSelection" />
        </div>
      </Transition>
    </div>

    <UiContextMenu v-model="ctx" />

    <!-- ══ New playlist ═══════════════════════════════════════════════════════ -->
    <UiModal v-model:open="newPlOpen" title="New playlist" icon="i-carbon-playlist" width="400px" :subtitle="newPl ? `With ${plural(newPl.entries.length, 'video')}` : ''">
      <UiInput v-if="newPl" ref="newPlInput" v-model="newPl.name" size="md" placeholder="Playlist name" @enter="createPlaylist" />
      <template #footer>
        <UiButton variant="ghost" @click="newPl = null">
          Cancel
        </UiButton>
        <UiButton variant="primary" icon="i-carbon-add" @click="createPlaylist">
          Create
        </UiButton>
      </template>
    </UiModal>

    <!-- ══ Info & tags ════════════════════════════════════════════════════════ -->
    <UiModal v-model:open="metaOpen" title="Info & tags" icon="i-carbon-tag-edit" width="520px" :subtitle="meta?.entry.basename">
      <div v-if="meta" class="flex flex-col gap-4">
        <!-- Read-only facts -->
        <div class="flex gap-3">
          <div class="rounded-[var(--radius-md)] bg-surface-800 shrink-0 h-[90px] w-40 overflow-hidden">
            <img v-if="meta.entry.thumbnailUrl" :src="meta.entry.thumbnailUrl" class="h-full w-full object-cover" alt="">
          </div>
          <dl class="text-[12px] gap-x-3 gap-y-1 grid grid-cols-[auto_1fr] min-w-0">
            <dt class="text-fg-faint">
              Length
            </dt>
            <dd class="num">
              {{ formatTime(meta.entry.duration, '—') }}
            </dd>
            <dt class="text-fg-faint">
              Size
            </dt>
            <dd class="num">
              {{ formatSize(meta.entry.file.size) }}
            </dd>
            <dt class="text-fg-faint">
              Modified
            </dt>
            <dd>{{ formatDate(meta.entry.file.lastModified) }}</dd>
            <dt class="text-fg-faint">
              Script
            </dt>
            <dd class="truncate">
              {{ scriptBadge(meta.entry).long }}<template v-if="meta.entry.channels?.length">
                · <span class="num">{{ meta.entry.channels.join(' ') }}</span>
              </template>
            </dd>
          </dl>
        </div>
        <div v-if="meta.entry.scriptMatches.length" class="px-3 py-2 well flex flex-col gap-1">
          <div v-for="m in meta.entry.scriptMatches" :key="m.file.name" class="text-[12px] flex gap-2 items-center">
            <span class="i-carbon-document text-fg-faint shrink-0" />
            <span class="text-fg-muted flex-1 truncate">{{ m.file.name }}</span>
            <UiBadge v-if="m.isAlt" size="xs" tone="info">
              alt · {{ m.altName }}
            </UiBadge>
          </div>
        </div>

        <div class="divider-y" />

        <div class="gap-3 grid grid-cols-2">
          <UiInput v-model="meta.draft.creator" label="Creator" placeholder="Who made the script" />
          <UiInput v-model="meta.draft.date" label="Date" placeholder="2024-10-05" />
          <UiInput v-model="meta.draft.url" label="Source URL" placeholder="https://…" class="col-span-2">
            <template #suffix>
              <a
                v-if="meta.draft.url"
                v-tip="'Open link'"
                :href="meta.draft.url"
                target="_blank"
                rel="noopener noreferrer"
                class="text-fg-faint mr-1.5 rounded center h-5 w-5 hover:text-fg"
              ><span class="i-carbon-launch text-[13px]" /></a>
            </template>
          </UiInput>
        </div>

        <div class="flex flex-col gap-1">
          <span class="label">Rating</span>
          <div class="flex gap-0.5 items-center">
            <button
              v-for="n in 5"
              :key="n"
              type="button"
              class="text-[20px] focusable rounded pressable"
              :class="(meta.draft.rating ?? 0) >= n ? 'text-warn' : 'text-fg-faint hover:text-fg-muted'"
              :aria-label="`${n} star${n === 1 ? '' : 's'}`"
              @click="meta.draft.rating = meta.draft.rating === n ? 0 : n"
            >
              <span :class="(meta.draft.rating ?? 0) >= n ? 'i-carbon-star-filled' : 'i-carbon-star'" />
            </button>
          </div>
        </div>

        <div class="flex flex-col gap-1">
          <span class="label">Tags</span>
          <div class="p-1.5 border border-edge-strong rounded-[var(--radius-sm)] bg-surface-900 flex flex-wrap gap-1 min-h-8 transition-[border-color,box-shadow] items-center focus-within:border-accent/70 focus-within:ring-3 focus-within:ring-accent-soft">
            <TransitionGroup name="t-pop">
              <span v-for="tag in meta.draft.tags" :key="tag" class="text-[11.5px] text-accent-300 pl-2 pr-1 rounded-[var(--radius-xs)] bg-accent-soft flex gap-1 h-6 items-center">
                {{ tag }}
                <button type="button" class="rounded center h-4 w-4 hover:bg-fg/10" :aria-label="`Remove ${tag}`" @click="meta.draft.tags = meta.draft.tags!.filter(t => t !== tag)">
                  <span class="i-carbon-close text-[11px]" />
                </button>
              </span>
            </TransitionGroup>
            <input
              v-model="tagInput"
              list="ph-lib-tags"
              class="text-[12.5px] text-fg px-1 outline-none bg-transparent flex-1 min-w-[120px] placeholder:text-fg-faint"
              placeholder="Add a tag, Enter or comma"
              @keydown="onTagKey"
              @blur="addTag"
            >
            <datalist id="ph-lib-tags">
              <option v-for="t in allTags" :key="t" :value="t" />
            </datalist>
          </div>
        </div>

        <label class="flex flex-col gap-1">
          <span class="label">Notes</span>
          <textarea
            v-model="meta.draft.notes"
            rows="3"
            class="text-[12.5px] text-fg px-2.5 py-2 outline-none border border-edge-strong rounded-[var(--radius-sm)] bg-surface-900 resize-none transition-[border-color,box-shadow] placeholder:text-fg-faint focus:border-accent/70 focus:ring-3 focus:ring-accent-soft"
            placeholder="Personal notes…"
          />
        </label>
      </div>
      <template #footer>
        <UiButton variant="ghost" @click="meta = null">
          Cancel
        </UiButton>
        <UiButton variant="primary" icon="i-carbon-checkmark" @click="saveMeta">
          Save
        </UiButton>
      </template>
    </UiModal>
  </div>
</template>

<style scoped>
/* ── Filter chips ─────────────────────────────────────────────────────────── */
.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  color: var(--text-muted);
  font-size: 12.5px;
  white-space: nowrap;
}
.chip:hover {
  color: var(--text);
  background: color-mix(in srgb, var(--text) 5%, transparent);
}
.chip-on,
.chip-on:hover {
  color: var(--accent-light);
  border-color: color-mix(in srgb, var(--accent) 55%, transparent);
  background: var(--accent-soft);
}

/* ── Grid cards ───────────────────────────────────────────────────────────── */
.card-item .thumb {
  box-shadow: 0 0 0 1px var(--border);
  transition:
    transform var(--dur) var(--ease-out),
    box-shadow var(--dur) var(--ease-out);
}
.card-item:hover .thumb {
  transform: translateY(-3px);
  box-shadow:
    0 0 0 1px var(--border-strong),
    var(--shadow-lg);
}
.card-item:active .thumb {
  transform: translateY(-1px) scale(0.99);
}
/* Multi-axis and merged scripts get a faint glow, the old library's tell. */
.thumb.kind-multi {
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 35%, transparent);
}
.thumb.kind-merged {
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--info) 40%, transparent);
}
.card-item.is-current .thumb {
  box-shadow:
    0 0 0 2px var(--accent),
    0 8px 24px -8px var(--accent);
}
.card-item.is-selected .thumb {
  box-shadow: 0 0 0 2px var(--accent-light);
  transform: scale(0.96);
}
.thumb-img {
  transition: transform 600ms var(--ease-out);
}
.card-item:hover .thumb-img {
  transform: scale(1.045);
}
/* Over the picture: white on dark is right regardless of theme. */
.shade {
  background: linear-gradient(to top, rgba(0, 0, 0, 0.62), rgba(0, 0, 0, 0) 45%);
  pointer-events: none;
}
.play-btn {
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(8px);
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.2);
  transform: scale(0.85);
  transition: transform var(--dur) var(--ease-out);
}
.card-item:hover .play-btn {
  transform: scale(1);
}
.chip-over {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 20px;
  padding: 0 6px;
  border-radius: var(--radius-xs);
  font-size: 11px;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(6px);
}
.star-btn,
.select-dot {
  color: white;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(6px);
}
.star-btn:hover {
  background: rgba(0, 0, 0, 0.65);
}
.star-btn.is-on {
  color: var(--warn);
}
.select-dot {
  box-shadow: inset 0 0 0 1.5px rgba(255, 255, 255, 0.7);
}
.select-dot > span {
  opacity: 0;
}
.select-dot.is-on {
  background: var(--accent);
  color: var(--accent-contrast);
  box-shadow: none;
}
.select-dot.is-on > span {
  opacity: 1;
}

/* ── List ─────────────────────────────────────────────────────────────────── */
.lib-body {
  container-type: inline-size;
}
.list-cols {
  display: grid;
  grid-template-columns: 28px 64px minmax(0, 1fr) 128px 64px 72px 110px 32px;
  column-gap: 12px;
}
@container (max-width: 820px) {
  .col-date {
    display: none;
  }
}
.sort-head {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  text-align: left;
  text-transform: inherit;
  letter-spacing: inherit;
}
.sort-head:hover {
  color: var(--text);
}
.list-row {
  transition: background-color var(--dur-fast);
}
.list-row:hover {
  background: color-mix(in srgb, var(--text) 5%, transparent);
}
.list-row.is-current {
  background: var(--accent-soft);
}
.list-row.is-selected {
  background: color-mix(in srgb, var(--accent) 22%, transparent);
}
.select-box {
  margin-left: auto;
  box-shadow: inset 0 0 0 1.5px var(--border-strong);
}
.select-box > span {
  opacity: 0;
}
.select-box.is-on {
  background: var(--accent);
  color: var(--accent-contrast);
  box-shadow: none;
}
.select-box.is-on > span {
  opacity: 1;
}

/* ── Now-playing equaliser ────────────────────────────────────────────────── */
.eq {
  display: inline-flex;
  align-items: flex-end;
  gap: 2px;
  height: 11px;
}
.eq i {
  display: block;
  width: 3px;
  height: 100%;
  border-radius: 1px;
  background: currentColor;
  transform-origin: bottom;
  animation: ph-eq 0.9s ease-in-out infinite;
}
.eq i:nth-child(2) {
  animation-delay: -0.3s;
}
.eq i:nth-child(3) {
  animation-delay: -0.6s;
}
.eq.paused i {
  animation-play-state: paused;
}
</style>
