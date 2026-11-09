<script setup lang="ts">
import type { CycleSource, FillTarget, RateSpec } from '~/lib/scriptFill'
import type { Pattern } from '~/lib/scriptPatterns'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiIconButton from '~/components/ui/UiIconButton.vue'
import UiSegmented from '~/components/ui/UiSegmented.vue'
import UiSlider from '~/components/ui/UiSlider.vue'
import UiSwitch from '~/components/ui/UiSwitch.vue'
import { useSoundtrack } from '~/composables/useSoundtrack'
import { toast } from '~/composables/useToast'
import { speedLimit } from '~/lib/musicScript'
import { positionAt } from '~/lib/scriptEdit'
import { countFast, pickTarget, planFill, STROKE_SHAPES } from '~/lib/scriptFill'
import { SHAPE_LABELS, thumbPath } from '~/lib/scriptPatterns'
import { useMotionStore } from '~/stores/motionStore'
import { usePlayerStore } from '~/stores/playerStore'
import { useScriptEditStore } from '~/stores/scriptEditStore'
import { useScriptPatternStore } from '~/stores/scriptPatternStore'

/**
 * Fill and Insert pattern, one panel: pick a shape or a pattern, a range
 * and a rate; the canvas shows what it would make until it is applied.
 *
 * What it goes into: between the first and last selected points, a marked
 * stretch of time, the A–B loop, or (with none of those) from the playhead.
 */

const emit = defineEmits<{ close: [], show: [from: number, to: number], resize: [] }>()

const edit = useScriptEditStore()
const patterns = useScriptPatternStore()
const player = usePlayerStore()
const motion = useMotionStore()
const soundtrack = useSoundtrack()

const f = computed(() => edit.prefs.fill)
const offset = computed(() => edit.target?.offsetMs ?? 0)

// ─── What it goes into ───────────────────────────────────────────────────────
type Into = 'between' | 'marked' | 'loop' | 'at'

const loopRange = computed(() => {
  if (player.loopStart === null || player.loopEnd === null)
    return null
  const a = Math.min(player.loopStart, player.loopEnd) * 1000 + offset.value
  const b = Math.max(player.loopStart, player.loopEnd) * 1000 + offset.value
  return b - a >= 2 ? { t0: Math.max(0, Math.round(a)), t1: Math.round(b) } : null
})

const intoOptions = computed(() => {
  const out: { value: Into, label: string, title: string }[] = []
  if (pickTarget(edit.points, edit.selection, null, 0).kind === 'between')
    out.push({ value: 'between', label: 'Selection', title: 'Between the first and last selected points' })
  if (edit.markedRange)
    out.push({ value: 'marked', label: 'Marked', title: 'The stretch marked with Alt + drag' })
  if (loopRange.value)
    out.push({ value: 'loop', label: 'A–B loop', title: 'The A–B loop' })
  out.push({ value: 'at', label: 'From here', title: 'From the playhead, as long as it runs' })
  return out
})

function defaultInto(): Into {
  if (edit.fillPrefer === 'at')
    return 'at'
  return intoOptions.value[0].value
}
const into = ref<Into>(defaultInto())
watch(intoOptions, (opts) => {
  if (!opts.some(o => o.value === into.value))
    into.value = opts[0].value
})

const target = computed<FillTarget>(() => {
  const s = edit.selection
  if (into.value === 'between' && s.length >= 2)
    return { kind: 'between', i0: s[0], i1: s[s.length - 1] }
  if (into.value === 'marked' && edit.markedRange)
    return { kind: 'range', t0: Math.round(edit.markedRange.t0), t1: Math.round(edit.markedRange.t1) }
  if (into.value === 'loop' && loopRange.value)
    return { kind: 'range', ...loopRange.value }
  return { kind: 'at', t: edit.fillAt }
})
const isAt = computed(() => target.value.kind === 'at')

/** The positions at the span's two ends, for "use the end points". */
const endPositions = computed<[number, number] | null>(() => {
  const t = target.value
  const pts = edit.points
  if (t.kind === 'between')
    return [pts[t.i0].pos, pts[t.i1].pos]
  if (t.kind === 'range')
    return [positionAt(pts, t.t0), positionAt(pts, t.t1)]
  return null
})

// ─── Shape or pattern ────────────────────────────────────────────────────────
interface SourceItem { id: string, label: string, source: CycleSource, pattern: Pattern | null, path: string }

const THUMB_W = 56
const THUMB_H = 22

const sources = computed<SourceItem[]>(() => [
  ...STROKE_SHAPES.map((shape) => {
    const source: CycleSource = { kind: 'shape', shape }
    return { id: `shape:${shape}`, label: SHAPE_LABELS[shape], source, pattern: null, path: thumbPath(source, THUMB_W, THUMB_H) }
  }),
  ...patterns.all.map((p) => {
    const source: CycleSource = { kind: 'pattern', points: p.points }
    return { id: p.id, label: p.name, source, pattern: p, path: thumbPath(source, THUMB_W, THUMB_H) }
  }),
])
const current = computed(() => sources.value.find(s => s.id === f.value.source) ?? sources.value[0])
const pattern = computed(() => current.value.pattern)

function pick(item: SourceItem) {
  if (f.value.source === item.id)
    return
  f.value.source = item.id
  const p = item.pattern
  if (p) {
    // A pattern goes in as it was: its own range and speed, until changed.
    f.value.lo = p.lo
    f.value.hi = p.hi
    f.value.patternSpm = Math.max(1, Math.round(60000 / p.durationMs))
  }
}

function useEnds() {
  const e = endPositions.value
  if (!e)
    return
  f.value.lo = Math.round(Math.min(...e) * 100)
  f.value.hi = Math.round(Math.max(...e) * 100)
}
const endsUsable = computed(() => {
  const e = endPositions.value
  return !!e && Math.abs(e[0] - e[1]) >= 0.01
})

// Renaming and deleting the user's own patterns, right in the list.
const renaming = ref<string | null>(null)
const renameText = ref('')
const renameEl = ref<HTMLInputElement[] | null>(null)

async function startRename(p: Pattern) {
  renaming.value = p.id
  renameText.value = p.name
  await nextTick()
  renameEl.value?.[0]?.select()
}
function finishRename() {
  if (renaming.value)
    patterns.rename(renaming.value, renameText.value)
  renaming.value = null
}
function removePattern(p: Pattern) {
  const undo = patterns.remove(p.id)
  if (f.value.source === p.id)
    f.value.source = 'shape:sine'
  if (undo)
    toast('Pattern deleted', { detail: p.name, icon: 'i-carbon-trash-can', key: 'pattern-delete', action: { label: 'Undo', run: undo } })
}

// ─── Rate ────────────────────────────────────────────────────────────────────
type RateKind = 'spm' | 'count' | 'beats' | 'own'

const rateOptions = computed(() => {
  if (isAt.value) {
    const out: { value: RateKind, label: string }[] = [{ value: 'spm', label: 'Per minute' }]
    if (pattern.value)
      out.push({ value: 'own', label: 'Its own speed' })
    return out
  }
  return [
    { value: 'spm' as RateKind, label: 'Per minute' },
    { value: 'count' as RateKind, label: pattern.value ? 'Times' : 'Strokes' },
    { value: 'beats' as RateKind, label: 'Beats' },
  ]
})
const rateKind = computed<RateKind>({
  get: () => (rateOptions.value.some(o => o.value === f.value.rate) ? f.value.rate : rateOptions.value[0].value),
  set: v => (f.value.rate = v),
})

/** Strokes per minute, or a pattern's repeats per minute. */
const spm = computed({
  get: () => (pattern.value ? f.value.patternSpm : f.value.spm),
  set: (v: number) => (pattern.value ? (f.value.patternSpm = v) : (f.value.spm = v)),
})
const count = computed({
  get: () => (pattern.value ? f.value.repeats : f.value.count),
  set: (v: number) => (pattern.value ? (f.value.repeats = v) : (f.value.count = v)),
})
const ownSpm = computed(() => (pattern.value ? 60000 / pattern.value.durationMs : 60))
const unit = computed(() => (pattern.value ? 'repeats' : 'strokes'))

const analysis = computed(() => soundtrack.analysis.value)
const beatsMs = computed(() => analysis.value?.beats.map(b => b * 1000 + offset.value) ?? null)
const soundtrackBusy = computed(() => {
  const s = soundtrack.current.value?.status
  return s === 'decoding' || s === 'analysing'
})
const PER_BEAT = [
  { value: 0.5, label: '½' },
  { value: 1, label: '1' },
  { value: 2, label: '2' },
]

const rate = computed<RateSpec | null>(() => {
  switch (rateKind.value) {
    case 'beats':
      return beatsMs.value ? { kind: 'beats', beats: beatsMs.value, perBeat: f.value.perBeat } : null
    case 'count':
      return { kind: 'count', count: count.value }
    case 'own':
      return { kind: 'spm', spm: ownSpm.value }
    default:
      return { kind: 'spm', spm: spm.value, to: f.value.ramp ? f.value.spmTo : undefined }
  }
})

/** From the playhead: as long as `count` strokes take at the rate. */
const length = computed(() => {
  const r = rate.value
  if (!isAt.value || !r || r.kind !== 'spm')
    return 0
  const avg = (r.spm + (r.to ?? r.spm)) / 2
  return avg > 0 ? (count.value * 60000) / avg : 0
})

// ─── The plan, previewed ─────────────────────────────────────────────────────
const plan = computed(() => {
  const r = rate.value
  if (!r || !edit.target)
    return null
  return planFill(edit.points, target.value, {
    source: current.value.source,
    lo: f.value.lo / 100,
    hi: f.value.hi / 100,
    rate: r,
    fit: f.value.fit,
    edges: f.value.edges,
    length: length.value,
  })
})

watch(plan, (p) => {
  edit.fillPreview = p && !p.result.error ? { from: p.from, to: p.to, points: p.inserted } : null
}, { immediate: true })
onBeforeUnmount(() => (edit.fillPreview = null))

// Bring the stretch into view when it changes, not on every tweak.
watch(() => (plan.value ? `${plan.value.from}:${plan.value.to}` : ''), () => {
  if (plan.value)
    emit('show', plan.value.from, plan.value.to)
}, { immediate: true })

function fmtTime(ms: number) {
  const s = Math.max(0, ms) / 1000
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`
}

const title = computed(() => {
  const t = target.value
  if (t.kind === 'between')
    return 'Fill between the selected points'
  if (t.kind === 'range')
    return into.value === 'loop' ? 'Fill the A–B loop' : 'Fill the marked stretch'
  return pattern.value ? 'Insert a pattern' : 'Insert strokes'
})
const spanText = computed(() => {
  const p = plan.value
  if (!p)
    return isAt.value ? `at ${fmtTime(edit.fillAt)}` : ''
  return `${fmtTime(p.from)} – ${fmtTime(p.to)} · ${((p.to - p.from) / 1000).toFixed(1)} s`
})

const summary = computed(() => {
  const p = plan.value
  if (!p || p.result.error)
    return null
  const r = p.result
  const n = Math.round(r.cycles * 10) / 10
  const ramping = Math.abs(r.spmFrom - r.spmTo) > 0.5
  const rateText = ramping ? `${Math.round(r.spmFrom)} → ${Math.round(r.spmTo)}/min` : `${Math.round(r.spm)}/min`
  // Fitting nudged the rate: say from what.
  let nudged = ''
  if (!isAt.value && f.value.fit && rateKind.value === 'spm' && !f.value.ramp && Math.abs(r.spm - spm.value) >= 0.5)
    nudged = `fitted from ${spm.value}/min`
  return { count: `${n} ${n === 1 ? unit.value.replace(/s$/, '') : unit.value}`, rate: rateText, nudged, points: p.inserted.length }
})

const errorText = computed(() => {
  const e = plan.value?.result.error
  if (e === 'beats')
    return 'No beat falls in this stretch.'
  if (e === 'span')
    return isAt.value ? 'Nothing to insert at this length.' : 'Too short to fill.'
  return null
})

const fast = computed(() => (plan.value && !plan.value.result.error ? countFast(plan.value.points, edit.prefs.fastLimit, plan.value.first, plan.value.last) : 0))
const overCeiling = computed(() => !!plan.value && plan.value.peak > speedLimit(motion.maxSpm) * 1000 + 0.5)

function apply() {
  const p = plan.value
  if (!p || p.result.error || !p.inserted.length)
    return
  edit.commit(p.points, p.selection)
  if (into.value === 'marked')
    edit.markedRange = null
  emit('close')
}

/** Enter applies, except where Enter already means something (a button, the name being edited). */
function onEnter(e: KeyboardEvent) {
  const tag = (e.target as HTMLElement | null)?.tagName
  if (tag === 'INPUT' || tag === 'BUTTON' || tag === 'SELECT')
    return
  e.preventDefault()
  apply()
}

// The popover places itself once; anything that changes the panel's height asks again.
watch(() => [rateKind.value, isAt.value, f.value.ramp, !!errorText.value, fast.value > 0, overCeiling.value, intoOptions.value.length, sources.value.length], () => {
  void nextTick(() => emit('resize'))
})
</script>

<template>
  <div class="flex flex-col gap-3" @keydown.enter.exact="onEnter">
    <div class="flex gap-3 items-center">
      <span class="text-[13px] text-fg font-medium shrink-0">{{ title }}</span>
      <span class="text-[11px] text-fg-faint num truncate">{{ spanText }}</span>
      <UiSegmented v-if="intoOptions.length > 1" v-model="into" :options="intoOptions" size="xs" class="ml-auto shrink-0" />
    </div>

    <div class="gap-4 grid grid-cols-[236px_1fr]">
      <!-- Shapes, then patterns -->
      <div class="flex flex-col gap-1.5 min-w-0">
        <span class="label">Shape</span>
        <div class="pr-0.5 gap-1 grid grid-cols-3 max-h-[252px] overflow-y-auto">
          <div v-for="s in sources" :key="s.id" class="group relative">
            <button
              type="button"
              class="px-1 pb-1 pt-1.5 focusable border rounded-[var(--radius-sm)] flex flex-col gap-1 w-full transition-colors items-center"
              :class="s.id === current.id ? 'border-accent/60 bg-accent-soft text-accent-300' : 'border-edge text-fg-muted hover:bg-fg/6 hover:text-fg'"
              :aria-pressed="s.id === current.id"
              :title="s.pattern ? `${s.label} · ${(s.pattern.durationMs / 1000).toFixed(1)} s` : s.label"
              @click="pick(s)"
            >
              <svg :width="THUMB_W" :height="THUMB_H" :viewBox="`0 0 ${THUMB_W} ${THUMB_H}`" class="block" aria-hidden="true">
                <path :d="s.path" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
              </svg>
              <input
                v-if="renaming === s.id"
                ref="renameEl"
                v-model="renameText"
                class="text-[11px] text-fg px-1 border border-edge-strong rounded-[var(--radius-xs)] bg-surface-850 h-4.5 w-full"
                aria-label="Pattern name"
                @click.stop
                @keydown.enter.stop.prevent="finishRename"
                @keydown.escape.stop.prevent="renaming = null"
                @blur="finishRename"
              >
              <span v-else class="text-[11px] leading-tight max-w-full truncate">{{ s.label }}</span>
            </button>
            <div
              v-if="s.pattern && !s.pattern.builtin && renaming !== s.id"
              class="opacity-0 flex transition-opacity right-0.5 top-0.5 absolute group-focus-within:opacity-100 group-hover:opacity-100"
            >
              <UiIconButton icon="i-carbon-edit" label="Rename" size="xs" variant="solid" @click="startRename(s.pattern)" />
              <UiIconButton icon="i-carbon-trash-can" label="Delete" size="xs" variant="solid" @click="removePattern(s.pattern)" />
            </div>
          </div>
        </div>
        <p v-if="!patterns.saved.length" class="hint">
          Select some points and save them as a pattern to have them here.
        </p>
      </div>

      <div class="flex flex-col gap-3 min-w-0">
        <!-- Range -->
        <div class="flex flex-col gap-2">
          <div class="flex gap-2 items-center justify-between">
            <span class="label">Range</span>
            <div class="flex gap-1">
              <UiButton v-if="pattern" variant="ghost" size="xs" @click="f.lo = pattern.lo; f.hi = pattern.hi">
                Its own
              </UiButton>
              <UiButton v-if="!isAt" variant="ghost" size="xs" :disabled="!endsUsable" @click="useEnds">
                Use the end points
              </UiButton>
            </div>
          </div>
          <div class="gap-3 grid grid-cols-2">
            <UiSlider v-model="f.lo" label="Low" :min="0" :max="100" :step="1" :reset="5" />
            <UiSlider v-model="f.hi" label="High" :min="0" :max="100" :step="1" :reset="95" />
          </div>
        </div>

        <!-- Rate -->
        <div class="flex flex-col gap-2">
          <div class="flex gap-2 items-center justify-between">
            <span class="label">Rate</span>
            <UiSegmented v-model="rateKind" :options="rateOptions" size="xs" />
          </div>

          <template v-if="rateKind === 'spm'">
            <div class="gap-3 grid" :class="f.ramp ? 'grid-cols-2' : 'grid-cols-1'">
              <UiSlider
                v-model="spm"
                :label="f.ramp ? 'From' : pattern ? 'Repeats a minute' : 'Strokes a minute'"
                :min="pattern ? 1 : 10"
                :max="pattern ? 120 : 400"
                :step="1"
                :format="v => `${v}/min`"
              />
              <UiSlider
                v-if="f.ramp"
                v-model="f.spmTo"
                label="To"
                :min="pattern ? 1 : 10"
                :max="pattern ? 120 : 400"
                :step="1"
                :format="v => `${v}/min`"
              />
            </div>
            <UiSwitch v-model="f.ramp" size="sm" label="Ramp" hint="Speed up or slow down across the span" />
          </template>
          <p v-else-if="rateKind === 'own'" class="hint">
            {{ pattern ? `${(pattern.durationMs / 1000).toFixed(1)} s each, as it was saved` : '' }}
          </p>
          <template v-else-if="rateKind === 'beats'">
            <div v-if="beatsMs" class="flex gap-2 items-center justify-between">
              <span class="hint">{{ pattern ? 'Repeats' : 'Strokes' }} per beat · {{ Math.round(analysis?.bpm ?? 0) }} bpm</span>
              <UiSegmented v-model="f.perBeat" :options="PER_BEAT" size="xs" class="num" />
            </div>
            <div v-else class="flex gap-2 items-center justify-between">
              <span class="hint">{{ soundtrackBusy ? 'Analysing the soundtrack…' : 'The soundtrack has not been analysed yet.' }}</span>
              <UiButton size="xs" icon="i-carbon-music" :loading="soundtrackBusy" :disabled="!soundtrack.canAnalyse.value" @click="soundtrack.analyseCurrent()">
                Analyse
              </UiButton>
            </div>
          </template>

          <UiSlider
            v-if="rateKind === 'count' || isAt"
            v-model="count"
            :label="pattern ? 'Repeats' : 'Strokes'"
            :min="1"
            :max="pattern ? 32 : 200"
            :step="1"
            :format="v => (!isAt && pattern && v === 1 ? '1, stretched to fit' : String(v))"
          />

          <UiSwitch
            v-if="!isAt && rateKind !== 'beats'"
            v-model="f.fit"
            size="sm"
            :label="pattern ? 'Whole repeats' : 'Whole strokes'"
            hint="Nudge the rate so it ends on the end point"
          />
          <div v-if="target.kind === 'range'" class="flex gap-2 items-center justify-between">
            <span class="hint">Ends</span>
            <UiSegmented
              v-model="f.edges"
              :options="[{ value: 'script', label: 'Meet the script', title: 'Start and end where the script is' }, { value: 'fill', label: 'Its own', title: 'Start and end wherever the motion is' }]"
              size="xs"
            />
          </div>
        </div>
      </div>
    </div>

    <!-- What it makes -->
    <div class="pt-2.5 border-t border-edge flex gap-3 items-end">
      <div class="flex flex-1 flex-col gap-1 min-w-0">
        <p v-if="errorText" class="text-[12px] text-warn flex gap-1.5 items-center">
          <span class="i-carbon-warning-alt shrink-0" />{{ errorText }}
        </p>
        <p v-else-if="summary" class="text-[12px] text-fg-muted num flex flex-wrap gap-x-2.5">
          <span class="text-fg">{{ summary.count }}</span>
          <span>{{ summary.rate }}</span>
          <span v-if="summary.nudged" class="text-fg-faint">{{ summary.nudged }}</span>
          <span class="text-fg-faint">{{ summary.points.toLocaleString() }} points</span>
        </p>
        <p v-if="fast" class="text-[12px] text-danger flex gap-1.5 items-start">
          <span class="i-carbon-warning-alt mt-0.5 shrink-0" />
          {{ fast }} {{ fast === 1 ? 'segment is' : 'segments are' }} faster than {{ edit.prefs.fastLimit }}/s, more than most devices can follow.
        </p>
        <p v-if="overCeiling" class="text-[12px] text-warn flex gap-1.5 items-start">
          <span class="i-carbon-warning-alt mt-0.5 shrink-0" />
          Faster than your speed ceiling ({{ motion.maxSpm }} full strokes a minute).
        </p>
      </div>
      <UiButton variant="ghost" size="sm" @click="emit('close')">
        Cancel
      </UiButton>
      <UiButton variant="primary" size="sm" icon="i-carbon-checkmark" :disabled="!summary" @click="apply">
        {{ isAt ? 'Insert' : 'Fill' }}
      </UiButton>
    </div>
  </div>
</template>
