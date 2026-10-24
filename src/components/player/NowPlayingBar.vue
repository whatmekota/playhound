<script setup lang="ts">
import { useLocalStorage } from '@vueuse/core'
import { formatTime } from '~/lib/time'
import { usePlaybackStore } from '~/stores/playbackStore'
import { usePlayerStore } from '~/stores/playerStore'
import { useQueueStore } from '~/stores/queueStore'
import FunscriptTimeline from './FunscriptTimeline.vue'
import LoopControls from './LoopControls.vue'
import ScriptOffsetControl from './ScriptOffsetControl.vue'
import SpeedControl from './SpeedControl.vue'

const playerStore = usePlayerStore()
const queueStore = useQueueStore()
const playback = usePlaybackStore()
const showHeatmap = useLocalStorage('ph-timeline-heatmap', true)

function updateVolumeFill(e: Event) {
  const el = e.target as HTMLInputElement
  const pct = (Number.parseFloat(el.value) / Number.parseFloat(el.max)) * 100
  el.style.setProperty('--pct', `${pct}%`)
  playback.setVolume(Number.parseFloat(el.value))
}
</script>

<template>
  <div class="px-4 pb-2.5 pt-2 border-t border-edge bg-surface-900 flex shrink-0 flex-col gap-1.5">
    <FunscriptTimeline @seek="playback.seek" />

    <div class="flex gap-2 items-center">
      <div class="flex flex-1 gap-2 min-w-0 items-center">
        <span class="text-[11px] text-fg-muted font-mono shrink-0 tabular-nums">
          {{ formatTime(playerStore.currentTime, '0:00') }}
          <span class="text-fg-faint">/</span>
          {{ formatTime(playerStore.videoDuration, '0:00') }}
        </span>
        <div class="divider-x" />
        <button class="btn-icon shrink-0" title="Mute (M)" @click="playback.toggleMute()">
          <div :class="playerStore.isMuted ? 'i-carbon-volume-mute' : 'i-carbon-volume-up'" class="text-sm" />
        </button>
        <input
          type="range" min="0" max="1" step="0.01" :value="playerStore.volume"
          class="accent filled shrink-0 w-20" title="Volume" @input="updateVolumeFill"
        >
      </div>

      <div class="flex shrink-0 gap-1 items-center">
        <button class="btn-icon" title="Previous (P)" :disabled="!playerStore.videoUrl" @click="playback.prev()">
          <div class="i-carbon-skip-back text-sm" />
        </button>
        <button class="btn-icon" title="Back 5s (left arrow)" @click="playback.seekRelative(-5)">
          <div class="i-carbon-rewind-5 text-sm" />
        </button>
        <button
          class="text-white focusable rounded-full bg-accent-500 flex h-10 w-10 shadow-accent-500/20 shadow-lg transition items-center justify-center active:scale-95 hover:brightness-115"
          :title="playerStore.isPlaying ? 'Pause (space)' : 'Play (space)'"
          @click="playback.togglePlay()"
        >
          <div :class="playerStore.isPlaying ? 'i-carbon-pause-filled' : 'i-carbon-play-filled-alt'" class="text-base" />
        </button>
        <button class="btn-icon" title="Forward 5s (right arrow)" @click="playback.seekRelative(5)">
          <div class="i-carbon-forward-5 text-sm" />
        </button>
        <button class="btn-icon" title="Next (N)" :disabled="!queueStore.hasNext" @click="playback.next()">
          <div class="i-carbon-skip-forward text-sm" />
        </button>
      </div>

      <div class="flex flex-1 gap-1 min-w-0 items-center justify-end">
        <button
          class="btn-icon"
          :class="queueStore.shuffle ? 'text-accent-400 bg-accent-500/15' : ''"
          :title="queueStore.shuffle ? 'Shuffle on' : 'Shuffle off'"
          @click="playback.toggleShuffle()"
        >
          <div class="i-carbon-shuffle text-sm" />
        </button>
        <button
          class="btn-icon"
          :class="queueStore.repeatMode !== 'off' ? 'text-accent-400 bg-accent-500/15' : ''"
          :title="queueStore.repeatMode === 'off' ? 'Repeat off'
            : queueStore.repeatMode === 'all' ? 'Repeat all' : 'Repeat one'"
          @click="playback.cycleRepeat()"
        >
          <div :class="queueStore.repeatMode === 'one' ? 'i-carbon-repeat-one' : 'i-carbon-repeat'" class="text-sm" />
        </button>
        <div class="divider-x" />
        <LoopControls />
        <ScriptOffsetControl />
        <div class="divider-x" />
        <SpeedControl @speed="playback.setSpeed" />
        <div class="divider-x" />
        <button
          class="btn-ghost text-[11px] font-semibold px-2 py-1.5"
          :class="playerStore.sbs180 ? 'text-accent-400 bg-accent-500/15' : ''"
          title="180 degree side-by-side VR"
          @click="playerStore.toggleSbs()"
        >
          180&deg;
        </button>
        <button
          class="btn-icon"
          :class="showHeatmap ? 'text-accent-400' : ''"
          title="Script heatmap and shape on the timeline"
          @click="showHeatmap = !showHeatmap"
        >
          <div class="i-carbon-chart-histogram text-sm" />
        </button>
        <button class="btn-icon" title="Fullscreen (F)" @click="playback.toggleFullscreen()">
          <div class="i-carbon-fit-to-screen text-sm" />
        </button>
      </div>
    </div>
  </div>
</template>
