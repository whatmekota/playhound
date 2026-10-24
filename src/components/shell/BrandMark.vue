<script setup lang="ts">
import { useId } from 'vue'

/**
 * The playhound mark.
 *
 * A play button built out of a stroke meter: four bars whose envelope is the
 * play triangle, fading to a dot at the tip — the waveform the app plays and
 * the stroke it drives, in one shape. The tile's top-right corner is folded
 * down: a dog-ear, which is as much hound as a 20px icon can carry.
 *
 * Everything resolves through the theme tokens, so the mark reskins with the
 * app. `animated` draws it in (outline, fill, bars, then the fold), for the
 * splash and other first impressions.
 */
withDefaults(defineProps<{ size?: number, animated?: boolean }>(), { size: 28 })

// Gradient ids are document-global, and the mark is on screen more than once.
const gid = `ph-mark-${useId()}`

/** Bars on a 32-unit grid: [x, height]. The tops trace the play triangle. */
const BARS: [number, number][] = [
  [8.6, 16],
  [13.4, 11.4],
  [18.2, 6.9],
  [23, 3.2],
]
const BAR_W = 3

/** Tile with the top-right corner cut away along the fold line. */
const TILE = 'M9 0H20.4Q21 0 21.5 .5L31.5 10.5Q32 11 32 11.6V23A9 9 0 0 1 23 32H9A9 9 0 0 1 0 23V9A9 9 0 0 1 9 0Z'
/** The folded-over corner, lying on the face of the tile. */
const FLAP = 'M21 0V8.6Q21 11 23.4 11H32Z'
</script>

<template>
  <svg
    class="brand-mark shrink-0 inline-block"
    :class="{ 'is-animated': animated }"
    :width="size"
    :height="size"
    viewBox="0 0 32 32"
    role="img"
    aria-label="playhound"
  >
    <defs>
      <linearGradient :id="gid" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" style="stop-color: var(--accent-light)" />
        <stop offset=".5" style="stop-color: var(--accent)" />
        <stop offset="1" style="stop-color: var(--accent-strong)" />
      </linearGradient>
    </defs>

    <path class="bm-tile" :d="TILE" :style="{ fill: `url(#${gid})` }" />
    <path
      v-if="animated"
      class="bm-outline"
      :d="TILE"
      pathLength="1"
      fill="none"
      style="stroke: var(--accent-light)"
      stroke-width="1.2"
      stroke-linejoin="round"
    />
    <!-- Shadow under the flap gives the fold a little lift. -->
    <g transform="translate(-.7 .7)">
      <path class="bm-flap-shadow" :d="FLAP" style="fill: var(--accent-strong)" fill-opacity=".55" />
    </g>
    <path class="bm-flap" :d="FLAP" style="fill: var(--accent-contrast)" fill-opacity=".5" />

    <rect
      v-for="([x, h], i) in BARS"
      :key="i"
      class="bm-bar"
      :x="x"
      :y="16 - h / 2"
      :width="BAR_W"
      :height="h"
      :rx="BAR_W / 2"
      style="fill: var(--accent-contrast)"
      :style="{ animationDelay: `${560 + i * 75}ms` }"
    />
  </svg>
</template>

<style scoped>
.brand-mark {
  overflow: visible;
}

.bm-bar,
.bm-flap,
.bm-flap-shadow,
.bm-tile {
  transform-box: fill-box;
}

/* ── Draw-in ───────────────────────────────────────────────────────────────── */
.is-animated .bm-outline {
  stroke-dasharray: 1;
  stroke-dashoffset: 1;
  animation:
    bm-draw 700ms var(--ease-in-out) forwards,
    bm-fade-out 400ms 650ms ease forwards;
}
.is-animated .bm-tile {
  transform-origin: center;
  animation: bm-tile-in 520ms 320ms var(--ease-out) both;
}
.is-animated .bm-bar {
  transform-origin: center;
  animation: bm-bar-in 520ms var(--ease-spring) both;
}
.is-animated .bm-flap,
.is-animated .bm-flap-shadow {
  transform-origin: 100% 0;
  animation: bm-fold 460ms 920ms var(--ease-spring) both;
}

@keyframes bm-draw {
  to {
    stroke-dashoffset: 0;
  }
}
@keyframes bm-fade-out {
  to {
    opacity: 0;
  }
}
@keyframes bm-tile-in {
  from {
    opacity: 0;
    transform: scale(0.9);
  }
}
@keyframes bm-bar-in {
  from {
    opacity: 0;
    transform: scaleY(0.1);
  }
}
@keyframes bm-fold {
  from {
    opacity: 0;
    transform: scale(0.2);
  }
}
</style>
