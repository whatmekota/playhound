<script setup lang="ts">
import { ref } from 'vue'
import LatencyCalibrateModal from '~/components/device/LatencyCalibrateModal.vue'
import UiButton from '~/components/ui/UiButton.vue'
import { useDeviceLatency } from '~/composables/useVideoSync'
import { clampLatency, LATENCY_LIMIT_MS } from '~/lib/latency'

/**
 * Device latency: the number, a step either way, the tap-along calibration
 * and a reset. The Device panel's Latency section and the first-run setup's
 * device step are both this. `calibrate` off leaves the calibration out, for
 * a device it can't move (it drives the stroke over TCode only).
 */
withDefaults(defineProps<{ calibrate?: boolean }>(), { calibrate: true })

const latency = useDeviceLatency()
const calibrating = ref(false)
const STEP = 10

function setLatency(v: number) {
  latency.value = clampLatency(v)
}
function onInput(e: Event) {
  const el = e.target as HTMLInputElement
  setLatency(Number.parseInt(el.value, 10) || 0)
  el.value = String(latency.value)
}
</script>

<template>
  <div class="flex gap-2 items-center">
    <div class="flex flex-1 flex-col min-w-0">
      <span class="text-[12.5px] text-fg">Device latency</span>
      <span class="hint">Added to every script's own offset</span>
    </div>
    <div class="well flex shrink-0 items-center">
      <button
        type="button"
        class="text-fg-muted focusable rounded-[var(--radius-sm)] center h-7 w-6 pressable hover:text-fg hover:bg-fg/8"
        aria-label="Less latency"
        @click="setLatency(latency - STEP)"
      >
        <span class="i-carbon-subtract text-[13px]" />
      </button>
      <input
        type="number"
        :step="STEP"
        :min="-LATENCY_LIMIT_MS"
        :max="LATENCY_LIMIT_MS"
        :value="latency"
        class="text-[12px] text-fg num text-center outline-none bg-transparent h-7 w-14"
        aria-label="Device latency in milliseconds"
        @change="onInput"
      >
      <button
        type="button"
        class="text-fg-muted focusable rounded-[var(--radius-sm)] center h-7 w-6 pressable hover:text-fg hover:bg-fg/8"
        aria-label="More latency"
        @click="setLatency(latency + STEP)"
      >
        <span class="i-carbon-add text-[13px]" />
      </button>
    </div>
    <span class="text-[11.5px] text-fg-faint">ms</span>
  </div>

  <div class="flex gap-1.5 items-center">
    <UiButton v-if="calibrate" size="xs" icon="i-carbon-touch-1" @click="calibrating = true">
      Calibrate…
    </UiButton>
    <UiButton size="xs" variant="ghost" icon="i-carbon-reset" class="ml-auto" :disabled="!latency" @click="setLatency(0)">
      Reset
    </UiButton>
  </div>

  <p class="hint">
    Positive sends commands earlier, for a device that arrives late. Leave it at 0 unless strokes feel behind the video on every script.
  </p>

  <LatencyCalibrateModal v-if="calibrate" v-model:open="calibrating" />
</template>
