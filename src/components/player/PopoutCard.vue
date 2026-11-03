<script setup lang="ts">
import { computed } from 'vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiKbd from '~/components/ui/UiKbd.vue'
import UiSlider from '~/components/ui/UiSlider.vue'
import UiSwitch from '~/components/ui/UiSwitch.vue'
import { MIN_OPACITY, usePopout } from '~/composables/usePopout'
import { usePlaybackStore } from '~/stores/playbackStore'
import { usePlayerStore } from '~/stores/playerStore'

/**
 * What the player stage shows while the video is in the pop-out window: where
 * it went, the pop-out's own settings, and the way back.
 *
 * Click-through lives here as well as on the global key, since a window that
 * lets clicks through cannot be clicked to stop it.
 */
const popout = usePopout()
const playback = usePlaybackStore()
const player = usePlayerStore()

const opacity = computed({
  get: () => popout.opacity.value,
  set: (v: number) => (popout.opacity.value = Math.max(MIN_OPACITY, Math.min(1, v))),
})

const title = computed(() => {
  if (playback.currentEntry)
    return playback.currentEntry.basename
  return player.videoPath?.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') ?? ''
})

const note = computed(() => {
  if (popout.kind === 'pip')
    return 'The browser keeps it on top of other windows. See-through and click-through need the desktop app.'
  if (popout.kind === 'window')
    return 'This browser cannot keep it on top of other windows. Chrome, Edge and the desktop app can.'
  return null
})
</script>

<template>
  <div class="text-fg p-6 bg-surface-950 center select-none">
    <div class="flex flex-col gap-5 max-w-[360px] w-full animate-rise items-center">
      <span class="text-[22px] text-accent-300 rounded-[var(--radius-lg)] bg-accent-soft center h-12 w-12">
        <span class="i-carbon-popup" />
      </span>
      <div class="text-center flex flex-col gap-1.5 min-w-0 w-full">
        <h2 class="text-[17px] tracking-[-0.01em] font-semibold m-0">
          Playing in the pop-out
        </h2>
        <p v-if="title" class="text-[12.5px] text-fg-muted m-0 truncate">
          {{ title }}
        </p>
      </div>

      <div
        v-if="popout.kind === 'desktop'"
        class="p-4 border border-edge rounded-[var(--radius-lg)] bg-surface-850/80 flex flex-col gap-4 w-full"
      >
        <UiSlider
          v-model="opacity"
          label="Opacity"
          :min="MIN_OPACITY"
          :max="1"
          :step="0.05"
          :reset="1"
          :format="v => `${Math.round(v * 100)}%`"
        />
        <UiSwitch
          v-model="popout.clickThrough.value"
          label="Let clicks through"
          :hint="popout.shortcut.value
            ? 'Clicks go to the window underneath. The key below switches it from any app.'
            : 'Clicks go to the window underneath. Switch it off here to use the pop-out again.'"
        />
        <p v-if="popout.shortcut.value" class="text-[12px] text-fg-muted m-0 flex gap-2 items-center">
          <UiKbd>{{ popout.shortcut.value }}</UiKbd>
          click-through on / off
        </p>
      </div>
      <p v-else-if="note" class="text-[12.5px] text-fg-muted leading-relaxed m-0 text-center">
        {{ note }}
      </p>

      <UiButton variant="primary" icon="i-carbon-pop-in" @click="popout.close()">
        Bring it back
      </UiButton>
    </div>
  </div>
</template>
