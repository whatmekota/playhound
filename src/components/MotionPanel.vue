<script setup lang="ts">
import { computed } from 'vue'
import { useGamepadStatus } from '~/composables/useGamepadStatus'
import { useMotionEngine } from '~/composables/useMotionEngine'
import { synthTargets } from '~/lib/axisSynth'
import { useAudioStore } from '~/stores/audio'
import { useDeviceStore } from '~/stores/deviceStore'
import { MOTION_SOURCES, useMotionStore } from '~/stores/motionStore'
import { useScriptStore } from '~/stores/scriptStore'

const motion = useMotionStore()
const audio = useAudioStore()
const device = useDeviceStore()
const scriptStore = useScriptStore()
const { shouldRun, funscriptBusy } = useMotionEngine()
const pad = useGamepadStatus()

const SYNTH_AXES = [
  { key: 'synthTwist', label: 'Twist', hint: 'R0 — turns slowly and continuously' },
  { key: 'synthRoll', label: 'Roll', hint: 'R1 — leans into the direction of travel' },
  { key: 'synthSurge', label: 'Surge', hint: 'L1 — trails the stroke at reduced depth' },
] as const

const MANUAL_MODES = [
  { id: 'oscillate', label: 'Rate', hint: 'The stick sets how fast it strokes.' },
  { id: 'direct', label: 'Direct', hint: 'The stick is the position — the device follows your thumb.' },
] as const

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

/** Derived channels that are both selected and enabled on the device. */
const derivedReady = computed(() => {
  const wanted = synthTargets(
    scriptStore.activeScripts.map(s => s.channel),
    {
      depth: motion.synthDepth,
      twist: motion.synthTwist,
      roll: motion.synthRoll,
      surge: motion.synthSurge,
    },
  )
  return wanted.filter(c => device.axisConfigs[c]?.enabled)
})

/** Centre-out bar for a -1..1 stick value. */
function stickBar(v: number) {
  const half = Math.min(1, Math.abs(v)) * 50
  return v >= 0
    ? { left: '50%', width: `${half}%` }
    : { right: '50%', width: `${half}%` }
}

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

      <section v-if="motion.source === 'manual'" class="space-y-1.5">
        <p class="label">
          Stick behaviour
        </p>
        <div class="flex gap-1">
          <button
            v-for="m in MANUAL_MODES"
            :key="m.id"
            class="text-[11px] px-2 py-1 rounded-md flex-1 transition-colors"
            :class="motion.manualMode === m.id
              ? 'bg-white/15 text-white'
              : 'bg-white/5 text-white/40 hover:bg-white/10'"
            :title="m.hint"
            @click="motion.manualMode = m.id"
          >
            {{ m.label }}
          </button>
        </div>
        <p class="hint">
          {{ MANUAL_MODES.find(m => m.id === motion.manualMode)?.hint }}
        </p>
      </section>

      <section class="pt-1 border-t border-white/5 space-y-1.5">
        <div class="flex items-center justify-between">
          <p class="label">
            Fill idle axes
          </p>
          <label class="text-[11px] text-fg-muted flex gap-1.5 cursor-pointer items-center">
            <input v-model="motion.synthEnabled" type="checkbox">
            On
          </label>
        </div>
        <p class="hint">
          Derives twist, roll and surge from the stroke curve, so a one-axis
          script still moves a multi-axis device. Never overrides an axis the
          script actually drives.
        </p>

        <div v-if="motion.synthEnabled" class="pt-0.5 space-y-2">
          <div class="flex gap-1">
            <button
              v-for="a in SYNTH_AXES"
              :key="a.key"
              class="text-[11px] px-2 py-1 rounded-md flex-1 transition-colors"
              :class="motion[a.key]
                ? 'bg-white/15 text-white'
                : 'bg-white/5 text-white/40 hover:bg-white/10'"
              :title="a.hint"
              @click="motion[a.key] = !motion[a.key]"
            >
              {{ a.label }}
            </button>
          </div>

          <div>
            <div class="text-[10px] text-white/40 mb-1 flex justify-between">
              <span>Depth</span>
              <span class="font-mono">{{ (motion.synthDepth * 100).toFixed(0) }}%</span>
            </div>
            <input v-model.number="motion.synthDepth" type="range" min="0" max="1" step="0.01" class="accent w-full">
          </div>

          <p v-if="!derivedReady.length" class="hint text-amber-400/80">
            The axes it would drive are switched off in the Device panel, so
            nothing will move.
          </p>
          <p v-else class="hint">
            Driving {{ derivedReady.join(', ') }}.
          </p>
        </div>
      </section>

      <section class="pt-1 border-t border-white/5 space-y-1.5">
        <div class="flex items-center justify-between">
          <p class="label">
            Gamepad
          </p>
          <label class="text-[11px] text-fg-muted flex gap-1.5 cursor-pointer items-center">
            <input v-model="motion.gamepadEnabled" type="checkbox">
            On
          </label>
        </div>

        <div v-if="motion.gamepadEnabled" class="space-y-1.5">
          <div class="text-[11px] flex gap-2 items-center">
            <span
              class="rounded-full shrink-0 h-1.5 w-1.5"
              :class="pad.connected.value ? 'bg-emerald-400' : 'bg-fg/25'"
            />
            <span :class="pad.connected.value ? 'text-fg-muted' : 'text-fg-faint'" class="truncate">
              {{ pad.connected.value ? (pad.padName.value || 'Connected') : 'No gamepad detected' }}
            </span>
          </div>
          <p v-if="!pad.connected.value" class="hint">
            Press a button on the pad to wake it — browsers hide gamepads until
            they are used.
          </p>

          <!-- Live axis values: makes "is the stick being read?" answerable
               without opening devtools. -->
          <div v-else class="space-y-1">
            <div class="text-[10px] text-fg-faint font-mono flex gap-2 items-center">
              <span class="shrink-0 w-14">Left Y</span>
              <div class="rounded-full bg-fg/10 flex-1 h-1 relative overflow-hidden">
                <div
                  class="bg-emerald-400 bottom-0 top-0 absolute"
                  :style="stickBar(-(pad.axes.value[1] ?? 0))"
                />
              </div>
              <span class="text-right w-9">{{ (-(pad.axes.value[1] ?? 0)).toFixed(2) }}</span>
            </div>
            <div class="text-[10px] text-fg-faint font-mono flex gap-2 items-center">
              <span class="shrink-0 w-14">Right Y</span>
              <div class="rounded-full bg-fg/10 flex-1 h-1 relative overflow-hidden">
                <div
                  class="bg-emerald-400 bottom-0 top-0 absolute"
                  :style="stickBar(-(pad.axes.value[3] ?? 0))"
                />
              </div>
              <span class="text-right w-9">{{ (-(pad.axes.value[3] ?? 0)).toFixed(2) }}</span>
            </div>
            <p v-if="pad.mapping.value && pad.mapping.value !== 'standard'" class="hint text-amber-400/80">
              This pad reports a non-standard layout, so the sticks may sit on
              different axes: {{ pad.axes.value.map(a => a.toFixed(1)).join(', ') }}
            </p>
            <p class="hint">
              Moving a stick switches the source to Manual.
            </p>
          </div>
          <dl class="text-[10px] text-fg-faint gap-x-2 gap-y-0.5 grid grid-cols-2">
            <dt>Left stick</dt><dd class="text-fg-muted">
              Rate / position
            </dd>
            <dt>Right stick</dt><dd class="text-fg-muted">
              Depth
            </dd>
            <dt>A</dt><dd class="text-fg-muted">
              Play / pause
            </dd>
            <dt>B</dt><dd class="text-fg-muted">
              Output on / off
            </dd>
            <dt>Y</dt><dd class="text-fg-muted">
              Random video
            </dd>
            <dt>LB / RB</dt><dd class="text-fg-muted">
              Previous / next
            </dd>
            <dt>Start</dt><dd class="text-fg-muted">
              Panic
            </dd>
          </dl>
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
