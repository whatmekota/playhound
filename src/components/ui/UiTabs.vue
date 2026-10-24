<script setup lang="ts" generic="T extends string">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

/** Underlined tabs with a sliding indicator, for switching sub-views. */
const props = defineProps<{
  tabs: { value: T, label: string, icon?: string, badge?: string | number }[]
}>()

const model = defineModel<T>({ required: true })
const root = ref<HTMLElement | null>(null)
const bar = ref({ left: 0, width: 0 })
const idx = computed(() => props.tabs.findIndex(t => t.value === model.value))

function measure() {
  const el = root.value?.querySelectorAll<HTMLElement>('[data-tab]')[idx.value]
  if (el)
    bar.value = { left: el.offsetLeft, width: el.offsetWidth }
}

let ro: ResizeObserver | null = null
onMounted(() => {
  measure()
  document.fonts?.ready.then(measure)
  if (root.value) {
    ro = new ResizeObserver(measure)
    ro.observe(root.value)
  }
})
onBeforeUnmount(() => ro?.disconnect())
watch(idx, () => nextTick(measure))
</script>

<template>
  <div ref="root" role="tablist" class="border-b border-edge flex gap-1 relative">
    <button
      v-for="t in tabs"
      :key="t.value"
      data-tab
      type="button"
      role="tab"
      :aria-selected="t.value === model"
      class="text-[13px] font-medium px-2.5 focusable flex gap-1.5 h-9 transition-colors items-center"
      :class="t.value === model ? 'text-fg' : 'text-fg-muted hover:text-fg'"
      @click="model = t.value"
    >
      <span v-if="t.icon" :class="t.icon" class="text-[15px]" />
      {{ t.label }}
      <span v-if="t.badge !== undefined && t.badge !== ''" class="text-[10.5px] text-fg-muted num px-1.5 rounded-full bg-fg/8">{{ t.badge }}</span>
    </button>
    <span
      class="bottom--px rounded-full bg-accent h-0.5 transition-all duration-300 ease-[var(--ease-out)] absolute"
      :style="{ left: `${bar.left}px`, width: `${bar.width}px` }"
    />
  </div>
</template>
