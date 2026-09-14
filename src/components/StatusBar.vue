<script setup lang="ts">
import { computed } from 'vue'
import { useBinauralBeats } from '~/composables/useBinauralBeats'
import { useAudioStore } from '~/stores/audio'
import { useDeviceStore } from '~/stores/deviceStore'
import { useMotionStore } from '~/stores/motionStore'

const audio = useAudioStore()
const motion = useMotionStore()
const device = useDeviceStore()
const binaural = useBinauralBeats()

function toggleAudio() {
  if (audio.isPlaying.value) {
    binaural.stop()
    audio.isPlaying.value = false
  }
  else {
    binaural.start(
      audio.baseFrequency.value,
      audio.beatDelta.value,
      audio.volume.value,
      audio.waveType.value,
    )
    audio.isPlaying.value = true
  }
}

/** Nine bars tracking the live stroke position. */
const meter = computed(() => {
  const pos = motion.currentPos
  return Array.from({ length: 9 }, (_, i) => {
    const d = Math.abs(i / 8 - pos)
    return Math.max(0.15, 1 - d * 2.2)
  })
})

const motionLabel = computed(() => {
  if (!motion.enabled)
    return 'off'
  if (motion.source === 'funscript')
    return 'script'
  return motion.source
})
</script>

<template>
  <footer class="text-[10px] px-3 border-t border-white/5 bg-surface-900 flex shrink-0 gap-3 h-8 items-center">
    <!-- Binaural -->
    <button
      class="rounded-full flex shrink-0 h-5 w-5 transition-colors items-center justify-center"
      :class="audio.isPlaying.value
        ? 'bg-teal-600 text-white hover:bg-teal-500'
        : 'bg-white/10 text-white/40 hover:bg-white/20'"
      :title="audio.isPlaying.value ? 'Stop binaural' : 'Play binaural'"
      @click="toggleAudio"
    >
      <div :class="audio.isPlaying.value ? 'i-carbon-pause-filled' : 'i-carbon-play-filled'" class="text-[9px]" />
    </button>

    <div class="text-white/40 font-mono flex gap-1.5 min-w-0 items-center">
      <span>{{ audio.baseFrequency.value }}Hz</span>
      <span class="text-white/15">·</span>
      <span>&#916;{{ audio.beatDelta.value.toFixed(1) }}</span>
      <template v-if="audio.phase.value !== 'idle'">
        <span class="text-white/15">·</span>
        <span class="text-teal-400">{{ audio.phase.value }}</span>
      </template>
    </div>

    <div class="bg-white/10 h-3.5 w-px" />

    <!-- Motion -->
    <div class="flex gap-2 min-w-0 items-center">
      <span class="text-white/30 tracking-wide uppercase">L0</span>
      <div class="flex gap-px h-3.5 w-12 items-end">
        <div
          v-for="(h, i) in meter"
          :key="i"
          class="rounded-sm flex-1 transition-all duration-75"
          :class="motion.running ? 'bg-emerald-400/80' : 'bg-white/10'"
          :style="{ height: `${h * 100}%` }"
        />
      </div>
      <span class="text-white/40 font-mono">
        {{ motion.running ? `${motion.currentSpm.toFixed(0)} spm` : '--' }}
      </span>
      <span
        class="px-1.5 py-0.5 rounded"
        :class="motion.running ? 'bg-emerald-600/20 text-emerald-300' : 'bg-white/5 text-white/30'"
      >{{ motionLabel }}</span>
    </div>

    <div class="ml-auto flex shrink-0 gap-2 items-center">
      <span
        class="rounded-full h-1.5 w-1.5"
        :class="device.connected ? 'bg-emerald-400' : 'bg-white/15'"
      />
      <span class="text-white/30">
        {{ device.connected ? 'device' : 'no device' }}
      </span>
      <span class="text-white/15 hidden sm:inline">headphones required for binaural</span>
    </div>
  </footer>
</template>
