<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  title: string
  /** UnoCSS icon class, optional. */
  icon?: string
  /** Short state summary shown on the right while collapsed. */
  summary?: string
  /** Highlight the header when the section is doing something. */
  active?: boolean
}>()

const open = defineModel<boolean>('open', { default: false })

const tone = computed(() => (props.active ? 'text-teal-400' : 'text-fg-muted'))
</script>

<template>
  <section class="border border-edge rounded-xl bg-surface-900 overflow-hidden">
    <button
      class="px-2.5 py-2 text-left flex gap-2 w-full transition-colors items-center hover:bg-fg/5"
      :aria-expanded="open"
      @click="open = !open"
    >
      <div
        class="i-carbon-chevron-right text-xs text-fg-faint shrink-0 transition-transform"
        :class="open ? 'rotate-90' : ''"
      />
      <div v-if="icon" :class="[icon, tone]" class="text-sm shrink-0" />
      <span class="text-[11px] tracking-wider font-semibold uppercase" :class="tone">
        {{ title }}
      </span>
      <span v-if="summary && !open" class="text-[10px] text-fg-faint font-mono ml-auto max-w-[45%] truncate">
        {{ summary }}
      </span>
      <span v-else-if="active" class="ml-auto rounded-full bg-teal-400 shrink-0 h-1.5 w-1.5" />
    </button>

    <div v-if="open" class="px-2.5 pb-2.5 pt-0.5 space-y-3">
      <slot />
    </div>
  </section>
</template>
