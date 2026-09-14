<script setup lang="ts">
import type { PanelId } from '~/lib/panels'
import { PANEL_GROUPS } from '~/lib/panels'

const props = defineProps<{
  active: PanelId | null
  pinned: PanelId | null
  /** Floating windows currently open; these highlight without owning a slot. */
  overlays?: PanelId[]
}>()

const emit = defineEmits<{
  select: [id: PanelId]
  pin: [id: PanelId]
}>()

function isActive(id: PanelId) {
  return props.active === id || (props.overlays?.includes(id) ?? false)
}
</script>

<template>
  <nav
    class="py-1.5 border-l border-white/5 bg-surface-900 flex shrink-0 flex-col gap-0.5 w-11 items-center overflow-y-auto"
    aria-label="Panels"
  >
    <template v-for="(group, gi) in PANEL_GROUPS" :key="group.id">
      <div
        v-if="gi > 0"
        class="my-1 bg-white/10 shrink-0 h-px w-5"
        role="separator"
      />

      <button
        v-for="panel in group.panels"
        :key="panel.id"
        class="group rounded-lg flex shrink-0 h-8 w-8 transition-colors items-center justify-center relative"
        :class="isActive(panel.id)
          ? [panel.accent, 'bg-fg/10']
          : 'text-fg-faint hover:text-fg hover:bg-fg/5'"
        :aria-label="panel.label"
        :aria-pressed="isActive(panel.id)"
        @click="emit('select', panel.id)"
        @click.middle.prevent="emit('pin', panel.id)"
      >
        <div :class="panel.icon" class="text-base" />

        <!-- pinned marker -->
        <span
          v-if="pinned === panel.id"
          class="rounded-full bg-current h-1.5 w-1.5 right-0.5 top-0.5 absolute"
        />

        <!-- hover label -->
        <span
          class="text-[11px] font-medium mr-2 px-2 py-1 border border-white/10 rounded-md bg-surface-800 opacity-0 pointer-events-none whitespace-nowrap shadow-lg translate-x-1 transition-all duration-100 right-full absolute z-50 group-hover:opacity-100 group-hover:translate-x-0"
        >
          <span class="text-white">{{ panel.label }}</span>
          <span class="text-[9px] text-white/30 tracking-wide ml-1.5 uppercase">{{ group.label }}</span>
        </span>
      </button>
    </template>
  </nav>
</template>
