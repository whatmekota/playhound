<script setup lang="ts">
import type { Stretch } from '~/lib/scriptIntensity'
import { computed } from 'vue'

/** Speed over the length of a script, with its busiest stretch shaded. */
const props = defineProps<{
  curve: number[]
  durationMs: number
  busiest?: Stretch | null
}>()

const W = 100
const H = 32

const max = computed(() => Math.max(0.001, ...props.curve))

const line = computed(() => {
  const n = props.curve.length
  if (n < 2)
    return ''
  return props.curve.map((v, i) => `${((i / (n - 1)) * W).toFixed(2)},${(H - (v / max.value) * (H - 2)).toFixed(2)}`).join(' ')
})
const area = computed(() => (line.value ? `0,${H} ${line.value} ${W},${H}` : ''))

const band = computed(() => {
  const b = props.busiest
  if (!b || !props.durationMs)
    return null
  const x = (b.startMs / props.durationMs) * W
  return { x, w: Math.max(0.8, ((b.endMs - b.startMs) / props.durationMs) * W) }
})
</script>

<template>
  <svg :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" class="spark h-9 w-full block" aria-hidden="true">
    <rect v-if="band" :x="band.x" y="0" :width="band.w" :height="H" class="busy" />
    <polygon v-if="area" :points="area" class="fill" />
    <polyline v-if="line" :points="line" class="stroke" vector-effect="non-scaling-stroke" />
  </svg>
</template>

<style scoped>
.spark .busy {
  fill: color-mix(in srgb, var(--warn) 16%, transparent);
}
.spark .fill {
  fill: color-mix(in srgb, var(--accent) 18%, transparent);
}
.spark .stroke {
  fill: none;
  stroke: var(--accent-light);
  stroke-width: 1.5;
  stroke-linejoin: round;
}
</style>
