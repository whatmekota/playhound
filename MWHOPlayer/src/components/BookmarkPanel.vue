<script setup lang="ts">
import { computed, ref } from 'vue'
import { useBookmarkStore } from '@/stores/bookmarkStore'
import { usePlayerStore } from '@/stores/playerStore'

const bookmarkStore = useBookmarkStore()
const playerStore = usePlayerStore()

const emit = defineEmits<{ seek: [time: number] }>()

const currentVideo = computed(() => playerStore.videoPath?.split(/[\\/]/).pop() ?? null)
const bms = computed(() => currentVideo.value ? bookmarkStore.forVideo(currentVideo.value) : [])

const editingId = ref<string | null>(null)
const editLabel = ref('')

function startEdit(id: string, label: string) {
  editingId.value = id
  editLabel.value = label
}

function commitEdit(id: string) {
  if (editLabel.value.trim()) bookmarkStore.rename(id, editLabel.value.trim())
  editingId.value = null
}

function formatTime(s: number) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60)
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
  return `${m}:${String(sec).padStart(2,'0')}`
}
</script>

<template>
  <div class="flex flex-col h-full overflow-hidden">
    <div class="flex items-center justify-between px-4 py-3 border-b border-white/5 shrink-0">
      <h2 class="text-sm font-semibold text-white/80">Bookmarks</h2>
      <span class="text-[10px] text-white/30">B to add at current time</span>
    </div>

    <div v-if="!currentVideo" class="text-xs text-white/30 text-center py-8">No video loaded</div>
    <div v-else-if="bms.length === 0" class="text-xs text-white/30 text-center py-8">
      No bookmarks yet.<br>Press <kbd class="bg-white/10 px-1 rounded">B</kbd> to add one.
    </div>

    <div class="flex-1 overflow-y-auto">
      <div
        v-for="bm in bms" :key="bm.id"
        class="flex items-center gap-2 px-4 py-2 border-b border-white/5 hover:bg-white/5 group transition-colors cursor-pointer"
        @click="emit('seek', bm.time)"
      >
        <!-- Time badge -->
        <span class="text-[10px] font-mono text-amber-400 bg-amber-500/15 px-2 py-0.5 rounded shrink-0">
          {{ formatTime(bm.time) }}
        </span>

        <!-- Label (editable) -->
        <input
          v-if="editingId === bm.id"
          v-model="editLabel"
          class="flex-1 bg-white/10 text-xs text-white px-2 py-0.5 rounded outline-none border border-accent-500/50"
          @click.stop
          @keydown.enter="commitEdit(bm.id)"
          @keydown.escape="editingId = null"
          @blur="commitEdit(bm.id)"
          autofocus
        />
        <span v-else class="flex-1 text-xs text-white/70 truncate">{{ bm.label }}</span>

        <!-- Actions -->
        <div class="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
          <button class="btn-ghost px-1 py-0.5 text-[10px] text-white/40 hover:text-white"
            @click.stop="startEdit(bm.id, bm.label)">✏️</button>
          <button class="btn-ghost px-1 py-0.5 text-[10px] text-white/40 hover:text-red-400"
            @click.stop="bookmarkStore.remove(bm.id)">✕</button>
        </div>
      </div>
    </div>
  </div>
</template>
