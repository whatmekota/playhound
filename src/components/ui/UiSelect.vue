<script setup lang="ts" generic="T extends string | number">
/** Native select, styled to match. Native keeps keyboard handling and long lists free. */
withDefaults(defineProps<{
  options: { value: T, label: string, disabled?: boolean }[]
  label?: string
  size?: 'sm' | 'md'
  disabled?: boolean
}>(), { size: 'sm' })

const model = defineModel<T>({ required: true })

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
        class="text-fg pl-2.5 pr-7 appearance-none focusable border border-edge-strong rounded-[var(--radius-sm)] bg-surface-800 w-full cursor-pointer transition-colors hover:bg-surface-700 disabled:opacity-45"
        :class="size === 'sm' ? 'h-7 text-[12.5px]' : 'h-8 text-[13px]'"
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
