<script setup lang="ts" generic="T extends string | number">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

/**
 * Segmented control with a sliding indicator. For 2–5 mutually exclusive
 * options; past that, use UiSelect.
 */
const props = withDefaults(defineProps<{
  options: { value: T, label?: string, icon?: string, title?: string }[]
  size?: 'xs' | 'sm' | 'md'
  block?: boolean
}>(), { size: 'sm' })

const model = defineModel<T>({ required: true })

const root = ref<HTMLElement | null>(null)
const indicator = ref({ left: 0, width: 0, ready: false })

const activeIdx = computed(() => props.options.findIndex(o => o.value === model.value))

function measure() {
  const el = root.value?.querySelectorAll<HTMLElement>('[data-seg]')[activeIdx.value]
  if (!el) {
    indicator.value = { left: 0, width: 0, ready: false }
    return
  }
  indicator.value = { left: el.offsetLeft, width: el.offsetWidth, ready: true }
}

let ro: ResizeObserver | null = null
onMounted(() => {
  measure()
  // Fonts loading late change label widths.
  document.fonts?.ready.then(measure)
  if (root.value) {
    ro = new ResizeObserver(measure)
    ro.observe(root.value)
  }
})
onBeforeUnmount(() => ro?.disconnect())
watch([activeIdx, () => props.options.length], () => nextTick(measure))

const SIZE = {
  xs: 'h-6 text-[11px] px-2 gap-1',
  sm: 'h-7 text-[12px] px-2.5 gap-1.5',
  md: 'h-8 text-[13px] px-3 gap-1.5',
}
</script>

<template>
  <div
    ref="root"
    role="radiogroup"
    class="p-0.5 rounded-[var(--radius-md)] bg-surface-950/60 flex shrink-0 ring-1 ring-edge relative"
    :class="block ? 'w-full' : 'inline-flex'"
  >
    <span
      class="rounded-[calc(var(--radius-md)-2px)] bg-surface-700 shadow-[var(--shadow-sm)] transition-all duration-300 ease-[var(--ease-out)] bottom-0.5 top-0.5 absolute"
      :style="{ left: `${indicator.left}px`, width: `${indicator.width}px`, opacity: indicator.ready ? 1 : 0 }"
    />
    <button
      v-for="o in options"
      :key="String(o.value)"
      v-tip="o.title"
      data-seg
      type="button"
      role="radio"
      :aria-checked="o.value === model"
      :aria-label="o.label ?? o.title"
      class="font-medium focusable flex whitespace-nowrap transition-colors duration-150 items-center justify-center relative z-1"
      :class="[SIZE[size], block ? 'flex-1' : '', o.value === model ? 'text-fg' : 'text-fg-muted hover:text-fg']"
      @click="model = o.value"
    >
      <span v-if="o.icon" :class="o.icon" class="text-[1.1em]" />
      <span v-if="o.label">{{ o.label }}</span>
    </button>
  </div>
</template>
