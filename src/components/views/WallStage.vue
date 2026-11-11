<script setup lang="ts">
import type { WallItem } from '~/stores/mediaWall'
import { useElementSize } from '@vueuse/core'
import { computed, ref } from 'vue'
import { vReleaseMedia } from '~/lib/releaseMedia'

/**
 * The media wall as it is laid out, to look at rather than arrange: behind an
 * audio file on the player. Every tile is muted whatever its own setting, so
 * the track is the only thing heard. Scaled to fit when the box is not the
 * size the wall was laid out at (the pop-out, a smaller window).
 */
const props = defineProps<{ items: WallItem[] }>()

const box = ref<HTMLElement | null>(null)
const { width, height } = useElementSize(box)

const extent = computed(() => ({
  w: Math.max(1, ...props.items.map(i => i.x + i.width)) + 8,
  h: Math.max(1, ...props.items.map(i => i.y + i.height)) + 8,
}))

const frame = computed(() => {
  const { w, h } = extent.value
  const s = width.value && height.value ? Math.min(1.25, width.value / w, height.value / h) : 1
  return {
    width: `${w}px`,
    height: `${h}px`,
    transform: `translate(${(width.value - w * s) / 2}px, ${(height.value - h * s) / 2}px) scale(${s})`,
  }
})

const sorted = computed(() => [...props.items].sort((a, b) => a.zIndex - b.zIndex))

function ytUrl(id: string) {
  return `https://www.youtube.com/embed/${id}?autoplay=1&mute=1&loop=1&playlist=${id}&controls=0&modestbranding=1&playsinline=1&rel=0`
}

function onMeta(e: Event, item: WallItem) {
  ;(e.target as HTMLVideoElement).playbackRate = item.playbackRate
}
</script>

<template>
  <div ref="box" class="inset-0 absolute overflow-hidden">
    <div class="origin-top-left left-0 top-0 absolute" :style="frame">
      <div
        v-for="item in sorted"
        :key="item.id"
        class="rounded-[var(--radius-md)] bg-black ring-1 ring-black/40 shadow-[var(--shadow-md)] absolute overflow-hidden"
        :style="{ left: `${item.x}px`, top: `${item.y}px`, width: `${item.width}px`, height: `${item.height}px` }"
      >
        <img
          v-if="item.type === 'image'"
          :src="item.src"
          :alt="item.label"
          class="h-full w-full block object-cover"
          :style="{ opacity: item.opacity }"
          draggable="false"
        >
        <video
          v-else-if="item.type === 'video'"
          v-release-media
          :src="item.src"
          muted
          loop
          autoplay
          playsinline
          class="h-full w-full block object-cover"
          :style="{ opacity: item.opacity }"
          @loadedmetadata="onMeta($event, item)"
        />
        <iframe
          v-else
          :src="ytUrl(item.src)"
          :title="item.label"
          class="border-0 h-full w-full block pointer-events-none"
          :style="{ opacity: item.opacity }"
          allow="autoplay; encrypted-media"
          referrerpolicy="strict-origin-when-cross-origin"
        />
      </div>
    </div>
  </div>
</template>
