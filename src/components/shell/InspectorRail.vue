<script setup lang="ts">
import type { FloatingId, InspectorId } from '~/lib/views'
import { computed } from 'vue'
import { INSPECTOR_GROUPS } from '~/lib/views'
import { useAudioStore } from '~/stores/audio'
import { useDeviceStore } from '~/stores/deviceStore'
import { useMotionStore } from '~/stores/motionStore'
import { useQueueStore } from '~/stores/queueStore'
import { useUiStore } from '~/stores/uiStore'

const ui = useUiStore()
const device = useDeviceStore()
const motion = useMotionStore()
const audio = useAudioStore()
const queue = useQueueStore()

function isOn(id: InspectorId | FloatingId) {
  return id === 'emulator' ? ui.isFloatingOpen('emulator') : ui.inspector === id || ui.pinned === id
}

function click(id: InspectorId | FloatingId) {
  if (id === 'emulator')
    ui.toggleFloating('emulator')
  else
    ui.toggleInspector(id)
}

function pin(id: InspectorId | FloatingId) {
  if (id !== 'emulator')
    ui.togglePin(id)
}

/** Small live indicators on rail icons, so state is visible with the drawer shut. */
const status = computed<Partial<Record<InspectorId | FloatingId, 'ok' | 'info' | 'accent' | null>>>(() => ({
  device: device.connected ? 'ok' : null,
  motion: motion.running ? 'ok' : null,
  binaural: audio.isPlaying.value ? 'info' : null,
}))

const upcomingCount = computed(() => queue.upcoming.length)
</script>

<template>
  <nav
    class="py-2 scroll-y border-l border-edge bg-surface-900 flex shrink-0 flex-col gap-0.5 w-[var(--rail-w)] select-none items-center relative z-20"
    aria-label="Tools"
  >
    <template v-for="(group, gi) in INSPECTOR_GROUPS" :key="group.id">
      <div v-if="gi > 0" class="my-1.5 bg-edge-strong shrink-0 h-px w-5" role="separator" />
      <button
        v-for="item in group.items"
        :key="item.id"
        v-tip="{ text: item.label + (item.kind === 'inspector' ? ' · middle-click to pin' : ''), kbd: item.kbd, placement: 'left' }"
        type="button"
        class="group focusable rounded-[var(--radius-md)] flex shrink-0 h-9 w-9 transition-colors items-center justify-center relative"
        :class="isOn(item.id)
          ? 'text-accent-300 bg-accent-soft'
          : 'text-fg-muted hover:text-fg hover:bg-fg/6'"
        :aria-label="item.label"
        :aria-pressed="isOn(item.id)"
        @click="click(item.id)"
        @click.middle.prevent="pin(item.id)"
        @auxclick.prevent
      >
        <span :class="item.icon" class="text-[17px] transition-transform duration-200 group-active:scale-90" />
        <!-- active edge marker -->
        <span
          class="rounded-full bg-accent w-[3px] transition-all duration-300 ease-[var(--ease-out)] right-[-7px] absolute"
          :class="ui.inspector === item.id ? 'h-4 opacity-100' : 'h-0 opacity-0'"
        />
        <!-- pinned -->
        <span
          v-if="ui.pinned === item.id"
          class="i-carbon-pin-filled text-[9px] text-accent-300 left-0.5 top-0.5 absolute"
        />
        <!-- live status -->
        <span
          v-if="status[item.id]"
          class="border-2 border-surface-900 rounded-full h-2.5 w-2.5 right-1 top-1 absolute"
          :class="{ ok: 'bg-ok', info: 'bg-info', accent: 'bg-accent' }[status[item.id]!]"
        />
        <span
          v-if="item.id === 'queue' && upcomingCount > 0"
          class="text-[9px] text-fg font-semibold num px-1 rounded-full bg-surface-600 center h-3.5 min-w-3.5 right-0 top-0 absolute"
        >{{ upcomingCount > 99 ? '99+' : upcomingCount }}</span>
      </button>
    </template>
  </nav>
</template>
