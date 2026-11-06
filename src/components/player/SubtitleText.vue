<script setup lang="ts">
import type { SubtitlePrefs } from '~/stores/subtitleStore'

/**
 * One subtitle cue over the picture, in the user's style.
 *
 * Sized from the picture rather than the window (container units), so it
 * reads the same in the player, fullscreen and the pop-out. White text with
 * a dark outline and a box behind it: the outline alone keeps it legible
 * over a bright frame even with the box switched off.
 */
withDefaults(defineProps<{
  /** Safe HTML from cueHtml(). */
  html: string
  prefs: Pick<SubtitlePrefs, 'size' | 'background' | 'raise'>
  /** Extra px above the bottom, to clear a control bar drawn over the picture. */
  lift?: number
  /** A fixed size, for the settings preview where the box is small. */
  preview?: boolean
}>(), { lift: 0 })
</script>

<template>
  <div
    class="sub-layer pointer-events-none inset-0 absolute"
    :class="preview ? 'sub-preview' : ''"
    :style="{
      '--sub-size': prefs.size,
      '--sub-bg': prefs.background,
      '--sub-raise': `${prefs.raise}%`,
      '--sub-lift': `${lift}px`,
    }"
    aria-live="off"
  >
    <div class="sub-line">
      <!-- Safe: cueHtml() keeps only <i>, <b> and <u> and escapes the rest. -->
      <span class="sub-text" v-html="html" />
    </div>
  </div>
</template>

<style scoped>
.sub-layer {
  container-type: size;
}
.sub-line {
  position: absolute;
  left: 6%;
  right: 6%;
  bottom: calc(5% + var(--sub-raise) + var(--sub-lift));
  text-align: center;
  transition: bottom var(--dur-slow) var(--ease-out);
}
.sub-text {
  /* Each line gets its own box, not one rectangle around the block. */
  -webkit-box-decoration-break: clone;
  box-decoration-break: clone;
  white-space: pre-line;
  font-size: max(11px, calc(min(4.4cqh, 2.6cqw) * var(--sub-size)));
  line-height: 1.34;
  font-weight: 600;
  color: #fff;
  background: rgba(0, 0, 0, var(--sub-bg));
  padding: 0.06em 0.38em;
  border-radius: 0.18em;
  text-shadow:
    0 0 2px #000,
    0 0 2px #000,
    0 1px 3px rgba(0, 0, 0, 0.9),
    0 0 8px rgba(0, 0, 0, 0.55);
}
.sub-preview .sub-text {
  font-size: calc(17px * var(--sub-size));
}
</style>
