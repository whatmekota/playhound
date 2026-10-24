<script setup lang="ts">
/** A number with a label underneath, for readouts and dashboards. */
withDefaults(defineProps<{
  label: string
  value: string | number
  unit?: string
  tone?: 'fg' | 'accent' | 'ok' | 'warn' | 'danger' | 'info'
  size?: 'sm' | 'md' | 'lg'
  hint?: string
}>(), { tone: 'fg', size: 'md' })

const TONE = {
  fg: 'text-fg',
  accent: 'text-accent-300',
  ok: 'text-ok',
  warn: 'text-warn',
  danger: 'text-danger',
  info: 'text-info',
}
</script>

<template>
  <div v-tip="hint" class="flex flex-col gap-0.5 min-w-0">
    <div class="flex gap-1 items-baseline">
      <span
        class="tracking-[-0.02em] font-semibold num truncate"
        :class="[TONE[tone], size === 'sm' ? 'text-[15px]' : size === 'md' ? 'text-[20px]' : 'text-[28px]']"
      >{{ value }}</span>
      <span v-if="unit" class="text-[11.5px] text-fg-faint">{{ unit }}</span>
    </div>
    <span class="eyebrow truncate">{{ label }}</span>
  </div>
</template>
