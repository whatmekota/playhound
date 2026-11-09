<script setup lang="ts">
import type { StyleValue } from 'vue'
import type { SlideshowItem, SlideshowOverlay } from '~/stores/slideshow'
import { computed } from 'vue'

/**
 * The slideshow's picture: the current slide with its transition, the
 * overlays blended over it and the vignette. No controls and no clock; the
 * Slideshow view and the player (behind an audio file) each drive it.
 *
 * Layers use z 10–12, so the parent decides what sits above them.
 */
const props = defineProps<{
  item: SlideshowItem | undefined
  /** Vue <Transition> name; empty for a cut. */
  transition: string
  /** Applied to the slide's media (the motion LFO). */
  mediaStyle?: StyleValue
  overlays: SlideshowOverlay[]
  /** Multiplies every overlay's opacity (the LFO, when it reaches overlays). */
  overlayFade?: number
  /** 0–1 black over the slides, under the overlays. */
  dim?: number
}>()

const ytUrl = computed(() => {
  if (!props.item || props.item.type !== 'youtube')
    return ''
  const id = props.item.src
  return `https://www.youtube.com/embed/${id}?autoplay=1&mute=1&loop=1&playlist=${id}&controls=0&modestbranding=1&playsinline=1&rel=0`
})

function overlayStyle(o: SlideshowOverlay) {
  return {
    opacity: o.opacity * (props.overlayFade ?? 1),
    mixBlendMode: o.blendMode as any,
    objectFit: o.fit,
  }
}

function randomizeVideoStart(e: Event) {
  const video = e.target as HTMLVideoElement
  if (video.duration && Number.isFinite(video.duration))
    video.currentTime = Math.random() * video.duration
}
</script>

<template>
  <div class="inset-0 absolute">
    <!-- Slides -->
    <div class="inset-0 absolute overflow-hidden">
      <Transition :name="transition">
        <div
          v-if="item"
          :key="item.id"
          class="flex items-center inset-0 justify-center absolute"
        >
          <img
            v-if="item.type === 'image'"
            :src="item.src"
            :alt="item.label"
            :style="mediaStyle"
            :class="item.fit === 'cover' ? 'object-cover' : 'object-contain'"
            class="will-change-transform h-full w-full"
            draggable="false"
          >
          <video
            v-else-if="item.type === 'video'"
            :key="`${item.id}-v`"
            :src="item.src"
            :style="mediaStyle"
            :class="item.fit === 'cover' ? 'object-cover' : 'object-contain'"
            autoplay
            loop
            muted
            playsinline
            class="will-change-transform h-full w-full"
            @loadedmetadata="randomizeVideoStart"
          />
          <iframe
            v-else-if="item.type === 'youtube'"
            :src="ytUrl"
            :title="item.label"
            class="border-0 h-full w-full pointer-events-none"
            allow="autoplay; encrypted-media"
            referrerpolicy="strict-origin-when-cross-origin"
          />
        </div>
      </Transition>
    </div>

    <!-- Audio-reactive brightness -->
    <div
      class="bg-black pointer-events-none transition-opacity duration-500 inset-0 absolute z-10"
      :style="{ opacity: dim ?? 0 }"
    />

    <!-- Overlays -->
    <div v-for="overlay in overlays" :key="overlay.id" class="pointer-events-none inset-0 absolute z-[11]">
      <img
        v-if="overlay.type === 'image'"
        :src="overlay.src"
        class="h-full w-full"
        :style="overlayStyle(overlay)"
        draggable="false"
      >
      <video
        v-else
        :src="overlay.src"
        autoplay
        loop
        muted
        playsinline
        class="h-full w-full"
        :style="overlayStyle(overlay)"
        @loadedmetadata="randomizeVideoStart"
      />
    </div>

    <!-- Vignette -->
    <div v-if="item" class="vignette pointer-events-none inset-0 absolute z-[12]" />
  </div>
</template>

<style scoped>
.vignette {
  background: radial-gradient(ellipse at center, transparent 60%, rgb(0 0 0 / 0.45) 100%);
}

/* ── Slide transitions ── */

/* True crossfade: entering slide at full opacity underneath, leaving fades out on top */
.fade-leave-active {
  z-index: 1;
  transition: opacity 0.6s ease;
}
.fade-leave-to {
  opacity: 0;
}

.slide-enter-active,
.slide-leave-active {
  transition: transform 0.5s cubic-bezier(0.25, 0.46, 0.45, 0.94);
}
.slide-enter-from {
  transform: translateX(100%);
}
.slide-leave-to {
  transform: translateX(-100%);
}

.zoom-enter-active,
.zoom-leave-active {
  transition:
    opacity 0.5s ease,
    transform 0.5s ease;
}
.zoom-enter-from {
  opacity: 0;
  transform: scale(1.08);
}
.zoom-leave-to {
  opacity: 0;
  transform: scale(0.94);
}

.flip-enter-active,
.flip-leave-active {
  transition:
    transform 0.55s ease,
    opacity 0.55s ease;
}
.flip-enter-from {
  transform: perspective(900px) rotateY(90deg);
  opacity: 0;
}
.flip-leave-to {
  transform: perspective(900px) rotateY(-90deg);
  opacity: 0;
}

.blur-enter-active,
.blur-leave-active {
  transition:
    opacity 0.55s ease,
    filter 0.55s ease;
}
.blur-enter-from,
.blur-leave-to {
  opacity: 0;
  filter: blur(24px);
}

.wipe-enter-active,
.wipe-leave-active {
  transition: clip-path 0.6s cubic-bezier(0.25, 0.46, 0.45, 0.94);
}
.wipe-enter-from {
  clip-path: inset(0 100% 0 0);
}
.wipe-leave-to {
  clip-path: inset(0 0 0 100%);
}

.rotate-enter-active,
.rotate-leave-active {
  transition:
    opacity 0.5s ease,
    transform 0.5s ease;
}
.rotate-enter-from {
  opacity: 0;
  transform: rotate(-6deg) scale(0.88);
}
.rotate-leave-to {
  opacity: 0;
  transform: rotate(6deg) scale(0.88);
}
</style>
