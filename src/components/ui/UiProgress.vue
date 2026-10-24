<script setup lang="ts">
/** Thin progress bar. Omit `value` for an indeterminate shimmer. */
withDefaults(defineProps<{
  /** 0..1 */
  value?: number
  tone?: 'accent' | 'ok' | 'warn' | 'danger' | 'info'
}>(), { tone: 'accent' })

const TONE = { accent: 'var(--accent)', ok: 'var(--ok)', warn: 'var(--warn)', danger: 'var(--danger)', info: 'var(--info)' }
</script>

<template>
  <div class="rounded-full bg-surface-700 h-1 w-full overflow-hidden" role="progressbar" :aria-valuenow="value">
    <div
      v-if="value !== undefined"
      class="rounded-full h-full transition-[width] duration-300 ease-[var(--ease-out)]"
      :style="{ width: `${Math.max(0, Math.min(1, value)) * 100}%`, background: TONE[tone] }"
    />
    <div v-else class="skeleton h-full w-full" :style="{ background: `linear-gradient(90deg, transparent, ${TONE[tone]}, transparent)`, backgroundSize: '200% 100%' }" />
  </div>
</template>
