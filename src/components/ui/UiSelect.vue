<script setup lang="ts" generic="T extends string | number">
import { computed } from 'vue'

/**
 * Native select, styled to match. Native keeps keyboard handling and long
 * lists free; where the engine allows (main.css), the open list is themed too.
 */
const props = withDefaults(defineProps<{
  options: { value: T, label: string, disabled?: boolean }[]
  label?: string
  size?: 'sm' | 'md'
  disabled?: boolean
}>(), { size: 'sm' })

const model = defineModel<T>({ required: true })

// A stylable select sizes to the chosen option; keep the native habit of
// fitting the longest one, so the box doesn't jump as the choice changes.
// Never wider than the space it has, though: a long label is cut off instead.
const minWidth = computed(() => `min(calc(${Math.max(...props.options.map(o => o.label.length), 4)}ch + 2.75rem), 100%)`)

function onChange(e: Event, options: { value: T }[]) {
  const i = (e.target as HTMLSelectElement).selectedIndex
  model.value = options[i].value
}
</script>

<template>
  <label class="flex flex-col gap-1 min-w-0">
    <span v-if="label" class="label">{{ label }}</span>
    <span class="relative">
      <select
        class="ui-select text-fg pl-2.5 pr-7 focusable border border-edge-strong rounded-[var(--radius-sm)] bg-surface-800 max-w-full w-full cursor-pointer truncate transition-colors hover:bg-surface-700 disabled:opacity-45"
        :class="size === 'sm' ? 'h-7 text-[12.5px]' : 'h-8 text-[13px]'"
        :style="{ minWidth }"
        :disabled="disabled"
        @change="onChange($event, options)"
      >
        <option v-for="o in options" :key="String(o.value)" :selected="o.value === model" :disabled="o.disabled">
          {{ o.label }}
        </option>
      </select>
      <span class="i-carbon-chevron-down text-[12px] text-fg-faint pointer-events-none right-2 top-1/2 absolute -translate-y-1/2" />
    </span>
  </label>
</template>
