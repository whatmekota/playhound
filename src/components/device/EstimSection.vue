<script setup lang="ts">
import type { EstimMapping } from '~/lib/estim'
import { computed, onMounted, ref } from 'vue'
import { useEstim } from '~/composables/useEstim'
import { toast } from '~/composables/useToast'
import { CARRIER_DEFAULT_HZ, CARRIER_MAX_HZ, CARRIER_MIN_HZ, startDuration } from '~/lib/estim'
import { useSafetyStore } from '~/stores/safetyStore'
import { useSessionControlStore } from '~/stores/sessionControlStore'

/**
 * The Device panel's e-stim audio section (experimental): pick an output,
 * set the volume and its limit, and Start. See useEstim for the safety rules.
 */

const estim = useEstim()
const safety = useSafetyStore()
const control = useSessionControlStore()
const s = estim.settings

const open = ref(estim.running.value)
const pct = (v: number) => `${Math.round(v * 100)}%`

onMounted(() => void estim.refreshOutputs())

const OUTPUT_OPTIONS = computed(() => {
  const list = estim.outputs.value
    .filter(o => o.deviceId !== 'default' && o.deviceId !== 'communications')
    .map((o, i) => ({ value: o.deviceId, label: o.label || `Output ${i + 1} (name hidden)` }))
  const opts = [{ value: '', label: 'Choose an output…' }, ...list]
  // Remembered but not plugged in: keep it visible, by its old name.
  if (s.value.sinkId && !list.some(o => o.value === s.value.sinkId))
    opts.push({ value: s.value.sinkId, label: `${s.value.sinkLabel || 'Last used output'} (not found)` })
  return opts
})
const output = computed({
  get: () => s.value.sinkId,
  set: (id: string) => estim.setOutput(id),
})

const MAPPINGS: { value: EstimMapping, label: string, title: string }[] = [
  { value: 'threephase', label: 'Three-phase', title: 'restim\'s signal for three electrodes on a stereo box: the stroke moves the sensation from the left and right electrodes to the common one' },
  { value: 'balance', label: 'Two channels', title: 'Two separate channels: the stroke pans the carrier from left (bottom) to right (top)' },
]
const mapping = computed({
  get: () => s.value.mapping,
  set: (m: EstimMapping) => {
    s.value = { ...s.value, mapping: m }
  },
})

const volume = computed({
  get: () => s.value.volume,
  set: (v: number) => estim.setVolume(v),
})
const ceiling = computed({
  get: () => s.value.ceiling,
  set: (v: number) => estim.setCeiling(v),
})
const carrier = computed({
  get: () => s.value.carrierHz,
  set: (v: number) => {
    s.value = { ...s.value, carrierHz: v }
  },
})

const limitsOpen = ref(false)

const summary = computed(() => {
  switch (estim.state.value) {
    case 'starting': return 'Starting'
    case 'on': return pct(estim.meter.level)
    case 'waiting': return 'Waiting'
    case 'stopping': return 'Stopping'
    default: return 'Off'
  }
})

const stateLine = computed<{ tone: 'ok' | 'info' | 'warn' | 'idle' | 'danger', text: string }>(() => {
  switch (estim.state.value) {
    case 'starting':
      return { tone: 'info', text: `Fading in from silence (about ${Math.round(startDuration(Math.min(s.value.volume, s.value.ceiling)))} s)` }
    case 'on':
      return { tone: 'ok', text: 'Following the stroke' }
    case 'waiting':
      return { tone: 'idle', text: 'Silent until something moves the stroke' }
    case 'stopping':
      return { tone: 'warn', text: 'Fading out' }
  }
  if (estim.stoppedBy.value === 'panic')
    return { tone: 'danger', text: 'Stopped by panic. Press Start when you are ready.' }
  if (estim.stoppedBy.value === 'output-lost')
    return { tone: 'danger', text: 'The output went away, so it stopped.' }
  return { tone: 'idle', text: 'Off. Starts silent and fades in.' }
})

const DOT = {
  ok: 'bg-ok',
  info: 'bg-info',
  warn: 'bg-warn',
  danger: 'bg-danger',
  idle: 'bg-fg-faint',
}

async function start() {
  if (await estim.start())
    toast('E-stim audio started', { detail: 'Fading in from silence', icon: 'i-carbon-volume-up', key: 'estim' })
  else if (estim.error.value)
    toast.error('E-stim audio', { detail: estim.error.value, key: 'estim' })
}

function stop() {
  estim.stop()
  toast('E-stim audio stopped', { icon: 'i-carbon-volume-mute', key: 'estim' })
}
</script>

<template>
  <UiSection
    v-model:open="open"
    title="E-stim audio"
    icon="i-carbon-flash"
    collapsible
    :live="estim.state.value === 'on'"
    :summary="summary"
  >
    <template #actions>
      <UiBadge size="xs" tone="warn">
        Experimental
      </UiBadge>
    </template>

    <div class="text-[12px] text-fg-muted leading-relaxed px-2.5 py-2 border border-warn/20 rounded-[var(--radius-md)] bg-warn/8 flex gap-2">
      <span class="i-carbon-warning-alt text-[15px] text-warn mt-px shrink-0" />
      <div class="flex flex-col gap-1 min-w-0">
        <p class="text-fg font-medium">
          18+. Untested on real hardware.
        </p>
        <ul class="pl-3.5 list-disc flex flex-col gap-0.5">
          <li>Only through a stim box made for audio input. Never wire electrodes to a headphone jack.</li>
          <li>Never above the waist, never across the chest, never with a pacemaker or a heart condition.</li>
          <li>Start low: turn the box down first, then raise it slowly.</li>
          <li>Stop at once if anything hurts, stings or burns.</li>
        </ul>
      </div>
    </div>

    <div class="flex flex-col gap-1">
      <UiSelect v-model="output" label="Sound output" :options="OUTPUT_OPTIONS" size="md" />
      <div class="flex gap-1 items-center">
        <span class="hint flex-1 min-w-0">Not the one your video plays on.</span>
        <UiButton v-if="!estim.namesShown.value" size="xs" variant="ghost" icon="i-carbon-view" @click="estim.showNames()">
          Show names
        </UiButton>
        <UiIconButton icon="i-carbon-renew" label="Look for outputs again" size="xs" @click="estim.refreshOutputs()" />
      </div>
      <p v-if="!estim.namesShown.value" class="hint">
        Browsers hide output names until the page may use a microphone. Show names asks once and closes it straight away; nothing is recorded.
      </p>
    </div>

    <div
      v-if="estim.problem.value && s.sinkId"
      class="text-[12px] text-danger px-2.5 py-2 rounded-[var(--radius-md)] bg-danger/10 flex gap-2 ring-1 ring-danger/20"
    >
      <span class="i-carbon-error-filled text-[14px] mt-px shrink-0" />
      <span class="min-w-0">{{ estim.problem.value }}</span>
    </div>

    <div class="flex flex-col gap-1">
      <span class="label">Signal</span>
      <UiSegmented v-model="mapping" :options="MAPPINGS" size="xs" block />
    </div>

    <UiSlider
      v-model="volume"
      label="Volume"
      :max="s.ceiling"
      :step="0.005"
      :format="pct"
      tone="warn"
      hint="Changes fade in slowly. Your limit is the top of this slider."
    />

    <div class="flex flex-col">
      <button
        type="button"
        class="text-[11.5px] text-fg-faint px-1 focusable rounded-[var(--radius-sm)] flex gap-1.5 h-6 transition-colors items-center hover:text-fg-muted"
        :aria-expanded="limitsOpen"
        @click="limitsOpen = !limitsOpen"
      >
        <span class="i-carbon-chevron-right text-[11px] transition-transform duration-200" :class="limitsOpen ? 'rotate-90' : ''" />
        <span>Limit and carrier</span>
        <span class="num ml-auto">max {{ pct(s.ceiling) }} · {{ s.carrierHz }} Hz</span>
      </button>
      <Transition name="t-collapse">
        <div v-if="limitsOpen">
          <div class="min-h-0 overflow-hidden">
            <div class="pt-1.5 flex flex-col gap-2.5">
              <UiSlider
                v-model="ceiling"
                label="Volume limit"
                :min="0.01"
                :max="1"
                :step="0.01"
                :format="pct"
                :reset="0.25"
                tone="danger"
                hint="Nothing goes above this, whatever drives it. Set the system volume for this output once and leave it."
              />
              <UiSlider
                v-model="carrier"
                label="Carrier"
                :min="CARRIER_MIN_HZ"
                :max="CARRIER_MAX_HZ"
                :step="10"
                unit=" Hz"
                :reset="CARRIER_DEFAULT_HZ"
                hint="The tone itself. restim uses 700 Hz; lower feels rougher, higher smoother."
              />
            </div>
          </div>
        </div>
      </Transition>
    </div>

    <div class="text-[12px] px-2.5 rounded-[var(--radius-sm)] bg-surface-950/60 flex gap-2 h-8 items-center">
      <span class="rounded-full shrink-0 h-1.5 w-1.5" :class="DOT[stateLine.tone]" />
      <span class="text-fg-muted truncate">{{ stateLine.text }}</span>
    </div>

    <div v-if="estim.running.value" class="gap-2 grid grid-cols-2 animate-fade-in">
      <div class="flex flex-col gap-1">
        <div class="flex items-baseline justify-between">
          <span class="label">Left</span>
          <span class="text-[11.5px] text-fg num">{{ pct(estim.meter.left) }}</span>
        </div>
        <UiProgress :value="s.ceiling ? estim.meter.left / s.ceiling : 0" />
      </div>
      <div class="flex flex-col gap-1">
        <div class="flex items-baseline justify-between">
          <span class="label">Right</span>
          <span class="text-[11.5px] text-fg num">{{ pct(estim.meter.right) }}</span>
        </div>
        <UiProgress :value="s.ceiling ? estim.meter.right / s.ceiling : 0" />
      </div>
    </div>

    <UiButton
      v-if="!estim.armed.value"
      variant="primary"
      block
      icon="i-carbon-play-filled-alt"
      :disabled="!!estim.problem.value || safety.panicked"
      @click="start"
    >
      Start
    </UiButton>
    <UiButton v-else variant="secondary" block icon="i-carbon-stop-filled-alt" @click="stop">
      Stop
    </UiButton>

    <p class="hint">
      Follows the stroke from the script, the motion generator or a plugin, scaled by the intensity knob
      ({{ pct(control.effectiveIntensity) }} now) and edges. Silent when nothing moves; fades out on pause and stop,
      cuts out at once on panic. Off every time the app starts.
    </p>
  </UiSection>
</template>
