<script setup lang="ts">
import { computed, watch } from 'vue'
import SlideshowStage from '~/components/views/SlideshowStage.vue'
import { useSlideshowEngine } from '~/composables/useSlideshowEngine'
import { analyseSoundtrack, isAnalysedGridReady } from '~/composables/useSoundtrack'
import { getBeatGrid } from '~/composables/useVideoBeat'
import { useAudioStore } from '~/stores/audio'
import { usePlaybackStore } from '~/stores/playbackStore'
import { usePlayerStore } from '~/stores/playerStore'
import { useSlideshowStore } from '~/stores/slideshow'

/**
 * The slideshow behind an audio file, with its own settings, running with
 * the track: it plays while the track plays and stops when it pauses. In
 * Beats mode it turns on the track's own beat once that is known (the track
 * is analysed for it, as the Music source does), and on the binaural beat
 * until then.
 */
const { items, settings, isPlaying, overlays } = useSlideshowStore()
const player = usePlayerStore()
const playback = usePlaybackStore()
const audioStore = useAudioStore()

const engine = useSlideshowEngine({ beats: () => getBeatGrid()?.beats ?? null })
const { currentItem, transitionName, mode } = engine
const lfoValues = engine.lfo.values
const lfoActive = engine.lfo.active

// The slideshow keeps time with the track.
watch(() => player.isPlaying && items.length > 0, (p) => {
  isPlaying.value = p
}, { immediate: true })

// Beats mode wants the track's beat: analyse it (once per file, cached), and
// re-time the slides the moment it is known.
watch(
  () => [mode.value === 'beat', player.isPlaying, playback.currentFile] as const,
  ([beat, playing, file]) => {
    if (beat && playing && file && !isAnalysedGridReady())
      void analyseSoundtrack(file, { durationHint: player.videoDuration })
  },
  { immediate: true },
)
watch(() => isAnalysedGridReady(), () => engine.reschedule())

const lfoStyle = computed(() => {
  if (!isPlaying.value)
    return {}
  return {
    transform: `scale(${lfoValues.zoom}) translate(${lfoValues.panX}px, ${lfoValues.panY}px)`,
    opacity: lfoValues.opacity,
    transition: 'none',
  }
})
const activeOverlays = computed(() => overlays.filter(o => o.enabled))
const overlayFade = computed(() => (isPlaying.value && lfoActive.value && settings.value.lfoOverlays) ? lfoValues.opacity : 1)
const dim = computed(() => audioStore.noiseEnabled.value ? audioStore.noiseVolume.value * 0.25 : 0)
</script>

<template>
  <div class="inset-0 absolute isolate">
    <SlideshowStage
      :item="currentItem"
      :transition="transitionName"
      :media-style="lfoStyle"
      :overlays="activeOverlays"
      :overlay-fade="overlayFade"
      :dim="dim"
    />
  </div>
</template>
