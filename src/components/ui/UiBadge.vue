<script setup lang="ts">
/** Small status pill. `dot` adds a leading status dot; `pulse` animates it. */
withDefaults(defineProps<{
  tone?: 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' | 'info'
  size?: 'xs' | 'sm'
  icon?: string
  dot?: boolean
  pulse?: boolean
  /** Solid fill instead of tinted. */
  solid?: boolean
}>(), { tone: 'neutral', size: 'sm' })

const TINT = {
  neutral: 'bg-fg/7 text-fg-muted',
  accent: 'bg-accent-soft text-accent-300',
  ok: 'bg-ok/14 text-ok',
  warn: 'bg-warn/14 text-warn',
  danger: 'bg-danger/14 text-danger',
  info: 'bg-info/14 text-info',
}
const SOLID = {
  neutral: 'bg-surface-600 text-fg',
  accent: 'bg-accent text-accent-contrast',
  ok: 'bg-ok text-black',
  warn: 'bg-warn text-black',
  danger: 'bg-danger text-white',
  info: 'bg-info text-black',
}
</script>

<template>
  <span
    class="font-medium inline-flex shrink-0 whitespace-nowrap items-center"
    :class="[
      solid ? SOLID[tone] : TINT[tone],
      size === 'xs' ? 'h-4 px-1.5 text-[10px] gap-1 rounded-[var(--radius-xs)]' : 'h-5 px-2 text-[11px] gap-1.5 rounded-[var(--radius-sm)]',
    ]"
  >
    <span v-if="dot" class="rounded-full bg-current shrink-0 h-1.5 w-1.5" :class="pulse ? 'animate-pulse-dot' : ''" />
    <span v-if="icon" :class="icon" class="text-[1.15em] shrink-0" />
    <slot />
  </span>
</template>
