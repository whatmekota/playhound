<script setup lang="ts">
/**
 * Square icon-only button. `label` is required: it becomes the aria-label and
 * the tooltip, so an icon is never a mystery.
 */
withDefaults(defineProps<{
  icon: string
  label: string
  /** Shortcut shown in the tooltip. */
  kbd?: string
  size?: 'xs' | 'sm' | 'md' | 'lg'
  /** `glass` is for controls drawn over video. */
  variant?: 'ghost' | 'solid' | 'glass'
  active?: boolean
  disabled?: boolean
  /** Tooltip placement. */
  tip?: 'top' | 'bottom' | 'left' | 'right'
}>(), {
  size: 'sm',
  variant: 'ghost',
  tip: 'top',
})

const SIZE = {
  xs: 'h-6 w-6 text-[13px] rounded-[var(--radius-sm)]',
  sm: 'h-7 w-7 text-[15px] rounded-[var(--radius-sm)]',
  md: 'h-8 w-8 text-[16px] rounded-[var(--radius-md)]',
  lg: 'h-10 w-10 text-[19px] rounded-[var(--radius-md)]',
}

const VARIANT = {
  ghost: 'text-fg-muted hover:text-fg hover:bg-fg/8',
  solid: 'bg-surface-800 border border-edge-strong text-fg hover:bg-surface-700',
  glass: 'text-white/85 hover:text-white hover:bg-white/14',
}
</script>

<template>
  <button
    v-tip="{ text: label, kbd, placement: tip }"
    type="button"
    :aria-label="label"
    :aria-pressed="active ?? undefined"
    :disabled="disabled"
    class="focusable inline-flex shrink-0 pressable items-center justify-center relative disabled:opacity-35 disabled:pointer-events-none"
    :class="[SIZE[size], active ? '!text-accent-300 bg-accent-soft' : VARIANT[variant]]"
  >
    <span :class="icon" />
    <slot />
  </button>
</template>
