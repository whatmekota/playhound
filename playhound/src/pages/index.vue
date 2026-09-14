<script setup lang="ts">
import { useAudioStore } from '~/stores/audio'

defineOptions({ name: 'IndexPage' })

const { baseFrequency, beatDelta, waveType, volume, isPlaying, currentPreset } = useAudioStore()
const binaural = useBinauralBeats()
const activeTab = ref<'binaural' | 'wall' | 'slideshow'>('binaural')

const tabs = [
  { id: 'binaural' as const, label: '🎧 Binaural' },
  { id: 'wall' as const, label: '🖼 Media Wall' },
  { id: 'slideshow' as const, label: '▶ Slideshow' },
]

function toggleAudio() {
  if (isPlaying.value) {
    binaural.stop()
    isPlaying.value = false
  }
  else {
    binaural.start(baseFrequency.value, beatDelta.value, volume.value, waveType.value)
    isPlaying.value = true
  }
}

onUnmounted(() => {
  binaural.stop()
  isPlaying.value = false
})
</script>

<template>
  <div class="text-zinc-100 font-sans bg-zinc-950 flex flex-col h-screen overflow-hidden">
    <!-- Tab navigation -->
    <nav class="border-b border-zinc-800 bg-zinc-900/80 flex flex-shrink-0 items-center backdrop-blur-sm">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        class="text-sm font-medium px-5 py-3 transition-colors relative"
        :class="activeTab === tab.id
          ? 'text-teal-400'
          : 'text-zinc-500 hover:text-zinc-200'"
        @click="activeTab = tab.id"
      >
        {{ tab.label }}
        <div
          v-if="activeTab === tab.id"
          class="rounded-t bg-teal-400 h-0.5 bottom-0 left-0 right-0 absolute"
        />
      </button>
      <div class="ml-auto px-4 flex items-center">
        <button
          class="text-zinc-500 transition-colors hover:text-zinc-300"
          :title="isDark ? 'Light mode' : 'Dark mode'"
          @click="toggleDark()"
        >
          <div :class="isDark ? 'i-carbon-sun' : 'i-carbon-moon'" class="text-lg" />
        </button>
      </div>
    </nav>

    <!-- Main content -->
    <main class="flex-1 overflow-hidden">
      <BinauralBeats v-if="activeTab === 'binaural'" />
      <MediaWall v-else-if="activeTab === 'wall'" />
      <SlideshowView v-else-if="activeTab === 'slideshow'" />
    </main>

    <!-- Persistent audio status bar -->
    <footer class="px-4 border-t border-zinc-800 bg-zinc-900 flex flex-shrink-0 gap-3 h-11 items-center">
      <button
        class="text-xs rounded-full flex flex-shrink-0 h-7 w-7 transition-all items-center justify-center active:scale-90"
        :class="isPlaying
          ? 'bg-teal-600 hover:bg-teal-500 text-white'
          : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-400'"
        :title="isPlaying ? 'Stop binaural' : 'Play binaural'"
        @click="toggleAudio"
      >
        <div :class="isPlaying ? 'i-carbon-pause-filled' : 'i-carbon-play-filled'" />
      </button>

      <div class="text-xs flex gap-1.5 min-w-0 items-center">
        <span
          class="text-[10px] transition-colors"
          :class="isPlaying ? 'text-teal-400' : 'text-zinc-700'"
        >●</span>
        <span class="text-zinc-400">{{ baseFrequency }} Hz</span>
        <span class="text-zinc-700">·</span>
        <span class="text-zinc-400">Δ{{ beatDelta }} Hz</span>
        <span v-if="currentPreset" class="text-zinc-700">·</span>
        <span v-if="currentPreset" class="text-teal-500">{{ currentPreset }}</span>
      </div>

      <span class="text-[10px] text-zinc-700 ml-auto hidden sm:block">
        🎧 headphones required for binaural effect
      </span>
    </footer>
  </div>
</template>
