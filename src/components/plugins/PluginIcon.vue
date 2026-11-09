<script setup lang="ts">
import type { ImageRef } from '~/plugins/storeCache'
import { computed, ref, watch } from 'vue'
import { useImage } from '~/plugins/storeCache'
import { monogram } from '~/plugins/storeMeta'

/**
 * A plugin's icon: its own picture when it has one (checked and cached, see
 * storeCache), else its initials on a colour picked from its id, so each
 * plugin keeps the same one.
 */
const props = withDefaults(defineProps<{
  id: string
  name: string
  image?: ImageRef | null
  size?: number
}>(), { size: 40, image: null })

const url = useImage(() => props.image, 'icon')
const broken = ref(false)
watch(url, () => (broken.value = false))
const mono = computed(() => monogram(props.id, props.name))
const radius = computed(() => `${Math.round(props.size * 0.24)}px`)
</script>

<template>
  <span
    class="plugin-mark shrink-0 select-none overflow-hidden"
    :style="{ 'width': `${size}px`, 'height': `${size}px`, 'borderRadius': radius, '--h': mono.hue }"
    aria-hidden="true"
  >
    <img v-if="url && !broken" :src="url" alt="" class="h-full w-full block object-cover" draggable="false" @error="broken = true">
    <span v-else class="mono center h-full w-full" :style="{ fontSize: `${Math.round(size * (mono.letters.length > 1 ? 0.36 : 0.44))}px` }">{{ mono.letters }}</span>
  </span>
</template>

<style scoped>
.plugin-mark {
  display: inline-block;
  background: var(--bg-800);
  box-shadow: inset 0 0 0 1px var(--border);
}
/* Quiet, on the theme's own surfaces: a hint of the plugin's hue, never a loud tile. */
.mono {
  color: color-mix(in oklch, var(--text-muted) 70%, oklch(0.72 0.12 calc(var(--h) * 1deg)));
  font-weight: 650;
  letter-spacing: -0.02em;
  background:
    radial-gradient(
      110% 80% at 25% 10%,
      color-mix(in oklch, var(--bg-600) 80%, oklch(0.6 0.12 calc(var(--h) * 1deg))),
      transparent 70%
    ),
    var(--bg-700);
}
</style>
