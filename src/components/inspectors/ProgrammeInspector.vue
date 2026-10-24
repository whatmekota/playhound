<script setup lang="ts">
import type { PhaseKind, Programme, ProgrammePhase, VideoSwitch } from '~/lib/programme'
import { computed, ref, useId } from 'vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiEmpty from '~/components/ui/UiEmpty.vue'
import UiIconButton from '~/components/ui/UiIconButton.vue'
import UiInput from '~/components/ui/UiInput.vue'
import UiPanel from '~/components/ui/UiPanel.vue'
import UiSection from '~/components/ui/UiSection.vue'
import UiSegmented from '~/components/ui/UiSegmented.vue'
import UiSlider from '~/components/ui/UiSlider.vue'
import UiStat from '~/components/ui/UiStat.vue'
import UiSwitch from '~/components/ui/UiSwitch.vue'
import { useAutoDirector } from '~/composables/useAutoDirector'
import { toast } from '~/composables/useToast'
import {
  cloneProgramme,
  edgeStateAt,
  MAX_EDGES,
  MAX_PHASES,
  newPhase,
  PHASE_KINDS,
  sampleCurve,
  timeline,
  totalSeconds,
  uid,
} from '~/lib/programme'
import { meanSpeedToIntensity } from '~/lib/scriptIntensity'
import { useAudioStore } from '~/stores/audio'
import { useLibraryStore } from '~/stores/libraryStore'
import { MOTION_SOURCES, useMotionStore } from '~/stores/motionStore'
import { usePlaybackStore } from '~/stores/playbackStore'
import { useProgrammeStore } from '~/stores/programmeStore'
import { useUiStore } from '~/stores/uiStore'

const prog = useProgrammeStore()
const director = useAutoDirector()
const audio = useAudioStore()
const motion = useMotionStore()
const library = useLibraryStore()
const playback = usePlaybackStore()
const ui = useUiStore()

// ─── Reference data ─────────────────────────────────────────────────────────

/** Same colours the Binaural timeline uses for the session phase each kind borrows. */
const KIND_TONE: Record<PhaseKind, string> = {
  warmup: 'var(--info)',
  build: 'var(--ok)',
  peak: 'var(--warn)',
  cooldown: 'var(--accent)',
}

const VIDEO_MODES: { value: VideoSwitch, label: string, title: string }[] = [
  { value: 'ended', label: 'When it ends', title: 'Each video plays out; the director picks the next one for where the arc is then' },
  { value: 'phase', label: 'Each phase', title: 'Move on to a fitting video at every phase change' },
  { value: 'interval', label: 'Every N min', title: 'Move on every few minutes, waiting for a chapter break in the script when one is near' },
]

const pct = (v: number) => `${Math.round(v * 100)}%`

function clock(sec: number) {
  const s = Math.max(0, Math.round(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

const minutesOf = (p: Programme) => Math.round(totalSeconds(p.phases) / 60)

// ─── What is shown in the hero: the run, or the selection as a preview ─────

// A finished run stays on show until another programme is picked.
const shown = computed(() => prog.plan && (prog.active || (prog.finished && prog.plan.id === prog.selectedId)) ? prog.plan : prog.selected)
const shownExtra = computed(() => shown.value === prog.plan ? prog.extra : [])
const shownBounds = computed(() => timeline(shown.value.phases, shownExtra.value))
const shownTotal = computed(() => shownBounds.value.at(-1)?.end ?? 0)

const running = computed(() => prog.status === 'running')
const paused = computed(() => prog.status === 'paused')
const stopping = computed(() => prog.status === 'stopping')
const live = computed(() => running.value || paused.value)

const progress = computed(() => {
  if (!prog.plan || shown.value !== prog.plan || !shownTotal.value)
    return 0
  return Math.min(1, prog.elapsed / shownTotal.value)
})

const phaseTone = computed(() => prog.currentPhase && prog.active ? KIND_TONE[prog.currentPhase.kind] : 'var(--text-faint)')

const edge = computed(() => {
  const p = prog.currentPhase
  const loc = prog.where
  if (!p || !loc || !live.value)
    return null
  return edgeStateAt(p, loc.inPhase, prog.bounds[loc.index]?.dur)
})

const EDGE_WORD = { rise: 'climbing', hold: 'holding', retreat: 'backing off', ramp: '' } as const

// ─── The curve ──────────────────────────────────────────────────────────────

const W = 300
const H = 64
const PAD = 4
const SAMPLES = 150
const clipId = `prog-clip-${useId()}`

function curvePath(phases: ProgrammePhase[], extra: number[] = [], w = W, h = H, pad = PAD, n = SAMPLES) {
  const pts = sampleCurve(phases, n, extra)
  if (!pts.length)
    return { line: '', area: '' }
  const y = (v: number) => (pad + (1 - v) * (h - pad * 2)).toFixed(2)
  const x = (i: number) => ((i / (pts.length - 1)) * w).toFixed(2)
  const line = pts.map((v, i) => `${i ? 'L' : 'M'}${x(i)} ${y(v)}`).join(' ')
  return { line, area: `${line} L${w} ${h} L0 ${h} Z` }
}

const curve = computed(() => curvePath(shown.value.phases, shownExtra.value))
const yPct = (v: number) => `${((PAD + (1 - v) * (H - PAD * 2)) / H) * 100}%`

/** The script's own intensity, live while Follow script runs, else the current video's analysis. */
const actual = computed<number | null>(() => {
  if (prog.scriptLive && prog.scriptIntensity > 0)
    return prog.scriptIntensity
  const e = playback.currentEntry
  const s = e ? director.summaries.value[e.name] : null
  return s ? meanSpeedToIntensity(s.meanSpeed) : null
})

// ─── Hero controls ──────────────────────────────────────────────────────────

function primary() {
  if (prog.status === 'idle')
    prog.start()
  else if (running.value)
    prog.pause()
  else if (paused.value)
    prog.resume()
}

const primaryIcon = computed(() => running.value ? 'i-carbon-pause-filled' : 'i-carbon-play-filled-alt')
const primaryLabel = computed(() => prog.status === 'idle' ? `Start ${prog.selected.name}` : running.value ? 'Pause (holds the arc)' : 'Resume')

// ─── Connections: what is actually driving what right now ──────────────────

const ready = computed(() => director.readyCount())
const scripted = computed(() => library.videos.filter(v => v.hasScript).length)

const links = computed(() => {
  const sourceLabel = MOTION_SOURCES.find(s => s.id === motion.source)?.label ?? motion.source
  const device = !motion.enabled
    ? { text: 'Device output is off', tone: 'muted' as const }
    : motion.source === 'funscript'
      ? { text: 'Plays each script as written; the arc chooses the scripts', tone: 'ok' as const }
      : motion.source === 'session'
        ? { text: 'Generated from the arc when no script plays, capped per phase', tone: 'ok' as const }
        : { text: `On ${sourceLabel} — not following the arc`, tone: 'warn' as const }
  return [
    {
      icon: 'i-carbon-meter',
      label: 'Intensity',
      text: prog.scriptOwnsIntensity ? 'Follow script is setting it; the plan only steers video choice' : 'Set by the plan, gliding between phases',
      tone: prog.scriptOwnsIntensity ? 'warn' as const : 'ok' as const,
      action: null,
    },
    {
      icon: 'i-carbon-direction-fork',
      label: 'Next video',
      text: !library.hasVideos
        ? 'No library open'
        : ready.value
          ? `Director, from ${ready.value} analysed of ${scripted.value}`
          : 'Queue — nothing analysed for the director yet',
      tone: ready.value ? 'ok' as const : 'warn' as const,
      action: library.hasVideos && ready.value < scripted.value ? { label: 'Analyse', run: () => ui.openInspector('director') } : null,
    },
    {
      icon: 'i-carbon-wave-direction',
      label: 'Device',
      text: device.text,
      tone: device.tone,
      action: device.tone === 'warn' || device.tone === 'muted' ? { label: 'Motion', run: () => ui.openInspector('motion') } : null,
    },
    {
      icon: 'i-carbon-sound-wave',
      label: 'Tone',
      text: audio.isPlaying.value ? 'Beat band follows each phase' : shown.value.tone ? 'Starts with the programme' : 'Off — the plan runs silent',
      tone: audio.isPlaying.value || shown.value.tone ? 'ok' as const : 'muted' as const,
      action: null,
    },
  ]
})

const LINK_TONE = { ok: 'text-ok', warn: 'text-warn', muted: 'text-fg-faint' } as const

// ─── Video plan ─────────────────────────────────────────────────────────────

function suits(name: string): number | null {
  const s = director.summaries.value[name]
  return s ? meanSpeedToIntensity(s.meanSpeed) : null
}

const planGroups = computed(() => {
  const plan = prog.plan
  if (!plan)
    return []
  return plan.phases
    .map((p, i) => ({ phase: p, index: i, videos: prog.log.filter(e => e.phase === i) }))
    .filter(g => g.videos.length || g.index === prog.phaseIndex)
})

// ─── Programmes ─────────────────────────────────────────────────────────────

function sparkline(p: Programme) {
  return curvePath(p.phases, [], 64, 20, 2, 48).line
}

function select(p: Programme) {
  prog.selectedId = p.id
}

function removeProgramme(p: Programme) {
  const copy = JSON.parse(JSON.stringify(p)) as Programme
  prog.remove(p.id)
  toast(`Deleted ${p.name}`, {
    icon: 'i-carbon-trash-can',
    key: 'programme-delete',
    action: { label: 'Undo', run: () => prog.save(copy) },
  })
}

// ─── Editor ─────────────────────────────────────────────────────────────────

const draft = ref<Programme | null>(null)
const openPhase = ref<string | null>(null)

function edit(p: Programme) {
  draft.value = p.builtin
    ? cloneProgramme(p, `My ${p.name.toLowerCase()}`)
    : JSON.parse(JSON.stringify(p)) as Programme
  openPhase.value = null
}

function createNew() {
  draft.value = {
    id: uid('prog'),
    name: 'My programme',
    builtin: false,
    video: 'ended',
    everyMin: 8,
    tone: false,
    phases: [newPhase('warmup'), newPhase('build'), newPhase('peak'), newPhase('cooldown')],
  }
  openPhase.value = null
}

function saveDraft() {
  if (!draft.value)
    return
  const saved = prog.save(draft.value)
  if (!saved) {
    toast.warn('A programme needs at least one phase', { key: 'programme-save' })
    return
  }
  toast.success('Programme saved', { detail: saved.name, icon: 'i-carbon-roadmap', key: 'programme-save' })
  draft.value = null
}

function addPhase(kind: PhaseKind) {
  if (!draft.value || draft.value.phases.length >= MAX_PHASES)
    return
  const p = newPhase(kind)
  // Start where the arc currently ends, so a new phase does not open with a jump.
  const last = draft.value.phases.at(-1)
  if (last && kind !== 'cooldown')
    p.from = last.to
  draft.value.phases.push(p)
  openPhase.value = p.id
}

function movePhase(i: number, by: -1 | 1) {
  const list = draft.value?.phases
  const j = i + by
  if (!list || j < 0 || j >= list.length)
    return
  const [p] = list.splice(i, 1)
  list.splice(j, 0, p)
}

function removePhase(i: number) {
  draft.value?.phases.splice(i, 1)
}

const draftCurve = computed(() => draft.value ? curvePath(draft.value.phases) : null)
const draftMinutes = computed(() => draft.value ? Math.round(totalSeconds(draft.value.phases) / 60) : 0)

function toggleCap(p: ProgrammePhase, on: boolean) {
  p.capSpm = on ? Math.min(motion.maxSpm, p.kind === 'warmup' ? 80 : p.kind === 'cooldown' ? 70 : 110) : null
}

function toggleBeat(p: ProgrammePhase, on: boolean) {
  p.beat = on ? [4, 8] : null
}

function setBeat(p: ProgrammePhase, which: 0 | 1, v: number) {
  if (!p.beat)
    return
  const next: [number, number] = [p.beat[0], p.beat[1]]
  next[which] = v
  // Keep the band the right way round as either end is dragged past the other.
  if (next[0] > next[1])
    next[which === 0 ? 1 : 0] = v
  p.beat = next
}

const edgeFormat = (v: number) => v <= 1 ? 'off' : `${v} passes`
</script>

<template>
  <UiPanel>
    <!-- ─── Hero: the arc, where we are on it, and the transport ──────────── -->
    <section
      class="hero p-3 card flex flex-col gap-3"
      :class="live ? 'is-live' : ''"
      :style="{ '--phase': phaseTone }"
    >
      <div class="flex gap-3 items-center">
        <button
          v-tip="primaryLabel"
          type="button"
          :aria-label="primaryLabel"
          :disabled="stopping"
          class="focusable rounded-full center shrink-0 h-12 w-12 pressable disabled:opacity-50"
          :class="running
            ? 'bg-surface-700 text-fg ring-1 ring-edge-strong hover:bg-surface-600'
            : 'bg-accent text-accent-contrast shadow-[0_8px_20px_-8px_var(--accent)] hover:brightness-110'"
          @click="primary"
        >
          <Transition name="t-pop" mode="out-in">
            <span :key="primaryIcon" :class="primaryIcon" class="text-[20px]" />
          </Transition>
        </button>

        <div class="flex flex-1 flex-col gap-0.5 min-w-0">
          <span class="text-[13px] text-fg font-medium truncate">{{ shown.name }}</span>
          <Transition name="t-fade" mode="out-in">
            <span v-if="live && prog.currentPhase" :key="`p-${prog.phaseIndex}-${prog.status}`" class="text-[12px] font-medium flex gap-1.5 min-w-0 items-center" :style="{ color: phaseTone }">
              <span class="rounded-full bg-current shrink-0 h-1.5 w-1.5" :class="running ? 'animate-pulse-dot' : ''" />
              <span class="truncate">{{ paused ? 'Paused · ' : '' }}{{ prog.currentPhase.name }}</span>
              <span v-if="edge" class="text-fg-faint font-normal shrink-0">· pass {{ edge.pass + 1 }}/{{ edge.of }} {{ EDGE_WORD[edge.kind] }}</span>
            </span>
            <span v-else-if="stopping" key="stopping" class="text-[12px] text-fg-muted flex gap-1.5 items-center">
              <span class="i-carbon-renew [animation:ph-spin_1.2s_linear_infinite]" /> Easing down…
            </span>
            <span v-else-if="prog.finished" key="done" class="text-[12px] text-ok flex gap-1.5 items-center">
              <span class="i-carbon-checkmark-outline" /> Finished · {{ clock(prog.elapsed) }}
            </span>
            <span v-else key="idle" class="hint num">{{ shown.phases.length }} phases · {{ clock(shownTotal) }}</span>
          </Transition>
        </div>

        <Transition name="t-pop">
          <UiIconButton
            v-if="live"
            icon="i-carbon-stop-filled-alt"
            label="Stop (eases down)"
            variant="solid"
            size="md"
            @click="prog.stop()"
          />
          <UiButton v-else-if="stopping" size="sm" variant="danger" icon="i-carbon-stop-filled-alt" @click="prog.halt()">
            Stop now
          </UiButton>
        </Transition>
      </div>

      <!-- The arc: target curve, phase bands, playhead and the live levels -->
      <div class="curve rounded-[var(--radius-md)] bg-surface-950/70 h-20 ring-1 ring-edge relative overflow-hidden">
        <svg class="h-full w-full inset-0 absolute" :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <clipPath :id="clipId">
              <rect x="0" y="0" :width="progress * W" :height="H" />
            </clipPath>
          </defs>
          <rect
            v-for="(b, i) in shownBounds"
            :key="i"
            :x="(b.start / shownTotal) * W"
            y="0"
            :width="(b.dur / shownTotal) * W"
            :height="H"
            class="band"
            :class="live && i === prog.phaseIndex ? 'is-current' : ''"
            :style="{ fill: KIND_TONE[shown.phases[i].kind] }"
          />
          <path :d="curve.area" class="area" />
          <path :d="curve.line" class="line" />
          <g :clip-path="`url(#${clipId})`">
            <path :d="curve.area" class="area-played" />
            <path :d="curve.line" class="line-played" />
          </g>
        </svg>

        <template v-if="prog.active || prog.finished">
          <span class="playhead bg-fg w-px bottom-0 top-0 absolute" :style="{ left: `${progress * 100}%` }" />
          <span
            v-if="prog.active"
            v-tip="`Written ${pct(prog.output)}`"
            class="dot rounded-full bg-accent h-2 w-2 absolute"
            :style="{ left: `${progress * 100}%`, top: yPct(prog.output) }"
          />
          <span
            v-if="prog.active && actual !== null"
            v-tip="`Script ${pct(actual)}`"
            class="dot rounded-full h-2 w-2 ring-2 ring-info absolute"
            :style="{ left: `${progress * 100}%`, top: yPct(actual) }"
          />
        </template>
        <span class="eyebrow left-2 top-1.5 absolute">intensity</span>
        <span class="text-[10.5px] text-fg-faint num right-2 top-1.5 absolute">{{ clock(shownTotal) }}</span>
      </div>

      <!-- Phase strip -->
      <div class="flex gap-1">
        <div
          v-for="(p, i) in shown.phases"
          :key="p.id"
          class="flex flex-col gap-1 min-w-0"
          :style="{ flexGrow: shownBounds[i].dur, flexBasis: 0 }"
        >
          <span class="rounded-full bg-surface-700 h-1.5 w-full block overflow-hidden">
            <span
              class="rounded-full h-full block transition-[width] duration-300 ease-linear"
              :style="{
                width: `${(prog.active || prog.finished) && shown === prog.plan
                  ? Math.min(1, Math.max(0, (prog.elapsed - shownBounds[i].start) / shownBounds[i].dur)) * 100
                  : 0}%`,
                background: KIND_TONE[p.kind],
              }"
            />
          </span>
          <span
            v-tip="`${p.name} · ${Math.round(shownBounds[i].dur / 60)} min · ${pct(p.from)} → ${pct(p.to)}${p.edges > 1 ? ` · ${p.edges} edges` : ''}`"
            class="text-[10.5px] font-medium truncate transition-colors"
            :class="live && i === prog.phaseIndex ? '' : 'text-fg-faint'"
            :style="live && i === prog.phaseIndex ? { color: KIND_TONE[p.kind] } : undefined"
          >{{ p.name }}</span>
        </div>
      </div>

      <!-- Readouts -->
      <Transition name="t-collapse">
        <div v-if="prog.active">
          <div class="min-h-0 overflow-hidden">
            <div class="gap-x-3 gap-y-2 grid grid-cols-4">
              <UiStat label="Phase left" :value="clock(prog.where?.phaseLeft ?? 0)" size="sm" />
              <UiStat label="Total left" :value="clock(prog.where?.totalLeft ?? 0)" size="sm" />
              <UiStat label="Target" :value="Math.round(prog.target * 100)" unit="%" tone="accent" size="sm" />
              <UiStat
                label="Script"
                :value="actual === null ? '—' : Math.round(actual * 100)"
                :unit="actual === null ? undefined : '%'"
                tone="info"
                size="sm"
                :hint="prog.scriptLive ? 'live' : 'analysed'"
              />
            </div>
          </div>
        </div>
      </Transition>

      <!-- Run controls -->
      <div v-if="live" class="flex gap-2">
        <UiButton size="sm" icon="i-carbon-skip-forward" class="flex-1" @click="prog.skipPhase()">
          {{ prog.phaseIndex < (prog.plan?.phases.length ?? 0) - 1 ? 'Next phase' : 'Wind down' }}
        </UiButton>
        <UiButton v-tip="'Add five minutes to this phase'" size="sm" icon="i-carbon-time" class="flex-1" @click="prog.extendPhase()">
          +5 min
        </UiButton>
      </div>
    </section>

    <!-- ─── Connections: honest wiring ────────────────────────────────────── -->
    <UiSection title="What follows the arc" icon="i-carbon-connect" :live="prog.active">
      <ul class="flex flex-col gap-2">
        <li v-for="l in links" :key="l.label" class="flex gap-2.5 items-start">
          <span :class="[l.icon, LINK_TONE[l.tone]]" class="text-[14px] mt-px shrink-0" />
          <div class="flex flex-1 flex-col min-w-0">
            <span class="text-[12px] text-fg font-medium">{{ l.label }}</span>
            <span class="text-[11.5px] text-fg-muted leading-snug">{{ l.text }}</span>
          </div>
          <UiButton v-if="l.action" size="xs" variant="ghost" icon-right="i-carbon-arrow-right" @click="l.action.run">
            {{ l.action.label }}
          </UiButton>
        </li>
      </ul>
    </UiSection>

    <!-- ─── Video plan ────────────────────────────────────────────────────── -->
    <Transition name="t-fade">
      <UiSection
        v-if="prog.plan && (prog.active || prog.finished)"
        title="Video plan"
        icon="i-carbon-video"
        :summary="`${prog.log.length} played`"
        :live="live"
      >
        <p v-if="!prog.log.length" class="hint">
          Nothing played yet. Start a video, or let a phase change pick one.
        </p>
        <div v-for="g in planGroups" :key="g.phase.id" class="flex flex-col gap-1">
          <div class="flex gap-1.5 items-center">
            <span class="rounded-full shrink-0 h-1.5 w-1.5" :style="{ background: KIND_TONE[g.phase.kind] }" />
            <span class="text-[11.5px] text-fg font-medium truncate">{{ g.phase.name }}</span>
            <span class="text-[10.5px] text-fg-faint num ml-auto">{{ pct(g.phase.from) }} → {{ pct(g.phase.to) }}</span>
          </div>
          <TransitionGroup tag="ul" name="t-list" class="pl-3 border-l border-edge flex flex-col gap-0.5 relative">
            <li v-for="v in g.videos" :key="`${v.at}-${v.name}`" class="text-[11.5px] flex gap-2 min-w-0 items-baseline">
              <span class="text-fg-faint num shrink-0">{{ clock(v.at) }}</span>
              <span v-tip="v.basename" class="text-fg-muted flex-1 truncate">{{ v.basename }}</span>
              <span class="text-fg-faint num shrink-0">{{ suits(v.name) === null ? '—' : `suits ${pct(suits(v.name)!)}` }}</span>
            </li>
            <li v-if="!g.videos.length" key="none" class="hint">
              Nothing yet in this phase.
            </li>
          </TransitionGroup>
        </div>
      </UiSection>
    </Transition>

    <!-- ─── Editor ────────────────────────────────────────────────────────── -->
    <Transition name="t-fade" mode="out-in">
      <section v-if="draft" key="editor" class="card flex flex-col">
        <header class="px-3 flex gap-2 h-10 items-center">
          <span class="i-carbon-edit text-[15px] text-fg-muted shrink-0" />
          <span class="text-[13px] text-fg font-medium">Edit programme</span>
          <span class="text-[11.5px] text-fg-faint num ml-auto">{{ draftMinutes }} min</span>
        </header>
        <div class="px-3 pb-3 flex flex-col gap-3">
          <UiInput v-model="draft.name" label="Name" placeholder="Programme name" />

          <div v-if="draftCurve" class="rounded-[var(--radius-sm)] bg-surface-950/70 h-12 ring-1 ring-edge relative overflow-hidden">
            <svg class="h-full w-full inset-0 absolute" :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" aria-hidden="true">
              <path :d="draftCurve.area" class="area-played" />
              <path :d="draftCurve.line" class="line-played" />
            </svg>
          </div>

          <!-- Phases -->
          <TransitionGroup tag="div" name="t-list" class="flex flex-col gap-1.5 relative">
            <div
              v-for="(p, i) in draft.phases"
              :key="p.id"
              class="well flex flex-col"
            >
              <div class="pl-2 pr-1 flex gap-1.5 h-9 items-center">
                <button
                  type="button"
                  class="text-left focusable rounded-[var(--radius-xs)] flex flex-1 gap-2 min-w-0 items-center"
                  :aria-expanded="openPhase === p.id"
                  @click="openPhase = openPhase === p.id ? null : p.id"
                >
                  <span class="rounded-full shrink-0 h-2 w-2" :style="{ background: KIND_TONE[p.kind] }" />
                  <span class="text-[12.5px] text-fg font-medium truncate">{{ p.name }}</span>
                  <span class="text-[11px] text-fg-faint num shrink-0">{{ p.minutes }}m · {{ pct(p.from) }}→{{ pct(p.to) }}</span>
                  <span v-if="p.edges > 1" class="text-[10.5px] text-warn num shrink-0">×{{ p.edges }}</span>
                </button>
                <UiIconButton icon="i-carbon-arrow-up" label="Move up" size="xs" :disabled="i === 0" @click="movePhase(i, -1)" />
                <UiIconButton icon="i-carbon-arrow-down" label="Move down" size="xs" :disabled="i === draft.phases.length - 1" @click="movePhase(i, 1)" />
                <UiIconButton icon="i-carbon-close" label="Remove phase" size="xs" :disabled="draft.phases.length <= 1" @click="removePhase(i)" />
              </div>
              <Transition name="t-collapse">
                <div v-if="openPhase === p.id">
                  <div class="min-h-0 overflow-hidden">
                    <div class="px-2.5 pb-3 pt-1 flex flex-col gap-3">
                      <UiInput v-model="p.name" size="sm" placeholder="Phase name" />
                      <UiSegmented v-model="p.kind" :options="PHASE_KINDS" size="xs" block />
                      <UiSlider v-model="p.minutes" label="Length" :min="1" :max="90" :step="1" unit=" min" />
                      <div class="gap-3 grid grid-cols-2">
                        <UiSlider v-model="p.from" label="Starts at" :format="pct" />
                        <UiSlider v-model="p.to" :label="p.edges > 1 ? 'Peaks at' : 'Ends at'" :format="pct" />
                      </div>
                      <UiSlider
                        v-model="p.edges"
                        label="Edge passes"
                        :min="0"
                        :max="MAX_EDGES"
                        :step="1"
                        :format="edgeFormat"
                        tone="warn"
                        :hint="p.edges > 1 ? 'Each pass climbs from the start level a little higher, holds, and drops back; the last one holds at the top.' : undefined"
                      />
                      <div class="flex flex-col gap-2">
                        <UiSwitch
                          :model-value="p.capSpm !== null"
                          label="Slower device ceiling"
                          hint="Caps generated motion in this phase. Never above the Motion panel's own limit; scripts play as written."
                          size="sm"
                          @update:model-value="toggleCap(p, $event)"
                        />
                        <UiSlider
                          v-if="p.capSpm !== null"
                          :model-value="Math.min(p.capSpm, motion.maxSpm)"
                          label="Ceiling"
                          :min="10"
                          :max="Math.max(10, motion.maxSpm)"
                          :step="5"
                          unit=" spm"
                          tone="warn"
                          @update:model-value="p.capSpm = $event"
                        />
                      </div>
                      <div class="flex flex-col gap-2">
                        <UiSwitch
                          :model-value="p.beat !== null"
                          label="Own beat band"
                          hint="Otherwise the session engine's band for this kind of phase."
                          size="sm"
                          @update:model-value="toggleBeat(p, $event)"
                        />
                        <div v-if="p.beat" class="gap-3 grid grid-cols-2">
                          <UiSlider :model-value="p.beat[0]" label="From" :min="0.5" :max="35" :step="0.5" unit=" Hz" tone="info" @update:model-value="setBeat(p, 0, $event)" />
                          <UiSlider :model-value="p.beat[1]" label="To" :min="0.5" :max="35" :step="0.5" unit=" Hz" tone="info" @update:model-value="setBeat(p, 1, $event)" />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </Transition>
            </div>
          </TransitionGroup>

          <div class="flex flex-wrap gap-1 items-center">
            <span class="text-[11px] text-fg-faint mr-0.5">Add</span>
            <UiButton
              v-for="k in PHASE_KINDS"
              :key="k.value"
              size="xs"
              variant="subtle"
              icon="i-carbon-add"
              :disabled="draft.phases.length >= MAX_PHASES"
              @click="addPhase(k.value)"
            >
              {{ k.label }}
            </UiButton>
          </div>

          <div class="divider-y" />

          <div class="flex flex-col gap-1.5">
            <span class="label">Change video</span>
            <UiSegmented v-model="draft.video" :options="VIDEO_MODES" size="xs" block />
          </div>
          <Transition name="t-collapse">
            <div v-if="draft.video === 'interval'">
              <div class="min-h-0 overflow-hidden">
                <UiSlider v-model="draft.everyMin" label="Every" :min="2" :max="30" :step="1" unit=" min" />
              </div>
            </div>
          </Transition>
          <UiSwitch v-model="draft.tone" label="Start the binaural tone" hint="Fades out again when the programme ends." size="sm" />
        </div>
        <footer class="px-3 py-2.5 border-t border-edge flex gap-2 justify-end">
          <UiButton size="sm" variant="ghost" @click="draft = null">
            Cancel
          </UiButton>
          <UiButton size="sm" variant="primary" icon="i-carbon-save" @click="saveDraft">
            Save
          </UiButton>
        </footer>
      </section>

      <!-- ─── Programme list ──────────────────────────────────────────────── -->
      <UiSection v-else key="list" title="Programmes" icon="i-carbon-roadmap" :summary="`${prog.all.length}`">
        <template #actions>
          <UiButton size="xs" variant="ghost" icon="i-carbon-add" @click="createNew">
            New
          </UiButton>
        </template>
        <div class="flex flex-col gap-1">
          <div
            v-for="p in prog.all"
            :key="p.id"
            class="group px-2 rounded-[var(--radius-md)] flex gap-2.5 h-11 cursor-pointer ring-1 transition-colors items-center"
            :class="prog.selectedId === p.id
              ? 'bg-accent-soft ring-accent/35'
              : 'ring-transparent hover:bg-fg/5'"
            role="button"
            tabindex="0"
            :aria-pressed="prog.selectedId === p.id"
            @click="select(p)"
            @keydown.enter.prevent="select(p)"
            @keydown.space.prevent="select(p)"
          >
            <svg class="spark shrink-0 h-5 w-16" viewBox="0 0 64 20" preserveAspectRatio="none" aria-hidden="true">
              <path :d="sparkline(p)" />
            </svg>
            <div class="flex flex-1 flex-col min-w-0">
              <span class="text-[12.5px] font-medium truncate" :class="prog.selectedId === p.id ? 'text-accent-300' : 'text-fg'">{{ p.name }}</span>
              <span class="text-[10.5px] text-fg-faint num truncate">
                {{ minutesOf(p) }} min · {{ p.phases.length }} phases<template v-if="p.phases.some(ph => ph.edges > 1)"> · edged</template>
              </span>
            </div>
            <UiBadge v-if="prog.active && prog.plan?.id === p.id" tone="ok" size="xs" dot pulse>
              Running
            </UiBadge>
            <UiBadge v-else-if="p.builtin" size="xs">
              Built-in
            </UiBadge>
            <div class="flex shrink-0 gap-0.5 transition-opacity items-center group-focus-within:opacity-100 group-hover:opacity-100" :class="prog.selectedId === p.id ? 'opacity-100' : 'opacity-0'" @click.stop>
              <UiIconButton :icon="p.builtin ? 'i-carbon-copy' : 'i-carbon-edit'" :label="p.builtin ? 'Customise a copy' : 'Edit'" size="xs" @click="edit(p)" />
              <UiIconButton v-if="!p.builtin" icon="i-carbon-trash-can" label="Delete" size="xs" @click="removeProgramme(p)" />
            </div>
          </div>
        </div>
        <UiEmpty
          v-if="!prog.userProgrammes.length"
          icon="i-carbon-roadmap"
          title="Only the built-ins so far"
          description="Customise one of them, or start from a blank four-phase plan."
          size="sm"
        />
      </UiSection>
    </Transition>
  </UiPanel>
</template>

<style scoped>
/* A faint wash of the current phase colour, as in the Binaural panel. */
.hero {
  background: linear-gradient(180deg, color-mix(in srgb, var(--phase) 9%, var(--bg-850)) 0%, var(--bg-850) 70%);
  transition: background var(--dur-slow) var(--ease-out);
}

.band {
  opacity: 0.06;
  transition: opacity var(--dur-slow) var(--ease-out);
}
.band.is-current {
  opacity: 0.16;
}

.area {
  fill: var(--text-faint);
  opacity: 0.12;
}
.line {
  fill: none;
  stroke: var(--text-faint);
  stroke-width: 1.25;
  vector-effect: non-scaling-stroke;
  opacity: 0.7;
}
.area-played {
  fill: var(--accent);
  opacity: 0.22;
}
.line-played {
  fill: none;
  stroke: var(--accent);
  stroke-width: 1.75;
  vector-effect: non-scaling-stroke;
}

.playhead {
  transition: left 250ms linear;
  box-shadow: 0 0 0 1px var(--bg-850);
}
.dot {
  transform: translate(-50%, -50%);
  transition:
    left 250ms linear,
    top var(--dur) var(--ease-out);
}
.is-live .dot.bg-accent {
  box-shadow: 0 0 10px var(--accent);
}

.spark path {
  fill: none;
  stroke: var(--accent);
  stroke-width: 1.5;
  vector-effect: non-scaling-stroke;
  opacity: 0.85;
}
</style>
