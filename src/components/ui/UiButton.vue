<script setup lang="ts">
/**
 * The one button.
 *
 * `variant` sets weight (primary for the main action on a surface, secondary
 * for everything else, ghost inside toolbars, danger for destructive acts).
 * `size` follows the 24 / 28 / 32 / 40 px rhythm the rest of the UI is built on.
 */
withDefaults(defineProps<{
  variant?: 'primary' | 'secondary' | 'ghost' | 'subtle' | 'danger'
  size?: 'xs' | 'sm' | 'md' | 'lg'
  icon?: string
  iconRight?: string
  loading?: boolean
  disabled?: boolean
  /** Fill the width of the parent. */
  block?: boolean
  /** Toggle-style "on" state for ghost/secondary/subtle buttons. */
  active?: boolean
  type?: 'button' | 'submit'
}>(), {
  variant: 'secondary',
  size: 'sm',
  type: 'button',
})

const VARIANT = {
  primary: 'bg-accent text-accent-contrast shadow-[0_1px_0_rgba(255,255,255,0.18)_inset,0_6px_16px_-6px_var(--accent)] hover:brightness-110',
  secondary: 'bg-surface-800 text-fg border border-edge-strong hover:bg-surface-700',
  ghost: 'text-fg-muted hover:text-fg hover:bg-fg/7',
  subtle: 'bg-fg/6 text-fg-muted hover:bg-fg/10 hover:text-fg',
  danger: 'bg-danger/14 text-danger border border-danger/25 hover:bg-danger/22',
}

const SIZE = {
  xs: 'h-6 px-2 text-[11.5px] gap-1 rounded-[var(--radius-sm)]',
  sm: 'h-7 px-2.5 text-[12.5px] gap-1.5 rounded-[var(--radius-sm)]',
  md: 'h-8 px-3 text-[13px] gap-1.5 rounded-[var(--radius-md)]',
  lg: 'h-10 px-4 text-[14px] gap-2 rounded-[var(--radius-md)]',
}

const ICON = { xs: 'text-[13px]', sm: 'text-[14px]', md: 'text-[15px]', lg: 'text-[17px]' }
</script>

<template>
  <button
    :type="type"
    :disabled="disabled || loading"
    class="font-medium focusable inline-flex shrink-0 select-none whitespace-nowrap pressable items-center justify-center disabled:opacity-40 disabled:pointer-events-none"
    :class="[
      VARIANT[variant],
      SIZE[size],
      block ? 'w-full' : '',
      active && variant !== 'primary' && variant !== 'danger' ? '!text-accent-300 !bg-accent-soft' : '',
    ]"
  >
    <span v-if="loading" class="border-2 border-current border-r-transparent rounded-full shrink-0 h-3.5 w-3.5 [animation:ph-spin_.7s_linear_infinite]" />
    <span v-else-if="icon" :class="[icon, ICON[size]]" class="shrink-0" />
    <slot />
    <span v-if="iconRight" :class="[iconRight, ICON[size]]" class="opacity-70 shrink-0" />
  </button>
</template>
