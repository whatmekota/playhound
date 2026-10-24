<script setup lang="ts">
import type { MenuItem } from '~/components/ui/menu'
import type { VideoEntry } from '~/stores/libraryStore'
import { useLocalStorage, watchDebounced } from '@vueuse/core'
import { computed, onActivated, onDeactivated, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import CardScrub from '~/components/library/CardScrub.vue'
import EntryInfoModal from '~/components/library/EntryInfoModal.vue'
import Equaliser from '~/components/library/Equaliser.vue'
import FilterChips from '~/components/library/FilterChips.vue'
import IntensityMeter from '~/components/library/IntensityMeter.vue'
import NewPlaylistModal from '~/components/library/NewPlaylistModal.vue'
import { useEntryActions } from '~/components/library/useEntryActions'
import { useLibraryQueryState } from '~/components/library/useLibraryQuery'
import { useWindowedRows } from '~/components/library/useWindowedRows'
import UiBadge from '~/components/ui/UiBadge.vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiContextMenu from '~/components/ui/UiContextMenu.vue'
import UiEmpty from '~/components/ui/UiEmpty.vue'
import UiIconButton from '~/components/ui/UiIconButton.vue'
import UiInput from '~/components/ui/UiInput.vue'
import UiKbd from '~/components/ui/UiKbd.vue'
import UiMenu from '~/components/ui/UiMenu.vue'
import UiPopover from '~/components/ui/UiPopover.vue'
import UiProgress from '~/components/ui/UiProgress.vue'
import UiSegmented from '~/components/ui/UiSegmented.vue'
import UiSlider from '~/components/ui/UiSlider.vue'
import UiSpinner from '~/components/ui/UiSpinner.vue'
import { toast } from '~/composables/useToast'
import { effectiveMeta, formatDate, formatSize, plural, scriptBadge } from '~/lib/entryInfo'
import { KEYS } from '~/lib/persist'
import { cancelGenerateAll, generateAllThumbs, hydrateLibrary, thumbBusy, thumbFailed, thumbJob, thumbsFor } from '~/lib/thumbs'
import { formatTime } from '~/lib/time'
import { useLibraryStore } from '~/stores/libraryStore'
import { usePlaybackStore } from '~/stores/playbackStore'
import { usePlayerStore } from '~/stores/playerStore'
import { useQueueStore } from '~/stores/queueStore'
import { useUiStore } from '~/stores/uiStore'

defineOptions({ name: 'LibraryView' })

const library = useLibraryStore()
const playback = usePlaybackStore()
const queue = useQueueStore()
const player = usePlayerStore()
const ui = useUiStore()

const scroller = ref<HTMLElement | null>(null)

// ─── Preferences ──────────────────────────────────────────────────────────────
const viewMode = useLocalStorage<'grid' | 'list'>(KEYS.libraryView.key, 'grid')
/** Minimum card width in px; the grid fits as many columns as that allows. */
const cardSize = useLocalStorage(KEYS.libraryCard.key, 220)

// ─── Search, filters, sort (the same machinery as the drawer panel) ───────────
const lq = useLibraryQueryState(() => library.videos)
const scripts = lq.scripts

// ─── Now playing ──────────────────────────────────────────────────────────────
const currentName = computed(() => playback.currentEntry?.name ?? queue.current?.name ?? null)

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
  const shown = lq.results.filter(v => selected.value.has(v.name))
  const shownSet = new Set(shown)
  return shown.concat(library.videos.filter(v => selected.value.has(v.name) && !shownSet.has(v)))
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
  const list = lq.results
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
  selected.value = new Set(lq.results.map(v => v.name))
}

function onItemClick(e: MouseEvent, entry: VideoEntry) {
  if (e.ctrlKey || e.metaKey)
    return toggleSelect(entry)
  if (e.shiftKey)
    return selectRange(entry)
  if (selected.value.size)
    clearSelection()
  lq.playEntry(entry)
}

// ─── Actions, context menu, dialogs ───────────────────────────────────────────
const actions = useEntryActions({ play: e => lq.playEntry(e), playMany: list => playList(list) })
const { ctx, infoEntry, newPlaylistFor } = actions

function openCtx(e: MouseEvent, entry: VideoEntry) {
  // Right-clicking inside the selection acts on all of it; outside, on that one video.
  const many = selected.value.has(entry.name) && selected.value.size > 1
  actions.openMenu(e, many ? selectedEntries.value : [entry], many ? [{ label: 'Clear selection', icon: 'i-carbon-close', run: clearSelection }] : [])
}

const allSelectedStarred = computed(() => selectedEntries.value.every(e => e.starred))

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
  lq.setSort('date', false)
  library.watchNewCount = 0
  scroller.value?.scrollTo({ top: 0, behavior: 'smooth' })
}

const unanalysed = computed(() => scripts.coverage.total - scripts.coverage.done)

const folderMenu = computed<MenuItem[]>(() => [
  thumbJob.running
    ? { label: 'Stop generating previews', icon: 'i-carbon-stop', run: cancelGenerateAll }
    : { label: 'Generate all previews', icon: 'i-carbon-image', run: () => void generateAllThumbs(library.videos), disabled: !library.hasVideos },
  scripts.sweeping
    ? { label: 'Stop analysing scripts', icon: 'i-carbon-stop', run: scripts.cancelAnalyse }
    : { label: unanalysed.value ? `Analyse all scripts (${unanalysed.value.toLocaleString()})` : 'All scripts analysed', icon: 'i-carbon-chart-average', run: () => void scripts.analyseAll(), disabled: !unanalysed.value },
  { separator: true },
  library.isWatching
    ? { label: 'Stop watching folder', icon: 'i-carbon-view-off', run: library.stopWatching }
    : { label: 'Rescan folder', icon: 'i-carbon-renew', run: () => void rescan(), disabled: !library.hasVideos },
  { label: 'Forget folder', icon: 'i-carbon-folder-off', danger: true, run: () => void library.forgetFolder(), disabled: !library.hasVideos && !library.savedFolderName },
])

// ─── Windowed grid / list ─────────────────────────────────────────────────────
const GAP = 16
const ROW_GAP = 22
const INFO_H = 46
const LIST_ROW_H = 48

const win = useWindowedRows({
  scroller,
  items: () => lq.results,
  cols: w => viewMode.value === 'list' ? 1 : Math.floor((w + GAP) / (cardSize.value + GAP)),
  rowH: (w, n) => viewMode.value === 'list' ? LIST_ROW_H : Math.round(((w - GAP * (n - 1)) / n) * 9 / 16 + INFO_H + ROW_GAP),
})
const { rows, totalH, cols, onScroll } = win

// A new search or sort starts at the top.
watch(() => [lq.query, lq.filters, lq.bands, lq.sort], () => win.scrollToTop(), { deep: true })

const currentIndex = computed(() => currentName.value ? lq.results.findIndex(v => v.name === currentName.value) : -1)

// ─── Background work ──────────────────────────────────────────────────────────
const active = ref(true)

watchDebounced([win.visible, active, () => lq.scriptAware], () => {
  // While the view is cached but hidden, drop its pending on-screen requests.
  const on = active.value ? win.visible.value : []
  thumbsFor(on, 'library')
  // Analyse the scripts of cards in view, except while the order depends on
  // it: cards would move under the pointer as their numbers arrived.
  scripts.want('library', lq.scriptAware ? [] : on)
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
  if (ui.paletteOpen || ui.settingsOpen || infoEntry.value || newPlaylistFor.value)
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

const sweepPct = computed(() => scripts.sweepTotal ? scripts.sweepDone / scripts.sweepTotal : 0)

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
            <span class="num">{{ lq.counts.scripted.toLocaleString() }} scripted</span>
            <span v-if="lq.filtering" class="text-accent-300 num">· {{ lq.results.length.toLocaleString() }} shown</span>
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
        v-model="lq.search"
        icon="i-carbon-search"
        placeholder="Search names, tags, creators"
        clearable
        class="w-[260px]"
        @escape="searchInput?.el?.blur()"
      >
        <template #suffix>
          <UiKbd v-if="!lq.search" class="mr-1.5">
            /
          </UiKbd>
        </template>
      </UiInput>

      <FilterChips :lq="lq" />

      <div class="flex-1" />

      <UiIconButton
        v-if="currentIndex >= 0"
        icon="i-carbon-center-circle"
        label="Scroll to now playing"
        @click="win.scrollToIndex(currentIndex)"
      />

      <UiPopover placement="bottom" align="end" flush>
        <template #trigger="{ toggle, open }">
          <UiButton variant="ghost" :active="open" :icon="lq.sort.asc ? 'i-carbon-sort-ascending' : 'i-carbon-sort-descending'" @click="toggle">
            {{ lq.sortLabel }}
          </UiButton>
        </template>
        <template #default="{ close }">
          <div class="p-1">
            <UiMenu :items="lq.sortMenu" @done="close" />
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

      <UiButton variant="primary" icon="i-carbon-play-filled-alt" :disabled="!lq.results.length" @click="lq.playAll()">
        Play all
      </UiButton>
      <UiIconButton icon="i-carbon-shuffle" label="Shuffle all" variant="solid" :disabled="!lq.results.length" @click="lq.shuffleAll()" />
    </div>

    <!-- Thumbnail generation / script analysis / scanning progress -->
    <Transition name="t-collapse">
      <div v-if="thumbJob.running || scripts.sweeping || (library.scanning && library.hasVideos) || (library.hasVideos && lq.scriptAware && unanalysed > 0)">
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
            <template v-else-if="scripts.sweeping">
              <span class="i-carbon-chart-average text-accent-300 shrink-0" />
              <span class="num shrink-0">Analysing scripts {{ scripts.sweepDone.toLocaleString() }} / {{ scripts.sweepTotal.toLocaleString() }}</span>
              <UiProgress :value="sweepPct" class="flex-1 max-w-[320px]" />
              <UiButton variant="ghost" size="xs" @click="scripts.cancelAnalyse()">
                Stop
              </UiButton>
            </template>
            <template v-else-if="library.scanning">
              <UiSpinner :size="13" />
              <span class="num">Rescanning {{ library.totalFiles.toLocaleString() }} files…</span>
              <UiProgress class="flex-1 max-w-[320px]" />
            </template>
            <template v-else>
              <span class="i-carbon-information text-fg-faint shrink-0" />
              <span class="num">Intensity is known for {{ scripts.coverage.done.toLocaleString() }} of {{ plural(scripts.coverage.total, 'scripted video') }}; the rest are listed last.</span>
              <UiButton variant="ghost" size="xs" icon="i-carbon-chart-average" @click="scripts.analyseAll()">
                Analyse all
              </UiButton>
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
      <div v-else-if="!lq.results.length" class="center flex-1 min-h-0">
        <UiEmpty
          icon="i-carbon-search"
          title="Nothing matches"
          :description="lq.query ? `No videos match “${lq.query}” with the current filters.` : lq.bands.size && !scripts.coverage.done ? 'No scripts have been analysed yet, so none has an intensity.' : 'No videos match the current filters.'"
        >
          <UiButton icon="i-carbon-close" @click="lq.clearFilters()">
            Clear search and filters
          </UiButton>
          <UiButton v-if="lq.bands.size && unanalysed > 0 && !scripts.sweeping" icon="i-carbon-chart-average" @click="scripts.analyseAll()">
            Analyse scripts
          </UiButton>
        </UiEmpty>
      </div>

      <template v-else>
        <!-- List header -->
        <div v-if="viewMode === 'list'" class="list-cols eyebrow mx-6 px-2 border-b border-edge shrink-0 h-8 items-center">
          <span />
          <span />
          <button type="button" class="sort-head" :class="lq.sort.key === 'name' ? 'text-fg' : ''" @click="lq.setSort('name')">
            Name<span v-if="lq.sort.key === 'name'" :class="lq.sort.asc ? 'i-carbon-arrow-up' : 'i-carbon-arrow-down'" />
          </button>
          <button v-tip="'Sort by intensity'" type="button" class="sort-head" :class="lq.sort.key === 'intensity' ? 'text-fg' : ''" @click="lq.setSort('intensity')">
            Script<span v-if="lq.sort.key === 'intensity'" :class="lq.sort.asc ? 'i-carbon-arrow-up' : 'i-carbon-arrow-down'" />
          </button>
          <button type="button" class="sort-head justify-end" :class="lq.sort.key === 'duration' ? 'text-fg' : ''" @click="lq.setSort('duration')">
            <span v-if="lq.sort.key === 'duration'" :class="lq.sort.asc ? 'i-carbon-arrow-up' : 'i-carbon-arrow-down'" />Length
          </button>
          <button type="button" class="sort-head justify-end" :class="lq.sort.key === 'size' ? 'text-fg' : ''" @click="lq.setSort('size')">
            <span v-if="lq.sort.key === 'size'" :class="lq.sort.asc ? 'i-carbon-arrow-up' : 'i-carbon-arrow-down'" />Size
          </button>
          <button type="button" class="sort-head col-date justify-end" :class="lq.sort.key === 'date' ? 'text-fg' : ''" @click="lq.setSort('date')">
            <span v-if="lq.sort.key === 'date'" :class="lq.sort.asc ? 'i-carbon-arrow-up' : 'i-carbon-arrow-down'" />Modified
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
                  v-for="{ item: entry } in row.cells"
                  :key="entry.name"
                  class="card-item group focusable rounded-[var(--radius-md)] cursor-pointer relative"
                  :class="{ 'is-selected': selected.has(entry.name), 'is-current': entry.name === currentName }"
                  tabindex="0"
                  role="button"
                  :aria-label="entry.basename"
                  @click="onItemClick($event, entry)"
                  @dblclick="ui.openView('player')"
                  @keydown.enter="lq.playEntry(entry)"
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

                    <!-- Hover: scrub through the video by moving across the card -->
                    <CardScrub :entry="entry" />

                    <div class="shade inset-0 absolute" />

                    <!-- Hover: play -->
                    <div class="hover-play opacity-0 center pointer-events-none transition-opacity duration-200 inset-0 absolute group-hover:opacity-100">
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
                    <div class="bottom-row flex gap-1 transition-opacity items-center bottom-1.5 left-1.5 right-1.5 absolute">
                      <span v-if="entry.name === currentName" class="chip-over text-accent-300 gap-1 animate-scale-in">
                        <Equaliser :playing="player.isPlaying" />
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
                      <span class="flex-1" />
                      <IntensityMeter :summary="scripts.summaryOf(entry)" />
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
                  v-for="{ item: entry, index } in row.cells"
                  :key="entry.name"
                  class="list-cols list-row group px-2 focusable rounded-[var(--radius-sm)] h-full cursor-pointer items-center"
                  :class="{ 'is-selected': selected.has(entry.name), 'is-current': entry.name === currentName }"
                  tabindex="0"
                  role="button"
                  :aria-label="entry.basename"
                  @click="onItemClick($event, entry)"
                  @dblclick="ui.openView('player')"
                  @keydown.enter="lq.playEntry(entry)"
                  @contextmenu.prevent="openCtx($event, entry)"
                >
                  <span class="text-[11.5px] text-fg-faint num text-right">
                    <Equaliser v-if="entry.name === currentName" class="text-accent-300" :playing="player.isPlaying" />
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
                  <span class="flex gap-2 min-w-0 items-center">
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
                    <IntensityMeter :summary="scripts.summaryOf(entry)" />
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
                <UiMenu :items="actions.playlistItems(selectedEntries)" @done="close" />
              </div>
            </template>
          </UiPopover>
          <UiIconButton
            :icon="allSelectedStarred ? 'i-carbon-star-filled' : 'i-carbon-star'"
            :label="allSelectedStarred ? 'Unstar' : 'Star'"
            @click="actions.setStar(selectedEntries, !allSelectedStarred)"
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
    <NewPlaylistModal v-model="newPlaylistFor" />
    <EntryInfoModal v-model="infoEntry" />
  </div>
</template>

<style scoped>
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
/* While scrubbing the frame is the point: the play button and chips step aside. */
.card-item:has(.scrub.is-on) .hover-play,
.card-item:has(.scrub.is-on) .bottom-row {
  opacity: 0;
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
  grid-template-columns: 28px 64px minmax(0, 1fr) 156px 64px 72px 110px 32px;
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
</style>
