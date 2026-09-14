<script setup lang="ts">
import { computed } from 'vue'
import { useMotionEngine } from '~/composables/useMotionEngine'
import { useAudioStore } from '~/stores/audio'
import { useDeviceStore } from '~/stores/deviceStore'
import { MOTION_SOURCES, useMotionStore } from '~/stores/motionStore'

const motion = useMotionStore()
const audio = useAudioStore()
const device = useDeviceStore()
const { shouldRun, funscriptBusy } = useMotionEngine()

const SHAPES = [
  { id: 'sine', label: 'Sine' },
  { id: 'ease', label: 'Ease' },
  { id: 'pulse', label: 'Pulse' },
] as const

const statusText = computed(() => {
  if (!motion.enabled)
    return 'Output off'
  if (motion.source === 'funscript')
    return 'Script drives the device'
  if (funscriptBusy.value)
    return 'Script is playing, it has priority'
  return shouldRun.value ? 'Generating' : 'Idle'
})

const statusTone = computed(() => {
  if (!motion.enabled)
    return 'text-white/30'
  if (shouldRun.value)
    return 'text-emerald-400'
  if (funscriptBusy.value)
    return 'text-amber-400'
  return 'text-white/40'
})

/** Bar heights for the little live stroke meter. */
const meter = computed(() => {
  const pos = motion.currentPos
  return Array.from({ length: 9 }, (_, i) => {
    const d = Math.abs(i / 8 - pos)
    return Math.max(0.12, 1 - d * 2.2)
  })
})

const sourceHint = computed(() =>
  MOTION_SOURCES.find(s => s.id === motion.source)?.hint ?? '',
)
</script>

<template>
  <div class="flex flex-col h-full">
    <div class="p-3 space-y-4">
      <p class="text-[11px] font-medium" :class="statusTone">
        {{ statusText }}
      </p>
      <button
        class="text-xs font-medium px-3 py-2 rounded-lg flex gap-2 w-full transition-colors items-center justify-center"
        :class="motion.enabled
          ? 'bg-emerald-600/20 text-emerald-300 hover:bg-emerald-600/30'
          : 'bg-white/5 text-white/50 hover:bg-white/10'"
        @click="motion.enabled = !motion.enabled"
      >
        <div :class="motion.enabled ? 'i-carbon-pause-filled' : 'i-carbon-play-filled'" />
        {{ motion.enabled ? 'Stop output' : 'Start output' }}
      </button>

      <p v-if="!device.connected" class="text-[10px] text-amber-400/70 -mt-2">
        No device connected. Output still drives the emulator.
      </p>

      <section class="space-y-1.5">
        <p class="label">
          Source
        </p>
        <div class="gap-1 grid grid-cols-2">
          <button
            v-for="s in MOTION_SOURCES"
            :key="s.id"
            class="text-xs px-2 py-1.5 text-left rounded-md transition-colors"
            :class="motion.source === s.id
              ? 'bg-emerald-600/20 text-emerald-300'
              : 'bg-white/5 text-white/50 hover:bg-white/10'"
            :title="s.hint"
            @click="motion.source = s.id"
          >
            {{ s.label }}
          </button>
        </div>
        <p class="text-[10px] text-white/30 leading-snug">
          {{ sourceHint }}
        </p>
      </section>

      <section v-if="motion.isGenerated" class="p-2.5 panel space-y-2">
        <div class="flex gap-0.5 h-8 items-end">
          <div
            v-for="(h, i) in meter"
            :key="i"
            class="rounded-sm bg-emerald-400/70 flex-1 transition-all duration-75"
            :style="{ height: `${h * 100}%` }"
          />
        </div>
        <div class="text-[10px] text-white/50 font-mono flex items-center justify-between">
          <span>{{ motion.currentSpm.toFixed(0) }} spm</span>
          <span>depth {{ (motion.currentDepth * 100).toFixed(0) }}%</span>
          <span v-if="motion.source === 'beat'">/{{ motion.beatDivisor }}</span>
          <span v-else>{{ audio.phase.value }}</span>
        </div>
      </section>

      <section v-if="motion.source === 'manual'" class="space-y-2.5">
        <div>
          <div class="text-[10px] text-white/40 mb-1 flex justify-between">
            <span>Rate</span>
            <span class="font-mono">{{ motion.manualSpm }} spm</span>
          </div>
          <input v-model.number="motion.manualSpm" type="range" min="0" :max="motion.maxSpm" step="1" class="accent w-full">
        </div>
        <div>
          <div class="text-[10px] text-white/40 mb-1 flex justify-between">
            <span>Depth</span>
            <span class="font-mono">{{ (motion.manualDepth * 100).toFixed(0) }}%</span>
          </div>
          <input v-model.number="motion.manualDepth" type="range" min="0" max="1" step="0.01" class="accent w-full">
        </div>
      </section>

      <section v-if="motion.source === 'session'" class="space-y-2.5">
        <p class="label">
          Intensity maps to
        </p>
        <div class="text-[10px] text-white/40 flex gap-2 items-center">
          <input v-model.number="motion.minSpm" type="number" min="0" max="300" class="input text-xs py-1 w-16">
          <span>to</span>
          <input v-model.number="motion.sessionMaxSpm" type="number" min="0" max="300" class="input text-xs py-1 w-16">
          <span>spm</span>
        </div>
        <div class="text-[10px] text-white/40 flex gap-2 items-center">
          <input v-model.number="motion.minDepth" type="number" min="0" max="1" step="0.05" class="input text-xs py-1 w-16">
          <span>to</span>
          <input v-model.number="motion.maxDepth" type="number" min="0" max="1" step="0.05" class="input text-xs py-1 w-16">
          <span>depth</span>
        </div>
      </section>

      <section v-if="motion.source === 'beat'" class="space-y-2.5">
        <p class="label">
          Keep stroke within
        </p>
        <div class="text-[10px] text-white/40 flex gap-2 items-center">
          <input v-model.number="motion.beatBandLo" type="number" min="0" max="300" class="input text-xs py-1 w-16">
          <span>to</span>
          <input v-model.number="motion.beatBandHi" type="number" min="0" max="300" class="input text-xs py-1 w-16">
          <span>spm</span>
        </div>
        <p class="text-[10px] text-white/30 leading-snug">
          The beat is divided by a power of two to land in this band.
          Currently {{ audio.beatDelta.value.toFixed(1) }} Hz over {{ motion.beatDivisor }}.
        </p>
      </section>

      <section v-if="motion.isGenerated" class="space-y-1.5">
        <p class="label">
          Shape
        </p>
        <div class="flex gap-1">
          <button
            v-for="s in SHAPES"
            :key="s.id"
            class="text-[11px] px-2 py-1 rounded-md flex-1 transition-colors"
            :class="motion.shape === s.id
              ? 'bg-white/15 text-white'
              : 'bg-white/5 text-white/40 hover:bg-white/10'"
            @click="motion.shape = s.id"
          >
            {{ s.label }}
          </button>
        </div>
      </section>

      <section v-if="motion.isGenerated" class="space-y-1.5">
        <p class="label">
          Axes
        </p>
        <label class="text-xs text-white/50 flex gap-2 cursor-pointer items-center">
          <input v-model="motion.secondaryAxes" type="checkbox">
          Also drive twist and roll
        </label>
        <label class="text-xs text-white/50 flex gap-2 cursor-pointer items-center">
          <input v-model="motion.vibrateFromIntensity" type="checkbox">
          Vibration follows intensity
        </label>
      </section>

      <section v-if="motion.isGenerated" class="pt-1 border-t border-white/5 space-y-1.5">
        <p class="label">
          Safety
        </p>
        <div>
          <div class="text-[10px] text-white/40 mb-1 flex justify-between">
            <span>Speed ceiling</span>
            <span class="font-mono">{{ motion.maxSpm }} spm</span>
          </div>
          <input v-model.number="motion.maxSpm" type="range" min="20" max="240" step="5" class="accent w-full">
        </div>
        <p class="text-[10px] text-white/30 leading-snug">
          Generated motion never exceeds this, and rate changes ramp at
          {{ motion.spmRampPerSec }} spm/s rather than jumping.
        </p>
      </section>
    </div>
  </div>
</template>
