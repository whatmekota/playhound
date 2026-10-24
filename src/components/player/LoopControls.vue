<script setup lang="ts">
import { computed } from 'vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiIconButton from '~/components/ui/UiIconButton.vue'
import UiPopover from '~/components/ui/UiPopover.vue'
import UiSwitch from '~/components/ui/UiSwitch.vue'
import { useLoopSection } from '~/composables/useLoopSection'
import { formatTime } from '~/lib/time'
import { usePlaybackStore } from '~/stores/playbackStore'
import { usePlayerStore } from '~/stores/playerStore'

/**
 * A–B loop: mark two points at the playhead and repeat what is between them.
 * The same points can be dragged on the timeline or set from its context menu.
 * `inline` renders just the panel, for the dock's overflow menu.
 */
defineProps<{ inline?: boolean }>()

const player = usePlayerStore()
const playback = usePlaybackStore()
const loop = useLoopSection()

const enabled = computed({
  get: () => player.loopEnabled,
  set: (v) => {
    if (player.hasLoop)
      player.loopEnabled = v
  },
})

function markA() {
  loop.setLoopStart()
}

function markB() {
  loop.setLoopEnd()
  // Closing the range is the moment someone wants it to loop.
  if (player.hasLoop)
    player.loopEnabled = true
}

const span = computed(() =>
  player.hasLoop ? formatTime((player.loopEnd ?? 0) - (player.loopStart ?? 0)) : null)
</script>

<template>
  <component :is="inline ? 'div' : UiPopover" v-bind="inline ? {} : { placement: 'top', width: '252px' }">
    <template v-if="!inline" #trigger="{ toggle, open }">
      <UiButton
        v-tip="'A–B loop'"
        variant="ghost"
        size="sm"
        class="font-mono relative"
        :class="open && !player.loopActive ? '!bg-fg/8 !text-fg' : ''"
        :active="player.loopActive"
        aria-label="A–B loop"
        @click="toggle"
      >
        A–B
        <span
          v-if="player.loopStart !== null && !player.loopActive"
          class="rounded-full bg-accent h-1.5 w-1.5 right-1 top-1 absolute"
        />
      </UiButton>
    </template>

    <div class="flex flex-col gap-2.5" :class="inline ? '' : 'p-1'">
      <div class="flex items-center justify-between">
        <span class="eyebrow">A–B loop</span>
        <UiSwitch v-model="enabled" size="sm" :disabled="!player.hasLoop" aria-label="Loop on" />
      </div>

      <div class="gap-1.5 grid grid-cols-2">
        <button
          v-for="side in (['A', 'B'] as const)"
          :key="side"
          type="button"
          class="px-2.5 text-left focusable rounded-[var(--radius-sm)] flex flex-col gap-0.5 h-12 pressable justify-center"
          :class="(side === 'A' ? player.loopStart : player.loopEnd) !== null
            ? 'bg-accent-soft text-accent-300'
            : 'bg-fg/5 text-fg-muted hover:bg-fg/10 hover:text-fg'"
          :disabled="!player.videoUrl"
          @click="side === 'A' ? markA() : markB()"
        >
          <span class="text-[10.5px] tracking-[0.08em] font-semibold opacity-80 uppercase">Set {{ side }}</span>
          <span class="text-[13px] num">{{ formatTime(side === 'A' ? player.loopStart : player.loopEnd) }}</span>
        </button>
      </div>

      <div class="flex gap-1 items-center">
        <span class="hint flex-1">
          {{ span ? `${span} loop` : 'Marks the playhead' }}
        </span>
        <UiIconButton
          icon="i-carbon-skip-back"
          label="Jump to A"
          size="xs"
          :disabled="player.loopStart === null"
          @click="playback.seek(player.loopStart ?? 0)"
        />
        <UiIconButton
          icon="i-carbon-close"
          label="Clear loop"
          size="xs"
          :disabled="player.loopStart === null && player.loopEnd === null"
          @click="loop.clearLoop()"
        />
      </div>
      <p class="hint">
        Drag the markers on the timeline, or right-click it to set them anywhere.
      </p>
    </div>
  </component>
</template>
