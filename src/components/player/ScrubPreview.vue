<script setup lang="ts">
import type { VideoEntry } from '~/stores/libraryStore'
import { computed, onBeforeUnmount, watch } from 'vue'
import { frameAt, frameStyle, getStrip, requestStrip } from '~/lib/previews'

/**
 * A frame from `entry` at `progress` (0..1), filling its parent like
 * object-fit: cover. Draws nothing until the entry's preview strip exists, and
 * asks for one (at low priority) while it is mounted — so mount it on hover,
 * not on every card.
 */
const props = defineProps<{
  entry: VideoEntry
  /** 0..1 through the video. */
  progress: number
}>()

const strip = computed(() => getStrip(props.entry))

const style = computed(() => {
  const s = strip.value
  if (!s)
    return null
  const p = Math.max(0, Math.min(1, props.progress))
  return frameStyle(s, frameAt(s, p * s.count * s.interval))
})

let release: (() => void) | null = null
watch(() => props.entry, (e) => {
  release?.()
  release = requestStrip(e, 'low')
}, { immediate: true })
onBeforeUnmount(() => release?.())
</script>

<template>
  <span class="sp-root pointer-events-none inset-0 absolute overflow-hidden" aria-hidden="true">
    <span v-if="style" class="sp-frame" :style="style" />
  </span>
</template>

<style scoped>
/* The sheet's frames are 16:9; cover whatever box the card gives us. */
.sp-root {
  container-type: size;
}
.sp-frame {
  position: absolute;
  left: 50%;
  top: 50%;
  width: max(100cqw, calc(100cqh * 16 / 9));
  height: max(100cqh, calc(100cqw * 9 / 16));
  transform: translate(-50%, -50%);
}
</style>
