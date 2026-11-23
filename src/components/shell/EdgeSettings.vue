<script setup lang="ts">
/**
 * Settings → Edges: edges on or off, a ready-made kind, and each part of one
 * (how fast it backs off, how far, how long it holds, how long it takes to
 * build back up), with a picture of the shape.
 */
import { computed } from 'vue'
import UiField from '~/components/ui/UiField.vue'
import UiKbd from '~/components/ui/UiKbd.vue'
import UiSegmented from '~/components/ui/UiSegmented.vue'
import UiSlider from '~/components/ui/UiSlider.vue'
import UiSwitch from '~/components/ui/UiSwitch.vue'
import { EDGE_PRESETS, edgeTotalSec, fallOf, MIN_FALL_SEC, presetOf } from '~/lib/edging'
import { DEFAULT_EDGE, useSessionControlStore } from '~/stores/sessionControlStore'

const control = useSessionControlStore()
const s = computed(() => control.settings)

const CUSTOM = 'custom'
const preset = computed(() => presetOf(s.value))
const options = computed(() => [
  ...EDGE_PRESETS.map(p => ({ value: p.id, label: p.label })),
  ...(preset.value ? [] : [{ value: CUSTOM, label: 'Your own' }]),
])
const presetModel = computed({
  get: () => preset.value?.id ?? CUSTOM,
  set: (id: string) => {
    const p = EDGE_PRESETS.find(x => x.id === id)
    if (p)
      control.settings = { ...control.settings, fallSec: p.fallSec, depth: p.depth, cooldownSec: p.cooldownSec, rebuildSec: p.rebuildSec }
  },
})

function field<K extends 'fallSec' | 'depth' | 'cooldownSec' | 'rebuildSec'>(key: K) {
  return computed({
    get: () => (key === 'fallSec' ? fallOf(s.value) : s.value[key]),
    set: (v: number) => { control.settings = { ...control.settings, [key]: v } },
  })
}
const fall = field('fallSec')
const depth = field('depth')
const hold = field('cooldownSec')
const rebuild = field('rebuildSec')

const enabled = computed({
  get: () => s.value.enabled,
  set: (on: boolean) => { control.settings = { ...control.settings, enabled: on } },
})

const secs = (v: number) => (v < 10 ? `${Math.round(v * 10) / 10} s` : `${Math.round(v)} s`)
const fallLabel = (v: number) => (v < 0.05 ? 'At once' : secs(v))
const howFar = (v: number) => (v >= 0.995 ? 'Stops' : `Leaves ${Math.round((1 - v) * 100)}%`)

/** The shape over the whole edge: intensity against time, the hold shaded. */
const W = 300
const H = 56
const shape = computed(() => {
  const total = Math.max(0.1, edgeTotalSec(s.value))
  const x = (t: number) => (t / total) * W
  const y = (holdBack: number) => 4 + holdBack * (H - 8)
  const smooth = (p: number) => p * p * (3 - 2 * p)
  const f = fallOf(s.value)
  const d = Math.max(0, Math.min(1, s.value.depth))
  const pts: string[] = []
  const n = 24
  for (let i = 0; i <= n; i++)
    pts.push(`${x((f * i) / n).toFixed(1)},${y(d * smooth(i / n)).toFixed(1)}`)
  pts.push(`${x(f + s.value.cooldownSec).toFixed(1)},${y(d).toFixed(1)}`)
  for (let i = 1; i <= n; i++)
    pts.push(`${x(f + s.value.cooldownSec + (s.value.rebuildSec * i) / n).toFixed(1)},${y(d * (1 - smooth(i / n))).toFixed(1)}`)
  return { line: `M${pts.join(' L')}`, holdFrom: x(f), holdTo: x(f + s.value.cooldownSec), total }
})
</script>

<template>
  <div class="px-4 py-3 card flex flex-col gap-3">
    <UiSwitch
      v-model="enabled"
      label="Edges"
      :hint="enabled
        ? 'Backs everything off for a while, then builds again: the motion, vibration, e-stim and the session sound. Called with E, the edge buttons, the phone, a rule, a programme or the heart-rate guard.'
        : 'Off: nothing calls an edge, and the edge buttons are gone. Programmes still follow their own arc.'"
    />
    <p v-if="enabled" class="hint">
      <UiKbd>E</UiKbd> calls one; pressing it again while one runs holds it longer.
    </p>
  </div>

  <div v-if="enabled" class="px-4 py-3 card flex flex-col gap-3">
    <UiField label="What an edge does" :hint="preset?.hint ?? 'Your own settings, below.'">
      <UiSegmented v-model="presetModel" :options="options" size="xs" />
    </UiField>

    <div class="rounded-[var(--radius-sm)] bg-surface-950/70 h-14 ring-1 ring-edge relative overflow-hidden" aria-hidden="true">
      <svg class="h-full w-full inset-0 absolute" :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none">
        <rect :x="shape.holdFrom" y="0" :width="Math.max(0, shape.holdTo - shape.holdFrom)" :height="H" class="fill-accent/10" />
        <path :d="shape.line" fill="none" class="stroke-accent" stroke-width="2" vector-effect="non-scaling-stroke" />
      </svg>
      <span class="text-[10.5px] text-fg-faint num right-1.5 top-1 absolute">{{ secs(shape.total) }} in all</span>
    </div>

    <UiSlider
      v-model="fall"
      label="Backs off in"
      :min="MIN_FALL_SEC" :max="3" :step="0.1" :reset="DEFAULT_EDGE.fallSec"
      :format="fallLabel"
      hint="How fast it comes down once called. Quicker is a sharper stop for the device; at 0 it drops the moment you call it."
    />
    <UiSlider
      v-model="depth"
      label="How far down"
      :min="0.5" :max="1" :step="0.05" :reset="DEFAULT_EDGE.depth"
      :format="howFar"
      hint="At 100% everything stops; lower leaves some movement going."
    />
    <UiSlider
      v-model="hold"
      label="Holds for"
      :min="0" :max="90" :step="1" :reset="DEFAULT_EDGE.cooldownSec"
      :format="secs"
      hint="How long it stays down. I'm OK (on the phone, or the edge badge) ends it early."
    />
    <UiSlider
      v-model="rebuild"
      label="Builds back up over"
      :min="0" :max="90" :step="1" :reset="DEFAULT_EDGE.rebuildSec"
      :format="secs"
    />
  </div>
</template>
