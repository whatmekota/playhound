<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useSessionActions } from '~/composables/useSessionActions'
import { formatTime } from '~/lib/time'
import { useSessionControlStore } from '~/stores/sessionControlStore'

/**
 * The edge button and, while an edge runs, its countdown.
 *
 * Idle it is a plain "Edge" button (dock only — over the video nothing shows
 * until one is called). Live it becomes a pill: a ring for what is left of
 * the whole edge, how many this session, the phase with its own countdown,
 * and "I'm OK" to end the hold early. Pressing the pill itself means "still
 * close" and restarts the hold.
 */
const props = withDefaults(defineProps<{
  /** `dock` in theme colours; `overlay` white on glass, over the video. */
  variant?: 'dock' | 'overlay'
}>(), { variant: 'dock' })

const ctl = useSessionControlStore()
const { edge, release } = useSessionActions()

const live = computed(() => ctl.phase !== 'idle')
const holding = computed(() => ctl.phase === 'falling' || ctl.phase === 'holding')
const count = computed(() => ctl.edges.length)

/**
 * Length of the edge as it was called, for the ring. Taken from the countdown
 * itself, so a second press (which restarts it) refills the ring and an
 * early release empties it in one step, both of which read correctly.
 */
const total = ref(0)
watch(() => ctl.remainingSec, (r, old) => {
  if (r <= 0)
    total.value = 0
  else if (r > (old ?? 0) + 0.25)
    total.value = r
})
const left = computed(() => (total.value > 0 ? Math.max(0, Math.min(1, ctl.remainingSec / total.value)) : 0))

const phaseText = computed(() => holding.value
  ? `Holding ${formatTime(Math.ceil(Math.max(0, ctl.remainingSec - ctl.settings.rebuildSec)), '0:00')}`
  : `Easing back ${formatTime(Math.ceil(ctl.remainingSec), '0:00')}`)

const R = 7
const C = 2 * Math.PI * R
</script>

<template>
  <!-- Idle: the button -->
  <button
    v-if="!live && props.variant === 'dock'"
    v-tip="{ text: 'Edge — back everything off for a while', kbd: 'E' }"
    type="button"
    class="eb-idle text-[11.5px] font-medium px-2 focusable rounded-[var(--radius-sm)] flex gap-1.5 h-7 whitespace-nowrap pressable items-center"
    aria-label="Edge"
    @click="edge('ui')"
  >
    <span class="i-carbon-temperature-hot text-[14px]" />
    Edge
    <span v-if="count" class="text-[10.5px] text-fg-faint num">{{ count }}</span>
  </button>

  <!-- Live: countdown, still close, I'm OK -->
  <div
    v-else-if="live"
    class="eb-live flex shrink-0 animate-scale-in items-center"
    :class="props.variant === 'overlay' ? 'eb-overlay text-white p-1 rounded-full bg-black/55 gap-1 ring-1 ring-white/12 shadow-[var(--shadow-lg)] backdrop-blur-xl' : 'gap-0.5'"
    role="status"
    :aria-label="`Edge ${count}: ${phaseText}`"
  >
    <button
      v-tip="{ text: 'Still close — hold again', kbd: 'E' }"
      type="button"
      class="text-[11.5px] font-medium focusable rounded-full flex gap-1.5 whitespace-nowrap pressable items-center"
      :class="props.variant === 'overlay' ? 'pl-1 pr-2 h-8 hover:bg-white/12' : 'eb-pill pl-1 pr-2.5 h-7'"
      @click="edge('ui')"
    >
      <svg viewBox="0 0 20 20" class="shrink-0 h-5 w-5 -rotate-90" aria-hidden="true">
        <circle cx="10" cy="10" :r="R" fill="none" stroke="currentColor" stroke-opacity="0.22" stroke-width="2.5" />
        <circle
          cx="10" cy="10" :r="R" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"
          :stroke-dasharray="C" :stroke-dashoffset="C * (1 - left)"
        />
      </svg>
      <span>Edge <span class="num">{{ count }}</span></span>
      <span class="opacity-50">·</span>
      <span class="num" :class="props.variant === 'overlay' ? 'text-white/75' : 'text-fg-muted'">{{ phaseText }}</span>
    </button>
    <Transition name="t-pop">
      <button
        v-if="holding"
        v-tip="{ text: 'End the hold and start easing back', kbd: '⇧E' }"
        type="button"
        class="text-[11.5px] font-medium px-2.5 focusable rounded-full flex gap-1 h-7 whitespace-nowrap pressable items-center"
        :class="props.variant === 'overlay' ? 'text-black bg-white hover:bg-white/90' : 'text-ok bg-ok/14 hover:bg-ok/22'"
        @click="release()"
      >
        <span class="i-carbon-checkmark text-[12px]" />
        I’m OK
      </button>
    </Transition>
  </div>
</template>

<style scoped>
.eb-idle {
  color: var(--warn);
  background: color-mix(in srgb, var(--warn) 10%, transparent);
  transition:
    background-color var(--dur-fast),
    transform var(--dur-fast);
}
.eb-idle:hover {
  background: color-mix(in srgb, var(--warn) 18%, transparent);
}

.eb-pill {
  color: var(--warn);
  background: color-mix(in srgb, var(--warn) 14%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--warn) 30%, transparent);
  transition: background-color var(--dur-fast);
}
.eb-pill:hover {
  background: color-mix(in srgb, var(--warn) 22%, transparent);
}
</style>
