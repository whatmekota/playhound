<script setup lang="ts">
/**
 * Play / pause glyph that morphs between the two shapes.
 *
 * The triangle is cut into two quads that line up with the pause bars, so
 * each half can tween its outline into a bar. Chromium animates the CSS `d`
 * property; elsewhere the attribute swaps instantly, which still reads fine.
 */
defineProps<{ playing: boolean }>()

const PLAY_L = 'M7 4 L12.5 7.67 L12.5 16.33 L7 20 Z'
const PLAY_R = 'M12.5 7.67 L19 12 L19 12 L12.5 16.33 Z'
const PAUSE_L = 'M6 5 L10 5 L10 19 L6 19 Z'
const PAUSE_R = 'M14 5 L18 5 L18 19 L14 19 Z'
</script>

<template>
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" class="pp-icon" :class="{ 'is-playing': playing }">
    <path class="pp-l" :d="playing ? PAUSE_L : PLAY_L" />
    <path class="pp-r" :d="playing ? PAUSE_R : PLAY_R" />
  </svg>
</template>

<style scoped>
.pp-icon {
  width: 1em;
  height: 1em;
  display: block;
}
.pp-l,
.pp-r {
  transition: d var(--dur) var(--ease-out);
}
.pp-l {
  d: path('M7 4 L12.5 7.67 L12.5 16.33 L7 20 Z');
}
.pp-r {
  d: path('M12.5 7.67 L19 12 L19 12 L12.5 16.33 Z');
}
.is-playing .pp-l {
  d: path('M6 5 L10 5 L10 19 L6 19 Z');
}
.is-playing .pp-r {
  d: path('M14 5 L18 5 L18 19 L14 19 Z');
}
</style>
