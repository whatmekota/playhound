<script setup lang="ts">
import type { Directive } from 'vue'
import type { Bookmark } from '~/stores/bookmarkStore'
import { computed, ref } from 'vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiEmpty from '~/components/ui/UiEmpty.vue'
import UiIconButton from '~/components/ui/UiIconButton.vue'
import UiKbd from '~/components/ui/UiKbd.vue'
import UiPanel from '~/components/ui/UiPanel.vue'
import { toast } from '~/composables/useToast'
import { formatTime } from '~/lib/time'
import { useBookmarkStore } from '~/stores/bookmarkStore'
import { usePlaybackStore } from '~/stores/playbackStore'
import { usePlayerStore } from '~/stores/playerStore'
import { useUiStore } from '~/stores/uiStore'

const bookmarks = useBookmarkStore()
const player = usePlayerStore()
const playback = usePlaybackStore()
const ui = useUiStore()

/** Bookmarks are keyed by file name, the same key the B shortcut uses. */
const videoName = computed(() => player.videoPath?.split(/[\\/]/).pop() ?? null)
const title = computed(() => playback.currentEntry?.basename ?? videoName.value?.replace(/\.[^.]+$/, '') ?? '')
const list = computed(() => (videoName.value ? bookmarks.forVideo(videoName.value) : []))
const duration = computed(() => player.videoDuration)

/** The bookmark the playhead has most recently passed, so the list shows where you are. */
const hereId = computed(() => {
  let id: string | null = null
  for (const b of list.value) {
    if (b.time <= player.currentTime + 0.25)
      id = b.id
  }
  return id
})

// ─── Edit ─────────────────────────────────────────────────────────────────────
const editingId = ref<string | null>(null)
const editLabel = ref('')
const vFocus: Directive<HTMLInputElement> = {
  mounted: (el) => {
    el.focus()
    el.select()
  },
}

function startEdit(b: Bookmark) {
  editingId.value = b.id
  editLabel.value = b.label
}

function commitEdit() {
  const id = editingId.value
  if (!id)
    return
  if (editLabel.value.trim())
    bookmarks.rename(id, editLabel.value.trim())
  editingId.value = null
}

function addHere() {
  if (!videoName.value)
    return
  const b = bookmarks.add(videoName.value, player.currentTime)
  // From the button there is time to name it; the B key stays instant.
  startEdit(b)
}

function remove(b: Bookmark) {
  bookmarks.remove(b.id)
  toast('Bookmark removed', {
    detail: `${formatTime(b.time)} · ${b.label}`,
    icon: 'i-carbon-bookmark',
    key: 'bookmark-remove',
    action: { label: 'Undo', run: () => bookmarks.add(b.videoName, b.time, b.label) },
  })
}

function seek(b: Bookmark) {
  playback.seek(b.time)
}

const pct = (t: number) => `${duration.value > 0 ? Math.min(100, (t / duration.value) * 100) : 0}%`
</script>

<template>
  <UiPanel pad="none">
    <template #toolbar>
      <div class="flex gap-2 items-center">
        <div class="flex-1 min-w-0">
          <p class="text-[12.5px] text-fg font-medium truncate" :title="title">
            {{ title || 'Nothing playing' }}
          </p>
          <p class="text-[11.5px] text-fg-faint num">
            {{ videoName ? `${list.length} bookmark${list.length === 1 ? '' : 's'}` : 'Open a video to bookmark it' }}
          </p>
        </div>
        <UiButton
          v-tip="{ text: 'Bookmark the current moment', kbd: 'B' }"
          variant="primary"
          icon="i-carbon-bookmark-add"
          :disabled="!videoName"
          @click="addHere"
        >
          Add <span class="num opacity-80">{{ formatTime(player.currentTime) }}</span>
        </UiButton>
      </div>

      <!-- Where they sit in the video -->
      <div v-if="videoName && duration > 0 && list.length" class="py-1.5 h-5 relative">
        <div class="rounded-full bg-surface-700 h-1 inset-x-0 top-1/2 absolute -translate-y-1/2" />
        <div class="rounded-full bg-fg/20 h-1 left-0 top-1/2 absolute -translate-y-1/2" :style="{ width: pct(player.currentTime) }" />
        <button
          v-for="b in list"
          :key="b.id"
          v-tip="`${formatTime(b.time)} · ${b.label}`"
          type="button"
          class="tick focusable rounded-full h-3 w-3 top-1/2 absolute"
          :class="b.id === hereId ? 'is-here' : ''"
          :style="{ left: pct(b.time) }"
          :aria-label="`Seek to ${b.label}`"
          @click="seek(b)"
        />
        <div class="rounded-full bg-fg h-3.5 w-0.5 pointer-events-none top-1/2 absolute -translate-y-1/2" :style="{ left: pct(player.currentTime) }" />
      </div>
    </template>

    <UiEmpty
      v-if="!videoName"
      icon="i-carbon-bookmark"
      title="No video loaded"
      description="Bookmarks belong to a video. Play one and mark the moments worth coming back to."
    >
      <UiButton icon="i-carbon-video-chat" @click="ui.openView('library')">
        Browse library
      </UiButton>
    </UiEmpty>

    <UiEmpty
      v-else-if="!list.length"
      icon="i-carbon-bookmark-add"
      title="No bookmarks yet"
    >
      <template #description>
        <p class="text-[12.5px] text-fg-muted leading-relaxed">
          Press <UiKbd>B</UiKbd> while watching to mark the moment, then click a bookmark to jump straight back to it.
        </p>
      </template>
    </UiEmpty>

    <TransitionGroup v-else name="t-list" tag="div" class="p-2 flex flex-col relative">
      <div
        v-for="b in list"
        :key="b.id"
        class="bm-row group focusable"
        :class="b.id === hereId ? 'is-here' : ''"
        tabindex="0"
        role="button"
        @click="editingId !== b.id && seek(b)"
        @keydown.enter="editingId !== b.id && seek(b)"
      >
        <span class="time num">{{ formatTime(b.time) }}</span>
        <input
          v-if="editingId === b.id"
          v-model="editLabel"
          v-focus
          class="text-[12.5px] text-fg px-2 outline-none border border-accent/60 rounded-[var(--radius-xs)] bg-surface-900 flex-1 h-6 min-w-0 ring-2 ring-accent-soft"
          aria-label="Bookmark name"
          @click.stop
          @keydown.enter.stop="commitEdit"
          @keydown.esc.stop="editingId = null"
          @blur="commitEdit"
        >
        <span v-else class="text-[12.5px] text-fg flex-1 min-w-0 truncate" @dblclick.stop="startEdit(b)">{{ b.label }}</span>
        <span v-if="editingId !== b.id" class="opacity-0 flex shrink-0 gap-0.5 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          <UiIconButton icon="i-carbon-edit" label="Rename" size="xs" @click.stop="startEdit(b)" />
          <UiIconButton icon="i-carbon-trash-can" label="Delete" size="xs" @click.stop="remove(b)" />
        </span>
      </div>
    </TransitionGroup>
  </UiPanel>
</template>

<style scoped>
.bm-row {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 38px;
  padding: 0 6px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background-color var(--dur-fast);
}
.bm-row:hover {
  background: color-mix(in srgb, var(--text) 5%, transparent);
}
.bm-row .time {
  flex-shrink: 0;
  min-width: 52px;
  padding: 2px 6px;
  border-radius: var(--radius-xs);
  font-size: 11.5px;
  text-align: center;
  color: var(--warn);
  background: color-mix(in srgb, var(--warn) 13%, transparent);
}
.bm-row.is-here {
  background: var(--accent-soft);
}
.bm-row.is-here .time {
  color: var(--accent-contrast);
  background: var(--accent);
}
.tick {
  transform: translate(-50%, -50%);
  background: var(--warn);
  box-shadow: 0 0 0 2px var(--bg-900);
  transition: transform var(--dur-fast) var(--ease-out);
}
.tick:hover {
  transform: translate(-50%, -50%) scale(1.35);
}
.tick.is-here {
  background: var(--accent);
}
</style>
