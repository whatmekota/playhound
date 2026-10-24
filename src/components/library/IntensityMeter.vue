<script setup lang="ts">
import type { ScriptSummary } from '~/lib/idb'
import { computed } from 'vue'
import { BANDS, intensityBand, intensityLevel, speedUnits } from '~/lib/scriptIntensity'

/**
 * Five rising bars, like a signal meter: how hard the script goes on average.
 * Renders nothing for a video that has not been analysed, so an unknown never
 * reads as "gentle".
 */
const props = withDefaults(defineProps<{
  summary: Pick<ScriptSummary, 'meanSpeed' | 'peakSpeed'> | null | undefined
  /** `over` is for drawing on a thumbnail, where white on dark is right in every theme. */
  tone?: 'default' | 'over'
  /** Show the band name beside the bars. */
  label?: boolean
}>(), { tone: 'default' })

const level = computed(() => (props.summary ? intensityLevel(props.summary.meanSpeed) : 0))
const band = computed(() => (props.summary ? BANDS.find(b => b.key === intensityBand(props.summary!.meanSpeed))! : null))
const tip = computed(() => props.summary
  ? `${band.value!.label} · avg ${speedUnits(props.summary.meanSpeed)}, peak ${speedUnits(props.summary.peakSpeed)} units/s`
  : '')
</script>

<template>
  <span
    v-if="summary"
    v-tip="tip"
    class="meter inline-flex shrink-0 gap-1.5 items-center"
    :class="[`tone-${tone}`, `lvl-${level}`]"
    role="img"
    :aria-label="`Intensity ${level} of 5`"
  >
    <span class="bars">
      <i v-for="n in 5" :key="n" :class="n <= level ? 'on' : ''" :style="{ height: `${30 + n * 14}%` }" />
    </span>
    <span v-if="label" class="text-[11px]">{{ band!.label }}</span>
  </span>
</template>

<style scoped>
.bars {
  display: inline-flex;
  align-items: flex-end;
  gap: 1.5px;
  height: 10px;
}
.bars i {
  display: block;
  width: 2.5px;
  border-radius: 1px;
  background: color-mix(in srgb, var(--text) 16%, transparent);
  transition: background-color var(--dur) var(--ease-out);
}
.bars i.on {
  background: var(--accent-light);
}
/* The top two levels warm up, so "intense" is visible at a glance. */
.lvl-5 .bars i.on {
  background: var(--danger);
}
.lvl-4 .bars i.on {
  background: var(--warn);
}
.meter.tone-default {
  color: var(--text-faint);
}
.meter.tone-over {
  color: rgba(255, 255, 255, 0.8);
}
.tone-over .bars i {
  background: rgba(255, 255, 255, 0.28);
}
.tone-over .bars i.on {
  background: white;
}
.tone-over.lvl-4 .bars i.on {
  background: var(--warn);
}
.tone-over.lvl-5 .bars i.on {
  background: var(--danger);
}
</style>
