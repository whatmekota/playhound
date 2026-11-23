<script setup lang="ts">
import type { HumaniseLevel, ScriptTweaks, SmoothLevel, StrokeCount } from '~/lib/scriptTweaks'
import { computed, ref, watch } from 'vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiIconButton from '~/components/ui/UiIconButton.vue'
import UiSegmented from '~/components/ui/UiSegmented.vue'
import UiSelect from '~/components/ui/UiSelect.vue'
import UiSlider from '~/components/ui/UiSlider.vue'
import UiSwitch from '~/components/ui/UiSwitch.vue'
import { parseTimespan } from '~/lib/chapters'
import { MAX_SPEED_CAP, MIN_REPEAT_MS } from '~/lib/scriptTweaks'
import { formatTime } from '~/lib/time'
import { usePlayerStore } from '~/stores/playerStore'
import { useScriptEditStore } from '~/stores/scriptEditStore'
import { useScriptStore } from '~/stores/scriptStore'

/**
 * How one axis plays on this video: whose script, range, invert, double or
 * half the strokes, a repeated stretch, a speed cap, smoothing, humanising
 * and the offset. Saved with the video, never written into the script.
 */
const props = defineProps<{ channel: string }>()

const scripts = useScriptStore()
const player = usePlayerStore()
const edit = useScriptEditStore()

const OFFSET_STEP = 50
/** The range never closes up completely: a script squeezed to one position does nothing. */
const MIN_SPAN = 5

const t = computed(() => scripts.tweaksFor(props.channel))
const set = (patch: Partial<ScriptTweaks>) => scripts.setTweaks(props.channel, patch)

const low = computed({
  get: () => t.value.min,
  set: v => set({ min: Math.min(v, t.value.max - MIN_SPAN) }),
})
const high = computed({
  get: () => t.value.max,
  set: v => set({ max: Math.max(v, t.value.min + MIN_SPAN) }),
})
const invert = computed({
  get: () => t.value.invert,
  set: v => set({ invert: v }),
})
const cap = computed({
  get: () => t.value.speedCap,
  set: v => set({ speedCap: v }),
})
const smooth = computed({
  get: () => t.value.smooth,
  set: (v: SmoothLevel) => set({ smooth: v }),
})

const strokes = computed({
  get: () => t.value.strokes,
  set: (v: StrokeCount) => set({ strokes: v }),
})
const STROKE_OPTIONS: { value: StrokeCount, label: string }[] = [
  { value: 'as-is', label: 'As written' },
  { value: 'double', label: 'Double' },
  { value: 'half', label: 'Half' },
]
const STROKE_HINT: Record<StrokeCount, string> = {
  'as-is': '',
  'double': 'Two strokes where the script has one, landing on the same moments: twice as fast for the same travel. The speed limit below shortens what a device can’t keep up with.',
  'half': 'One stroke where the script has two, on every other bottom, as tall as the taller of the pair.',
}

const SMOOTH_OPTIONS: { value: SmoothLevel, label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'light', label: 'Light' },
  { value: 'medium', label: 'Medium' },
]
const smoothAbove = computed({
  get: () => t.value.smoothAbove,
  set: v => set({ smoothAbove: v }),
})

const human = computed({
  get: () => t.value.humanise,
  set: (v: HumaniseLevel) => set({ humanise: v }),
})
const HUMANISE_OPTIONS: { value: HumaniseLevel, label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'light', label: 'Light' },
  { value: 'medium', label: 'Medium' },
]

// ─── Whose script ─────────────────────────────────────────────────────────
/** The other axes loaded on this video, by channel, with their names. */
const others = computed(() => {
  const out = new Map<string, string>()
  for (const s of scripts.scripts) {
    if (s.channel !== props.channel && (!out.has(s.channel) || !s.isAlt))
      out.set(s.channel, s.label)
  }
  return out
})
const plays = computed({
  get: () => t.value.plays,
  set: (v: string) => set({ plays: v }),
})
const playsLoaded = computed(() => !plays.value || others.value.has(plays.value))
const playsOptions = computed(() => [
  { value: '', label: 'Its own script' },
  ...[...others.value].map(([ch, label]) => ({ value: ch, label: `${label}’s script (${ch})` })),
  // Chosen while that axis was loaded; kept, so the box shows what is saved.
  ...(playsLoaded.value ? [] : [{ value: plays.value, label: `${plays.value}’s script (not loaded)` }]),
])

// ─── Repeat a stretch ─────────────────────────────────────────────────────
const repeating = computed(() => t.value.repeatToMs > t.value.repeatFromMs)
/** m:ss, with tenths when there are any: how a stretch's ends are shown and typed. */
function clock(ms: number): string {
  const tenths = Math.round(ms / 100)
  return formatTime(Math.floor(tenths / 10)) + (tenths % 10 ? `.${tenths % 10}` : '')
}
// What is typed, until both ends make a stretch.
const fromText = ref('')
const toText = ref('')
const repeatError = ref('')
watch(() => `${t.value.repeatFromMs}-${t.value.repeatToMs}`, () => {
  fromText.value = repeating.value ? clock(t.value.repeatFromMs) : ''
  toText.value = repeating.value ? clock(t.value.repeatToMs) : ''
  repeatError.value = ''
}, { immediate: true })

function setStretch(from: number, to: number) {
  if (to - from < MIN_REPEAT_MS) {
    repeatError.value = 'The end needs to be at least half a second after the start.'
    return
  }
  repeatError.value = ''
  set({ repeatFromMs: from, repeatToMs: to })
}

function commitRepeat() {
  const f = fromText.value.trim()
  const to = toText.value.trim()
  // An empty box stops the repeat; one box filled is waiting for the other.
  if (!f || !to) {
    repeatError.value = ''
    if (repeating.value)
      set({ repeatFromMs: 0, repeatToMs: 0 })
    return
  }
  const a = parseTimespan(f)
  const b = parseTimespan(to)
  if (a === null || b === null) {
    repeatError.value = 'Type times like 1:35 or 95.5.'
    return
  }
  setStretch(a, b)
}

function useLoop() {
  if (player.loopStart === null || player.loopEnd === null)
    return
  const [a, b] = [player.loopStart, player.loopEnd].sort((x, y) => x - y)
  setStretch(Math.round(a * 1000), Math.round(b * 1000))
}

const tweaked = computed(() => scripts.isTweaked(props.channel))

function setOffset(raw: string) {
  const n = Number.parseInt(raw, 10)
  set({ offsetMs: Number.isNaN(n) ? 0 : n })
}
</script>

<template>
  <div class="px-3 py-2.5 border-t border-edge flex flex-col gap-3">
    <div class="flex gap-2 items-center">
      <span class="label flex-1">Offset</span>
      <UiIconButton icon="i-carbon-subtract" label="Script 50 ms later" size="xs" variant="solid" @click="set({ offsetMs: t.offsetMs - OFFSET_STEP })" />
      <input
        type="number"
        step="10"
        :value="t.offsetMs"
        aria-label="Offset in milliseconds"
        class="text-[12px] text-fg num text-center focusable border border-edge-strong rounded-[var(--radius-sm)] bg-surface-900 h-6 w-18"
        @change="setOffset(($event.target as HTMLInputElement).value)"
      >
      <UiIconButton icon="i-carbon-add" label="Script 50 ms earlier" size="xs" variant="solid" @click="set({ offsetMs: t.offsetMs + OFFSET_STEP })" />
    </div>

    <div v-if="others.size || plays" class="flex flex-col gap-1">
      <div class="flex gap-2 items-center justify-between">
        <span class="label shrink-0">Plays</span>
        <UiSelect v-model="plays" :options="playsOptions" />
      </div>
      <p v-if="plays" class="hint">
        {{ playsLoaded
          ? `This axis plays the ${others.get(plays)?.toLowerCase()} script, with its own tweaks on top.`
          : `No ${plays} script on this video, so this axis plays its own.` }}
      </p>
    </div>

    <div class="flex flex-col gap-2">
      <UiSlider v-model="low" label="Lowest" :min="0" :max="100" :step="1" :reset="0" :format="v => String(v)" />
      <UiSlider v-model="high" label="Highest" :min="0" :max="100" :step="1" :reset="100" :format="v => String(v)" hint="The script’s 0–100 is fitted into this range." />
    </div>

    <UiSwitch v-model="invert" size="sm" label="Invert" hint="Up becomes down." />

    <div class="flex flex-col gap-1">
      <div class="flex gap-2 items-center justify-between">
        <span class="label">Strokes</span>
        <UiSegmented v-model="strokes" :options="STROKE_OPTIONS" size="xs" />
      </div>
      <p v-if="strokes !== 'as-is'" class="hint">
        {{ STROKE_HINT[strokes] }}
      </p>
    </div>

    <div class="flex flex-col gap-1">
      <div class="flex gap-1.5 items-center">
        <span v-tip="'For a script that stops early: a stretch you pick plays again and again to the end of the video'" class="label flex-1">Repeat</span>
        <input
          v-model="fromText"
          placeholder="from"
          aria-label="Repeat from (m:ss)"
          class="text-[12px] text-fg num text-center focusable border border-edge-strong rounded-[var(--radius-sm)] bg-surface-900 h-6 w-15"
          @change="commitRepeat"
        >
        <span class="text-fg-faint">–</span>
        <input
          v-model="toText"
          placeholder="to"
          aria-label="Repeat to (m:ss)"
          class="text-[12px] text-fg num text-center focusable border border-edge-strong rounded-[var(--radius-sm)] bg-surface-900 h-6 w-15"
          @change="commitRepeat"
        >
        <UiIconButton v-if="player.hasLoop" icon="i-carbon-repeat" label="Use the A-B loop" size="xs" @click="useLoop" />
        <UiIconButton v-if="repeating" icon="i-carbon-close" label="Stop repeating" size="xs" @click="set({ repeatFromMs: 0, repeatToMs: 0 })" />
      </div>
      <p v-if="repeatError" class="hint text-danger">
        {{ repeatError }}
      </p>
      <p v-else-if="repeating" class="hint">
        From {{ clock(t.repeatToMs) }} to the end, this stretch plays again and again in place of the script. Its ends snap to the nearest strokes.
      </p>
    </div>

    <UiSlider
      v-model="cap"
      label="Speed limit"
      :min="0"
      :max="MAX_SPEED_CAP"
      :step="50"
      :reset="0"
      :format="v => (v ? `${v} /s` : 'Off')"
      hint="Strokes faster than this get shorter, still on the beat."
    />

    <div class="flex gap-2 items-center justify-between">
      <span class="label">Smoothing</span>
      <UiSegmented v-model="smooth" :options="SMOOTH_OPTIONS" size="xs" />
    </div>
    <UiSlider
      v-if="smooth !== 'off'"
      v-model="smoothAbove"
      label="Only above"
      :min="0"
      :max="MAX_SPEED_CAP"
      :step="50"
      :reset="0"
      :format="v => (v ? `${v} /s` : 'Everywhere')"
      hint="Parts moving slower than this stay exactly as written."
      class="-mt-1.5"
    />

    <div class="flex flex-col gap-1">
      <div class="flex gap-2 items-center justify-between">
        <span class="label">Humanise</span>
        <UiSegmented v-model="human" :options="HUMANISE_OPTIONS" size="xs" />
      </div>
      <p v-if="human !== 'off'" class="hint">
        Each turn lands a little early or late, a little higher or lower: the same way every time this video plays.
      </p>
    </div>

    <div class="flex gap-1.5 items-center">
      <UiButton size="xs" variant="ghost" icon="i-carbon-reset" :disabled="!tweaked" @click="scripts.resetTweaks(channel)">
        Reset
      </UiButton>
      <UiButton
        v-tip="'Save a copy of the script with these tweaks written in, to use elsewhere'"
        size="xs"
        variant="ghost"
        icon="i-carbon-document-export"
        class="ml-auto"
        :disabled="!tweaked"
        @click="edit.exportTweaked()"
      >
        Export tweaked script
      </UiButton>
    </div>
    <p class="hint -mt-1.5">
      Saved with this video; the script file is left as it is. A positive offset plays the script earlier.
    </p>
  </div>
</template>
