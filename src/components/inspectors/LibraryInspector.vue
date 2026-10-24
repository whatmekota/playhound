<script setup lang="ts">
import type { MenuItem } from '~/components/ui/menu'
import type { VideoEntry } from '~/stores/libraryStore'
import { watchDebounced } from '@vueuse/core'
import { computed, onActivated, onDeactivated, ref, watch } from 'vue'
import EntryInfoModal from '~/components/library/EntryInfoModal.vue'
import FilterChips from '~/components/library/FilterChips.vue'
import LibraryRow from '~/components/library/LibraryRow.vue'
import NewPlaylistModal from '~/components/library/NewPlaylistModal.vue'
import { useEntryActions } from '~/components/library/useEntryActions'
import { useLibraryQueryState } from '~/components/library/useLibraryQuery'
import { useWindowedRows } from '~/components/library/useWindowedRows'
import UiButton from '~/components/ui/UiButton.vue'
import UiContextMenu from '~/components/ui/UiContextMenu.vue'
import UiEmpty from '~/components/ui/UiEmpty.vue'
import UiIconButton from '~/components/ui/UiIconButton.vue'
import UiInput from '~/components/ui/UiInput.vue'
import UiMenu from '~/components/ui/UiMenu.vue'
import UiPanel from '~/components/ui/UiPanel.vue'
import UiPopover from '~/components/ui/UiPopover.vue'
import UiProgress from '~/components/ui/UiProgress.vue'
import UiSpinner from '~/components/ui/UiSpinner.vue'
import { plural } from '~/lib/entryInfo'
import { cancelGenerateAll, generateAllThumbs, hydrateLibrary, thumbJob, thumbsFor } from '~/lib/thumbs'
import { useLibraryStore } from '~/stores/libraryStore'
import { usePlaybackStore } from '~/stores/playbackStore'
import { usePlayerStore } from '~/stores/playerStore'
import { useQueueStore } from '~/stores/queueStore'
import { useUiStore } from '~/stores/uiStore'

/**
 * The library beside the video: the same search, chips and sort as the full
 * view, in a dense list. Clicking plays without leaving the player.
 */
defineOptions({ name: 'LibraryInspector' })

const library = useLibraryStore()
const playback = usePlaybackStore()
const queue = useQueueStore()
const player = usePlayerStore()
const ui = useUiStore()

const lq = useLibraryQueryState(() => library.videos)
const actions = useEntryActions({ play: e => lq.playEntry(e) })
const { ctx, infoEntry, newPlaylistFor } = actions

const currentName = computed(() => playback.currentEntry?.name ?? queue.current?.name ?? null)

watch(() => library.loadedAt, () => void hydrateLibrary(library.videos, library.loadedAt), { immediate: true })

// ─── Windowed list ────────────────────────────────────────────────────────
const ROW_H = 46
const scroller = ref<HTMLElement | null>(null)
const win = useWindowedRows({ scroller, items: () => lq.results, rowH: ROW_H, overscan: 4 })

watch(() => [lq.query, lq.filters, lq.bands, lq.sort], () => win.scrollToTop(), { deep: true })

const currentIndex = computed(() => currentName.value ? lq.results.findIndex(v => v.name === currentName.value) : -1)

// ─── Background work ──────────────────────────────────────────────────────
// Pictures and script analysis for what is on screen, and nothing while the
// panel is closed. Analysis waits while the list is sorted or filtered by
// intensity: rows would jump as their numbers arrived.
const active = ref(true)
onActivated(() => (active.value = true))
onDeactivated(() => (active.value = false))

watchDebounced([win.visible, active, () => lq.scriptAware], () => {
  const on = active.value ? win.visible.value : []
  thumbsFor(on, 'library-panel')
  lq.scripts.want('library-panel', lq.scriptAware ? [] : on)
}, { debounce: 120 })

// ─── Rows ─────────────────────────────────────────────────────────────────
function onMenu(e: MouseEvent, entry: VideoEntry) {
  actions.openMenu(e, [entry])
}

const sweepPct = computed(() => lq.scripts.sweepTotal ? lq.scripts.sweepDone / lq.scripts.sweepTotal : 0)
const unanalysed = computed(() => lq.scripts.coverage.total - lq.scripts.coverage.done)

const moreMenu = computed<MenuItem[]>(() => [
  { label: 'Open full library', icon: 'i-carbon-launch', run: () => ui.openView('library') },
  { separator: true },
  lq.scripts.sweeping
    ? { label: 'Stop analysing scripts', icon: 'i-carbon-stop', run: lq.scripts.cancelAnalyse }
    : { label: unanalysed.value ? `Analyse all scripts (${unanalysed.value.toLocaleString()})` : 'All scripts analysed', icon: 'i-carbon-chart-average', disabled: !unanalysed.value, run: () => void lq.scripts.analyseAll() },
  thumbJob.running
    ? { label: 'Stop generating previews', icon: 'i-carbon-stop', run: cancelGenerateAll }
    : { label: 'Generate all previews', icon: 'i-carbon-image', run: () => void generateAllThumbs(library.videos), disabled: !library.hasVideos },
  { separator: true },
  { label: 'Change folder…', icon: 'i-carbon-folder-open', run: () => void library.pickFolder() },
])

const searchInput = ref<InstanceType<typeof UiInput> | null>(null)
</script>

<template>
  <UiPanel pad="none">
    <template v-if="library.hasVideos" #toolbar>
      <div class="flex gap-1 items-center">
        <UiInput
          ref="searchInput"
          v-model="lq.search"
          icon="i-carbon-search"
          placeholder="Search names, tags, creators"
          clearable
          class="flex-1 min-w-0"
          @escape="searchInput?.el?.blur()"
        />
        <UiPopover placement="bottom" align="end" flush>
          <template #trigger="{ toggle, open }">
            <UiIconButton
              :icon="lq.sort.asc ? 'i-carbon-sort-ascending' : 'i-carbon-sort-descending'"
              :label="`Sort: ${lq.sortLabel}`"
              :active="open"
              @click="toggle"
            />
          </template>
          <template #default="{ close }">
            <div class="p-1">
              <UiMenu :items="lq.sortMenu" @done="close" />
            </div>
          </template>
        </UiPopover>
        <UiPopover placement="bottom" align="end" flush>
          <template #trigger="{ toggle, open }">
            <UiIconButton icon="i-carbon-overflow-menu-horizontal" label="More" :active="open" @click="toggle" />
          </template>
          <template #default="{ close }">
            <div class="p-1">
              <UiMenu :items="moreMenu" @done="close" />
            </div>
          </template>
        </UiPopover>
      </div>

      <FilterChips :lq="lq" compact />

      <div class="text-[11.5px] text-fg-faint flex gap-1 h-6 items-center">
        <span class="num truncate">
          <template v-if="lq.filtering">{{ lq.results.length.toLocaleString() }} of </template>{{ plural(library.videos.length, 'video') }}
          <span>· {{ lq.sortLabel }} {{ lq.sort.asc ? '↑' : '↓' }}</span>
        </span>
        <span class="flex-1" />
        <UiIconButton
          v-if="currentIndex >= 0"
          icon="i-carbon-center-circle"
          label="Scroll to now playing"
          size="xs"
          @click="win.scrollToIndex(currentIndex)"
        />
        <UiIconButton icon="i-carbon-shuffle" label="Shuffle these" size="xs" :disabled="!lq.results.length" @click="lq.shuffleAll()" />
        <UiButton variant="primary" size="xs" icon="i-carbon-play-filled-alt" :disabled="!lq.results.length" @click="lq.playAll()">
          Play
        </UiButton>
      </div>

      <!-- Analysis: running, or wanted by the current sort/filter -->
      <Transition name="t-collapse">
        <div v-if="lq.scripts.sweeping || (lq.scriptAware && unanalysed > 0)">
          <div class="min-h-0 overflow-hidden">
            <div v-if="lq.scripts.sweeping" class="text-[11.5px] text-fg-muted flex gap-2 items-center">
              <span class="i-carbon-chart-average text-accent-300 shrink-0" />
              <span class="num shrink-0">Analysing {{ lq.scripts.sweepDone.toLocaleString() }} / {{ lq.scripts.sweepTotal.toLocaleString() }}</span>
              <UiProgress :value="sweepPct" class="flex-1" />
              <UiButton variant="ghost" size="xs" @click="lq.scripts.cancelAnalyse()">
                Stop
              </UiButton>
            </div>
            <div v-else class="text-[11.5px] text-fg-muted px-2 py-1 rounded-[var(--radius-sm)] bg-fg/5 flex gap-2 items-center">
              <span class="i-carbon-information text-fg-faint shrink-0" />
              <span class="flex-1">{{ plural(unanalysed, 'script') }} not analysed yet</span>
              <UiButton variant="ghost" size="xs" @click="lq.scripts.analyseAll()">
                Analyse
              </UiButton>
            </div>
          </div>
        </div>
      </Transition>
    </template>

    <!-- Restoring the remembered folder -->
    <div v-if="library.restoring && !library.hasVideos" class="center flex-1">
      <UiEmpty icon="i-carbon-folder-open" size="sm" title="Opening your library" :description="`Reading ${library.savedFolderName || 'the last folder'}…`">
        <UiSpinner :size="16" />
      </UiEmpty>
    </div>

    <!-- First scan -->
    <div v-else-if="library.scanning && !library.hasVideos" class="px-2 pt-2 flex flex-col gap-1">
      <div v-for="i in 12" :key="i" class="px-2 flex gap-2.5 h-11 items-center" :style="{ opacity: 1 - i * 0.06 }">
        <div class="skeleton rounded-[var(--radius-xs)] shrink-0 h-8 w-14" />
        <div class="flex flex-1 flex-col gap-1.5">
          <div class="skeleton rounded h-2.5 w-3/4" />
          <div class="skeleton rounded h-2 w-1/3" />
        </div>
      </div>
    </div>

    <div v-else-if="library.needsReconnect && !library.hasVideos" class="center flex-1">
      <UiEmpty icon="i-carbon-folder-off" size="sm" :title="`Reconnect “${library.savedFolderName}”`" description="The browser asks again after a restart. One click and the library is back.">
        <UiButton variant="primary" icon="i-carbon-unlocked" @click="library.reconnect()">
          Reconnect
        </UiButton>
      </UiEmpty>
    </div>

    <div v-else-if="!library.hasVideos" class="center flex-1">
      <UiEmpty icon="i-carbon-folder-add" size="sm" title="No library yet" description="Open a folder of videos; scripts beside them are matched automatically.">
        <UiButton variant="primary" icon="i-carbon-folder-open" @click="library.pickFolder()">
          Open folder
        </UiButton>
      </UiEmpty>
    </div>

    <div v-else-if="!lq.results.length" class="center flex-1">
      <UiEmpty icon="i-carbon-search" size="sm" title="Nothing matches" :description="lq.query ? `No videos match “${lq.query}” with these filters.` : 'No videos match these filters.'">
        <UiButton icon="i-carbon-close" @click="lq.clearFilters()">
          Clear filters
        </UiButton>
      </UiEmpty>
    </div>

    <div v-else ref="scroller" class="px-1.5 py-1.5 flex-1 min-h-0 overflow-y-auto" @scroll.passive="win.onScroll">
      <div class="relative" :style="{ height: `${win.totalH.value}px` }">
        <div
          v-for="row in win.rows.value"
          :key="row.index"
          class="py-px inset-x-0 absolute"
          :style="{ top: `${row.top}px`, height: `${ROW_H}px` }"
        >
          <LibraryRow
            v-for="{ item: entry } in row.cells"
            :key="entry.name"
            :entry="entry"
            :name="entry.name"
            :summary="lq.scripts.summaryOf(entry)"
            :current="entry.name === currentName"
            :playing="player.isPlaying"
            @play="lq.playEntry(entry)"
            @play-next="playback.playNextInQueue(entry)"
            @menu="onMenu($event, entry)"
          />
        </div>
      </div>
    </div>

    <UiContextMenu v-model="ctx" />
    <EntryInfoModal v-model="infoEntry" />
    <NewPlaylistModal v-model="newPlaylistFor" />
  </UiPanel>
</template>
