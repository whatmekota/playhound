<script setup lang="ts">
import type { Chapter } from '~/lib/chapters'
import { computed } from 'vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiIconButton from '~/components/ui/UiIconButton.vue'
import UiPopover from '~/components/ui/UiPopover.vue'
import UiSwitch from '~/components/ui/UiSwitch.vue'
import { useLoopSection } from '~/composables/useLoopSection'
import { useScriptAnalysis } from '~/composables/useScriptAnalysis'
import { chapterAt, chaptersForScript } from '~/lib/chapters'
import { formatTime } from '~/lib/time'
import { usePlaybackStore } from '~/stores/playbackStore'
import { usePlayerStore } from '~/stores/playerStore'

/**
 * A–B loop: mark two points at the playhead and repeat what is between them.
 * The same points can be dragged on the timeline or set from its context menu,
 * and "Loop this chapter" sets both to the script chapter under the playhead.
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

// ─── Chapters ────────────────────────────────────────────────────────────────
const { analysis, source } = useScriptAnalysis()
const chapters = computed(() => chaptersForScript(source.value, player.videoDuration, analysis.value?.peaks, playback.scriptMetadata))
const chapter = computed<Chapter | null>(() =>
  chapters.value.length > 1 ? chapterAt(chapters.value, player.currentTime * 1000) : null)

/** The loop already spans this chapter, give or take a rounding. */
const loopingChapter = computed(() => {
  const c = chapter.value
  return !!c && player.loopActive
    && Math.abs((player.loopStart ?? -1) - c.start / 1000) < 0.05
    && Math.abs((player.loopEnd ?? -1) - c.end / 1000) < 0.3
})

function loopChapter() {
  const c = chapter.value
  if (!c)
    return
  if (loopingChapter.value) {
    player.loopEnabled = false
    return
  }
  player.setLoopStart(c.start / 1000)
  // A loop end at the very end would never be reached before the video ends.
  player.setLoopEnd(player.videoDuration > 1 ? Math.min(c.end / 1000, player.videoDuration - 0.25) : c.end / 1000)
  player.loopEnabled = true
}
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

      <UiButton
        v-if="chapter"
        variant="subtle"
        size="sm"
        icon="i-carbon-repeat"
        block
        :active="loopingChapter"
        class="!justify-start"
        @click="loopChapter"
      >
        <span class="text-left flex-1 truncate">{{ loopingChapter ? 'Looping chapter' : 'Loop this chapter' }}</span>
        <span class="text-[11.5px] opacity-70 truncate">{{ chapter.name }}</span>
      </UiButton>

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
