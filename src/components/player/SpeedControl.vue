<script setup lang="ts">
import { computed } from 'vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiPopover from '~/components/ui/UiPopover.vue'
import UiSlider from '~/components/ui/UiSlider.vue'
import { usePlaybackStore } from '~/stores/playbackStore'
import { usePlayerStore } from '~/stores/playerStore'

/**
 * Playback speed: the common presets one click away, a fine slider for the
 * rest. `inline` renders just the panel, for the dock's overflow menu.
 */
defineProps<{ inline?: boolean }>()

const player = usePlayerStore()
const playback = usePlaybackStore()

const PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2]
const MIN = 0.25
const MAX = 4

const fmt = (v: number) => `${Number(v.toFixed(2))}×`

const speed = computed({
  get: () => player.playbackSpeed,
  set: v => playback.setSpeed(Math.max(MIN, Math.min(MAX, Math.round(v * 100) / 100))),
})
</script>

<template>
  <component :is="inline ? 'div' : UiPopover" v-bind="inline ? {} : { placement: 'top', width: '224px' }">
    <template v-if="!inline" #trigger="{ toggle, open }">
      <UiButton
        v-tip="{ text: 'Playback speed', kbd: '[ ]' }"
        variant="ghost"
        size="sm"
        class="num min-w-11"
        :class="open && speed === 1 ? '!bg-fg/8 !text-fg' : ''"
        :active="speed !== 1"
        aria-label="Playback speed"
        @click="toggle"
      >
        {{ fmt(speed) }}
      </UiButton>
    </template>

    <div class="flex flex-col gap-2.5" :class="inline ? '' : 'p-1'">
      <div class="flex items-center justify-between">
        <span class="eyebrow">Speed</span>
        <span class="text-[12px] text-fg num">{{ fmt(speed) }}</span>
      </div>
      <div class="gap-1 grid grid-cols-3">
        <button
          v-for="p in PRESETS"
          :key="p"
          type="button"
          class="text-[12px] num focusable rounded-[var(--radius-sm)] h-7 pressable"
          :class="speed === p ? 'bg-accent-soft text-accent-300 font-medium' : 'bg-fg/5 text-fg-muted hover:bg-fg/10 hover:text-fg'"
          @click="speed = p"
        >
          {{ fmt(p) }}
        </button>
      </div>
      <UiSlider v-model="speed" :min="MIN" :max="MAX" :step="0.05" :reset="1" hide-value />
      <p class="hint">
        Double-click the slider for 1×. Keys: <span class="num">[ ]</span> step, <span class="num">\</span> reset.
      </p>
    </div>
  </component>
</template>
