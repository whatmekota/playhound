<script setup lang="ts">
import type { LibraryQueryState } from './useLibraryQuery'
import { computed } from 'vue'
import UiButton from '~/components/ui/UiButton.vue'
import { BANDS } from '~/lib/scriptIntensity'
import { FILTER_CHIPS } from './useLibraryQuery'

/**
 * The library's filter chips: what kind of script, then how intense. The same
 * chips in the full view and the drawer panel, just smaller in the drawer.
 */
const props = defineProps<{
  lq: LibraryQueryState
  compact?: boolean
}>()

/** Bands only mean something once some scripts have been analysed. */
const showBands = computed(() => props.lq.scripts.coverage.done > 0 || props.lq.bands.size > 0)

const BAND_LEVEL = { gentle: 1, medium: 3, intense: 5 } as const
</script>

<template>
  <div class="flex flex-wrap items-center" :class="compact ? 'gap-1' : 'gap-1.5'">
    <button
      v-for="f in FILTER_CHIPS"
      :key="f.key"
      type="button"
      class="chip focusable pressable"
      :class="[lq.filters.has(f.key) ? 'chip-on' : '', compact ? 'is-compact' : '']"
      :aria-pressed="lq.filters.has(f.key)"
      @click="lq.toggleFilter(f.key)"
    >
      <span :class="lq.filters.has(f.key) && f.key === 'starred' ? 'i-carbon-star-filled' : f.icon" class="text-[13px]" />
      {{ f.label }}
      <span class="text-[11px] num opacity-60">{{ lq.counts[f.key].toLocaleString() }}</span>
    </button>

    <template v-if="showBands">
      <span class="mx-0.5 bg-edge-strong h-4 w-px" aria-hidden="true" />
      <button
        v-for="b in BANDS"
        :key="b.key"
        v-tip="`Average speed ${b.key === 'gentle' ? 'under 200' : b.key === 'medium' ? '200 to 320' : 'over 320'} units/s`"
        type="button"
        class="chip focusable pressable"
        :class="[lq.bands.has(b.key) ? 'chip-on' : '', compact ? 'is-compact' : '']"
        :aria-pressed="lq.bands.has(b.key)"
        @click="lq.toggleBand(b.key)"
      >
        <span class="bars" aria-hidden="true">
          <i v-for="n in 5" :key="n" :class="n <= BAND_LEVEL[b.key] ? 'on' : ''" :style="{ height: `${30 + n * 14}%` }" />
        </span>
        {{ b.label }}
        <span class="text-[11px] num opacity-60">{{ lq.bandTally[b.key].toLocaleString() }}</span>
      </button>
    </template>

    <Transition name="t-fade">
      <UiButton v-if="lq.filtering" variant="ghost" size="xs" icon="i-carbon-close" @click="lq.clearFilters()">
        Clear
      </UiButton>
    </Transition>
  </div>
</template>

<style scoped>
.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  color: var(--text-muted);
  font-size: 12.5px;
  white-space: nowrap;
}
.chip.is-compact {
  gap: 4px;
  height: 24px;
  padding: 0 8px;
  font-size: 11.5px;
}
.chip:hover {
  color: var(--text);
  background: color-mix(in srgb, var(--text) 5%, transparent);
}
.chip-on,
.chip-on:hover {
  color: var(--accent-light);
  border-color: color-mix(in srgb, var(--accent) 55%, transparent);
  background: var(--accent-soft);
}
.bars {
  display: inline-flex;
  align-items: flex-end;
  gap: 1px;
  height: 9px;
}
.bars i {
  display: block;
  width: 2px;
  border-radius: 1px;
  background: color-mix(in srgb, currentColor 25%, transparent);
}
.bars i.on {
  background: currentColor;
}
</style>
