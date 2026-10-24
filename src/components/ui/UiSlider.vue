<script setup lang="ts">
import { computed } from 'vue'

/**
 * Labelled range control.
 *
 * The header row shows the label and the formatted value; the track fills up to
 * the thumb in the accent colour (or `tone`). Double-click resets to `reset`
 * when given, which is how audio software behaves.
 */
const props = withDefaults(defineProps<{
  min?: number
  max?: number
  step?: number
  label?: string
  /** Appended to the displayed value. */
  unit?: string
  /** Custom display formatting; wins over unit. */
  format?: (v: number) => string
  /** Double-click value. */
  reset?: number
  disabled?: boolean
  tone?: 'accent' | 'info' | 'ok' | 'warn' | 'danger'
  /** Hide the value readout. */
  hideValue?: boolean
  hint?: string
}>(), {
  min: 0,
  max: 1,
  step: 0.01,
  tone: 'accent',
})

const model = defineModel<number>({ required: true })

const pct = computed(() => {
  const span = props.max - props.min
  return span > 0 ? Math.max(0, Math.min(100, ((model.value - props.min) / span) * 100)) : 0
})

const display = computed(() => {
  if (props.format)
    return props.format(model.value)
  const decimals = props.step >= 1 ? 0 : Math.min(3, String(props.step).split('.')[1]?.length ?? 0)
  return `${Number(model.value).toFixed(decimals)}${props.unit ?? ''}`
})

const TONE = { accent: 'var(--accent)', info: 'var(--info)', ok: 'var(--ok)', warn: 'var(--warn)', danger: 'var(--danger)' }

function onInput(e: Event) {
  model.value = Number((e.target as HTMLInputElement).value)
}

function onReset() {
  if (props.reset !== undefined && !props.disabled)
    model.value = props.reset
}
</script>

<template>
  <label class="flex flex-col gap-1 min-w-0" :class="disabled ? 'opacity-45' : ''">
    <div v-if="label || !hideValue" class="flex gap-2 items-baseline justify-between">
      <span v-if="label" class="label truncate">{{ label }}</span>
      <span v-if="!hideValue" class="text-[11.5px] text-fg num shrink-0">{{ display }}</span>
    </div>
    <input
      type="range"
      class="ui-slider w-full"
      :min="min" :max="max" :step="step"
      :value="model"
      :disabled="disabled"
      :style="{ '--pct': `${pct}%`, '--tone': TONE[tone] }"
      @input="onInput"
      @dblclick="onReset"
    >
    <span v-if="hint" class="hint">{{ hint }}</span>
  </label>
</template>

<style scoped>
.ui-slider::-webkit-slider-runnable-track {
  background: linear-gradient(
    to right,
    var(--tone) 0%,
    var(--tone) var(--pct),
    var(--bg-700) var(--pct),
    var(--bg-700) 100%
  );
}
</style>
