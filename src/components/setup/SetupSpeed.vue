<script setup lang="ts">
import { computed, ref } from 'vue'
import UiSegmented from '~/components/ui/UiSegmented.vue'
import UiSlider from '~/components/ui/UiSlider.vue'
import { useMotionStore } from '~/stores/motionStore'

/**
 * The setup's speed step: the motion store's speed ceiling (maxSpm), the same
 * one as the Motion panel's Safety limits. Kept as a draft until Next, so
 * Skip leaves it as it was.
 */
const motion = useMotionStore()
const spm = ref(motion.maxSpm)

/** Where the Motion panel starts warning, for the same reason. */
const WARN_ABOVE = 180
const PICKS = [
  { value: 90, label: 'Gentle' },
  { value: 150, label: 'Standard' },
  { value: 180, label: 'Fast' },
]
const pick = computed({
  get: () => PICKS.find(p => p.value === spm.value)?.value ?? 0,
  set: (v: number) => {
    if (v)
      spm.value = v
  },
})
const pickOptions = computed(() => [
  ...PICKS.map(p => ({ value: p.value, label: `${p.label} · ${p.value}` })),
  // Something in between: shown, so the control never claims a pick it isn't.
  ...(PICKS.some(p => p.value === spm.value) ? [] : [{ value: 0, label: 'Your own' }]),
])

defineExpose({
  commit() {
    motion.maxSpm = Math.min(Math.max(20, spm.value), motion.ceilingTop)
  },
})
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="p-4 card flex flex-col gap-3">
      <div class="flex gap-2 items-baseline">
        <span class="text-[30px] text-fg leading-none tracking-[-0.02em] font-semibold num">{{ spm }}</span>
        <span class="text-[13px] text-fg-muted">strokes a minute, at most</span>
      </div>
      <UiSlider
        v-model="spm"
        label="Speed limit"
        :min="20"
        :max="motion.ceilingTop"
        :step="5"
        :reset="150"
        :tone="spm > WARN_ABOVE ? 'danger' : 'warn'"
        hide-value
      />
      <UiSegmented v-model="pick" :options="pickOptions" size="sm" block />
      <p v-if="spm > WARN_ABOVE" class="text-[12px] text-danger m-0 flex gap-1.5 items-start">
        <span class="i-carbon-warning-filled text-[14px] mt-px shrink-0" />
        Above {{ WARN_ABOVE }} most strokers lose their place and slam the ends. Go there only if yours keeps up.
      </p>
    </div>

    <div class="px-4 py-3 card flex gap-3 items-start">
      <span class="i-carbon-security text-[17px] text-warn mt-0.5 shrink-0" />
      <p class="text-[12.5px] text-fg-muted leading-relaxed m-0">
        Lower is gentler: softer turns at each end, less strain and heat for the device, and less of a jolt
        when the motion changes. You can raise it any time.
      </p>
    </div>

    <p class="hint m-0">
      It holds back the motion playhound makes itself: the motion generator, music, the gamepad and stroke pad,
      rules and plugins. Scripts play as their author wrote them; a script's own speed limit is in its tweaks,
      in the Scripts panel. This is the speed ceiling in the Motion panel.
    </p>
  </div>
</template>
