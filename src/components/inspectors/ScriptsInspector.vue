<script setup lang="ts">
import type { ScriptFile } from '~/stores/scriptStore'
import { computed, ref, toRaw } from 'vue'
import { useFunscript } from '~/composables/useFunscript'
import { analyseActions, analysisKey } from '~/composables/useScriptAnalysis'
import { AXIS_PRIORITY } from '~/lib/axisMap'
import { openScriptFiles } from '~/lib/browserApi'
import { speedToIntensity } from '~/lib/funscriptAnalysis'
import { formatTime } from '~/lib/time'
import { usePlaybackStore } from '~/stores/playbackStore'
import { usePlayerStore } from '~/stores/playerStore'
import { useScriptStore } from '~/stores/scriptStore'

const scripts = useScriptStore()
const player = usePlayerStore()
const playback = usePlaybackStore()
const { loadScriptFiles, loading, error } = useFunscript()

const OFFSET_LIMIT = 9999
const SPARK_BINS = 120

// Each axis gets a theme token rather than a fixed colour, so all four themes
// keep their own palette. Repeats are fine: the channel code sits next to it.
const AXIS_TONE: Record<string, string> = {
  L0: 'var(--accent)',
  L1: 'var(--info)',
  L2: 'var(--ok)',
  R0: 'var(--warn)',
  R1: 'var(--danger)',
  R2: 'var(--accent-light)',
  V0: 'var(--info)',
  A0: 'var(--warn)',
  A1: 'var(--danger)',
}
const toneOf = (channel: string) => AXIS_TONE[channel] ?? 'var(--text-muted)'

const keyOf = (s: ScriptFile) => `${s.path}\u0000${s.channel}`

// ─── Grouping ─────────────────────────────────────────────────────────────────
interface AxisGroup {
  channel: string
  label: string
  files: ScriptFile[]
  active: ScriptFile | null
}

const groups = computed<AxisGroup[]>(() => {
  const byChannel = new Map<string, ScriptFile[]>()
  for (const s of scripts.scripts) {
    const list = byChannel.get(s.channel) ?? []
    list.push(s)
    byChannel.set(s.channel, list)
  }
  const rank = (c: string) => {
    const i = AXIS_PRIORITY.indexOf(c)
    return i === -1 ? 99 : i
  }
  return [...byChannel.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([channel, files]) => ({
      channel,
      // The primary take first, then alternates by name.
      files: [...files].sort((a, b) => Number(a.isAlt) - Number(b.isAlt) || a.filename.localeCompare(b.filename)),
      label: files.find(f => !f.isAlt)?.label ?? files[0].label,
      active: files.find(f => f.enabled) ?? null,
    }))
})

const activeCount = computed(() => scripts.activeScripts.length)
const videoName = computed(() => player.videoPath?.split(/[\\/]/).pop() ?? null)

// ─── Analysis ─────────────────────────────────────────────────────────────────
interface Shape {
  /** Normalised speed per bin, 0-1. */
  bins: number[]
  meanSpm: number
  intensity: number
  durationMs: number
}

// Analyses are cached by the composable, so this only does real work the first
// time a script is seen. toRaw skips the reactive proxy on a hot loop over
// possibly 100k actions.
const shapes = computed(() => {
  const out = new Map<string, Shape>()
  for (const s of scripts.scripts) {
    const actions = toRaw(s.parsed.actions)
    if (actions.length < 2)
      continue
    const a = analyseActions(actions, analysisKey(s.filename, s.channel, actions.length))
    const bins = Array.from<number>({ length: SPARK_BINS }).fill(0)
    const env = a.envelope
    for (let i = 0; i < env.length; i++) {
      const b = Math.min(SPARK_BINS - 1, Math.floor((i / env.length) * SPARK_BINS))
      if (env[i].speed > bins[b])
        bins[b] = env[i].speed
    }
    const peak = a.peakSpeed || 1
    out.set(keyOf(s), {
      bins: bins.map(v => v / peak),
      meanSpm: a.meanSpm,
      intensity: speedToIntensity(a.meanSpeed),
      durationMs: a.durationMs,
    })
  }
  return out
})

/** The timeline everything is drawn against: the video, or the script if it runs longer. */
function spanMs(s: ScriptFile) {
  return Math.max(player.videoDuration * 1000, s.parsed.duration, 1)
}

function sparkPath(s: ScriptFile): string {
  const shape = shapes.value.get(keyOf(s))
  if (!shape)
    return ''
  const w = (s.parsed.duration / spanMs(s)) * 100
  const n = shape.bins.length
  let d = `M0,24`
  shape.bins.forEach((v, i) => {
    d += ` L${((i / (n - 1)) * w).toFixed(2)},${(24 - Math.max(0.04, v) * 22).toFixed(2)}`
  })
  return `${d} L${w.toFixed(2)},24 Z`
}

// The sparkline is drawn in script time. A positive offset plays the script
// early (useVideoSync reads it at video time + offset), so map through that.
function playheadPct(s: ScriptFile) {
  return Math.min(100, ((player.currentTime * 1000 + s.offsetMs) / spanMs(s)) * 100)
}

function seekFromSpark(e: MouseEvent, s: ScriptFile) {
  if (!player.videoUrl)
    return
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))
  playback.seek(Math.max(0, f * spanMs(s) - s.offsetMs) / 1000)
}

function intensityLabel(v: number) {
  return v < 0.25 ? 'Gentle' : v < 0.5 ? 'Steady' : v < 0.75 ? 'Brisk' : 'Intense'
}

function coverage(s: ScriptFile): number | null {
  if (!player.videoDuration || !s.parsed.actions.length)
    return null
  return Math.min(100, Math.round((s.parsed.duration / (player.videoDuration * 1000)) * 100))
}
const coverageTone = (pct: number) => (pct >= 90 ? 'ok' : pct >= 60 ? 'warn' : 'danger') as 'ok' | 'warn' | 'danger'

// ─── Actions ──────────────────────────────────────────────────────────────────
function pick(s: ScriptFile) {
  scripts.toggleScript(s.path, s.channel)
}

async function loadManually() {
  const files = await openScriptFiles()
  if (!files.length)
    return
  const base = player.videoPath?.replace(/\.[^.]+$/, '') ?? ''
  await loadScriptFiles(files, base)
}

// ─── Offsets ──────────────────────────────────────────────────────────────────
const clampOffset = (v: number) => Math.max(-OFFSET_LIMIT, Math.min(OFFSET_LIMIT, Math.round(v)))

function nudge(s: ScriptFile, delta: number) {
  s.offsetMs = clampOffset(s.offsetMs + delta)
}
function setOffset(s: ScriptFile, raw: string) {
  const n = Number.parseInt(raw, 10)
  s.offsetMs = Number.isNaN(n) ? 0 : clampOffset(n)
}

const anyOffset = computed(() => scripts.scripts.some(s => s.offsetMs !== 0))
const offsetsDiffer = computed(() => new Set(scripts.scripts.map(s => s.offsetMs)).size > 1)

/** One offset for every axis, which is what you want when the whole video is out of sync. */
const sharedOffset = computed({
  get: () => scripts.primaryScript?.offsetMs ?? scripts.scripts[0]?.offsetMs ?? 0,
  set: (v: number) => scripts.scripts.forEach(s => (s.offsetMs = clampOffset(v))),
})

function resetOffsets() {
  scripts.scripts.forEach(s => (s.offsetMs = 0))
}

const fmtOffset = (v: number) => `${v > 0 ? '+' : ''}${v} ms`

/** Which axis card has its offset row open. */
const tuning = ref<string | null>(null)
</script>

<template>
  <UiPanel gap="sm">
    <template #toolbar>
      <div class="flex gap-2 items-center">
        <div class="flex flex-1 flex-col min-w-0">
          <span class="text-[12.5px] text-fg truncate">
            {{ scripts.hasScripts ? `${activeCount} of ${scripts.scripts.length} axes on` : 'No scripts' }}
          </span>
          <span v-if="videoName" v-tip="videoName" class="hint truncate">{{ videoName }}</span>
        </div>
        <UiBadge v-if="scripts.hasScripts" :tone="scripts.autoDetected ? 'accent' : 'neutral'" size="xs" :icon="scripts.autoDetected ? 'i-carbon-flash' : 'i-carbon-document'">
          {{ scripts.autoDetected ? 'Auto' : 'Manual' }}
        </UiBadge>
        <UiIconButton
          v-if="scripts.hasScripts"
          icon="i-carbon-close"
          label="Unload all scripts"
          size="sm"
          tip="bottom"
          @click="scripts.clearScripts()"
        />
        <UiButton size="sm" icon="i-carbon-document-add" :loading="loading" @click="loadManually">
          Load
        </UiButton>
      </div>
      <p v-if="error" class="text-[11.5px] text-danger flex gap-1.5 items-center">
        <span class="i-carbon-warning-filled shrink-0" />
        <span class="truncate">{{ error }}</span>
      </p>
    </template>

    <UiEmpty
      v-if="!scripts.hasScripts"
      icon="i-carbon-chart-line"
      title="No scripts loaded"
      :description="player.videoUrl
        ? 'Nothing matched this video. Load .funscript files by hand — one per axis, or a merged multi-axis file.'
        : 'Play a video from the library and its scripts are picked up automatically.'"
    >
      <UiButton variant="primary" icon="i-carbon-document-add" :loading="loading" @click="loadManually">
        Load scripts
      </UiButton>
    </UiEmpty>

    <TransitionGroup v-else name="t-list" tag="div" class="flex flex-col gap-2 relative">
      <section
        v-for="g in groups"
        :key="g.channel"
        class="card overflow-hidden"
        :style="{ '--axis': toneOf(g.channel) }"
        :class="g.active ? '' : 'opacity-70'"
      >
        <!-- Axis header -->
        <header class="pl-3 pr-1.5 flex gap-2 h-9 items-center">
          <span
            class="rounded-full shrink-0 h-2 w-2 transition-[background-color,box-shadow]"
            :class="g.active ? 'bg-[var(--axis)] shadow-[0_0_0_3px_color-mix(in_srgb,var(--axis)_22%,transparent)]' : 'bg-fg/20'"
          />
          <span class="text-[11.5px] text-fg-muted font-medium num">{{ g.channel }}</span>
          <span class="text-[13px] text-fg font-medium truncate">{{ g.label }}</span>
          <UiBadge v-if="g.files.length > 1" size="xs" class="ml-1">
            {{ g.files.length }} takes
          </UiBadge>
          <div class="ml-auto flex gap-0.5 items-center">
            <UiIconButton
              v-if="g.active"
              icon="i-carbon-time"
              :label="g.active.offsetMs ? `Offset ${fmtOffset(g.active.offsetMs)}` : 'Offset this axis'"
              size="xs"
              :active="tuning === g.channel || g.active.offsetMs !== 0"
              @click="tuning = tuning === g.channel ? null : g.channel"
            />
            <UiSwitch
              :model-value="!!g.active"
              size="sm"
              :aria-label="`${g.label} on`"
              class="mx-1"
              @update:model-value="pick(g.active ?? g.files[0])"
            />
          </div>
        </header>

        <!-- Shape of the active take -->
        <div v-if="g.active && shapes.get(keyOf(g.active))" class="px-3 pb-2.5 flex flex-col gap-1.5">
          <div
            v-tip="player.videoUrl ? 'Click to seek' : undefined"
            class="well h-9 relative overflow-hidden"
            :class="player.videoUrl ? 'cursor-pointer' : ''"
            @click="seekFromSpark($event, g.active)"
          >
            <svg viewBox="0 0 100 24" preserveAspectRatio="none" class="h-full w-full inset-0 absolute">
              <path :d="sparkPath(g.active)" fill="color-mix(in srgb, var(--axis) 26%, transparent)" stroke="var(--axis)" stroke-width="0.6" vector-effect="non-scaling-stroke" />
            </svg>
            <span
              v-if="player.videoUrl"
              class="bg-fg/80 w-px pointer-events-none bottom-0 top-0 absolute"
              :style="{ left: `${Math.max(0, playheadPct(g.active))}%` }"
            />
          </div>
          <div class="text-[11px] text-fg-faint flex flex-wrap gap-x-3 gap-y-0.5 items-center">
            <span v-tip="'Average speed across the script'" class="text-fg-muted">
              {{ intensityLabel(shapes.get(keyOf(g.active))!.intensity) }}
            </span>
            <span class="num">{{ Math.round(shapes.get(keyOf(g.active))!.meanSpm) }} spm</span>
            <span class="num">{{ g.active.parsed.actions.length.toLocaleString() }} pts</span>
            <span class="num">{{ formatTime(g.active.parsed.duration / 1000) }}</span>
            <UiBadge
              v-if="coverage(g.active) !== null"
              v-tip="'How much of the video the script covers'"
              :tone="coverageTone(coverage(g.active)!)"
              size="xs"
              class="ml-auto"
            >
              {{ coverage(g.active) }}%
            </UiBadge>
          </div>
        </div>

        <!-- Per-axis offset -->
        <Transition name="t-collapse">
          <div v-if="g.active && tuning === g.channel">
            <div class="min-h-0 overflow-hidden">
              <div class="px-3 py-2 border-t border-edge flex gap-2 items-center">
                <span class="label flex-1">Offset</span>
                <UiIconButton icon="i-carbon-subtract" label="Script 50 ms later" size="xs" variant="solid" @click="nudge(g.active, -50)" />
                <input
                  type="number"
                  step="10"
                  :value="g.active.offsetMs"
                  aria-label="Offset in milliseconds"
                  class="text-[12px] text-fg num text-center focusable border border-edge-strong rounded-[var(--radius-sm)] bg-surface-900 h-6 w-18"
                  @change="setOffset(g.active, ($event.target as HTMLInputElement).value)"
                >
                <UiIconButton icon="i-carbon-add" label="Script 50 ms earlier" size="xs" variant="solid" @click="nudge(g.active, 50)" />
                <UiIconButton icon="i-carbon-reset" label="Reset" size="xs" :disabled="!g.active.offsetMs" @click="g.active.offsetMs = 0" />
              </div>
            </div>
          </div>
        </Transition>

        <!-- Takes: the primary and its alternates, one playing at a time -->
        <div v-if="g.files.length > 1" class="p-1 border-t border-edge flex flex-col gap-0.5">
          <button
            v-for="f in g.files"
            :key="keyOf(f)"
            type="button"
            class="text-[12px] px-2 text-left focusable rounded-[var(--radius-sm)] flex gap-2 h-7 transition-colors items-center"
            :class="f.enabled ? 'bg-fg/6 text-fg' : 'text-fg-muted hover:bg-fg/4 hover:text-fg'"
            :aria-pressed="f.enabled"
            @click="!f.enabled && pick(f)"
          >
            <span
              class="border rounded-full center shrink-0 h-3.5 w-3.5 transition-colors"
              :class="f.enabled ? 'border-[var(--axis)]' : 'border-edge-strong'"
            >
              <span v-if="f.enabled" class="rounded-full bg-[var(--axis)] h-1.5 w-1.5 animate-scale-in" />
            </span>
            <span class="flex-1 truncate">{{ f.isAlt ? (f.altName || 'Alternate') : 'Main' }}</span>
            <span v-tip="f.filename" class="text-[10.5px] text-fg-faint num">{{ formatTime(f.parsed.duration / 1000) }}</span>
          </button>
        </div>
        <div v-else-if="!g.active" class="hint px-3 pb-2.5 truncate">
          {{ g.files[0].filename }}
        </div>
      </section>
    </TransitionGroup>

    <!-- Whole-video sync -->
    <UiSection
      v-if="scripts.hasScripts"
      title="Sync"
      icon="i-carbon-time"
      collapsible
      :summary="anyOffset ? (offsetsDiffer ? 'per axis' : fmtOffset(sharedOffset)) : 'in sync'"
      :open="anyOffset"
    >
      <template #actions>
        <UiButton v-if="anyOffset" size="xs" variant="ghost" icon="i-carbon-reset" @click="resetOffsets">
          Reset
        </UiButton>
      </template>
      <UiSlider
        v-model="sharedOffset"
        label="All axes"
        :min="-1000"
        :max="1000"
        :step="10"
        :reset="0"
        :format="fmtOffset"
        :hint="offsetsDiffer ? 'Axes have their own offsets — moving this sets them all.' : 'Positive plays the script earlier than the video. Double-click to reset.'"
      />
    </UiSection>
  </UiPanel>
</template>
