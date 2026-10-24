<script setup lang="ts">
import { ref } from 'vue'

/** Text input with optional leading icon, clear button and trailing slot. */
const props = withDefaults(defineProps<{
  placeholder?: string
  icon?: string
  type?: string
  size?: 'sm' | 'md' | 'lg'
  clearable?: boolean
  label?: string
  mono?: boolean
  disabled?: boolean
  autofocus?: boolean
}>(), { type: 'text', size: 'sm' })

const emit = defineEmits<{ enter: [], escape: [] }>()
const model = defineModel<string | number>({ default: '' })
const el = ref<HTMLInputElement | null>(null)

defineExpose({ focus: () => el.value?.focus(), select: () => el.value?.select(), el })

const SIZE = { sm: 'h-7 text-[12.5px]', md: 'h-8 text-[13px]', lg: 'h-10 text-[14px]' }

function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter')
    emit('enter')
  if (e.key === 'Escape') {
    if (props.clearable && model.value) {
      e.stopPropagation()
      model.value = ''
    }
    emit('escape')
  }
}
</script>

<template>
  <label class="flex flex-col gap-1 min-w-0">
    <span v-if="label" class="label">{{ label }}</span>
    <span
      class="border border-edge-strong rounded-[var(--radius-sm)] bg-surface-900 flex transition-[border-color,box-shadow] duration-150 items-center relative focus-within:border-accent/70 focus-within:ring-3 focus-within:ring-accent-soft"
      :class="[SIZE[size], disabled ? 'opacity-45' : '']"
    >
      <span v-if="icon" :class="icon" class="text-[14px] text-fg-faint ml-2.5 shrink-0" />
      <input
        ref="el"
        v-model="model"
        :type="type"
        :placeholder="placeholder"
        :disabled="disabled"
        :autofocus="autofocus"
        class="text-fg px-2.5 outline-none bg-transparent h-full min-w-0 w-full placeholder:text-fg-faint"
        :class="[mono ? 'font-mono' : '', icon ? 'pl-2' : '']"
        @keydown="onKey"
      >
      <button
        v-if="clearable && model"
        type="button"
        class="text-fg-faint mr-1.5 rounded center shrink-0 h-5 w-5 hover:text-fg hover:bg-fg/8"
        aria-label="Clear"
        @click="model = ''"
      >
        <span class="i-carbon-close text-[13px]" />
      </button>
      <slot name="suffix" />
    </span>
  </label>
</template>
