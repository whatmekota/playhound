<script setup lang="ts">
import type { PlaylistRow, PlaylistSel } from '~/components/library/usePlaylistRows'
import type { MenuItem } from '~/components/ui/menu'
import type { SmartPlaylist } from '~/stores/playlistStore'
import { useLocalStorage, watchDebounced } from '@vueuse/core'
import { computed, onActivated, onDeactivated, ref, watch } from 'vue'
import EntryInfoModal from '~/components/library/EntryInfoModal.vue'
import Equaliser from '~/components/library/Equaliser.vue'
import LibraryRow from '~/components/library/LibraryRow.vue'
import NewPlaylistModal from '~/components/library/NewPlaylistModal.vue'
import { useEntryActions } from '~/components/library/useEntryActions'
import { cleanName, usePlaylistRows } from '~/components/library/usePlaylistRows'
import { useScriptSummaries } from '~/components/library/useScriptSummaries'
import { useWindowedRows } from '~/components/library/useWindowedRows'
import UiButton from '~/components/ui/UiButton.vue'
import UiContextMenu from '~/components/ui/UiContextMenu.vue'
import UiEmpty from '~/components/ui/UiEmpty.vue'
import UiIconButton from '~/components/ui/UiIconButton.vue'
import UiMenu from '~/components/ui/UiMenu.vue'
import UiPanel from '~/components/ui/UiPanel.vue'
import UiPopover from '~/components/ui/UiPopover.vue'
import { formatTotal, plural } from '~/lib/entryInfo'
import { KEYS } from '~/lib/persist'
import { ensureDurations, hydrateLibrary, prefetchThumbs, thumbsFor } from '~/lib/thumbs'
import { useLibraryStore } from '~/stores/libraryStore'
import { usePlaybackStore } from '~/stores/playbackStore'
import { usePlayerStore } from '~/stores/playerStore'
import { evaluateSmartPlaylist, usePlaylistStore } from '~/stores/playlistStore'
import { useQueueStore } from '~/stores/queueStore'
import { useUiStore } from '~/stores/uiStore'

/**
 * Playlists beside the video: pick one, then play from it. Editing rules,
 * renaming and import/export stay in the full Playlists view; this is for
 * choosing what plays next without leaving the player.
 */
defineOptions({ name: 'PlaylistsInspector' })

const plStore = usePlaylistStore()
const library = useLibraryStore()
const playback = usePlaybackStore()
const queue = useQueueStore()
const player = usePlayerStore()
const ui = useUiStore()
const scripts = useScriptSummaries()

watch(() => library.loadedAt, () => void hydrateLibrary(library.videos, library.loadedAt), { immediate: true })

const currentName = computed(() => playback.currentEntry?.name ?? queue.current?.name ?? null)

// ─── Which playlist ───────────────────────────────────────────────────────
/** null: the list of playlists; otherwise the one drilled into. */
const open = ref<PlaylistSel | null>(null)
const pl = usePlaylistRows(open)

// A playlist deleted elsewhere drops back to the list.
watch([pl.activeList, pl.activeSmart], ([l, s]) => {
  if (open.value && !l && !s)
    open.value = null
})

// Playing a whole playlist straight from the list, without opening it.
const quick = ref<PlaylistSel | null>(null)
const quickPl = usePlaylistRows(quick)
function quickPlay(sel: PlaylistSel, shuffle = false) {
  quick.value = sel
  if (shuffle)
    quickPl.shuffleAll()
  else
    quickPl.playAll()
}

const smartCounts = computed(() => {
  const out: Record<string, number> = {}
  if (!library.hasVideos)
    return out
  for (const s of plStore.smartPlaylists)
    out[s.id] = evaluateSmartPlaylist(s, library.videos).length
  return out
})

const SMART_ICONS: Record<string, string> = {
  has_script: 'i-carbon-chart-line-smooth',
  no_script: 'i-carbon-subtract-alt',
  multi_axis: 'i-carbon-chart-multi-line',
  starred: 'i-carbon-star',
  has_tag: 'i-carbon-tag',
  min_rating: 'i-carbon-star-review',
}
const smartIcon = (s: SmartPlaylist) => SMART_ICONS[s.rules[0]?.type ?? ''] ?? 'i-carbon-filter'

/** The playlist the current video was started from, so its row can show the bars. */
const playingFrom = computed(() => queue.sourceLabel)

function listLabel(id: string, name: string) {
  return id === 'favorites' ? 'Favorites' : cleanName(name)
}

const openIcon = computed(() => pl.activeSmart.value
  ? smartIcon(pl.activeSmart.value)
  : pl.activeList.value?.id === 'favorites' ? 'i-carbon-favorite-filled' : 'i-carbon-playlist')
const openCover = computed(() => pl.activeList.value && pl.activeList.value.id !== 'favorites' ? pl.coverFor(pl.activeList.value.entries) : null)

// ─── Rows ─────────────────────────────────────────────────────────────────
const ROW_H = 46
const scroller = ref<HTMLElement | null>(null)
const win = useWindowedRows<PlaylistRow>({ scroller, items: () => pl.rows.value, rowH: ROW_H, overscan: 4 })

watch(open, () => win.scrollToTop())

const currentIndex = computed(() => currentName.value ? pl.rows.value.findIndex(r => r.entry?.name === currentName.value) : -1)

const active = ref(true)
onActivated(() => (active.value = true))
onDeactivated(() => (active.value = false))

watchDebounced([win.visible, active], () => {
  const on = active.value ? win.visible.value.flatMap(r => (r.entry ? [r.entry] : [])) : []
  thumbsFor(on, 'playlists-panel')
  scripts.want('playlists-panel', on)
  void ensureDurations(on)
}, { debounce: 120 })

// Covers for the list of playlists.
watch(() => plStore.playlists.map(p => p.entries[0]?.videoName), () => {
  prefetchThumbs(plStore.playlists.flatMap(p => p.entries.slice(0, 1).flatMap(e => pl.byName.value.get(e.videoName) ?? [])))
}, { immediate: true })

// ─── Menus ────────────────────────────────────────────────────────────────
const actions = useEntryActions({ play: e => pl.playFrom(e) })
const { ctx, infoEntry, newPlaylistFor } = actions

function onRowMenu(e: MouseEvent, row: PlaylistRow) {
  const edit = pl.rowEditItems(row)
  if (row.entry)
    actions.openMenu(e, [row.entry], edit)
  else if (edit.length)
    ctx.value = { x: e.clientX, y: e.clientY, items: edit }
}

function onListMenu(e: MouseEvent, sel: PlaylistSel) {
  ctx.value = {
    x: e.clientX,
    y: e.clientY,
    items: [
      { label: 'Open', icon: 'i-carbon-folder-open', run: () => (open.value = sel) },
      { label: 'Play', icon: 'i-carbon-play-filled-alt', run: () => quickPlay(sel) },
      { label: 'Shuffle', icon: 'i-carbon-shuffle', run: () => quickPlay(sel, true) },
      { separator: true },
      { label: 'Edit in Playlists', icon: 'i-carbon-launch', run: () => openInView(sel) },
    ],
  }
}

/** The full view's choice, so handing over can open it at this playlist. */
const viewSel = useLocalStorage<PlaylistSel>(KEYS.playlistsSelected.key, { kind: 'list', id: 'favorites' })

/** Hand over to the full view, already showing this playlist. */
function openInView(sel: PlaylistSel | null) {
  if (sel)
    viewSel.value = sel
  ui.openView('playlists')
}

const detailMenu = computed<MenuItem[]>(() => [
  { label: 'Edit in Playlists', icon: 'i-carbon-launch', run: () => openInView(open.value) },
])

function newPlaylist() {
  const base = 'New playlist'
  const taken = plStore.playlists.map(p => p.name)
  let name = base
  for (let n = 2; taken.includes(name); n++)
    name = `${base} ${n}`
  const created = plStore.createPlaylist(name)
  open.value = { kind: 'list', id: created.id }
}
</script>

<template>
  <Transition name="t-slide-right" mode="out-in">
    <!-- ══ The list of playlists ═════════════════════════════════════════════ -->
    <UiPanel v-if="!open" key="index" pad="none">
      <div class="px-1.5 py-2 flex flex-col">
        <div class="pl-2.5 pr-1 flex h-7 items-center justify-between">
          <span class="eyebrow">Your playlists</span>
          <UiIconButton icon="i-carbon-add" label="New playlist" size="xs" tip="left" @click="newPlaylist" />
        </div>
        <TransitionGroup name="t-list" tag="div" class="flex flex-col relative">
          <div
            v-for="p in plStore.playlists"
            :key="p.id"
            class="pick group focusable"
            tabindex="0"
            role="button"
            @click="open = { kind: 'list', id: p.id }"
            @keydown.enter="open = { kind: 'list', id: p.id }"
            @contextmenu.prevent="onListMenu($event, { kind: 'list', id: p.id })"
          >
            <span class="pick-cover" :class="p.id === 'favorites' ? 'is-fav' : ''">
              <img v-if="p.id !== 'favorites' && pl.coverFor(p.entries)" :src="pl.coverFor(p.entries)!" alt="" class="h-full w-full object-cover">
              <span v-else :class="p.id === 'favorites' ? 'i-carbon-favorite-filled' : 'i-carbon-playlist'" class="text-[14px]" />
            </span>
            <span class="flex-1 min-w-0">
              <span class="text-[12.5px] text-fg leading-4 block truncate">{{ listLabel(p.id, p.name) }}</span>
              <span class="text-[11px] text-fg-faint leading-4 num block">{{ plural(p.entries.length, 'video') }}</span>
            </span>
            <Equaliser v-if="playingFrom === listLabel(p.id, p.name)" class="text-accent-300 shrink-0" :playing="player.isPlaying" />
            <UiIconButton
              v-if="p.entries.length"
              icon="i-carbon-play-filled-alt"
              label="Play"
              size="xs"
              tip="left"
              class="opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
              @click.stop="quickPlay({ kind: 'list', id: p.id })"
            />
            <span class="i-carbon-chevron-right text-[13px] text-fg-faint shrink-0" />
          </div>
        </TransitionGroup>

        <div class="pl-2.5 pr-1 pt-3 flex h-10 items-center">
          <span class="eyebrow">Smart playlists</span>
        </div>
        <div
          v-for="s in plStore.smartPlaylists"
          :key="s.id"
          class="pick group focusable"
          tabindex="0"
          role="button"
          @click="open = { kind: 'smart', id: s.id }"
          @keydown.enter="open = { kind: 'smart', id: s.id }"
          @contextmenu.prevent="onListMenu($event, { kind: 'smart', id: s.id })"
        >
          <span class="pick-cover is-smart">
            <span :class="smartIcon(s)" class="text-[14px]" />
          </span>
          <span class="flex-1 min-w-0">
            <span class="text-[12.5px] text-fg leading-4 block truncate">{{ cleanName(s.name) }}</span>
            <span v-if="library.hasVideos" class="text-[11px] text-fg-faint leading-4 num block">{{ plural(smartCounts[s.id] ?? 0, 'video') }}</span>
          </span>
          <Equaliser v-if="playingFrom === cleanName(s.name)" class="text-accent-300 shrink-0" :playing="player.isPlaying" />
          <UiIconButton
            v-if="smartCounts[s.id]"
            icon="i-carbon-play-filled-alt"
            label="Play"
            size="xs"
            tip="left"
            class="opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
            @click.stop="quickPlay({ kind: 'smart', id: s.id })"
          />
          <span class="i-carbon-chevron-right text-[13px] text-fg-faint shrink-0" />
        </div>
      </div>

      <template #footer>
        <UiButton variant="ghost" size="xs" icon="i-carbon-launch" @click="openInView(null)">
          Manage playlists
        </UiButton>
      </template>

      <UiContextMenu v-model="ctx" />
    </UiPanel>

    <!-- ══ One playlist ══════════════════════════════════════════════════════ -->
    <UiPanel v-else :key="`${open.kind}:${open.id}`" pad="none">
      <template #toolbar>
        <div class="flex gap-2 min-w-0 items-center">
          <UiIconButton icon="i-carbon-arrow-left" label="All playlists" size="sm" tip="bottom" @click="open = null" />
          <span class="pick-cover" :class="pl.activeList.value?.id === 'favorites' ? 'is-fav' : pl.activeSmart.value ? 'is-smart' : ''">
            <img v-if="openCover" :src="openCover" alt="" class="h-full w-full object-cover">
            <span v-else :class="openIcon" class="text-[14px]" />
          </span>
          <span class="flex-1 min-w-0">
            <span class="text-[13px] text-fg leading-4 font-semibold block truncate">{{ pl.displayName.value }}</span>
            <span class="text-[11px] text-fg-faint leading-4 num block truncate">
              {{ plural(pl.playable.value.length, 'video') }}<template v-if="pl.totalDuration.value.secs > 0"> · {{ pl.totalDuration.value.unknown ? 'over ' : '' }}{{ formatTotal(pl.totalDuration.value.secs) }}</template><span v-if="pl.missingCount.value" class="text-warn"> · {{ pl.missingCount.value }} missing</span>
            </span>
          </span>
          <UiPopover placement="bottom" align="end" flush>
            <template #trigger="{ toggle, open: isOpen }">
              <UiIconButton icon="i-carbon-overflow-menu-horizontal" label="More" :active="isOpen" @click="toggle" />
            </template>
            <template #default="{ close }">
              <div class="p-1">
                <UiMenu :items="detailMenu" @done="close" />
              </div>
            </template>
          </UiPopover>
        </div>
        <div class="flex gap-1.5 items-center">
          <UiButton variant="primary" size="sm" icon="i-carbon-play-filled-alt" class="flex-1" :disabled="!pl.playable.value.length" @click="pl.playAll()">
            Play
          </UiButton>
          <UiButton size="sm" icon="i-carbon-shuffle" class="flex-1" :disabled="!pl.playable.value.length" @click="pl.shuffleAll()">
            Shuffle
          </UiButton>
          <UiIconButton
            v-if="currentIndex >= 0"
            icon="i-carbon-center-circle"
            label="Scroll to now playing"
            @click="win.scrollToIndex(currentIndex)"
          />
        </div>
      </template>

      <div v-if="library.needsReconnect && !library.hasVideos && pl.rows.value.length" class="text-[12px] mx-2 mt-2 px-2.5 py-2 border border-warn/25 rounded-[var(--radius-md)] bg-warn/10 flex gap-2 items-center">
        <span class="i-carbon-folder-off text-warn shrink-0" />
        <span class="text-fg-muted flex-1">Reconnect the folder to play these.</span>
        <UiButton size="xs" @click="library.reconnect()">
          Reconnect
        </UiButton>
      </div>

      <div v-if="pl.rows.value.length" ref="scroller" class="px-1.5 py-1.5 flex-1 min-h-0 overflow-y-auto" @scroll.passive="win.onScroll">
        <div class="relative" :style="{ height: `${win.totalH.value}px` }">
          <div
            v-for="row in win.rows.value"
            :key="row.index"
            class="py-px inset-x-0 absolute"
            :style="{ top: `${row.top}px`, height: `${ROW_H}px` }"
          >
            <LibraryRow
              v-for="{ item } in row.cells"
              :key="item.key"
              :entry="item.entry"
              :name="item.name"
              :summary="item.entry ? scripts.summaryOf(item.entry) : null"
              :current="!!item.entry && item.entry.name === currentName"
              :playing="player.isPlaying"
              @play="pl.onRowClick(item)"
              @play-next="item.entry && playback.playNextInQueue(item.entry)"
              @menu="onRowMenu($event, item)"
            />
          </div>
        </div>
      </div>

      <div v-else class="center flex-1">
        <UiEmpty
          v-if="pl.activeSmart.value && !library.hasVideos"
          icon="i-carbon-folder"
          size="sm"
          title="Open a library first"
          description="Smart playlists are built from the videos in your library folder."
        >
          <UiButton icon="i-carbon-video-chat" @click="ui.openInspector('library-panel')">
            Browse library
          </UiButton>
        </UiEmpty>
        <UiEmpty v-else-if="pl.activeSmart.value" icon="i-carbon-filter" size="sm" title="Nothing matches" description="No videos in the library fit these rules." />
        <UiEmpty
          v-else
          :icon="pl.activeList.value?.id === 'favorites' ? 'i-carbon-favorite' : 'i-carbon-playlist'"
          size="sm"
          :title="pl.activeList.value?.id === 'favorites' ? 'No favorites yet' : 'This playlist is empty'"
          description="Right-click a video in the library and choose Add to playlist."
        >
          <UiButton icon="i-carbon-video-chat" @click="ui.openInspector('library-panel')">
            Browse library
          </UiButton>
        </UiEmpty>
      </div>

      <UiContextMenu v-model="ctx" />
      <EntryInfoModal v-model="infoEntry" />
      <NewPlaylistModal v-model="newPlaylistFor" />
    </UiPanel>
  </Transition>
</template>

<style scoped>
.pick {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 46px;
  padding: 0 6px 0 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background-color var(--dur-fast);
}
.pick:hover {
  background: color-mix(in srgb, var(--text) 5%, transparent);
}
.pick-cover {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--bg-800);
  color: var(--text-faint);
}
.pick-cover.is-fav {
  color: var(--accent-contrast);
  background: linear-gradient(135deg, var(--accent), var(--accent-strong));
}
.pick-cover.is-smart {
  color: var(--accent-light);
  background: var(--accent-soft);
}
</style>
