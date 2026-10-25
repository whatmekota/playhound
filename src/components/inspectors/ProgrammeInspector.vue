<script setup lang="ts">
import type { PhaseKind, Programme, ProgrammePhase, RunShape, VideoSwitch } from '~/lib/programme'
import type { ReelClip } from '~/lib/reel'
import type { VideoEntry } from '~/stores/libraryStore'
import { computed, onMounted, ref, useId } from 'vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiEmpty from '~/components/ui/UiEmpty.vue'
import UiIconButton from '~/components/ui/UiIconButton.vue'
import UiInput from '~/components/ui/UiInput.vue'
import UiPanel from '~/components/ui/UiPanel.vue'
import UiProgress from '~/components/ui/UiProgress.vue'
import UiSection from '~/components/ui/UiSection.vue'
import UiSegmented from '~/components/ui/UiSegmented.vue'
import UiSlider from '~/components/ui/UiSlider.vue'
import UiStat from '~/components/ui/UiStat.vue'
import UiSwitch from '~/components/ui/UiSwitch.vue'
import { useAutoDirector } from '~/composables/useAutoDirector'
import { toast } from '~/composables/useToast'
import { frameAt, frameStyle, getStrip } from '~/lib/previews'
import {
  cloneProgramme,
  DEFAULT_CLIP_SEC,
  edgeCount,
  MAX_EDGES,
  MAX_PHASES,
  newPhase,
  PHASE_KINDS,
  runShape,
  sampleShape,
  totalSeconds,
  uid,
} from '~/lib/programme'
import { clipSeconds } from '~/lib/reel'
import { meanSpeedToIntensity } from '~/lib/scriptIntensity'
import { vLazyThumb } from '~/lib/thumbs'
import { useAudioStore } from '~/stores/audio'
import { useLibraryStore } from '~/stores/libraryStore'
import { MOTION_SOURCES, useMotionStore } from '~/stores/motionStore'
import { usePlaybackStore } from '~/stores/playbackStore'
import { usePlayerStore } from '~/stores/playerStore'
import { KEEP_LONGER_SEC, MIN_POOL_CHAPTERS, MIN_POOL_VIDEOS, useProgrammeStore } from '~/stores/programmeStore'
import { useSessionControlStore } from '~/stores/sessionControlStore'
import { useUiStore } from '~/stores/uiStore'

const prog = useProgrammeStore()
const director = useAutoDirector()
const audio = useAudioStore()
const motion = useMotionStore()
const library = useLibraryStore()
const playback = usePlaybackStore()
const player = usePlayerStore()
const control = useSessionControlStore()
const ui = useUiStore()

// Indexing is lazy: it starts the first time anyone looks at programmes.
onMounted(() => {
  prog.ensureIndex()
  prog.planPreview()
})

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

function span(sec: number) {
  const s = Math.round(sec)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60 ? ` ${String(s % 60).padStart(2, '0')}s` : ''}`
}

const minutesOf = (p: Programme) => Math.round(totalSeconds(p.phases) / 60)

// ─── What is shown in the hero: the run, or the selection as a preview ─────

// A finished run stays on show until another programme is picked.
const showingRun = computed(() => !!prog.plan && (prog.active || (prog.finished && prog.plan.id === prog.selectedId)))
const shown = computed(() => showingRun.value ? prog.plan! : prog.selected)

/** The arc as drawn: the run's (real edges and all) or the selection's projection. */
const shape = computed<RunShape>(() => showingRun.value && prog.shape ? prog.shape : prog.previewShape)
const shownBounds = computed(() => shape.value.bounds)
const shownTotal = computed(() => shape.value.total)

const running = computed(() => prog.status === 'running')
const paused = computed(() => prog.status === 'paused')
const stopping = computed(() => prog.status === 'stopping')
const live = computed(() => running.value || paused.value)
const reelMode = computed(() => live.value ? prog.mode === 'reel' : prog.canReel)

const progress = computed(() => {
  if (!showingRun.value || !shownTotal.value)
    return 0
  return Math.min(1, prog.elapsed / shownTotal.value)
})

const phaseTone = computed(() => prog.currentPhase && prog.active ? KIND_TONE[prog.currentPhase.kind] : 'var(--text-faint)')

const edge = computed(() => live.value ? prog.edgeState : null)

const EDGE_WORD = { rise: 'building', hold: 'holding', retreat: 'easing off', ramp: '' } as const

// ─── The curve ──────────────────────────────────────────────────────────────

const W = 300
const H = 64
const PAD = 4
const SAMPLES = 150
const clipId = `prog-clip-${useId()}`

function shapePath(s: RunShape, w = W, h = H, pad = PAD, n = SAMPLES) {
  const pts = sampleShape(s, n)
  if (!pts.length)
    return { line: '', area: '' }
  const y = (v: number) => (pad + (1 - v) * (h - pad * 2)).toFixed(2)
  const x = (i: number) => ((i / (pts.length - 1)) * w).toFixed(2)
  const line = pts.map((v, i) => `${i ? 'L' : 'M'}${x(i)} ${y(v)}`).join(' ')
  return { line, area: `${line} L${w} ${h} L0 ${h} Z` }
}

const curve = computed(() => shapePath(shape.value))
const yPct = (v: number) => `${((PAD + (1 - v) * (H - PAD * 2)) / H) * 100}%`

/** The script's own intensity, live while Follow script runs, else the clip's or the video's analysis. */
const actual = computed<number | null>(() => {
  if (prog.scriptLive && prog.scriptIntensity > 0)
    return prog.scriptIntensity
  if (prog.mode === 'reel' && prog.currentClip && !prog.offReel)
    return prog.currentClip.intensity
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

function callEdge() {
  control.edge('ui', { videoTime: player.currentTime, videoName: player.videoPath })
}

// ─── Reel ───────────────────────────────────────────────────────────────────

const byName = computed(() => new Map(library.videos.map(v => [v.name, v])))
const entryOf = (c: ReelClip): VideoEntry | null => byName.value.get(c.video) ?? null
const title = (c: ReelClip) => entryOf(c)?.basename ?? c.video.replace(/\.[^.]+$/, '')

/** The frame at the clip's start when a scrub strip exists; otherwise the video's thumbnail. */
function thumbStyle(c: ReelClip): Record<string, string> {
  const e = entryOf(c)
  const strip = e ? getStrip(e) : null
  if (strip)
    return frameStyle(strip, frameAt(strip, c.start))
  return e?.thumbnailUrl ? { backgroundImage: `url("${e.thumbnailUrl}")`, backgroundSize: 'cover', backgroundPosition: 'center' } : {}
}

/** Whether the reel on show belongs to what is shown in the hero. */
const reelShown = computed(() => reelMode.value && prog.reel.length > 0 && (showingRun.value ? prog.mode === 'reel' : prog.reelFor === prog.selectedId))

const groups = computed(() => {
  if (!reelShown.value)
    return []
  const b = shownBounds.value
  return shown.value.phases.map((p, i) => ({
    phase: p,
    index: i,
    clips: prog.reel
      .map((c, k) => ({ c, k }))
      .filter(({ c }) => {
        const mid = c.at + 0.01
        return mid >= b[i].start && (mid < b[i].end || i === b.length - 1)
      }),
  })).filter(g => g.clips.length)
})

function clipState(k: number): 'played' | 'current' | 'planned' {
  if (!showingRun.value || prog.mode !== 'reel')
    return 'planned'
  if (!live.value)
    return k <= prog.clipIndex ? 'played' : 'planned'
  return k < prog.clipIndex ? 'played' : k === prog.clipIndex ? 'current' : 'planned'
}

const reelVideos = computed(() => new Set(prog.reel.map(c => c.video)).size)
const reelSummary = computed(() => reelShown.value ? `${prog.reel.length} clips · ${reelVideos.value} videos` : '')

/** The intensity colour of a clip on the strip: stronger accent for harder clips. */
const clipFill = (v: number) => `color-mix(in srgb, var(--accent) ${Math.round(25 + v * 75)}%, var(--bg-850))`

const nowClip = computed(() => live.value && prog.mode === 'reel' ? prog.currentClip : null)
const nowEntry = computed(() => nowClip.value ? entryOf(nowClip.value) : null)
const nowLeft = computed(() => nowClip.value ? Math.max(0, nowClip.value.end - player.currentTime) : 0)

// ─── Index ──────────────────────────────────────────────────────────────────

const ix = computed(() => prog.indexState)
const indexProgress = computed(() => ix.value.total ? ix.value.done / ix.value.total : 0)
const indexComplete = computed(() => ix.value.total > 0 && ix.value.done >= ix.value.total)

const fallbackReason = computed(() => {
  if (!shown.value.reel)
    return 'This programme plays whole videos.'
  if (prog.poolReady)
    return null
  if (!library.hasVideos)
    return 'Open a library to build a highlight reel from its chapters.'
  const p = prog.poolInfo
  const need = `${MIN_POOL_VIDEOS} videos and ${MIN_POOL_CHAPTERS} chapters`
  return ix.value.running
    ? `Indexing chapters — ${p.videos} videos and ${p.chapters} chapters so far. Until there are ${need}, whole videos play.`
    : `Only ${p.videos} videos and ${p.chapters} chapters to choose from; a reel needs ${need}. Whole videos play instead.`
})

// ─── Connections: what is actually driving what right now ──────────────────

const ready = computed(() => director.readyCount())

const links = computed(() => {
  const sourceLabel = MOTION_SOURCES.find(s => s.id === motion.source)?.label ?? motion.source
  const device = !motion.enabled
    ? { text: 'Device output is off', tone: 'muted' as const }
    : motion.source === 'funscript'
      ? { text: 'Plays each clip\'s script as written; the arc chooses the clips', tone: 'ok' as const }
      : motion.source === 'session'
        ? { text: 'Generated from the arc when no script plays, capped per phase', tone: 'ok' as const }
        : { text: `On ${sourceLabel} — not following the arc`, tone: 'warn' as const }
  const video = reelMode.value
    ? { text: `Highlight reel from ${prog.poolInfo.chapters} chapters in ${prog.poolInfo.videos} videos`, tone: 'ok' as const, action: null }
    : !library.hasVideos
        ? { text: 'No library open', tone: 'warn' as const, action: null }
        : ready.value
          ? { text: `Whole videos, by the director, from ${ready.value} analysed`, tone: 'ok' as const, action: null }
          : { text: 'Queue — nothing analysed for the director yet', tone: 'warn' as const, action: { label: 'Analyse', run: () => ui.openInspector('director') } }
  return [
    {
      icon: 'i-carbon-meter',
      label: 'Intensity',
      text: prog.scriptOwnsIntensity ? 'Follow script is setting it; the plan only chooses what plays' : 'Set by the plan, gliding between phases',
      tone: prog.scriptOwnsIntensity ? 'warn' as const : 'ok' as const,
      action: null,
    },
    { icon: 'i-carbon-video', label: 'What plays', ...video },
    {
      icon: 'i-carbon-wave-direction',
      label: 'Device',
      text: device.text,
      tone: device.tone,
      action: device.tone === 'warn' || device.tone === 'muted' ? { label: 'Motion', run: () => ui.openInspector('motion') } : null,
    },
    {
      icon: 'i-carbon-hourglass',
      label: 'Edges',
      text: shown.value.phases.some(p => edgeCount(p) > 1)
        ? 'Edged phases count your edges; elsewhere the arc holds while you back off'
        : 'The arc holds while an edge backs things off',
      tone: 'ok' as const,
      action: null,
    },
    {
      icon: 'i-carbon-waveform',
      label: 'Tone',
      text: audio.isPlaying.value ? 'Beat band follows each phase' : shown.value.tone ? 'Starts with the programme' : 'Off — the plan runs silent',
      tone: audio.isPlaying.value || shown.value.tone ? 'ok' as const : 'muted' as const,
      action: null,
    },
  ]
})

const LINK_TONE = { ok: 'text-ok', warn: 'text-warn', muted: 'text-fg-faint' } as const

// ─── Whole-video log (fallback mode) ────────────────────────────────────────

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
  return shapePath(runShape(p.phases), 64, 20, 2, 48).line
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
    reel: true,
    clipSec: [DEFAULT_CLIP_SEC[0], DEFAULT_CLIP_SEC[1]],
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

const draftCurve = computed(() => draft.value ? shapePath(runShape(draft.value.phases)) : null)
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

function setClip(which: 0 | 1, v: number) {
  if (!draft.value)
    return
  const next: [number, number] = [draft.value.clipSec[0], draft.value.clipSec[1]]
  next[which] = v
  if (next[0] > next[1])
    next[which === 0 ? 1 : 0] = v
  draft.value.clipSec = next
}

const edgeFormat = (v: number) => v <= 1 ? 'off' : `${v} edges`
const secFormat = (v: number) => span(v)

/** For the editor's pass hint: what a run will actually do. */
const passHint = 'Each pass builds, then holds at its top until you call an edge (the edge button, a key, the remote) — or gives up after two minutes — eases right off, and builds again higher. The last one holds and leads into the next phase.'

/** Phase strip label tooltip; edged phases explain their passes. */
function phaseTip(p: ProgrammePhase, i: number) {
  const lp = showingRun.value ? prog.shape?.live[i] : null
  const edges = edgeCount(p) > 1
    ? ` · ${lp ? `${prog.liveEdges[i]?.at.length ?? 0}/${edgeCount(p)} edges` : `${edgeCount(p)} edges`}`
    : ''
  return `${p.name} · ${span(shownBounds.value[i].dur)} · ${pct(p.from)} → ${pct(p.to)}${edges}`
}

/** For the hero status line: edge pass in words. */
const edgeLine = computed(() => {
  const e = edge.value
  if (!e)
    return null
  if (e.pass >= e.of)
    return `all ${e.of} edges done`
  return `edge ${Math.min(e.pass + 1, e.of)}/${e.of} · ${e.waiting ? 'waiting for your edge' : EDGE_WORD[e.kind]}`
})
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
          <span class="text-[13px] text-fg font-medium flex gap-1.5 items-center">
            <span class="truncate">{{ shown.name }}</span>
            <UiBadge v-if="reelMode" size="xs" tone="accent" icon="i-carbon-video-player">Reel</UiBadge>
          </span>
          <Transition name="t-fade" mode="out-in">
            <span v-if="live && prog.currentPhase" :key="`p-${prog.phaseIndex}-${prog.status}`" class="text-[12px] font-medium flex gap-1.5 min-w-0 items-center" :style="{ color: phaseTone }">
              <span class="rounded-full bg-current shrink-0 h-1.5 w-1.5" :class="running ? 'animate-pulse-dot' : ''" />
              <span class="truncate">{{ paused ? 'Paused · ' : '' }}{{ prog.currentPhase.name }}</span>
              <span v-if="edgeLine" class="text-fg-faint font-normal truncate">· {{ edgeLine }}</span>
            </span>
            <span v-else-if="stopping" key="stopping" class="text-[12px] text-fg-muted flex gap-1.5 items-center">
              <span class="i-carbon-renew [animation:ph-spin_1.2s_linear_infinite]" /> Easing down…
            </span>
            <span v-else-if="prog.finished && showingRun" key="done" class="text-[12px] text-ok flex gap-1.5 items-center">
              <span class="i-carbon-checkmark-outline" /> Finished · {{ clock(prog.elapsed) }}
            </span>
            <span v-else key="idle" class="hint num">{{ shown.phases.length }} phases · {{ clock(shownTotal) }}<template v-if="reelShown"> · {{ prog.reel.length }} clips</template></span>
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

      <!-- The arc: target curve, phase bands, reel strip, playhead and the live levels -->
      <div class="flex flex-col gap-1">
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

          <template v-if="prog.active || (prog.finished && showingRun)">
            <span class="playhead bg-fg w-px bottom-0 top-0 absolute" :style="{ left: `${progress * 100}%` }" />
            <span
              v-if="prog.active"
              v-tip="`Written ${pct(prog.output)}`"
              class="dot rounded-full bg-accent h-2 w-2 absolute"
              :style="{ left: `${progress * 100}%`, top: yPct(prog.output) }"
            />
            <span
              v-if="prog.active && actual !== null"
              v-tip="`${prog.mode === 'reel' && !prog.scriptLive ? 'Clip' : 'Script'} ${pct(actual)}`"
              class="dot rounded-full h-2 w-2 ring-2 ring-info absolute"
              :style="{ left: `${progress * 100}%`, top: yPct(actual) }"
            />
          </template>
          <span class="eyebrow left-2 top-1.5 absolute">intensity</span>
          <span class="text-[10.5px] text-fg-faint num right-2 top-1.5 absolute">{{ clock(shownTotal) }}</span>
        </div>

        <!-- Reel strip: each clip where it falls on the clock, shaded by how hard it goes -->
        <Transition name="t-fade">
          <div v-if="reelShown" class="strip rounded-[var(--radius-xs)] bg-surface-950/60 h-2.5 relative overflow-hidden" aria-hidden="true">
            <span
              v-for="(c, k) in prog.reel"
              :key="c.id"
              v-tip="`${title(c)} · ${c.name} · ${span(clipSeconds(c))} · ${pct(c.intensity)}`"
              class="seg bottom-0 top-0 absolute"
              :class="[clipState(k) === 'current' ? 'is-current' : '', clipState(k) === 'played' ? 'opacity-45' : '', c.locked ? 'is-locked' : '']"
              :style="{
                left: `${(c.at / shownTotal) * 100}%`,
                width: `${Math.max(0.4, (clipSeconds(c) / shownTotal) * 100)}%`,
                backgroundColor: clipFill(c.intensity),
              }"
            />
          </div>
        </Transition>
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
                width: `${showingRun
                  ? Math.min(1, Math.max(0, (prog.elapsed - shownBounds[i].start) / shownBounds[i].dur)) * 100
                  : 0}%`,
                background: KIND_TONE[p.kind],
              }"
            />
          </span>
          <span
            v-tip="phaseTip(p, i)"
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
                :label="prog.mode === 'reel' && !prog.scriptLive ? 'Clip' : 'Script'"
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
      <div v-if="live" class="flex flex-wrap gap-2">
        <UiButton size="sm" icon="i-carbon-skip-forward" class="flex-1" @click="prog.skipPhase()">
          {{ prog.phaseIndex < (prog.plan?.phases.length ?? 0) - 1 ? 'Next phase' : 'Wind down' }}
        </UiButton>
        <UiButton v-tip="'Add five minutes to this phase'" size="sm" icon="i-carbon-time" class="flex-1" @click="prog.extendPhase()">
          +5 min
        </UiButton>
        <UiButton
          v-tip="edge && edge.pass < edge.of ? 'Close: end this pass and ease right off' : 'Close: back everything off for a while'"
          size="sm"
          variant="subtle"
          icon="i-carbon-hourglass"
          class="flex-1"
          @click="callEdge"
        >
          Edge
        </UiButton>
      </div>
    </section>

    <!-- ─── Now playing clip ──────────────────────────────────────────────── -->
    <Transition name="t-fade">
      <section v-if="nowClip" class="p-2.5 card flex flex-col gap-2.5">
        <div class="flex gap-2.5 items-center">
          <span v-lazy-thumb="nowEntry" class="thumb rounded-[var(--radius-sm)] bg-surface-800 shrink-0 h-12 w-20 relative overflow-hidden" :style="thumbStyle(nowClip)">
            <span class="eyebrow text-[9px] px-1 rounded-[var(--radius-xs)] bg-surface-950/80 bottom-1 left-1 absolute">{{ prog.clipIndex + 1 }}/{{ prog.reel.length }}</span>
          </span>
          <div class="flex flex-1 flex-col gap-0.5 min-w-0">
            <span v-tip="title(nowClip)" class="text-[12.5px] text-fg font-medium truncate">{{ title(nowClip) }}</span>
            <span class="text-[11px] text-fg-muted flex gap-1.5 min-w-0 items-center">
              <span class="truncate">{{ nowClip.name || 'Chapter' }}</span>
              <span class="text-fg-faint num shrink-0">· {{ clock(nowClip.start) }}–{{ clock(nowClip.end) }}</span>
            </span>
            <span class="text-[11px] num flex gap-1.5 items-center">
              <span class="text-accent-300">{{ pct(nowClip.intensity) }}</span>
              <span class="text-fg-faint">for {{ pct(nowClip.target) }} wanted</span>
            </span>
          </div>
          <div class="flex shrink-0 flex-col gap-1 items-end">
            <span class="text-[11px] text-fg-muted num">{{ prog.offReel ? 'off reel' : `−${clock(nowLeft)}` }}</span>
          </div>
        </div>
        <UiProgress :value="prog.clipProgress" />
        <div class="flex gap-2">
          <UiButton
            v-if="prog.offReel"
            size="sm"
            variant="primary"
            icon="i-carbon-undo"
            class="flex-1"
            @click="prog.nextClip()"
          >
            Back to the reel
          </UiButton>
          <template v-else>
            <UiButton v-tip="`Stay on this clip for another ${KEEP_LONGER_SEC} s`" size="sm" icon="i-carbon-add-alt" class="flex-1" @click="prog.keepLonger()">
              Keep longer
            </UiButton>
            <UiButton size="sm" icon="i-carbon-skip-forward-outline" class="flex-1" @click="prog.nextClip()">
              Next clip
            </UiButton>
          </template>
        </div>
      </section>
    </Transition>

    <!-- ─── Highlight reel ────────────────────────────────────────────────── -->
    <UiSection title="Highlight reel" icon="i-carbon-video-player" :summary="reelSummary" :live="live && prog.mode === 'reel'">
      <template #actions>
        <UiButton
          v-if="reelShown"
          v-tip="'Reshuffle what has not played; locked clips stay'"
          size="xs"
          variant="ghost"
          icon="i-carbon-shuffle"
          @click="prog.regenerate()"
        >
          Shuffle
        </UiButton>
      </template>

      <!-- Index progress -->
      <div class="flex flex-col gap-1.5">
        <div class="flex gap-2 items-center">
          <span class="text-[11.5px] text-fg-muted num flex-1">
            <template v-if="!library.hasVideos">No library open</template>
            <template v-else-if="ix.total">Indexed {{ ix.done }} / {{ ix.total }} videos<template v-if="ix.failed"> · {{ ix.failed }} unreadable</template></template>
            <template v-else>{{ prog.scriptedCount }} scripted videos</template>
          </span>
          <UiIconButton
            v-if="ix.running"
            icon="i-carbon-pause"
            label="Pause indexing"
            size="xs"
            @click="prog.cancelIndex()"
          />
          <UiIconButton
            v-else-if="library.hasVideos && !indexComplete"
            icon="i-carbon-play"
            label="Index chapters in the background"
            size="xs"
            @click="prog.ensureIndex()"
          />
          <span v-else-if="indexComplete" class="i-carbon-checkmark-outline text-[13px] text-ok" />
        </div>
        <UiProgress v-if="ix.total && !indexComplete" :value="indexProgress" :tone="ix.running ? 'accent' : 'info'" />
      </div>

      <Transition name="t-fade">
        <p v-if="fallbackReason" class="text-[11.5px] text-fg-muted leading-snug px-2.5 py-2 rounded-[var(--radius-sm)] bg-warn/8 flex gap-2 ring-1 ring-warn/20">
          <span class="i-carbon-information text-[14px] text-warn mt-px shrink-0" />
          <span>{{ fallbackReason }}</span>
        </p>
      </Transition>
      <p v-if="prog.shortfall && reelShown" class="hint">
        Not enough distinct chapters for this length; a few repeat.
      </p>

      <!-- The planned clips, by phase -->
      <div v-if="reelShown" class="flex flex-col gap-2">
        <div v-for="g in groups" :key="g.phase.id" class="flex flex-col gap-1">
          <div class="flex gap-1.5 items-center">
            <span class="rounded-full shrink-0 h-1.5 w-1.5" :style="{ background: KIND_TONE[g.phase.kind] }" />
            <span class="text-[11.5px] text-fg font-medium truncate">{{ g.phase.name }}</span>
            <span class="text-[10.5px] text-fg-faint num ml-auto">{{ g.clips.length }} clips · {{ pct(g.phase.from) }} → {{ pct(g.phase.to) }}</span>
          </div>
          <TransitionGroup tag="ul" name="t-list" class="flex flex-col gap-0.5 relative">
            <li
              v-for="{ c, k } in g.clips"
              :key="c.id"
              class="clip group pl-1 pr-0.5 rounded-[var(--radius-sm)] flex gap-2 h-11 transition-colors items-center"
              :class="{
                'bg-accent-soft ring-1 ring-accent/35': clipState(k) === 'current',
                'opacity-50': clipState(k) === 'played',
                'hover:bg-fg/5': clipState(k) === 'planned',
              }"
            >
              <span v-lazy-thumb="entryOf(c)" class="thumb rounded-[var(--radius-xs)] bg-surface-800 shrink-0 h-8 w-14 relative overflow-hidden" :style="thumbStyle(c)">
                <span v-if="clipState(k) === 'current'" class="bg-surface-950/55 center inset-0 absolute">
                  <span class="i-carbon-play-filled-alt text-[12px] text-accent-300" />
                </span>
              </span>
              <div class="flex flex-1 flex-col min-w-0">
                <span v-tip="title(c)" class="text-[12px] text-fg truncate">{{ title(c) }}</span>
                <span class="text-[10.5px] text-fg-faint num flex gap-1 min-w-0">
                  <span>{{ clock(c.at) }}</span>
                  <span>·</span>
                  <span class="truncate">{{ c.name || 'Chapter' }}</span>
                  <span class="shrink-0">· {{ span(clipSeconds(c)) }}</span>
                </span>
              </div>
              <span v-tip="`${pct(c.intensity)} for ${pct(c.target)} wanted`" class="meter rounded-full bg-surface-700 shrink-0 h-1 w-10 relative">
                <span class="rounded-full h-full block" :style="{ width: pct(c.intensity), background: clipFill(c.intensity) }" />
                <span class="tick bg-fg-muted w-px absolute -bottom-0.5 -top-0.5" :style="{ left: pct(c.target) }" />
              </span>
              <div v-if="clipState(k) !== 'played'" class="flex shrink-0 items-center">
                <UiIconButton
                  :icon="c.locked ? 'i-carbon-locked' : 'i-carbon-unlocked'"
                  :label="c.locked ? 'Unlock' : 'Lock: keep through a reshuffle'"
                  size="xs"
                  :active="c.locked"
                  :class="c.locked ? '' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'"
                  @click="prog.toggleLock(c.id)"
                />
                <UiIconButton
                  icon="i-carbon-skip-forward-outline"
                  :label="clipState(k) === 'current' ? 'Skip to the next clip' : 'Skip: choose another for this slot'"
                  size="xs"
                  class="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
                  @click="prog.skipClip(c.id)"
                />
              </div>
            </li>
          </TransitionGroup>
        </div>
      </div>
      <div v-else-if="!fallbackReason" class="flex flex-col gap-1.5" aria-hidden="true">
        <div v-for="i in 4" :key="i" class="skeleton rounded-[var(--radius-sm)] h-9" />
      </div>
    </UiSection>

    <!-- ─── Connections: honest wiring ────────────────────────────────────── -->
    <UiSection title="What follows the arc" icon="i-carbon-connect" :live="prog.active" collapsible>
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

    <!-- ─── Whole-video plan (fallback) ───────────────────────────────────── -->
    <Transition name="t-fade">
      <UiSection
        v-if="prog.plan && (prog.active || prog.finished) && prog.mode === 'videos'"
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
                        label="Edges"
                        :min="0"
                        :max="MAX_EDGES"
                        :step="1"
                        :format="edgeFormat"
                        tone="warn"
                        :hint="p.edges > 1 ? passHint : undefined"
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

          <UiSwitch
            v-model="draft.reel"
            label="Highlight reel"
            hint="The best-fitting chapters of many videos, back to back, gentle ones first and the hardest at the peak. Whole videos play while the chapter index is too small."
            size="sm"
          />
          <Transition name="t-collapse">
            <div v-if="draft.reel">
              <div class="min-h-0 overflow-hidden">
                <div class="gap-3 grid grid-cols-2">
                  <UiSlider :model-value="draft.clipSec[0]" label="Shortest clip" :min="10" :max="300" :step="5" :format="secFormat" @update:model-value="setClip(0, $event)" />
                  <UiSlider :model-value="draft.clipSec[1]" label="Longest clip" :min="10" :max="600" :step="10" :format="secFormat" @update:model-value="setClip(1, $event)" />
                </div>
              </div>
            </div>
          </Transition>
          <div class="flex flex-col gap-1.5">
            <span class="label">{{ draft.reel ? 'Whole videos change (fallback)' : 'Change video' }}</span>
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
                {{ minutesOf(p) }} min · {{ p.phases.length }} phases<template v-if="p.phases.some(ph => ph.edges > 1)"> · edging</template><template v-if="p.reel"> · reel</template>
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

/* Clips sit edge to edge; a hairline of background between them shows the cuts. */
.seg {
  box-shadow: inset -1px 0 0 var(--bg-900);
  transition:
    left var(--dur) var(--ease-out),
    width var(--dur) var(--ease-out),
    opacity var(--dur) var(--ease-out);
}
.seg.is-current {
  box-shadow:
    inset 0 0 0 1px var(--text),
    inset -1px 0 0 var(--bg-900);
}
.seg.is-locked {
  background-image: repeating-linear-gradient(
    135deg,
    transparent 0 3px,
    color-mix(in srgb, var(--bg-900) 45%, transparent) 3px 5px
  );
}

.thumb {
  background-size: cover;
  background-position: center;
}

.spark path {
  fill: none;
  stroke: var(--accent);
  stroke-width: 1.5;
  vector-effect: non-scaling-stroke;
  opacity: 0.85;
}
</style>
