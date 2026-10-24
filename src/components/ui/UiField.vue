<script setup lang="ts">
/**
 * Settings row: label (and hint) on the left, control on the right.
 * `stacked` puts the control underneath instead, for wide controls.
 */
defineProps<{
  label: string
  hint?: string
  stacked?: boolean
}>()
</script>

<template>
  <div class="flex min-w-0" :class="stacked ? 'flex-col gap-1.5' : 'items-center justify-between gap-3'">
    <div class="flex flex-col gap-0.5 min-w-0">
      <span class="text-[13px] text-fg">{{ label }}</span>
      <span v-if="hint" class="hint">{{ hint }}</span>
    </div>
    <div class="flex gap-2 items-center" :class="stacked ? '' : 'shrink-0'">
      <slot />
    </div>
  </div>
</template>
