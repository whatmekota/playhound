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

/** Bars tracking the live stroke position. */
const meter = computed(() => {
  const pos = motion.currentPos
  return Array.from({ length: 11 }, (_, i) => {
    const d = Math.abs(i / 10 - pos)
    return Math.max(0.18, 1 - d * 2.4)
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
  <footer class="text-[11px] px-3 border-t border-edge bg-surface-900 flex shrink-0 gap-3 h-9 items-center">
    <!-- ─── Binaural ─────────────────────────────────────────────────────── -->
    <button
      class="focusable rounded-md flex shrink-0 h-6 w-6 transition-colors items-center justify-center"
      :class="audio.isPlaying.value
        ? 'bg-teal-500/20 text-teal-300 hover:bg-teal-500/30'
        : 'text-fg-muted hover:bg-fg/10 hover:text-fg'"
      :title="audio.isPlaying.value ? 'Stop binaural tone' : 'Play binaural tone'"
      @click="toggleAudio"
    >
      <div :class="audio.isPlaying.value ? 'i-carbon-pause-filled' : 'i-carbon-play-filled'" class="text-[10px]" />
    </button>

    <div class="text-fg-muted font-mono flex gap-1.5 min-w-0 items-center">
      <span>{{ audio.baseFrequency.value }} Hz</span>
      <span class="text-fg-faint">&middot;</span>
      <span>&#916;{{ audio.beatDelta.value.toFixed(1) }}</span>
      <template v-if="audio.phase.value !== 'idle'">
        <span class="text-fg-faint">&middot;</span>
        <span class="text-teal-400 font-medium font-sans">{{ audio.phase.value }}</span>
      </template>
    </div>

    <div class="divider-x" />

    <!-- ─── Motion ───────────────────────────────────────────────────────── -->
    <div class="flex gap-2 min-w-0 items-center">
      <span class="text-fg-faint font-mono">L0</span>
      <div class="flex gap-px h-4 w-14 items-end" aria-hidden="true">
        <div
          v-for="(h, i) in meter"
          :key="i"
          class="rounded-[1px] flex-1 transition-all duration-75"
          :class="motion.running ? 'bg-emerald-400' : 'bg-fg/15'"
          :style="{ height: `${h * 100}%` }"
        />
      </div>
      <span class="text-fg-muted font-mono tabular-nums">
        {{ motion.running ? `${motion.currentSpm.toFixed(0)} spm` : '—' }}
      </span>
      <span
        class="font-medium px-1.5 py-0.5 rounded"
        :class="motion.running
          ? 'bg-emerald-500/15 text-emerald-300'
          : 'bg-fg/5 text-fg-faint'"
      >{{ motionLabel }}</span>
    </div>

    <!-- ─── Device ───────────────────────────────────────────────────────── -->
    <div class="ml-auto flex shrink-0 gap-2 items-center">
      <span class="text-fg-faint hidden lg:inline">Headphones required for the binaural effect</span>
      <div class="divider-x hidden lg:block" />
      <span
        class="rounded-full shrink-0 h-1.5 w-1.5"
        :class="device.connected ? 'bg-emerald-400' : 'bg-fg/25'"
      />
      <span :class="device.connected ? 'text-fg-muted' : 'text-fg-faint'">
        {{ device.connected ? 'Device connected' : 'No device' }}
      </span>
    </div>
  </footer>
</template>
