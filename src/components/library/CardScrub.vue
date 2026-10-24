<script setup lang="ts">
import type { VideoEntry } from '~/stores/libraryStore'
import { onBeforeUnmount, ref } from 'vue'
import ScrubPreview from '~/components/player/ScrubPreview.vue'
import { formatTime } from '~/lib/time'

/**
 * Hover-scrub over a card's thumbnail: the pointer's position across the card
 * picks a moment in the video, shown by ScrubPreview, with a hairline for
 * where that is.
 *
 * Its own component so pointer moves re-render this layer only, not the grid.
 * The preview mounts after a short dwell, so sweeping the pointer across a
 * page of cards does not start a decode on every one of them.
 */
const props = defineProps<{ entry: VideoEntry }>()

const DWELL_MS = 140

const progress = ref(0)
const hovering = ref(false)
const showPreview = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined

function onMove(e: PointerEvent) {
  if (e.pointerType === 'touch')
    return
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  progress.value = r.width ? Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) : 0
  if (!hovering.value) {
    hovering.value = true
    clearTimeout(timer)
    timer = setTimeout(() => (showPreview.value = true), DWELL_MS)
  }
}

function onLeave() {
  clearTimeout(timer)
  hovering.value = false
  showPreview.value = false
}

onBeforeUnmount(() => clearTimeout(timer))
</script>

<template>
  <div class="scrub inset-0 absolute" :class="hovering ? 'is-on' : ''" @pointermove="onMove" @pointerleave="onLeave">
    <Transition name="t-fade">
      <div v-if="showPreview" class="inset-0 absolute overflow-hidden">
        <ScrubPreview :entry="props.entry" :progress="progress" />
      </div>
    </Transition>
    <div v-if="hovering" class="hair-track inset-x-0 bottom-0 absolute">
      <div class="hair" :style="{ transform: `scaleX(${progress})` }" />
    </div>
    <span
      v-if="showPreview && entry.duration"
      class="stamp text-[10.5px] text-white num px-1 rounded-[var(--radius-xs)] bottom-1.5 absolute"
      :style="{ left: `clamp(4px, calc(${progress * 100}% - 18px), calc(100% - 40px))` }"
    >{{ formatTime(progress * entry.duration) }}</span>
  </div>
</template>

<style scoped>
/* Over the picture: white on dark is right in every theme. */
.hair-track {
  height: 2px;
  background: rgba(255, 255, 255, 0.22);
}
.hair {
  height: 100%;
  background: var(--accent-light);
  transform-origin: left;
  box-shadow: 0 0 6px var(--accent);
}
.stamp {
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(6px);
  pointer-events: none;
}
</style>
