<script setup lang="ts">
import type { MenuItem } from '~/components/ui/menu'
import type { QueueItem } from '~/stores/queueStore'
import { useLocalStorage } from '@vueuse/core'
import { computed, ref, watch } from 'vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiContextMenu from '~/components/ui/UiContextMenu.vue'
import UiEmpty from '~/components/ui/UiEmpty.vue'
import UiIconButton from '~/components/ui/UiIconButton.vue'
import UiMenu from '~/components/ui/UiMenu.vue'
import UiPanel from '~/components/ui/UiPanel.vue'
import UiPopover from '~/components/ui/UiPopover.vue'
import { useAutoDirector } from '~/composables/useAutoDirector'
import { toast } from '~/composables/useToast'
import { formatTotal, scriptBadge } from '~/lib/entryInfo'
import { ensureDurations, ensureThumb, vLazyThumb } from '~/lib/thumbs'
import { formatTime } from '~/lib/time'
import { useLibraryStore } from '~/stores/libraryStore'
import { usePlaybackStore } from '~/stores/playbackStore'
import { usePlayerStore } from '~/stores/playerStore'
import { useQueueStore } from '~/stores/queueStore'
import { useUiStore } from '~/stores/uiStore'

const queue = useQueueStore()
const playback = usePlaybackStore()
const player = usePlayerStore()
const library = useLibraryStore()
const director = useAutoDirector()
const ui = useUiStore()

// ─── Now playing ──────────────────────────────────────────────────────────────
const nowEntry = computed(() => queue.current ?? playback.currentEntry)
/** A loose file (opened or dropped) has no library entry, only a name. */
const nowTitle = computed(() => nowEntry.value?.basename ?? player.videoPath?.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') ?? '')
const progress = computed(() => player.videoDuration > 0 ? player.currentTime / player.videoDuration : 0)

watch(nowEntry, (e) => {
  if (e)
    void ensureThumb(e)
}, { immediate: true })

// ─── Up next ──────────────────────────────────────────────────────────────────
// A queue built from a big library can hold thousands; render a page at a time.
const PAGE = 100
const limit = ref(PAGE)
const shownUpcoming = computed(() => queue.upcoming.slice(0, limit.value))
const hiddenCount = computed(() => Math.max(0, queue.upcoming.length - limit.value))

const remaining = computed(() => {
  let secs = 0
  for (const q of queue.upcoming)
    secs += q.entry.duration ?? 0
  return secs
})

watch(shownUpcoming, list => void ensureDurations(list.map(q => q.entry)), { immediate: true })

function jump(item: QueueItem) {
  void playback.jumpTo(item.uid)
}

function clearUpcoming() {
  const n = queue.upcoming.length
  queue.clearUpcoming()
  toast(`Cleared ${n} from up next`, { icon: 'i-carbon-list', key: 'queue-clear' })
}

function clearHistory() {
  queue.clearHistory()
  toast('History cleared', { icon: 'i-carbon-time', key: 'queue-clear' })
}

// ─── History ──────────────────────────────────────────────────────────────────
const historyOpen = useLocalStorage('ph:ui.queue.historyOpen', false)
/** Most recent first, like every player's history. */
const historyItems = computed(() => queue.history.slice().reverse())

// ─── Drag to reorder ──────────────────────────────────────────────────────────
// Items swap live as the pointer crosses them, so TransitionGroup animates the
// gap opening rather than a drop marker jumping about.
const dragFrom = ref<number | null>(null)
let lastMove = 0

function onDragStart(e: DragEvent, i: number) {
  dragFrom.value = i
  e.dataTransfer!.effectAllowed = 'move'
  e.dataTransfer!.setData('text/plain', String(i))
}

function onDragEnter(i: number) {
  if (dragFrom.value === null || dragFrom.value === i)
    return
  // Ignore the frames where rows are still sliding under a stationary pointer.
  const now = performance.now()
  if (now - lastMove < 140)
    return
  lastMove = now
  queue.moveUpcoming(dragFrom.value, i)
  dragFrom.value = i
}

function onDragEnd() {
  dragFrom.value = null
}

// ─── Menus ────────────────────────────────────────────────────────────────────
const ctx = ref<{ x: number, y: number, items: MenuItem[] } | null>(null)

function openItemMenu(e: MouseEvent, item: QueueItem, where: 'current' | 'history' | number) {
  const items: MenuItem[] = []
  if (where !== 'current')
    items.push({ label: 'Play now', icon: 'i-carbon-play-filled-alt', run: () => jump(item) })
  if (typeof where === 'number') {
    const last = queue.upcoming.length - 1
    items.push(
      { label: 'Move to top', icon: 'i-carbon-up-to-top', disabled: where === 0, run: () => queue.moveUpcoming(where, 0) },
      { label: 'Move to bottom', icon: 'i-carbon-down-to-bottom', disabled: where === last, run: () => queue.moveUpcoming(where, last) },
    )
  }
  else if (where === 'history') {
    items.push({ label: 'Play next', icon: 'i-carbon-skip-forward', run: () => playback.playNextInQueue(item.entry) })
  }
  if (items.length)
    items.push({ separator: true })
  items.push({ label: item.entry.starred ? 'Unstar' : 'Star', icon: item.entry.starred ? 'i-carbon-star-filled' : 'i-carbon-star', run: () => library.toggleStar(item.entry) })
  if (where !== 'current')
    items.push({ label: 'Remove', icon: 'i-carbon-subtract-alt', danger: true, run: () => queue.remove(item.uid) })
  ctx.value = { x: e.clientX, y: e.clientY, items }
}

const moreMenu = computed<MenuItem[]>(() => [
  { label: 'Clear up next', icon: 'i-carbon-clean', run: clearUpcoming, disabled: !queue.upcoming.length },
  { label: 'Clear history', icon: 'i-carbon-time', run: clearHistory, disabled: !queue.history.length },
])

const repeatLabel = computed(() => ({ off: 'Repeat off', all: 'Repeat all', one: 'Repeat one' })[queue.repeatMode])
const empty = computed(() => !nowEntry.value && !player.videoUrl && !queue.length)
</script>

<template>
  <UiPanel pad="none" gap="sm">
    <template #toolbar>
      <div class="flex gap-1 items-center">
        <UiIconButton
          icon="i-carbon-shuffle"
          :label="queue.shuffle ? 'Shuffle on' : 'Shuffle off'"
          kbd="Shift S"
          :active="queue.shuffle"
          :class="queue.shuffle ? 'text-accent-300' : ''"
          @click="playback.toggleShuffle()"
        />
        <UiIconButton
          :icon="queue.repeatMode === 'one' ? 'i-carbon-repeat-one' : 'i-carbon-repeat'"
          :label="repeatLabel"
          kbd="Shift R"
          :active="queue.repeatMode !== 'off'"
          :class="queue.repeatMode !== 'off' ? 'text-accent-300' : ''"
          @click="playback.cycleRepeat()"
        />
        <span class="text-[11.5px] text-fg-faint num ml-2 flex-1 truncate">
          <template v-if="queue.upcoming.length">
            {{ queue.upcoming.length.toLocaleString() }} up next<template v-if="remaining > 0"> · {{ formatTotal(remaining) }}</template>
          </template>
        </span>
        <UiIconButton icon="i-carbon-video-chat" label="Open library" @click="ui.openView('library')" />
        <UiIconButton
          icon="i-carbon-clean"
          label="Clear up next"
          :disabled="!queue.upcoming.length"
          @click="clearUpcoming"
        />
        <UiPopover placement="bottom" align="end" flush>
          <template #trigger="{ toggle, open }">
            <UiIconButton icon="i-carbon-overflow-menu-vertical" label="More" :active="open" @click="toggle" />
          </template>
          <template #default="{ close }">
            <div class="p-1">
              <UiMenu :items="moreMenu" @done="close" />
            </div>
          </template>
        </UiPopover>
      </div>
    </template>

    <!-- Nothing at all -->
    <UiEmpty
      v-if="empty"
      icon="i-carbon-list-boxes"
      title="The queue is empty"
      description="Play something from the library or a playlist and the rest of that list lines up here. Right-click any video to play it next or add it to the queue."
    >
      <UiButton variant="primary" icon="i-carbon-video-chat" @click="ui.openView('library')">
        Browse library
      </UiButton>
    </UiEmpty>

    <template v-else>
      <!-- Director -->
      <Transition name="t-collapse">
        <div v-if="director.enabled.value">
          <div class="min-h-0 overflow-hidden">
            <div class="mx-3 mt-3 px-3 py-2.5 border border-info/25 rounded-[var(--radius-md)] bg-info/10 flex gap-2.5 items-start">
              <span class="i-carbon-bot text-[16px] text-info mt-0.5 shrink-0" />
              <div class="text-[12px] text-fg-muted leading-snug flex-1">
                <span class="text-fg font-medium">The director picks what plays next</span>, matching script intensity to the session.
                The queue below is used when it has nothing analysed to offer.
              </div>
              <UiButton variant="ghost" size="xs" @click="ui.openInspector('director')">
                Open
              </UiButton>
            </div>
          </div>
        </div>
      </Transition>

      <!-- Now playing -->
      <section class="px-3 pt-3">
        <div class="eyebrow mb-2 px-0.5">
          Now playing
        </div>
        <div
          :key="playback.trackSeq"
          class="p-2.5 card flex gap-3 animate-rise items-center"
          @contextmenu.prevent="queue.currentItem && openItemMenu($event, queue.currentItem, 'current')"
        >
          <div class="rounded-[var(--radius-sm)] bg-surface-800 shrink-0 h-[54px] w-24 relative overflow-hidden">
            <img v-if="nowEntry?.thumbnailUrl" :src="nowEntry.thumbnailUrl" alt="" class="h-full w-full animate-fade-in object-cover">
            <div v-else-if="nowEntry" class="skeleton inset-0 absolute" />
            <div v-else class="text-fg-faint center inset-0 absolute">
              <span class="i-carbon-video text-[18px]" />
            </div>
            <div class="now-eq px-1 rounded-[var(--radius-xs)] flex h-4 items-center bottom-1 left-1 absolute">
              <span class="eq text-white" :class="player.isPlaying ? '' : 'paused'"><i /><i /><i /></span>
            </div>
          </div>
          <div class="flex-1 min-w-0">
            <p class="text-[13px] text-fg leading-snug font-medium truncate" :title="nowTitle">
              {{ nowTitle || 'Nothing loaded' }}
            </p>
            <p class="text-[11.5px] text-fg-faint mt-0.5 truncate">
              <template v-if="queue.sourceLabel">
                Playing from <span class="text-fg-muted">{{ queue.sourceLabel }}</span>
              </template>
              <template v-else-if="nowEntry && nowEntry.scriptType !== 'none'">
                {{ scriptBadge(nowEntry).long }}
              </template>
              <template v-else>
                Single video
              </template>
            </p>
            <div class="mt-2 flex gap-2 items-center">
              <div class="rounded-full bg-surface-700 flex-1 h-1 overflow-hidden">
                <div class="rounded-full bg-accent h-full transition-[width] duration-300 ease-linear" :style="{ width: `${progress * 100}%` }" />
              </div>
              <span class="text-[10.5px] text-fg-faint num shrink-0">
                {{ formatTime(player.currentTime) }} / {{ formatTime(player.videoDuration) }}
              </span>
            </div>
          </div>
        </div>
      </section>

      <!-- Up next -->
      <section class="px-3 pt-4">
        <div class="mb-1 px-0.5 flex h-6 items-center justify-between">
          <span class="eyebrow">Up next</span>
          <span v-if="queue.repeatMode === 'all' && !queue.upcoming.length && queue.length" class="hint">Repeats from the start</span>
        </div>

        <p v-if="!queue.upcoming.length" class="text-[12px] text-fg-faint px-0.5 py-3">
          Nothing queued after this one.
          <template v-if="queue.repeatMode === 'one'">
            It will repeat.
          </template>
        </p>

        <TransitionGroup v-else name="t-list" tag="div" class="flex flex-col relative">
          <div
            v-for="(item, i) in shownUpcoming"
            :key="item.uid"
            class="q-row group focusable"
            :class="{ 'is-dragging': dragFrom === i }"
            tabindex="0"
            role="button"
            draggable="true"
            @click="jump(item)"
            @keydown.enter="jump(item)"
            @contextmenu.prevent="openItemMenu($event, item, i)"
            @dragstart="onDragStart($event, i)"
            @dragenter.prevent="onDragEnter(i)"
            @dragover.prevent
            @dragend="onDragEnd"
            @drop.prevent="onDragEnd"
          >
            <span class="i-carbon-draggable text-[13px] text-fg-faint opacity-0 shrink-0 cursor-grab transition-opacity group-hover:opacity-100" />
            <span v-lazy-thumb="item.entry" class="rounded-[var(--radius-xs)] bg-surface-800 shrink-0 h-8 w-14 relative overflow-hidden">
              <img v-if="item.entry.thumbnailUrl" :src="item.entry.thumbnailUrl" alt="" class="h-full w-full animate-fade-in object-cover" draggable="false">
              <span class="play-hover text-white opacity-0 center transition-opacity inset-0 absolute group-hover:opacity-100">
                <span class="i-carbon-play-filled-alt text-[14px]" />
              </span>
            </span>
            <span class="flex-1 min-w-0">
              <span class="text-[12.5px] text-fg leading-tight block truncate" :title="item.entry.name">{{ item.entry.basename }}</span>
              <span class="text-[11px] text-fg-faint mt-0.5 flex gap-1.5 items-center">
                <span v-if="item.manual" v-tip="'Added by you'" class="text-accent-300 flex gap-0.5 items-center">
                  <span class="i-carbon-user text-[11px]" />Queued
                </span>
                <span v-if="item.entry.duration" class="num">{{ formatTime(item.entry.duration) }}</span>
                <span v-if="item.entry.scriptType === 'none'">· no script</span>
              </span>
            </span>
            <UiIconButton
              icon="i-carbon-close"
              label="Remove"
              size="xs"
              class="opacity-0 shrink-0 group-focus-within:opacity-100 group-hover:opacity-100"
              @click.stop="queue.remove(item.uid)"
            />
          </div>
        </TransitionGroup>

        <UiButton
          v-if="hiddenCount"
          variant="ghost"
          size="xs"
          block
          class="mt-1"
          @click="limit += PAGE * 5"
        >
          Show {{ Math.min(hiddenCount, PAGE * 5).toLocaleString() }} more of {{ hiddenCount.toLocaleString() }}
        </UiButton>
      </section>

      <!-- History -->
      <section v-if="queue.history.length" class="px-3 pb-4 pt-3">
        <button
          type="button"
          class="px-0.5 focusable rounded-[var(--radius-sm)] hoverable flex gap-1.5 h-7 w-full items-center"
          :aria-expanded="historyOpen"
          @click="historyOpen = !historyOpen"
        >
          <span class="i-carbon-chevron-right text-[12px] text-fg-faint transition-transform duration-200" :class="historyOpen ? 'rotate-90' : ''" />
          <span class="eyebrow">History</span>
          <span class="text-[11px] text-fg-faint num">{{ queue.history.length }}</span>
          <span class="flex-1" />
          <UiButton v-if="historyOpen" variant="ghost" size="xs" @click.stop="clearHistory">
            Clear
          </UiButton>
        </button>
        <Transition name="t-collapse">
          <div v-if="historyOpen">
            <div class="min-h-0 overflow-hidden">
              <TransitionGroup name="t-list" tag="div" class="pt-1 flex flex-col relative">
                <div
                  v-for="item in historyItems.slice(0, 200)"
                  :key="item.uid"
                  class="q-row is-history group focusable"
                  tabindex="0"
                  role="button"
                  @click="jump(item)"
                  @keydown.enter="jump(item)"
                  @contextmenu.prevent="openItemMenu($event, item, 'history')"
                >
                  <span v-lazy-thumb="item.entry" class="rounded-[var(--radius-xs)] bg-surface-800 shrink-0 h-8 w-14 relative overflow-hidden">
                    <img v-if="item.entry.thumbnailUrl" :src="item.entry.thumbnailUrl" alt="" class="h-full w-full object-cover" draggable="false">
                    <span class="play-hover text-white opacity-0 center transition-opacity inset-0 absolute group-hover:opacity-100">
                      <span class="i-carbon-restart text-[14px]" />
                    </span>
                  </span>
                  <span class="text-[12.5px] text-fg-muted flex-1 min-w-0 truncate">{{ item.entry.basename }}</span>
                  <span v-if="item.entry.duration" class="text-[11px] text-fg-faint num shrink-0">{{ formatTime(item.entry.duration) }}</span>
                </div>
              </TransitionGroup>
            </div>
          </div>
        </Transition>
      </section>
    </template>

    <UiContextMenu v-model="ctx" />
  </UiPanel>
</template>

<style scoped>
.q-row {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 46px;
  padding: 0 6px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition:
    background-color var(--dur-fast),
    opacity var(--dur-fast);
}
.q-row:hover {
  background: color-mix(in srgb, var(--text) 5%, transparent);
}
.q-row.is-history {
  opacity: 0.75;
}
.q-row.is-history:hover {
  opacity: 1;
}
.q-row.is-dragging {
  opacity: 0.35;
}
/* Over a thumbnail, so white on a dark scrim in every theme. */
.play-hover {
  background: rgba(0, 0, 0, 0.45);
}
.now-eq {
  background: rgba(0, 0, 0, 0.6);
}

.eq {
  display: inline-flex;
  align-items: flex-end;
  gap: 2px;
  height: 9px;
}
.eq i {
  display: block;
  width: 2px;
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
