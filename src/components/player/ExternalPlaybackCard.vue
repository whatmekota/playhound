<script setup lang="ts">
import { computed } from 'vue'
import UiButton from '~/components/ui/UiButton.vue'
import { formatTime } from '~/lib/time'
import { usePlaybackStore } from '~/stores/playbackStore'
import { usePlayerStore } from '~/stores/playerStore'
import { useSafetyStore } from '~/stores/safetyStore'

/**
 * Where the picture would be while the video plays in another app (a VR
 * headset): what plays, where, and a way to stop following it. The device
 * and the timeline follow the other app's clock (playbackStore.playExternal).
 */
defineProps<{ mini?: boolean }>()

const playback = usePlaybackStore()
const player = usePlayerStore()
const safety = useSafetyStore()

const s = computed(() => playback.external)
const time = computed(() => `${formatTime(player.currentTime, '0:00')}${player.videoDuration > 0 ? ` / ${formatTime(player.videoDuration, '0:00')}` : ''}`)
const state = computed(() => {
  // The clock isn't reactive; the player's time, which follows it, is.
  void player.currentTime
  if (safety.panicked)
    return 'Device stopped (panic)'
  if (!s.value?.clock.started)
    return `Waiting for ${s.value?.label}…`
  const r = s.value.clock.read(performance.now())
  if (r.stale)
    return `Nothing heard from ${s.value.label}: device stopped`
  return player.isPlaying ? 'Playing' : 'Paused'
})
</script>

<template>
  <div v-if="s" class="text-white center inset-0 absolute z-[1]" :class="mini ? 'p-3' : 'p-8'">
    <div class="text-center flex flex-col gap-2 max-w-[440px] items-center">
      <span class="i-carbon-augmented-reality text-white/70" :class="mini ? 'text-[22px]' : 'text-[40px]'" aria-hidden="true" />
      <p class="text-white/60 font-medium" :class="mini ? 'text-[11px]' : 'text-[13px]'">
        Playing in {{ s.label }}
      </p>
      <h2 v-if="!mini" class="text-[17px] text-white font-semibold max-w-full truncate">
        {{ s.title }}
      </h2>
      <p class="text-white/70 num" :class="mini ? 'text-[11px]' : 'text-[12.5px]'">
        {{ state }} · {{ time }}
      </p>
      <p v-if="!mini" class="text-[12px] text-white/50 leading-relaxed">
        The device follows {{ s.label }}'s clock with your latency, offset, intensity and edges.
        {{ s.controllable ? 'Play, pause and seek here go to it too.' : 'Play, pause and seek there.' }}
      </p>
      <UiButton
        class="pointer-events-auto"
        :class="mini ? 'mt-0.5' : 'mt-2'"
        :size="mini ? 'xs' : 'sm'"
        icon="i-carbon-stop-filled-alt"
        @click.stop="playback.endExternal('stopped')"
      >
        Stop following
      </UiButton>
    </div>
  </div>
</template>
