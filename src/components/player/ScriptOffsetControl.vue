<script setup lang="ts">
import type { ScriptFile } from '~/stores/scriptStore'
import { computed } from 'vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiPopover from '~/components/ui/UiPopover.vue'
import { useScriptStore } from '~/stores/scriptStore'

/**
 * Per-axis script offset, for scripts made against a slightly different cut
 * of the video. `inline` renders just the panel, for the dock's overflow menu.
 */
defineProps<{ inline?: boolean }>()

const scriptStore = useScriptStore()

const STEP = 50
const LIMIT = 9999

const clamp = (v: number) => Math.max(-LIMIT, Math.min(LIMIT, Math.round(v)))

function setOffset(script: ScriptFile, raw: string) {
  const n = Number.parseInt(raw, 10)
  script.offsetMs = Number.isNaN(n) ? 0 : clamp(n)
}

function nudgeAll(delta: number) {
  scriptStore.scripts.forEach(s => (s.offsetMs = clamp(s.offsetMs + delta)))
}

function resetAll() {
  scriptStore.scripts.forEach(s => (s.offsetMs = 0))
}

const anyOffset = computed(() => scriptStore.scripts.some(s => s.offsetMs !== 0))

/** What the trigger shows: the shared offset, or "mixed" when axes differ. */
const summary = computed(() => {
  const set = new Set(scriptStore.scripts.map(s => s.offsetMs))
  if (!anyOffset.value)
    return ''
  if (set.size > 1)
    return 'mixed'
  const v = [...set][0]
  return `${v > 0 ? '+' : ''}${v}`
})
</script>

<template>
  <component :is="inline ? 'div' : UiPopover" v-bind="inline ? {} : { placement: 'top', width: '288px' }">
    <template v-if="!inline" #trigger="{ toggle, open }">
      <UiButton
        v-tip="'Script offset'"
        variant="ghost"
        size="sm"
        icon="i-carbon-time"
        class="num"
        :class="[open && !anyOffset ? '!bg-fg/8 !text-fg' : '', summary ? '' : '!px-0 w-7']"
        :active="anyOffset"
        aria-label="Script offset"
        @click="toggle"
      >
        <span v-if="summary">{{ summary }}</span>
      </UiButton>
    </template>

    <div class="flex flex-col gap-2.5" :class="inline ? '' : 'p-1'">
      <div class="flex items-center justify-between">
        <span class="eyebrow">Script offset</span>
        <UiButton variant="ghost" size="xs" :disabled="!anyOffset" @click="resetAll">
          Reset
        </UiButton>
      </div>

      <p v-if="!scriptStore.scripts.length" class="text-[12.5px] text-fg-muted py-2">
        No script loaded. Offsets apply per axis once one is.
      </p>

      <div v-else class="flex flex-col gap-1">
        <div
          v-for="script in scriptStore.scripts"
          :key="script.path + script.channel"
          class="flex gap-2 h-8 items-center"
        >
          <UiBadge tone="accent" size="xs" class="num">
            {{ script.channel }}
          </UiBadge>
          <span v-tip="script.label" class="text-[12px] text-fg-muted flex-1 min-w-0 truncate">
            {{ script.label }}<span v-if="script.isAlt" class="text-fg-faint"> · {{ script.altName }}</span>
          </span>
          <div class="well flex shrink-0 items-center">
            <button
              type="button"
              class="text-fg-muted focusable rounded-[var(--radius-sm)] center h-7 w-6 pressable hover:text-fg hover:bg-fg/8"
              :aria-label="`${script.channel} earlier`"
              @click="script.offsetMs = clamp(script.offsetMs - STEP)"
            >
              <span class="i-carbon-subtract text-[13px]" />
            </button>
            <input
              type="number"
              :step="STEP"
              :value="script.offsetMs"
              class="text-[12px] text-fg num text-center outline-none bg-transparent h-7 w-14"
              :aria-label="`${script.channel} offset in milliseconds`"
              @change="setOffset(script, ($event.target as HTMLInputElement).value)"
            >
            <button
              type="button"
              class="text-fg-muted focusable rounded-[var(--radius-sm)] center h-7 w-6 pressable hover:text-fg hover:bg-fg/8"
              :aria-label="`${script.channel} later`"
              @click="script.offsetMs = clamp(script.offsetMs + STEP)"
            >
              <span class="i-carbon-add text-[13px]" />
            </button>
          </div>
        </div>

        <div v-if="scriptStore.scripts.length > 1" class="mt-1 pt-2 border-t border-edge flex gap-2 items-center">
          <span class="text-[12px] text-fg-muted flex-1">All axes</span>
          <UiButton size="xs" variant="subtle" class="num" @click="nudgeAll(-STEP)">
            −{{ STEP }}
          </UiButton>
          <UiButton size="xs" variant="subtle" class="num" @click="nudgeAll(STEP)">
            +{{ STEP }}
          </UiButton>
        </div>
      </div>

      <p class="hint">
        In milliseconds. Positive runs the script ahead of the video, negative behind it.
      </p>
    </div>
  </component>
</template>
