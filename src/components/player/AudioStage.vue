<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import AudioSlideshow from '~/components/player/AudioSlideshow.vue'
import HypnoOverlay from '~/components/player/HypnoOverlay.vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiEmpty from '~/components/ui/UiEmpty.vue'
import SlideshowStage from '~/components/views/SlideshowStage.vue'
import WallStage from '~/components/views/WallStage.vue'
import { useAudioVisual } from '~/composables/useAudioVisual'
import { fileSource, findCover } from '~/lib/audioCover'
import { effectiveMeta } from '~/lib/entryInfo'
import { ensureThumb } from '~/lib/thumbs'
import { useHypnoStore } from '~/stores/hypnoStore'
import { useMediaWallStore } from '~/stores/mediaWall'
import { usePlaybackStore } from '~/stores/playbackStore'
import { usePlayerStore } from '~/stores/playerStore'
import { useSessionControlStore } from '~/stores/sessionControlStore'
import { useSlideshowStore } from '~/stores/slideshow'
import { useUiStore } from '~/stores/uiStore'

/**
 * What the stage shows while an audio file plays, in place of a picture: the
 * slideshow or the media wall as they are set up, the hypno overlay, or the
 * track's cover. The choice is made from the player's title bar and kept.
 *
 * Drawn in the player's overlay layer, so subtitles sit over it as captions
 * and it comes along into fullscreen and the pop-out. Nothing here makes a
 * sound or takes a click: clicks fall through to the player.
 *
 * `compact` is the mini player: just the cover, nothing that runs.
 */
const props = defineProps<{ compact?: boolean }>()

const visual = useAudioVisual()
const player = usePlayerStore()
const playback = usePlaybackStore()
const ui = useUiStore()
const hypno = useHypnoStore()
const control = useSessionControlStore()
const slideshow = useSlideshowStore()
const wall = useMediaWallStore()

const entry = computed(() => playback.currentEntry)
watch(entry, e => e && void ensureThumb(e).catch(() => {}), { immediate: true })

const title = computed(() => entry.value?.basename ?? player.videoPath?.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') ?? '')
const creator = computed(() => (entry.value ? effectiveMeta(entry.value).creator : undefined))
const cover = computed(() => entry.value?.thumbnailUrl ?? null)

const shown = computed(() => (props.compact ? 'cover' : visual.value))

/**
 * The embedded cover at full size for the big Cover view (the library's
 * thumbnail is small); the thumbnail, or the script tile, when there is none.
 */
const art = ref<string | null>(null)
let artSeq = 0
watch(() => [shown.value === 'cover' && !props.compact, playback.currentFile] as const, async ([want, file]) => {
  const seq = ++artSeq
  if (art.value)
    URL.revokeObjectURL(art.value)
  art.value = null
  if (!want || !file)
    return
  const found = await findCover(fileSource(file))
  if (found && seq === artSeq)
    art.value = URL.createObjectURL(new Blob([found.data as BlobPart], { type: found.mime }))
}, { immediate: true })
onBeforeUnmount(() => {
  artSeq++
  if (art.value)
    URL.revokeObjectURL(art.value)
})
/**
 * The Slideshow view runs the slideshow itself while it is open (here, that
 * is only the pop-out): show the same slide without a second clock on it.
 */
const slideshowElsewhere = computed(() => ui.view === 'slideshow')
const passiveSlide = computed(() => slideshow.items[slideshow.currentIndex.value])

/** Things that stimulate fade back with an edge, as the hypno layer does. */
const fade = computed(() => ({ opacity: 1 - control.holdBack }))

function showCover() {
  visual.value = 'cover'
}
</script>

<template>
  <div class="audio-stage bg-black inset-0 absolute overflow-hidden">
    <!-- Slideshow -->
    <template v-if="shown === 'slideshow'">
      <div v-if="slideshow.items.length" class="inset-0 absolute" :style="fade">
        <AudioSlideshow v-if="!slideshowElsewhere" />
        <div v-else class="inset-0 absolute isolate">
          <SlideshowStage :item="passiveSlide" transition="fade" :overlays="slideshow.overlays.filter(o => o.enabled)" />
        </div>
      </div>
      <div v-else class="p-6 center inset-0 absolute">
        <div class="rounded-[var(--radius-xl)] bg-surface-900 ring-1 ring-edge shadow-[var(--shadow-lg)] empty-card">
          <UiEmpty
            icon="i-carbon-image"
            title="The slideshow is empty"
            description="Add pictures or clips to the slideshow and they play here while the track does. Slides added from your disk stay until playhound closes."
          >
            <UiButton variant="primary" icon="i-carbon-add" @click="ui.openView('slideshow')">
              Set up the slideshow
            </UiButton>
            <UiButton variant="ghost" icon="i-carbon-music" @click="showCover">
              Show the cover
            </UiButton>
          </UiEmpty>
        </div>
      </div>
    </template>

    <!-- Media wall -->
    <template v-else-if="shown === 'wall'">
      <div v-if="wall.items.value.length" class="inset-0 absolute" :style="fade">
        <WallStage :items="wall.items.value" />
      </div>
      <div v-else class="p-6 center inset-0 absolute">
        <div class="rounded-[var(--radius-xl)] bg-surface-900 ring-1 ring-edge shadow-[var(--shadow-lg)] empty-card">
          <UiEmpty
            icon="i-carbon-image-copy"
            title="The media wall is empty"
            description="Put pictures, clips or YouTube videos on the wall and they show here, muted, while the track plays."
          >
            <UiButton variant="primary" icon="i-carbon-add" @click="ui.openView('wall')">
              Set up the wall
            </UiButton>
            <UiButton variant="ghost" icon="i-carbon-music" @click="showCover">
              Show the cover
            </UiButton>
          </UiEmpty>
        </div>
      </div>
    </template>

    <!-- Hypno: the shell already draws it when it is switched on. -->
    <div v-else-if="shown === 'hypno'" class="inset-0 absolute" :style="fade">
      <HypnoOverlay v-if="!hypno.enabled" />
    </div>

    <!-- Cover -->
    <template v-else>
      <img v-if="art || cover" :src="art || cover!" alt="" class="backdrop h-full w-full inset-0 absolute object-cover" draggable="false">
      <div v-if="compact" class="center inset-0 absolute">
        <img v-if="cover" :src="cover" alt="" class="h-full w-full object-contain" draggable="false">
        <span v-else class="i-carbon-music text-[28px] text-white/40" />
      </div>
      <div v-else class="px-8 flex flex-col gap-5 items-center inset-0 justify-center absolute">
        <img
          v-if="art"
          :src="art"
          alt=""
          class="art rounded-[var(--radius-lg)] ring-1 ring-white/10 shadow-[var(--shadow-lg)] object-contain"
          draggable="false"
        >
        <div v-else class="cover-box rounded-[var(--radius-lg)] bg-white/6 center ring-1 ring-white/10 shadow-[var(--shadow-lg)] overflow-hidden">
          <img v-if="cover" :src="cover" alt="" class="h-full w-full object-contain" draggable="false">
          <span v-else class="i-carbon-music text-[48px] text-white/35" />
        </div>
        <div class="text-center max-w-[min(640px,90%)]">
          <p class="text-[20px] text-white tracking-[-0.01em] font-semibold truncate drop-shadow">
            {{ title }}
          </p>
          <p v-if="creator" class="text-[13px] text-white/60 mt-1 truncate">
            {{ creator }}
          </p>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* Clicks go through to the player, except on an empty state's buttons. */
.audio-stage {
  pointer-events: none;
}
.empty-card {
  pointer-events: auto;
  max-width: 460px;
}
.backdrop {
  filter: blur(40px) brightness(0.45) saturate(1.2);
  transform: scale(1.15);
}
.cover-box {
  width: min(56vh, 70%);
  aspect-ratio: 16 / 9;
}
.art {
  max-width: min(70%, 640px);
  max-height: 56%;
}
</style>
