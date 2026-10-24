<script setup lang="ts">
import type { VideoEntry } from '~/stores/libraryStore'

/**
 * A frame from `entry` at `progress` (0..1), filling its parent. Placeholder
 * until the preview strips land; renders nothing.
 */
defineProps<{
  entry: VideoEntry
  /** 0..1 through the video. */
  progress: number
}>()
</script>

<template>
  <span class="hidden" />
</template>
