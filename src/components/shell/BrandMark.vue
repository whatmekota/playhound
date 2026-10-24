<script setup lang="ts">
import type { LogoId } from '~/lib/logos'
import { computed } from 'vue'
import { logoUrl } from '~/lib/logos'
import { useThemeStore } from '~/stores/themeStore'

/**
 * The playhound mark: a sly flat grin with one fang, in whichever colouring
 * is picked in Settings → Appearance, optionally with its tongue out (`logo`
 * and `tongue` force a specific one, for the picker itself).
 *
 * Drawn as an <img> of the file in public/logos/ rather than inline SVG: each
 * logo defines its own gradient and clip ids, and several marks on one page
 * would otherwise resolve each other's ids.
 *
 * `animated` springs it in with a little snap of the jaw, for the splash and
 * other first impressions.
 */
const props = withDefaults(defineProps<{ size?: number, animated?: boolean, logo?: LogoId, tongue?: boolean }>(), { size: 28, tongue: undefined })

const theme = useThemeStore()
const src = computed(() => logoUrl(props.logo ?? theme.logo, props.tongue ?? theme.logoTongue))
</script>

<template>
  <img
    :src="src"
    :width="size"
    :height="size"
    alt="playhound"
    draggable="false"
    class="brand-mark shrink-0 inline-block select-none"
    :class="{ 'is-animated': animated }"
  >
</template>

<style scoped>
.brand-mark {
  -webkit-user-drag: none;
}

.is-animated {
  animation: bm-in 900ms var(--ease-out) both;
  transform-origin: 50% 60%;
}

/* Pops in, overshoots, then a quick squash like a jaw closing. */
@keyframes bm-in {
  0% {
    opacity: 0;
    transform: scale(0.55) rotate(-10deg);
  }
  45% {
    opacity: 1;
    transform: scale(1.08) rotate(2deg);
  }
  62% {
    transform: scale(1) rotate(0deg);
  }
  74% {
    transform: scale(1.03, 0.94);
  }
  86% {
    transform: scale(0.99, 1.02);
  }
  100% {
    transform: none;
  }
}
</style>
