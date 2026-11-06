<script setup lang="ts">
import type { ScriptTweaks, SmoothLevel } from '~/lib/scriptTweaks'
import { computed } from 'vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiIconButton from '~/components/ui/UiIconButton.vue'
import UiSegmented from '~/components/ui/UiSegmented.vue'
import UiSlider from '~/components/ui/UiSlider.vue'
import UiSwitch from '~/components/ui/UiSwitch.vue'
import { MAX_SPEED_CAP } from '~/lib/scriptTweaks'
import { useScriptEditStore } from '~/stores/scriptEditStore'
import { useScriptStore } from '~/stores/scriptStore'

/**
 * How one axis plays on this video: range, invert, a speed cap, smoothing
 * and the offset. Saved with the video, never written into the script.
 */
const props = defineProps<{ channel: string }>()

const scripts = useScriptStore()
const edit = useScriptEditStore()

const OFFSET_STEP = 50
/** The range never closes up completely: a script squeezed to one position does nothing. */
const MIN_SPAN = 5

const t = computed(() => scripts.tweaksFor(props.channel))
const set = (patch: Partial<ScriptTweaks>) => scripts.setTweaks(props.channel, patch)

const low = computed({
  get: () => t.value.min,
  set: v => set({ min: Math.min(v, t.value.max - MIN_SPAN) }),
})
const high = computed({
  get: () => t.value.max,
  set: v => set({ max: Math.max(v, t.value.min + MIN_SPAN) }),
})
const invert = computed({
  get: () => t.value.invert,
  set: v => set({ invert: v }),
})
const cap = computed({
  get: () => t.value.speedCap,
  set: v => set({ speedCap: v }),
})
const smooth = computed({
  get: () => t.value.smooth,
  set: (v: SmoothLevel) => set({ smooth: v }),
})

const SMOOTH_OPTIONS: { value: SmoothLevel, label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'light', label: 'Light' },
  { value: 'medium', label: 'Medium' },
]

const tweaked = computed(() => scripts.isTweaked(props.channel))

function setOffset(raw: string) {
  const n = Number.parseInt(raw, 10)
  set({ offsetMs: Number.isNaN(n) ? 0 : n })
}
</script>

<template>
  <div class="px-3 py-2.5 border-t border-edge flex flex-col gap-3">
    <div class="flex gap-2 items-center">
      <span class="label flex-1">Offset</span>
      <UiIconButton icon="i-carbon-subtract" label="Script 50 ms later" size="xs" variant="solid" @click="set({ offsetMs: t.offsetMs - OFFSET_STEP })" />
      <input
        type="number"
        step="10"
        :value="t.offsetMs"
        aria-label="Offset in milliseconds"
        class="text-[12px] text-fg num text-center focusable border border-edge-strong rounded-[var(--radius-sm)] bg-surface-900 h-6 w-18"
        @change="setOffset(($event.target as HTMLInputElement).value)"
      >
      <UiIconButton icon="i-carbon-add" label="Script 50 ms earlier" size="xs" variant="solid" @click="set({ offsetMs: t.offsetMs + OFFSET_STEP })" />
    </div>

    <div class="flex flex-col gap-2">
      <UiSlider v-model="low" label="Lowest" :min="0" :max="100" :step="1" :reset="0" :format="v => String(v)" />
      <UiSlider v-model="high" label="Highest" :min="0" :max="100" :step="1" :reset="100" :format="v => String(v)" hint="The script’s 0–100 is fitted into this range." />
    </div>

    <UiSwitch v-model="invert" size="sm" label="Invert" hint="Up becomes down." />

    <UiSlider
      v-model="cap"
      label="Speed limit"
      :min="0"
      :max="MAX_SPEED_CAP"
      :step="50"
      :reset="0"
      :format="v => (v ? `${v} /s` : 'Off')"
      hint="Strokes faster than this get shorter, still on the beat."
    />

    <div class="flex gap-2 items-center justify-between">
      <span class="label">Smoothing</span>
      <UiSegmented v-model="smooth" :options="SMOOTH_OPTIONS" size="xs" />
    </div>

    <div class="flex gap-1.5 items-center">
      <UiButton size="xs" variant="ghost" icon="i-carbon-reset" :disabled="!tweaked" @click="scripts.resetTweaks(channel)">
        Reset
      </UiButton>
      <UiButton
        v-tip="'Save a copy of the script with these tweaks written in, to use elsewhere'"
        size="xs"
        variant="ghost"
        icon="i-carbon-document-export"
        class="ml-auto"
        :disabled="!tweaked"
        @click="edit.exportTweaked()"
      >
        Export tweaked script
      </UiButton>
    </div>
    <p class="hint -mt-1.5">
      Saved with this video; the script file is left as it is. A positive offset plays the script earlier.
    </p>
  </div>
</template>
