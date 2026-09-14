<script setup lang="ts">
import { computed, ref } from 'vue'
import { useBookmarkStore } from '~/stores/bookmarkStore'
import { usePlayerStore } from '~/stores/playerStore'

const emit = defineEmits<{ seek: [time: number] }>()
const bookmarkStore = useBookmarkStore()
const playerStore = usePlayerStore()

const currentVideo = computed(() => playerStore.videoPath?.split(/[\\/]/).pop() ?? null)
const bms = computed(() => currentVideo.value ? bookmarkStore.forVideo(currentVideo.value) : [])

const editingId = ref<string | null>(null)
const editLabel = ref('')

function startEdit(id: string, label: string) {
  editingId.value = id
  editLabel.value = label
}

function commitEdit(id: string) {
  if (editLabel.value.trim())
    bookmarkStore.rename(id, editLabel.value.trim())
  editingId.value = null
}

function formatTime(s: number) {
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const sec = Math.floor(s % 60)
  if (h > 0)
    return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  return `${m}:${String(sec).padStart(2, '0')}`
}
</script>

<template>
  <div class="flex flex-col h-full overflow-hidden">
    <div class="px-4 py-3 border-b border-white/5 flex shrink-0 items-center justify-between">
      <h2 class="text-sm text-white/80 font-semibold">
        Bookmarks
      </h2>
      <span class="text-[10px] text-white/30">B to add at current time</span>
    </div>

    <div v-if="!currentVideo" class="text-xs text-white/30 py-8 text-center">
      No video loaded
    </div>
    <div v-else-if="bms.length === 0" class="text-xs text-white/30 py-8 text-center">
      No bookmarks yet.<br>Press <kbd class="px-1 rounded bg-white/10">B</kbd> to add one.
    </div>

    <div class="flex-1 overflow-y-auto">
      <div
        v-for="bm in bms" :key="bm.id"
        class="group px-4 py-2 border-b border-white/5 flex gap-2 cursor-pointer transition-colors items-center hover:bg-white/5"
        @click="emit('seek', bm.time)"
      >
        <!-- Time badge -->
        <span class="text-[10px] text-amber-400 font-mono px-2 py-0.5 rounded bg-amber-500/15 shrink-0">
          {{ formatTime(bm.time) }}
        </span>

        <!-- Label (editable) -->
        <input
          v-if="editingId === bm.id"
          v-model="editLabel"
          class="text-xs text-white px-2 py-0.5 outline-none border border-accent-500/50 rounded bg-white/10 flex-1"
          autofocus
          @click.stop
          @keydown.enter="commitEdit(bm.id)"
          @keydown.escape="editingId = null"
          @blur="commitEdit(bm.id)"
        >
        <span v-else class="text-xs text-white/70 flex-1 truncate">{{ bm.label }}</span>

        <!-- Actions -->
        <div class="opacity-0 flex shrink-0 gap-1 transition-opacity group-hover:opacity-100">
          <button
            class="btn-ghost text-[10px] text-white/40 px-1 py-0.5 hover:text-white"
            @click.stop="startEdit(bm.id, bm.label)"
          >
            ✏️
          </button>
          <button
            class="btn-ghost text-[10px] text-white/40 px-1 py-0.5 hover:text-red-400"
            @click.stop="bookmarkStore.remove(bm.id)"
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
