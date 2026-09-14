<script setup lang="ts">
import { ref, computed } from 'vue'
import { usePlayerStore } from '~/stores/playerStore'
import { useLoopSection } from '~/composables/useLoopSection'

const playerStore = usePlayerStore()
const { setLoopStart, setLoopEnd, toggleLoop, clearLoop } = useLoopSection()

function formatTime(secs: number | null): string {
  if (secs === null) return '--:--'
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = Math.floor(secs % 60)
  if (h > 0) return `${h}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`
  return `${m}:${s.toString().padStart(2,'0')}`
}
</script>

<template>
  <div class="flex items-center gap-2">
    <!-- Set A -->
    <button
      class="btn-ghost text-xs px-2 py-1 rounded font-mono"
      :class="playerStore.loopStart !== null ? 'text-accent-400' : 'text-white/50'"
      title="Set loop start (A)"
      @click="setLoopStart()"
    >
      A:{{ formatTime(playerStore.loopStart) }}
    </button>

    <!-- Set B -->
    <button
      class="btn-ghost text-xs px-2 py-1 rounded font-mono"
      :class="playerStore.loopEnd !== null ? 'text-accent-400' : 'text-white/50'"
      title="Set loop end (B)"
      @click="setLoopEnd()"
    >
      B:{{ formatTime(playerStore.loopEnd) }}
    </button>

    <!-- Toggle loop -->
    <button
      class="btn-ghost text-xs px-2 py-1 rounded"
      :class="playerStore.loopActive ? 'text-accent-400 bg-accent-600/20' : 'text-white/40'"
      :disabled="!playerStore.hasLoop"
      title="Toggle loop"
      @click="toggleLoop()"
    >
      <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
          d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
      </svg>
    </button>

    <!-- Clear -->
    <button
      v-if="playerStore.hasLoop"
      class="btn-ghost text-xs text-red-400 hover:text-red-300 px-1.5 py-1 rounded"
      title="Clear loop"
      @click="clearLoop()"
    >
      <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
      </svg>
    </button>
  </div>
</template>
