<script setup lang="ts">
import type { EdgePreset } from '~/lib/edging'
import { ref } from 'vue'
import UiKbd from '~/components/ui/UiKbd.vue'
import { useCompactLayout } from '~/composables/useCompactLayout'
import { EDGE_PRESETS, edgeShape, presetOf, withPreset } from '~/lib/edging'
import { isTouchOnly } from '~/lib/platform'
import { useSessionControlStore } from '~/stores/sessionControlStore'

/**
 * The setup's edges step: on or off, and which kind (EDGE_PRESETS, the same
 * as Settings → Edges, where each part has a slider of its own). Kept as a
 * draft until Next, so Skip leaves them as they were.
 */
const control = useSessionControlStore()
const compact = useCompactLayout()

const enabled = ref(control.settings.enabled)
/** null: settings of the user's own, which no preset matches; left alone unless one is picked. */
const preset = ref<string | null>(presetOf(control.settings)?.id ?? null)

const W = 120
const H = 28
const shapes = Object.fromEntries(EDGE_PRESETS.map(p => [p.id, edgeShape(p, W, H)]))
const secs = (v: number) => `${Math.round(v)} s`

function pickPreset(p: EdgePreset) {
  preset.value = p.id
  enabled.value = true
}

defineExpose({
  commit() {
    const p = EDGE_PRESETS.find(x => x.id === preset.value)
    const base = p ? withPreset(control.settings, p) : control.settings
    control.settings = { ...base, enabled: enabled.value }
  },
})
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="gap-2.5 grid grid-cols-2" role="radiogroup" aria-label="Edges">
      <button
        v-for="o in [
          { on: true, icon: 'i-carbon-hourglass', title: 'Edges on', sub: 'Call one when you get close' },
          { on: false, icon: 'i-carbon-close-outline', title: 'No edges', sub: 'Nothing backs off' },
        ]"
        :key="String(o.on)"
        type="button"
        role="radio"
        :aria-checked="enabled === o.on"
        class="p-3 text-left focusable rounded-[var(--radius-lg)] flex gap-2.5 transition-[box-shadow,background-color] duration-200 items-center"
        :class="enabled === o.on ? 'ring-2 ring-accent bg-accent-soft' : 'ring-1 ring-edge-strong hover:ring-fg/25'"
        @click="enabled = o.on"
      >
        <span :class="[o.icon, enabled === o.on ? 'text-accent-300' : 'text-fg-muted']" class="text-[18px] shrink-0" />
        <span class="flex flex-col gap-0.5 min-w-0">
          <span class="text-[13px] text-fg font-medium">{{ o.title }}</span>
          <span class="hint">{{ o.sub }}</span>
        </span>
      </button>
    </div>

    <template v-if="enabled">
      <div class="flex flex-col gap-2">
        <span class="label">What an edge does</span>
        <div class="gap-2.5 grid" :class="compact ? 'grid-cols-1' : 'grid-cols-2'" role="radiogroup" aria-label="What an edge does">
          <button
            v-for="p in EDGE_PRESETS"
            :key="p.id"
            type="button"
            role="radio"
            :aria-checked="preset === p.id"
            class="p-3 text-left focusable rounded-[var(--radius-lg)] flex flex-col gap-2 transition-[box-shadow,background-color] duration-200"
            :class="preset === p.id ? 'ring-2 ring-accent bg-accent-soft' : 'ring-1 ring-edge-strong hover:ring-fg/25'"
            @click="pickPreset(p)"
          >
            <span class="flex gap-2 items-center justify-between">
              <span class="text-[13px] text-fg font-medium">{{ p.label }}</span>
              <span class="text-[11px] text-fg-faint num">{{ secs(shapes[p.id].total) }}</span>
            </span>
            <svg class="h-7 w-full" :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" aria-hidden="true">
              <rect :x="shapes[p.id].holdFrom" y="0" :width="Math.max(0, shapes[p.id].holdTo - shapes[p.id].holdFrom)" :height="H" class="fill-accent/10" />
              <path :d="shapes[p.id].line" fill="none" class="stroke-accent" stroke-width="2" vector-effect="non-scaling-stroke" />
            </svg>
            <span class="hint">{{ p.hint }}</span>
          </button>
        </div>
        <p v-if="!preset" class="hint m-0">
          Yours are settings of your own; they stay unless you pick one of these.
        </p>
      </div>
      <p class="hint m-0">
        <template v-if="!isTouchOnly">
          <UiKbd>E</UiKbd> calls an edge,
        </template>
        <template v-else>
          The edge button calls one,
        </template>
        and so can the phone remote, a rule or the heart-rate guard. Everything backs off: the motion, vibration,
        e-stim and the session sound. Settings → Edges has each part on a slider.
      </p>
    </template>
    <p v-else class="hint m-0">
      Nothing calls an edge, and the edge buttons are gone. Programmes still follow their own arc. Settings → Edges
      turns them on again.
    </p>
  </div>
</template>
