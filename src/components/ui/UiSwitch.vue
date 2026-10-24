<script setup lang="ts">
/** On/off toggle with an optional label and hint, laid out as a settings row. */
withDefaults(defineProps<{
  label?: string
  hint?: string
  disabled?: boolean
  size?: 'sm' | 'md'
  tone?: 'accent' | 'info' | 'ok' | 'warn' | 'danger'
}>(), { size: 'md', tone: 'accent' })

const model = defineModel<boolean>({ default: false })

const TONE = { accent: 'var(--accent)', info: 'var(--info)', ok: 'var(--ok)', warn: 'var(--warn)', danger: 'var(--danger)' }
</script>

<template>
  <label
    class="flex gap-3 select-none items-center"
    :class="[label || $slots.default ? 'justify-between w-full' : 'inline-flex', disabled ? 'opacity-45 pointer-events-none' : 'cursor-pointer']"
  >
    <span v-if="label || hint || $slots.default" class="flex flex-col gap-0.5 min-w-0">
      <span v-if="label" class="text-[13px] text-fg">{{ label }}</span>
      <span v-if="hint" class="hint">{{ hint }}</span>
      <slot />
    </span>
    <button
      type="button"
      role="switch"
      :aria-checked="model"
      :aria-label="label"
      :disabled="disabled"
      class="focusable rounded-full shrink-0 transition-colors duration-200 relative"
      :class="size === 'sm' ? 'h-4 w-7' : 'h-5 w-9'"
      :style="{ background: model ? TONE[tone] : 'var(--bg-600)' }"
      @click.prevent="model = !model"
    >
      <span
        class="rounded-full bg-white shadow-sm transition-transform duration-250 ease-[var(--ease-spring)] left-0.5 top-0.5 absolute"
        :class="[
          size === 'sm' ? 'h-3 w-3' : 'h-4 w-4',
          model ? (size === 'sm' ? 'translate-x-3' : 'translate-x-4') : 'translate-x-0',
        ]"
      />
    </button>
  </label>
</template>
