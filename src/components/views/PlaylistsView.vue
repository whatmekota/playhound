<script setup lang="ts">
import type { MenuItem } from '~/components/ui/menu'
import type { VideoEntry } from '~/stores/libraryStore'
import type { Playlist, SmartPlaylist, SmartRule } from '~/stores/playlistStore'
import { useIntersectionObserver, useLocalStorage } from '@vueuse/core'
import { computed, nextTick, ref, watch } from 'vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiContextMenu from '~/components/ui/UiContextMenu.vue'
import UiEmpty from '~/components/ui/UiEmpty.vue'
import UiIconButton from '~/components/ui/UiIconButton.vue'
import UiMenu from '~/components/ui/UiMenu.vue'
import UiPopover from '~/components/ui/UiPopover.vue'
import { toast } from '~/composables/useToast'
import { effectiveMeta, formatTotal, plural, scriptBadge } from '~/lib/entryInfo'
import { ensureDurations, hydrateLibrary, prefetchThumbs, vLazyThumb } from '~/lib/thumbs'
import { formatTime } from '~/lib/time'
import { useLibraryStore } from '~/stores/libraryStore'
import { usePlaybackStore } from '~/stores/playbackStore'
import { usePlayerStore } from '~/stores/playerStore'
import { evaluateSmartPlaylist, usePlaylistStore } from '~/stores/playlistStore'
import { useQueueStore } from '~/stores/queueStore'
import { useUiStore } from '~/stores/uiStore'

defineOptions({ name: 'PlaylistsView' })

const plStore = usePlaylistStore()
const library = useLibraryStore()
const playback = usePlaybackStore()
const queue = useQueueStore()
const player = usePlayerStore()
const ui = useUiStore()

watch(() => library.loadedAt, () => void hydrateLibrary(library.videos, library.loadedAt), { immediate: true })

const byName = computed(() => new Map(library.videos.map(v => [v.name, v])))
const currentName = computed(() => playback.currentEntry?.name ?? queue.current?.name ?? null)

// Long lists render a page at a time; a sentinel at the bottom pulls in more.
const PAGE = 150
const limit = ref(PAGE)

const renaming = ref(false)
const renameVal = ref('')
const renameEl = ref<HTMLInputElement | null>(null)

// ─── Selection ────────────────────────────────────────────────────────────────
interface Sel { kind: 'list' | 'smart', id: string }
const sel = useLocalStorage<Sel>('ph:ui.playlists.selected', { kind: 'list', id: 'favorites' })

const activeList = computed<Playlist | null>(() =>
  sel.value.kind === 'list' ? plStore.playlists.find(p => p.id === sel.value.id) ?? null : null)
const activeSmart = computed<SmartPlaylist | null>(() =>
  sel.value.kind === 'smart' ? plStore.smartPlaylists.find(p => p.id === sel.value.id) ?? null : null)

// A deleted or imported-away selection falls back to Favorites.
watch([activeList, activeSmart], ([l, s]) => {
  if (!l && !s)
    sel.value = { kind: 'list', id: 'favorites' }
}, { immediate: true })

function select(kind: Sel['kind'], id: string) {
  if (sel.value.kind !== kind || sel.value.id !== id) {
    renaming.value = false
    limit.value = PAGE
  }
  sel.value = { kind, id }
}

const isBuiltinSmart = (id: string) => id.startsWith('smart:')
const canEdit = computed(() =>
  activeList.value ? activeList.value.id !== 'favorites' : activeSmart.value ? !isBuiltinSmart(activeSmart.value.id) : false)

// ─── Rows ─────────────────────────────────────────────────────────────────────
interface Row {
  key: string
  /** Index into the playlist's own entries, for reordering and removal. */
  index: number
  name: string
  entry: VideoEntry | null
}

const rows = computed<Row[]>(() => {
  if (activeList.value) {
    return activeList.value.entries.map((pe, index) => ({
      key: `${pe.videoName}\u0000${pe.addedAt}`,
      index,
      name: pe.videoName,
      entry: byName.value.get(pe.videoName) ?? null,
    }))
  }
  if (activeSmart.value) {
    return evaluateSmartPlaylist(activeSmart.value, library.videos)
      .map((entry, index) => ({ key: entry.name, index, name: entry.name, entry }))
  }
  return []
})

/** What can actually play: rows whose file is in the library right now. */
const playable = computed(() => rows.value.flatMap(r => (r.entry ? [r.entry] : [])))
const missingCount = computed(() => rows.value.length - playable.value.length)
const activeName = computed(() => activeList.value?.name ?? activeSmart.value?.name ?? '')

const totalDuration = computed(() => {
  let secs = 0
  let unknown = 0
  for (const e of playable.value) {
    if (e.duration === null)
      unknown++
    else
      secs += e.duration
  }
  return { secs, unknown }
})

const shownRows = computed(() => rows.value.slice(0, limit.value))
const sentinel = ref<HTMLElement | null>(null)
useIntersectionObserver(sentinel, ([e]) => {
  if (e?.isIntersecting && limit.value < rows.value.length)
    limit.value += PAGE
}, { rootMargin: '400px' })

watch(playable, (list) => {
  prefetchThumbs(list.slice(0, 4))
  void ensureDurations(list.slice(0, 500))
}, { immediate: true })

/** Up to four pictures for the cover. */
const cover = computed(() => playable.value.slice(0, 4).map(e => e.thumbnailUrl).filter((u): u is string => !!u))

function coverFor(entries: { videoName: string }[]): string | null {
  for (const pe of entries.slice(0, 8)) {
    const e = byName.value.get(pe.videoName)
    if (e?.thumbnailUrl)
      return e.thumbnailUrl
  }
  return null
}

// ─── Play ─────────────────────────────────────────────────────────────────────
function playFrom(entry: VideoEntry) {
  void playback.play(entry, playable.value, activeName.value)
}

function playAll() {
  if (!playable.value.length)
    return
  if (queue.shuffle)
    queue.setShuffle(false)
  void playback.play(playable.value[0], playable.value, activeName.value)
}

function shuffleAll() {
  const list = playable.value
  if (!list.length)
    return
  if (!queue.shuffle)
    queue.setShuffle(true)
  void playback.play(list[Math.floor(Math.random() * list.length)], list, activeName.value)
}

function onRowClick(row: Row) {
  if (row.entry)
    playFrom(row.entry)
  else
    toast.warn('That video is not in the library', { detail: row.name, key: 'missing' })
}

// ─── Create, rename, delete ───────────────────────────────────────────────────

function startRename() {
  if (!canEdit.value)
    return
  renameVal.value = activeName.value
  renaming.value = true
  void nextTick(() => {
    renameEl.value?.focus()
    renameEl.value?.select()
  })
}

function commitRename() {
  if (!renaming.value)
    return
  const name = renameVal.value.trim()
  if (name) {
    if (activeList.value)
      plStore.renamePlaylist(activeList.value.id, name)
    else if (activeSmart.value)
      plStore.renameSmartPlaylist(activeSmart.value.id, name)
  }
  renaming.value = false
}

function uniqueName(base: string, taken: string[]) {
  if (!taken.includes(base))
    return base
  let n = 2
  while (taken.includes(`${base} ${n}`))
    n++
  return `${base} ${n}`
}

function newPlaylist() {
  const pl = plStore.createPlaylist(uniqueName('New playlist', plStore.playlists.map(p => p.name)))
  select('list', pl.id)
  startRename()
}

function newSmart(rules: SmartRule[] = [{ type: 'has_script' }], name = 'New smart playlist') {
  const pl = plStore.createSmartPlaylist(uniqueName(name, plStore.smartPlaylists.map(p => p.name)), rules)
  select('smart', pl.id)
  startRename()
}

function deleteActive() {
  if (activeList.value && activeList.value.id !== 'favorites') {
    const copy: Playlist = JSON.parse(JSON.stringify(activeList.value))
    plStore.deletePlaylist(copy.id)
    toast(`Deleted ${copy.name}`, {
      icon: 'i-carbon-trash-can',
      key: 'pl-delete',
      action: {
        label: 'Undo',
        run: () => {
          plStore.importAll(JSON.stringify([copy]))
          select('list', copy.id)
        },
      },
    })
  }
  else if (activeSmart.value && !isBuiltinSmart(activeSmart.value.id)) {
    const { name, rules } = activeSmart.value
    plStore.deleteSmartPlaylist(activeSmart.value.id)
    toast(`Deleted ${name}`, {
      icon: 'i-carbon-trash-can',
      key: 'pl-delete',
      action: { label: 'Undo', run: () => select('smart', plStore.createSmartPlaylist(name, rules).id) },
    })
  }
}

/** Freeze a smart playlist's current matches into an ordinary one you can reorder. */
function snapshotSmart() {
  if (!activeSmart.value)
    return
  const name = uniqueName(activeSmart.value.name.replace(/^\W+/, ''), plStore.playlists.map(p => p.name))
  const pl = plStore.createPlaylist(name)
  for (const e of playable.value)
    plStore.addToPlaylist(pl.id, e.name)
  select('list', pl.id)
  toast.success(`Saved ${name}`, { detail: plural(playable.value.length, 'video'), icon: 'i-carbon-playlist' })
}

// ─── Export / import ──────────────────────────────────────────────────────────
function download(json: string, filename: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

function exportActive() {
  if (!activeList.value)
    return
  const slug = activeList.value.name.replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'playlist'
  download(JSON.stringify([activeList.value], null, 2), `playhound-${slug}.json`)
}

function exportAll() {
  download(plStore.exportAll(), 'playhound-playlists.json')
  toast('Playlists exported', { icon: 'i-carbon-download', key: 'pl-export' })
}

function importPlaylists() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.json,application/json'
  input.onchange = async () => {
    const f = input.files?.[0]
    if (!f)
      return
    const before = plStore.playlists.length
    if (plStore.importAll(await f.text()))
      toast.success('Playlists imported', { detail: `${plural(plStore.playlists.length - before, 'new playlist')} from ${f.name}` })
    else
      toast.error('That is not a playlist file', { detail: f.name })
  }
  input.click()
}

const detailMenu = computed<MenuItem[]>(() => {
  const items: MenuItem[] = []
  if (canEdit.value) {
    items.push({ label: 'Rename', icon: 'i-carbon-edit', run: startRename })
  }
  if (activeSmart.value) {
    items.push(
      { label: 'Save as playlist', icon: 'i-carbon-playlist', run: snapshotSmart, disabled: !playable.value.length },
      { label: 'Duplicate', icon: 'i-carbon-copy', run: () => newSmart(activeSmart.value!.rules.map(r => ({ ...r })), `${activeSmart.value!.name.replace(/^\W+/, '')} copy`) },
    )
  }
  if (activeList.value)
    items.push({ label: 'Export this playlist', icon: 'i-carbon-download', run: exportActive })
  items.push(
    { label: 'Export all playlists', icon: 'i-carbon-document-export', run: exportAll },
    { label: 'Import…', icon: 'i-carbon-document-import', run: importPlaylists },
  )
  if (canEdit.value)
    items.push({ separator: true }, { label: 'Delete', icon: 'i-carbon-trash-can', danger: true, run: deleteActive })
  return items
})

// ─── Smart rules ──────────────────────────────────────────────────────────────
const RULES: { type: SmartRule['type'], label: string, icon: string }[] = [
  { type: 'has_script', label: 'Has a script', icon: 'i-carbon-chart-line-smooth' },
  { type: 'no_script', label: 'No script', icon: 'i-carbon-subtract-alt' },
  { type: 'multi_axis', label: 'Multi-axis', icon: 'i-carbon-chart-multi-line' },
  { type: 'starred', label: 'Starred', icon: 'i-carbon-star' },
  { type: 'has_tag', label: 'Tagged', icon: 'i-carbon-tag' },
  { type: 'min_rating', label: 'Rated at least', icon: 'i-carbon-star-review' },
]
const ruleDef = (t: SmartRule['type']) => RULES.find(r => r.type === t)!

function ruleSummary(rules: SmartRule[]): string {
  if (!rules.length)
    return 'Everything'
  return rules.map((r) => {
    if (r.type === 'has_tag')
      return r.tag ? `#${r.tag}` : 'Tagged'
    if (r.type === 'min_rating')
      return `${'★'.repeat(r.rating)}+`
    return ruleDef(r.type).label
  }).join(' · ')
}

const allTags = computed(() => {
  const set = new Set<string>()
  for (const v of library.videos) {
    for (const t of effectiveMeta(v).tags ?? [])
      set.add(t)
  }
  return [...set].sort()
})

function setRules(rules: SmartRule[]) {
  if (activeSmart.value)
    plStore.setSmartRules(activeSmart.value.id, rules)
}

const addRuleMenu = computed<MenuItem[]>(() => RULES.map(r => ({
  label: r.label,
  icon: r.icon,
  run: () => {
    const rule: SmartRule = r.type === 'has_tag'
      ? { type: 'has_tag', tag: allTags.value[0] ?? '' }
      : r.type === 'min_rating'
        ? { type: 'min_rating', rating: 3 }
        : { type: r.type } as SmartRule
    setRules([...(activeSmart.value?.rules ?? []), rule])
  },
})))

function updateRule(i: number, rule: SmartRule) {
  const rules = (activeSmart.value?.rules ?? []).slice()
  rules[i] = rule
  setRules(rules)
}

function removeRule(i: number) {
  setRules((activeSmart.value?.rules ?? []).filter((_, j) => j !== i))
}

const smartCounts = computed(() => {
  const out: Record<string, number> = {}
  for (const pl of plStore.smartPlaylists)
    out[pl.id] = library.hasVideos ? evaluateSmartPlaylist(pl, library.videos).length : 0
  return out
})

// ─── Reorder (drag) ───────────────────────────────────────────────────────────
// Rows swap live as the pointer crosses them, so TransitionGroup animates the
// gap opening rather than a drop line jumping around.
const dragIndex = ref<number | null>(null)
let lastMove = 0

function onDragStart(e: DragEvent, row: Row) {
  if (!activeList.value)
    return
  dragIndex.value = row.index
  e.dataTransfer!.effectAllowed = 'move'
  e.dataTransfer!.setData('text/plain', row.name)
}

function onDragEnter(row: Row) {
  if (dragIndex.value === null || !activeList.value || row.index === dragIndex.value)
    return
  // While rows are still sliding, the one under the pointer changes on its own;
  // ignoring those few frames stops the pair from swapping back and forth.
  const now = performance.now()
  if (now - lastMove < 140)
    return
  lastMove = now
  plStore.moveEntry(activeList.value.id, dragIndex.value, row.index)
  dragIndex.value = row.index
}

function onDragEnd() {
  dragIndex.value = null
}

// ─── Row menu ─────────────────────────────────────────────────────────────────
const ctx = ref<{ x: number, y: number, items: MenuItem[] } | null>(null)

function remove(row: Row) {
  if (!activeList.value)
    return
  plStore.removeFromPlaylist(activeList.value.id, row.name)
}

function openRowMenu(e: MouseEvent, row: Row) {
  const items: MenuItem[] = []
  const entry = row.entry
  if (entry) {
    items.push(
      { label: 'Play from here', icon: 'i-carbon-play-filled-alt', run: () => playFrom(entry) },
      { label: 'Play next', icon: 'i-carbon-skip-forward', run: () => playback.playNextInQueue(entry) },
      { label: 'Add to queue', icon: 'i-carbon-list-boxes', run: () => playback.addToQueue(entry) },
      { separator: true },
      { label: entry.starred ? 'Unstar' : 'Star', icon: entry.starred ? 'i-carbon-star-filled' : 'i-carbon-star', run: () => library.toggleStar(entry) },
    )
  }
  if (activeList.value) {
    const pl = activeList.value
    const last = pl.entries.length - 1
    items.push(
      { separator: true },
      { label: 'Move to top', icon: 'i-carbon-up-to-top', disabled: row.index === 0, run: () => plStore.moveEntry(pl.id, row.index, 0) },
      { label: 'Move to bottom', icon: 'i-carbon-down-to-bottom', disabled: row.index === last, run: () => plStore.moveEntry(pl.id, row.index, last) },
      { label: 'Remove from playlist', icon: 'i-carbon-subtract-alt', danger: true, run: () => remove(row) },
    )
  }
  ctx.value = { x: e.clientX, y: e.clientY, items }
}

function openListMenu(e: MouseEvent, kind: Sel['kind'], id: string) {
  select(kind, id)
  void nextTick(() => (ctx.value = {
    x: e.clientX,
    y: e.clientY,
    items: [
      { label: 'Play', icon: 'i-carbon-play-filled-alt', run: playAll, disabled: !playable.value.length },
      { label: 'Shuffle', icon: 'i-carbon-shuffle', run: shuffleAll, disabled: !playable.value.length },
      ...detailMenu.value.length ? [{ separator: true }, ...detailMenu.value] : [],
    ],
  }))
}

function smartIcon(pl: SmartPlaylist) {
  const t = pl.rules[0]?.type
  return t ? ruleDef(t).icon : 'i-carbon-filter'
}
/** Built-in smart playlists carry a symbol in their name; the list shows an icon instead. */
const cleanName = (name: string) => name.replace(/^[^\p{L}\p{N}]+/u, '') || name
</script>

<template>
  <div class="bg-surface-950 flex h-full min-h-0">
    <!-- ══ Sidebar ════════════════════════════════════════════════════════════ -->
    <aside class="border-r border-edge bg-surface-900/40 flex shrink-0 flex-col w-[264px]">
      <div class="px-5 pb-3 pt-5 flex items-center justify-between">
        <h1 class="h-view">
          Playlists
        </h1>
        <UiPopover placement="bottom" align="end" flush>
          <template #trigger="{ toggle, open }">
            <UiIconButton icon="i-carbon-overflow-menu-horizontal" label="Import / export" :active="open" @click="toggle" />
          </template>
          <template #default="{ close }">
            <div class="p-1">
              <UiMenu
                :items="[
                  { label: 'Export all playlists', icon: 'i-carbon-document-export', run: exportAll },
                  { label: 'Import…', icon: 'i-carbon-document-import', run: importPlaylists },
                ]"
                @done="close"
              />
            </div>
          </template>
        </UiPopover>
      </div>

      <nav class="px-2.5 pb-4 scroll-y flex-1">
        <div class="pl-2.5 pr-1 pt-1 flex h-8 items-center justify-between">
          <span class="eyebrow">Your playlists</span>
          <UiIconButton icon="i-carbon-add" label="New playlist" size="xs" @click="newPlaylist" />
        </div>
        <TransitionGroup name="t-list" tag="div" class="flex flex-col gap-0.5 relative">
          <button
            v-for="pl in plStore.playlists"
            :key="pl.id"
            type="button"
            class="side-item group focusable"
            :class="{ 'is-active': sel.kind === 'list' && sel.id === pl.id }"
            @click="select('list', pl.id)"
            @dblclick="select('list', pl.id); startRename()"
            @contextmenu.prevent="openListMenu($event, 'list', pl.id)"
          >
            <span
              class="side-cover"
              :class="pl.id === 'favorites' ? 'is-fav' : ''"
            >
              <img v-if="pl.id !== 'favorites' && coverFor(pl.entries)" :src="coverFor(pl.entries)!" alt="" class="h-full w-full object-cover">
              <span v-else :class="pl.id === 'favorites' ? 'i-carbon-favorite-filled' : 'i-carbon-playlist'" class="text-[15px]" />
            </span>
            <span class="text-left flex-1 min-w-0">
              <span class="text-[13px] block truncate">{{ pl.id === 'favorites' ? 'Favorites' : pl.name }}</span>
              <span class="text-[11.5px] text-fg-faint num block">{{ plural(pl.entries.length, 'video') }}</span>
            </span>
            <span v-if="pl.id === 'favorites'" v-tip="'Pinned'" class="i-carbon-pin-filled text-[11px] text-fg-faint" />
          </button>
        </TransitionGroup>

        <div class="pl-2.5 pr-1 pt-4 flex h-8 items-center justify-between">
          <span class="eyebrow">Smart playlists</span>
          <UiIconButton icon="i-carbon-add" label="New smart playlist" size="xs" @click="newSmart()" />
        </div>
        <TransitionGroup name="t-list" tag="div" class="flex flex-col gap-0.5 relative">
          <button
            v-for="pl in plStore.smartPlaylists"
            :key="pl.id"
            type="button"
            class="side-item group focusable"
            :class="{ 'is-active': sel.kind === 'smart' && sel.id === pl.id }"
            @click="select('smart', pl.id)"
            @dblclick="select('smart', pl.id); startRename()"
            @contextmenu.prevent="openListMenu($event, 'smart', pl.id)"
          >
            <span class="side-cover is-smart">
              <span :class="smartIcon(pl)" class="text-[15px]" />
            </span>
            <span class="text-left flex-1 min-w-0">
              <span class="text-[13px] block truncate">{{ cleanName(pl.name) }}</span>
              <span class="text-[11.5px] text-fg-faint block truncate">{{ ruleSummary(pl.rules) }}</span>
            </span>
            <span v-if="library.hasVideos" class="text-[11px] text-fg-faint num">{{ smartCounts[pl.id]?.toLocaleString() }}</span>
          </button>
        </TransitionGroup>
      </nav>
    </aside>

    <!-- ══ Detail ═════════════════════════════════════════════════════════════ -->
    <section class="flex flex-1 flex-col min-w-0">
      <!-- Keyed, so switching playlists fades the new one in. -->
      <div :key="`${sel.kind}:${sel.id}`" class="flex flex-1 flex-col min-h-0 animate-fade-in">
        <!-- Header -->
        <header class="px-6 pb-4 pt-6 flex shrink-0 gap-5 items-end">
          <div class="cover rounded-[var(--radius-lg)] shrink-0 h-[132px] w-[132px] shadow-[var(--shadow-lg)] relative overflow-hidden">
            <div v-if="cover.length >= 4" class="grid grid-cols-2 grid-rows-2 h-full w-full">
              <img v-for="(src, i) in cover" :key="i" :src="src" alt="" class="h-full w-full animate-fade-in object-cover">
            </div>
            <img v-else-if="cover.length" :src="cover[0]" alt="" class="h-full w-full animate-fade-in object-cover">
            <div v-else class="cover-empty text-accent-300 center h-full w-full">
              <span
                :class="activeSmart ? smartIcon(activeSmart) : activeList?.id === 'favorites' ? 'i-carbon-favorite-filled' : 'i-carbon-playlist'"
                class="text-[44px]"
              />
            </div>
          </div>

          <div class="flex-1 min-w-0">
            <p class="eyebrow mb-1">
              {{ activeSmart ? (isBuiltinSmart(activeSmart.id) ? 'Smart playlist · built in' : 'Smart playlist') : 'Playlist' }}
            </p>
            <input
              v-if="renaming"
              ref="renameEl"
              v-model="renameVal"
              class="text-[28px] text-fg leading-tight tracking-[-0.02em] font-semibold px-1.5 outline-none border border-accent/60 rounded-[var(--radius-sm)] bg-surface-900 w-full ring-3 ring-accent-soft -mx-1.5"
              aria-label="Playlist name"
              @keydown.enter="commitRename"
              @keydown.esc.stop="renaming = false"
              @blur="commitRename"
            >
            <h2
              v-else
              class="text-[28px] text-fg leading-tight tracking-[-0.02em] font-semibold truncate"
              :class="canEdit ? 'cursor-text' : ''"
              @dblclick="startRename"
            >
              {{ activeList?.id === 'favorites' ? 'Favorites' : cleanName(activeName) }}
            </h2>
            <p class="text-[12.5px] text-fg-muted mt-1.5 flex flex-wrap gap-x-2 items-center">
              <span class="num">{{ plural(playable.length, 'video') }}</span>
              <template v-if="totalDuration.secs > 0">
                <span class="text-fg-faint">·</span>
                <span class="num">{{ totalDuration.unknown ? 'over ' : '' }}{{ formatTotal(totalDuration.secs) }}</span>
              </template>
              <template v-if="missingCount">
                <span class="text-fg-faint">·</span>
                <span v-tip="'Not found in the library folder that is open'" class="text-warn num">{{ missingCount }} missing</span>
              </template>
            </p>
            <div class="mt-3.5 flex gap-2 items-center">
              <UiButton variant="primary" size="md" icon="i-carbon-play-filled-alt" :disabled="!playable.length" @click="playAll">
                Play
              </UiButton>
              <UiButton size="md" icon="i-carbon-shuffle" :disabled="!playable.length" @click="shuffleAll">
                Shuffle
              </UiButton>
              <UiPopover placement="bottom" align="start" flush>
                <template #trigger="{ toggle, open }">
                  <UiIconButton icon="i-carbon-overflow-menu-horizontal" label="More" size="md" :active="open" @click="toggle" />
                </template>
                <template #default="{ close }">
                  <div class="p-1">
                    <UiMenu :items="detailMenu" @done="close" />
                  </div>
                </template>
              </UiPopover>
            </div>
          </div>
        </header>

        <!-- Smart rules -->
        <div v-if="activeSmart" class="px-6 pb-4 shrink-0">
          <div class="px-3 py-2.5 well flex flex-wrap gap-2 items-center">
            <span class="eyebrow mr-1">{{ activeSmart.rules.length > 1 ? 'Matches all of' : 'Matches' }}</span>
            <TransitionGroup name="t-pop">
              <span
                v-for="(rule, i) in activeSmart.rules"
                :key="`${i}:${rule.type}`"
                class="rule-chip"
              >
                <span :class="ruleDef(rule.type).icon" class="text-[13px] text-accent-300" />
                <span>{{ ruleDef(rule.type).label }}</span>
                <template v-if="rule.type === 'has_tag'">
                  <input
                    :value="rule.tag"
                    :disabled="!canEdit"
                    list="ph-pl-tags"
                    class="text-[12px] text-fg px-1.5 outline-none rounded bg-surface-900 h-5 w-24 ring-1 ring-edge-strong focus:ring-accent/60"
                    placeholder="tag"
                    @change="updateRule(i, { type: 'has_tag', tag: ($event.target as HTMLInputElement).value.trim().toLowerCase() })"
                  >
                </template>
                <template v-else-if="rule.type === 'min_rating'">
                  <span class="flex">
                    <button
                      v-for="n in 5"
                      :key="n"
                      type="button"
                      :disabled="!canEdit"
                      class="text-[13px]"
                      :class="rule.rating >= n ? 'text-warn' : 'text-fg-faint'"
                      :aria-label="`${n} stars`"
                      @click="updateRule(i, { type: 'min_rating', rating: n })"
                    >
                      <span :class="rule.rating >= n ? 'i-carbon-star-filled' : 'i-carbon-star'" />
                    </button>
                  </span>
                </template>
                <button
                  v-if="canEdit"
                  type="button"
                  class="text-fg-faint ml-0.5 rounded center h-4 w-4 hover:text-fg hover:bg-fg/10"
                  aria-label="Remove rule"
                  @click="removeRule(i)"
                >
                  <span class="i-carbon-close text-[11px]" />
                </button>
              </span>
            </TransitionGroup>
            <span v-if="!activeSmart.rules.length" class="text-[12px] text-fg-faint">Everything in the library</span>
            <UiPopover v-if="canEdit" placement="bottom" align="start" flush>
              <template #trigger="{ toggle, open }">
                <UiButton variant="ghost" size="xs" icon="i-carbon-add" :active="open" @click="toggle">
                  Add rule
                </UiButton>
              </template>
              <template #default="{ close }">
                <div class="p-1">
                  <UiMenu :items="addRuleMenu" @done="close" />
                </div>
              </template>
            </UiPopover>
            <span v-else class="hint ml-auto">Built in — duplicate it from ⋯ to change the rules</span>
            <datalist id="ph-pl-tags">
              <option v-for="t in allTags" :key="t" :value="t" />
            </datalist>
          </div>
        </div>

        <!-- Folder needs a click before anything can play -->
        <div v-if="library.needsReconnect && !library.hasVideos && rows.length" class="px-6 pb-3 shrink-0">
          <div class="text-[12.5px] px-3 py-2 border border-warn/25 rounded-[var(--radius-md)] bg-warn/10 flex gap-3 items-center">
            <span class="i-carbon-folder-off text-warn" />
            <span class="text-fg-muted flex-1">Reconnect <b class="text-fg font-medium">{{ library.savedFolderName }}</b> to play these videos.</span>
            <UiButton size="xs" variant="secondary" @click="library.reconnect()">
              Reconnect
            </UiButton>
          </div>
        </div>

        <!-- Entries -->
        <div class="px-6 pb-28 scroll-y border-t border-edge flex-1">
          <template v-if="rows.length">
            <TransitionGroup name="t-list" tag="div" class="pt-2 relative">
              <div
                v-for="(row, i) in shownRows"
                :key="row.key"
                class="pl-row group focusable"
                :class="{
                  'is-missing': !row.entry,
                  'is-current': row.entry && row.entry.name === currentName,
                  'is-dragging': dragIndex === row.index,
                }"
                tabindex="0"
                role="button"
                :draggable="!!activeList"
                @click="onRowClick(row)"
                @keydown.enter="onRowClick(row)"
                @contextmenu.prevent="openRowMenu($event, row)"
                @dragstart="onDragStart($event, row)"
                @dragenter.prevent="onDragEnter(row)"
                @dragover.prevent
                @dragend="onDragEnd"
                @drop.prevent="onDragEnd"
              >
                <span class="text-[12px] text-fg-faint num center w-6">
                  <span v-if="row.entry && row.entry.name === currentName" class="eq text-accent-300" :class="player.isPlaying ? '' : 'paused'"><i /><i /><i /></span>
                  <template v-else>
                    <span class="group-hover:hidden">{{ i + 1 }}</span>
                    <span v-if="row.entry" class="i-carbon-play-filled-alt text-fg hidden group-hover:block" />
                    <span v-else class="i-carbon-unlink hidden group-hover:block" />
                  </template>
                </span>
                <span v-lazy-thumb="row.entry" class="rounded-[var(--radius-xs)] bg-surface-800 shrink-0 h-9 w-16 relative overflow-hidden">
                  <img v-if="row.entry?.thumbnailUrl" :src="row.entry.thumbnailUrl" alt="" class="h-full w-full animate-fade-in object-cover" draggable="false">
                  <span v-else-if="!row.entry" class="text-fg-faint center inset-0 absolute"><span class="i-carbon-unlink text-[14px]" /></span>
                </span>
                <span class="flex-1 min-w-0">
                  <span class="text-[13px] block truncate" :class="row.entry && row.entry.name === currentName ? 'text-accent-300 font-medium' : 'text-fg'">
                    {{ row.entry?.basename ?? row.name }}
                  </span>
                  <span class="text-[11.5px] text-fg-faint flex gap-1.5 items-center">
                    <template v-if="row.entry">
                      <span v-if="row.entry.scriptType !== 'none'" v-tip="scriptBadge(row.entry).title" :class="row.entry.scriptType === 'merged' ? 'text-info' : 'text-accent-300'">
                        {{ scriptBadge(row.entry).long }}
                      </span>
                      <span v-else>No script</span>
                      <span v-if="effectiveMeta(row.entry).creator" class="truncate">· {{ effectiveMeta(row.entry).creator }}</span>
                    </template>
                    <span v-else class="text-warn">Not in the library</span>
                  </span>
                </span>
                <span v-if="row.entry?.starred" class="i-carbon-star-filled text-[13px] text-warn shrink-0" />
                <span class="text-[12px] text-fg-muted num text-right shrink-0 w-14">{{ row.entry?.duration ? formatTime(row.entry.duration) : '' }}</span>
                <span class="opacity-0 flex shrink-0 gap-0.5 transition-opacity items-center group-focus-within:opacity-100 group-hover:opacity-100">
                  <UiIconButton
                    v-if="activeList"
                    icon="i-carbon-close"
                    label="Remove from playlist"
                    size="xs"
                    @click.stop="remove(row)"
                  />
                  <UiIconButton icon="i-carbon-overflow-menu-vertical" label="More" size="xs" @click.stop="openRowMenu($event, row)" />
                </span>
                <span v-if="activeList" class="i-carbon-draggable text-[14px] text-fg-faint opacity-0 shrink-0 cursor-grab transition-opacity group-hover:opacity-100" />
              </div>
            </TransitionGroup>
            <div v-if="shownRows.length < rows.length" ref="sentinel" class="text-[12px] text-fg-faint py-4 text-center">
              Loading more…
            </div>
          </template>

          <!-- Empty states -->
          <UiEmpty
            v-else-if="activeSmart && !library.hasVideos"
            icon="i-carbon-folder"
            title="Open a library first"
            description="Smart playlists are built from the videos in your library folder."
          >
            <UiButton variant="primary" icon="i-carbon-video-chat" @click="ui.openView('library')">
              Go to library
            </UiButton>
          </UiEmpty>
          <UiEmpty
            v-else-if="activeSmart"
            icon="i-carbon-filter"
            title="Nothing matches"
            :description="`No videos match ${ruleSummary(activeSmart.rules).toLowerCase()}.`"
          />
          <UiEmpty
            v-else-if="activeList?.id === 'favorites'"
            icon="i-carbon-favorite"
            title="No favorites yet"
            description="Right-click any video in the library and choose Add to playlist › Favorites."
          >
            <UiButton icon="i-carbon-video-chat" @click="ui.openView('library')">
              Browse library
            </UiButton>
          </UiEmpty>
          <UiEmpty
            v-else
            icon="i-carbon-playlist"
            title="This playlist is empty"
            description="Add videos from the library: right-click one, or select several and use the Playlist button."
          >
            <UiButton icon="i-carbon-video-chat" @click="ui.openView('library')">
              Browse library
            </UiButton>
          </UiEmpty>
        </div>
      </div>
    </section>

    <UiContextMenu v-model="ctx" />
  </div>
</template>

<style scoped>
.side-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 6px 8px;
  border-radius: var(--radius-md);
  color: var(--text-muted);
  transition:
    background-color var(--dur-fast),
    color var(--dur-fast);
}
.side-item:hover {
  color: var(--text);
  background: color-mix(in srgb, var(--text) 5%, transparent);
}
.side-item.is-active {
  color: var(--text);
  background: color-mix(in srgb, var(--text) 9%, transparent);
}
.side-cover {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--bg-800);
  color: var(--text-faint);
}
.side-cover.is-fav {
  color: var(--accent-contrast);
  background: linear-gradient(135deg, var(--accent), var(--accent-strong));
}
.side-cover.is-smart {
  color: var(--accent-light);
  background: var(--accent-soft);
}
.cover-empty {
  background:
    radial-gradient(120% 120% at 0% 0%, var(--accent-soft), transparent 60%),
    linear-gradient(135deg, var(--bg-800), var(--bg-700));
}
.rule-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 6px 0 8px;
  border-radius: var(--radius-sm);
  font-size: 12.5px;
  color: var(--text);
  background: var(--bg-850);
  box-shadow: inset 0 0 0 1px var(--border-strong);
}

.pl-row {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 52px;
  padding: 0 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition:
    background-color var(--dur-fast),
    opacity var(--dur-fast);
}
.pl-row:hover {
  background: color-mix(in srgb, var(--text) 5%, transparent);
}
.pl-row.is-current {
  background: var(--accent-soft);
}
.pl-row.is-missing {
  opacity: 0.5;
}
.pl-row.is-missing:hover {
  opacity: 0.8;
}
.pl-row.is-dragging {
  opacity: 0.35;
}

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
