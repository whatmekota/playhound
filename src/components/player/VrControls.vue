<script setup lang="ts">
import type { VrEye } from '~/lib/vrFormat'
import UiSegmented from '~/components/ui/UiSegmented.vue'
import UiSelect from '~/components/ui/UiSelect.vue'
import UiSwitch from '~/components/ui/UiSwitch.vue'
import { VR_FORMATS } from '~/lib/vrFormat'
import { usePlayerStore } from '~/stores/playerStore'

/**
 * The VR view's settings: on or off, the layout, which eye, and whether VR
 * videos open in it by themselves. The player bar's VR menu and the compact
 * player's sheet both show it; `always` keeps format and eye in view while
 * the VR view is off (the menu that exists only for them).
 */
defineProps<{ always?: boolean }>()

const player = usePlayerStore()
const formatOptions = VR_FORMATS.map(f => ({ value: f.id, label: f.label }))
const eyeOptions: { value: VrEye, label: string }[] = [
  { value: 'left', label: 'Left' },
  { value: 'right', label: 'Right' },
]
</script>

<template>
  <UiSwitch v-model="player.sbs180" label="VR view" hint="Side-by-side video, drag to look around" />
  <template v-if="always || player.sbs180">
    <UiSelect v-model="player.vrFormat" label="Format" :options="formatOptions" />
    <div class="flex gap-3 items-center justify-between">
      <span v-tip="'Some videos are sharper or better framed in one eye. Remembered for each video.'" class="text-[12.5px] text-fg-muted">Eye</span>
      <UiSegmented v-model="player.vrEye" :options="eyeOptions" size="xs" />
    </div>
  </template>
  <UiSwitch
    v-model="player.vrAuto"
    label="Open VR videos in it"
    hint="By name, a “vr” tag, or a 2:1 picture. What you set for a video wins."
  />
</template>
