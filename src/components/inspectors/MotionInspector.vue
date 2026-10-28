<script setup lang="ts">
import type { MotionSourceId, StrokeShape } from '~/stores/motionStore'
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref } from 'vue'
import MusicScriptCard from '~/components/player/MusicScriptCard.vue'
import { useGamepadStatus } from '~/composables/useGamepadStatus'
import { useMotionEngine } from '~/composables/useMotionEngine'
import { useSoundtrack } from '~/composables/useSoundtrack'
import { axisOutput } from '~/composables/useTCode'
import { useVideoBeat } from '~/composables/useVideoBeat'
import { synthTargets } from '~/lib/axisSynth'
import { useAudioStore } from '~/stores/audio'
import { useDeviceStore } from '~/stores/deviceStore'
import { MOTION_SOURCES, useMotionStore } from '~/stores/motionStore'
import { usePlayerStore } from '~/stores/playerStore'
import { useScriptStore } from '~/stores/scriptStore'
import { useUiStore } from '~/stores/uiStore'

const motion = useMotionStore()
const audio = useAudioStore()
const device = useDeviceStore()
const scripts = useScriptStore()
const player = usePlayerStore()
const ui = useUiStore()
const { shouldRun, sourceLive, funscriptBusy } = useMotionEngine()
const pad = useGamepadStatus()
const videoBeat = useVideoBeat()
const { analysis: soundtrackAnalysis } = useSoundtrack()

const pct = (v: number) => `${Math.round(v * 100)}%`

// ─── Source ───────────────────────────────────────────────────────────────────
const SOURCE_ICON: Record<MotionSourceId, string> = {
  funscript: 'i-carbon-chart-line',
  session: 'i-carbon-time-plot',
  beat: 'i-carbon-headphones',
  pulse: 'i-carbon-wave-period',
  music: 'i-carbon-music',
  manual: 'i-carbon-touch-1',
}

// Six sources do not fit as labels in a 340px drawer, so the segments are
// icons and the chosen one is named underneath.
const sourceOptions = MOTION_SOURCES.map(s => ({
  value: s.id,
  icon: SOURCE_ICON[s.id],
  title: `${s.label} — ${s.hint}`,
}))
const sourceDef = computed(() => MOTION_SOURCES.find(s => s.id === motion.source) ?? MOTION_SOURCES[0])

// ─── Status ───────────────────────────────────────────────────────────────────
const WAITING_FOR: Partial<Record<MotionSourceId, string>> = {
  session: 'Waiting for a session to start',
  beat: 'Waiting for binaural audio',
  pulse: 'Waiting for the session pulse',
  music: 'Waiting for the video to play',
}

const status = computed<{ tone: 'ok' | 'warn' | 'neutral', text: string, pulse?: boolean }>(() => {
  if (motion.source === 'funscript') {
    if (!scripts.activeScripts.length)
      return { tone: 'neutral', text: 'No script loaded' }
    return funscriptBusy.value
      ? { tone: 'ok', text: 'Following the script', pulse: true }
      : { tone: 'neutral', text: 'Script ready, plays with the video' }
  }
  if (!motion.enabled)
    return { tone: 'neutral', text: 'Generator off' }
  if (funscriptBusy.value)
    return { tone: 'warn', text: 'A script is playing and has priority' }
  if (shouldRun.value)
    return { tone: 'ok', text: 'Generating', pulse: true }
  if (!sourceLive.value)
    return { tone: 'neutral', text: WAITING_FOR[motion.source] ?? 'Idle' }
  return { tone: 'neutral', text: 'Idle' }
})

// ─── Live trace ───────────────────────────────────────────────────────────────
// Drawn on a canvas at frame rate from what was last sent to L0, so the same
// picture serves the script and every generator, device or no device.
const WINDOW_MS = 4000
const canvas = ref<HTMLCanvasElement | null>(null)
const samples: { t: number, p: number }[] = []
const scriptSpm = ref(0)
const travel = ref(0)
let raf: number | null = null
let frameNo = 0
let colors = { accent: '#888', faint: '#444', grid: '#222' }

function readColors(el: HTMLElement) {
  const cs = getComputedStyle(el)
  colors = {
    accent: cs.getPropertyValue('--accent').trim() || colors.accent,
    faint: cs.getPropertyValue('--text-faint').trim() || colors.faint,
    grid: cs.getPropertyValue('--border').trim() || colors.grid,
  }
}

function currentL0() {
  return axisOutput.L0 ?? motion.currentPos
}

/** Strokes per minute from direction reversals, for a script nobody told us the rate of. */
function estimate(now: number) {
  let dir = 0
  let anchor = samples[0]?.p ?? 0
  let reversals = 0
  let lo = 1
  let hi = 0
  for (const s of samples) {
    lo = Math.min(lo, s.p)
    hi = Math.max(hi, s.p)
    const d = s.p - anchor
    // Hysteresis: ignore jitter smaller than 3% of travel.
    if (Math.abs(d) < 0.03)
      continue
    const nd = Math.sign(d)
    if (dir !== 0 && nd !== dir)
      reversals++
    dir = nd
    anchor = s.p
  }
  const span = samples.length ? (now - samples[0].t) / 1000 : 0
  scriptSpm.value = span > 1 ? Math.round((reversals / 2) / span * 60) : 0
  travel.value = samples.length ? hi - lo : 0
}

function draw(now: number) {
  const el = canvas.value
  if (!el)
    return
  const dpr = window.devicePixelRatio || 1
  const w = el.clientWidth
  const h = el.clientHeight
  if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
    el.width = Math.round(w * dpr)
    el.height = Math.round(h * dpr)
  }
  const ctx = el.getContext('2d')
  if (!ctx)
    return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)

  const inset = 6
  const y = (p: number) => inset + (1 - p) * (h - inset * 2)
  const x = (t: number) => w - ((now - t) / WINDOW_MS) * w

  // The L0 range, so it is obvious when the stroke is hitting its limits.
  const cfg = device.axisConfigs.L0
  if (cfg) {
    ctx.strokeStyle = colors.grid
    ctx.lineWidth = 1
    ctx.setLineDash([3, 4])
    for (const p of [cfg.min, cfg.max]) {
      ctx.beginPath()
      ctx.moveTo(0, Math.round(y(p)) + 0.5)
      ctx.lineTo(w, Math.round(y(p)) + 0.5)
      ctx.stroke()
    }
    ctx.setLineDash([])
  }

  if (samples.length < 2)
    return

  ctx.beginPath()
  samples.forEach((s, i) => (i ? ctx.lineTo(x(s.t), y(s.p)) : ctx.moveTo(x(s.t), y(s.p))))
  const last = samples[samples.length - 1]

  // Area under the trace
  ctx.save()
  ctx.lineTo(x(last.t), h)
  ctx.lineTo(x(samples[0].t), h)
  ctx.closePath()
  const grad = ctx.createLinearGradient(0, 0, 0, h)
  grad.addColorStop(0, colors.accent)
  grad.addColorStop(1, 'transparent')
  ctx.globalAlpha = 0.18
  ctx.fillStyle = grad
  ctx.fill()
  ctx.restore()

  ctx.beginPath()
  samples.forEach((s, i) => (i ? ctx.lineTo(x(s.t), y(s.p)) : ctx.moveTo(x(s.t), y(s.p))))
  ctx.strokeStyle = colors.accent
  ctx.lineWidth = 1.75
  ctx.lineJoin = 'round'
  ctx.stroke()

  // Head
  ctx.beginPath()
  ctx.arc(x(last.t) - 3, y(last.p), 3.5, 0, Math.PI * 2)
  ctx.fillStyle = colors.accent
  ctx.fill()
}

function frame(now: number) {
  samples.push({ t: now, p: currentL0() })
  while (samples.length && now - samples[0].t > WINDOW_MS)
    samples.shift()
  // Theme switches change the tokens; re-reading twice a second is plenty.
  if (frameNo++ % 30 === 0 && canvas.value) {
    readColors(canvas.value)
    estimate(now)
  }
  draw(now)
  raf = requestAnimationFrame(frame)
}

function start() {
  if (raf === null)
    raf = requestAnimationFrame(frame)
}
function stop() {
  if (raf !== null)
    cancelAnimationFrame(raf)
  raf = null
}
onMounted(start)
onActivated(start)
onDeactivated(stop)
onBeforeUnmount(stop)

const spmReadout = computed(() =>
  motion.isGenerated ? Math.round(motion.currentSpm) : scriptSpm.value,
)
const depthReadout = computed(() =>
  motion.isGenerated ? motion.currentDepth : travel.value,
)
const nearCeiling = computed(() => motion.isGenerated && motion.currentSpm >= motion.maxSpm - 1 && motion.maxSpm > 0)

// ─── Manual ───────────────────────────────────────────────────────────────────
const MANUAL_MODES = [
  { value: 'oscillate' as const, label: 'Rate', icon: 'i-carbon-wave-height' },
  { value: 'direct' as const, label: 'Direct', icon: 'i-carbon-cursor-1' },
]

const SHAPES: { value: StrokeShape, label: string }[] = [
  { value: 'sine', label: 'Sine' },
  { value: 'ease', label: 'Ease' },
  { value: 'pulse', label: 'Pulse' },
]

// ─── Derived axes ─────────────────────────────────────────────────────────────
const SYNTH_AXES = [
  { key: 'synthTwist', label: 'Twist', channel: 'R0', hint: 'Turns slowly and continuously' },
  { key: 'synthRoll', label: 'Roll', channel: 'R1', hint: 'Leans into the direction of travel' },
  { key: 'synthSurge', label: 'Surge', channel: 'L1', hint: 'Trails the stroke at reduced depth' },
] as const

/** Derived channels that are both selected and switched on in the Device panel. */
const derivedReady = computed(() => {
  const wanted = synthTargets(
    scripts.activeScripts.map(s => s.channel),
    { depth: motion.synthDepth, twist: motion.synthTwist, roll: motion.synthRoll, surge: motion.synthSurge },
  )
  return wanted.filter(c => device.axisConfigs[c]?.enabled)
})

// ─── Safety ───────────────────────────────────────────────────────────────────
/** Past this, most strokers stop tracking position faithfully and start slamming. */
const CEILING_WARN = 180
const sessionCapped = computed(() => motion.sessionMaxSpm > motion.maxSpm)
const beatCapped = computed(() => motion.beatBandHi > motion.maxSpm)

/** Music source: the grid counts as locked once most recent hits land on it, or when it comes from an analysis. */
const beatAnalysed = computed(() => (soundtrackAnalysis.value?.beats.length ?? 0) >= 2)
const beatLocked = computed(() => beatAnalysed.value || videoBeat.confidence.value >= 0.6)

/** How the music source is stroking relative to the beat, in words. */
const subdivisionLabel = computed(() => ({
  2: 'Twice a beat',
  1: 'Every beat',
  0.5: 'Every 2 beats',
  0.25: 'Every bar',
} as Record<number, string>)[motion.musicStrokesPerBeat] ?? '')

// ─── Gamepad ──────────────────────────────────────────────────────────────────
function stickBar(v: number) {
  const half = Math.min(1, Math.abs(v)) * 50
  return v >= 0 ? { left: '50%', width: `${half}%` } : { right: '50%', width: `${half}%` }
}
const sticks = computed(() => [
  { label: 'Left Y', value: -(pad.axes.value[1] ?? 0), role: motion.manualMode === 'direct' ? 'Position' : 'Rate' },
  { label: 'Right Y', value: -(pad.axes.value[3] ?? 0), role: 'Depth' },
])
const PAD_MAP = [
  ['A', 'Play / pause'],
  ['B', 'Generator on / off'],
  ['Y', 'Random video'],
  ['LB / RB', 'Previous / next'],
  ['Start', 'Panic'],
] as const
</script>

<template>
  <UiPanel>
    <!-- ─── Hero: source + live trace ─────────────────────────────────────── -->
    <section class="p-3 card flex flex-col gap-3">
      <div class="flex gap-2 items-center">
        <UiBadge :tone="status.tone" dot :pulse="status.pulse">
          {{ status.text }}
        </UiBadge>
        <Transition name="t-fade">
          <UiButton
            v-if="motion.isGenerated"
            class="ml-auto"
            size="sm"
            :variant="motion.enabled ? 'secondary' : 'primary'"
            :icon="motion.enabled ? 'i-carbon-stop-filled-alt' : 'i-carbon-play-filled-alt'"
            @click="motion.enabled = !motion.enabled"
          >
            {{ motion.enabled ? 'Stop' : 'Start' }}
          </UiButton>
        </Transition>
      </div>

      <div class="flex flex-col gap-1.5">
        <UiSegmented v-model="motion.source" :options="sourceOptions" block size="md" />
        <Transition name="t-fade" mode="out-in">
          <p :key="motion.source" class="text-[12px] px-0.5 flex gap-1.5 items-baseline">
            <span class="text-fg font-medium shrink-0">{{ sourceDef.label }}</span>
            <span class="text-fg-faint truncate">{{ sourceDef.hint }}</span>
          </p>
        </Transition>
      </div>

      <div class="rounded-[var(--radius-md)] bg-surface-950/60 ring-1 ring-edge relative overflow-hidden">
        <canvas ref="canvas" class="h-[84px] w-full block" aria-hidden="true" />
        <div class="px-2.5 pb-2 pt-1 flex gap-4 items-end">
          <div class="flex flex-col">
            <span class="flex gap-1 items-baseline">
              <span
                class="text-[22px] tracking-[-0.02em] font-semibold num transition-colors"
                :class="nearCeiling ? 'text-warn' : 'text-fg'"
              >{{ spmReadout }}</span>
              <span class="text-[11px] text-fg-faint">spm</span>
            </span>
            <span class="eyebrow">{{ motion.isGenerated ? 'Rate' : 'Est. rate' }}</span>
          </div>
          <div class="flex flex-col">
            <span class="text-[15px] text-fg font-semibold num">{{ pct(depthReadout) }}</span>
            <span class="eyebrow">{{ motion.isGenerated ? 'Depth' : 'Travel' }}</span>
          </div>
          <div v-if="motion.source === 'beat'" class="flex flex-col">
            <span class="text-[15px] text-fg font-semibold num">÷{{ motion.beatDivisor }}</span>
            <span class="eyebrow">Divisor</span>
          </div>
          <div v-else-if="motion.source === 'session'" class="flex flex-col">
            <span class="text-[15px] text-fg font-semibold capitalize">{{ audio.phase.value }}</span>
            <span class="eyebrow">Phase</span>
          </div>
          <div v-else-if="motion.source === 'music' && videoBeat.bpm.value" class="flex flex-col">
            <span class="text-[15px] text-fg font-semibold num">{{ videoBeat.bpm.value }}</span>
            <span class="eyebrow">{{ subdivisionLabel || 'BPM' }}</span>
          </div>
          <span v-if="nearCeiling" v-tip="'Held back by the speed ceiling below'" class="text-[11px] text-warn ml-auto flex gap-1 items-center">
            <span class="i-carbon-warning-alt text-[13px]" />
            At ceiling
          </span>
        </div>
      </div>

      <div v-if="!device.connected" class="text-[12px] text-fg-muted px-2.5 py-2 rounded-[var(--radius-md)] bg-fg/4 flex gap-2 items-center">
        <span class="i-carbon-plug text-[14px] text-fg-faint shrink-0" />
        <span class="flex-1 min-w-0">No device connected. The trace and emulator still show the output.</span>
        <UiButton size="xs" variant="ghost" @click="ui.openInspector('device')">
          Connect
        </UiButton>
      </div>
    </section>

    <!-- ─── Per-source controls ───────────────────────────────────────────── -->
    <Transition name="t-fade" mode="out-in">
      <!-- Script -->
      <UiSection v-if="motion.source === 'funscript'" key="funscript" title="Script" icon="i-carbon-chart-line">
        <p class="hint">
          The loaded funscript drives the device whenever the video plays, exactly as written. Range and inversion
          come from the Device panel.
        </p>
        <div class="flex gap-2 items-center">
          <UiBadge :tone="scripts.activeScripts.length ? 'accent' : 'neutral'">
            {{ scripts.activeScripts.length }} {{ scripts.activeScripts.length === 1 ? 'axis' : 'axes' }} loaded
          </UiBadge>
          <UiButton size="xs" variant="ghost" icon-right="i-carbon-arrow-right" class="ml-auto" @click="ui.openInspector('scripts')">
            Scripts
          </UiButton>
        </div>
      </UiSection>

      <!-- Manual -->
      <UiSection v-else-if="motion.source === 'manual'" key="manual" title="Manual" icon="i-carbon-touch-1">
        <UiField label="Stick behaviour" :hint="motion.manualMode === 'direct' ? 'The device follows your thumb' : 'The stick sets how fast it strokes'">
          <UiSegmented v-model="motion.manualMode" :options="MANUAL_MODES" size="xs" />
        </UiField>
        <UiSlider
          v-model="motion.manualSpm"
          label="Rate"
          unit=" spm"
          :min="0"
          :max="motion.maxSpm"
          :step="1"
          :reset="60"
          :disabled="motion.manualMode === 'direct'"
        />
        <UiSlider v-model="motion.manualDepth" label="Depth" :format="pct" :reset="0.7" :disabled="motion.manualMode === 'direct'" />
      </UiSection>

      <!-- Session -->
      <UiSection v-else-if="motion.source === 'session'" key="session" title="Session mapping" icon="i-carbon-time-plot">
        <p class="hint">
          Session intensity moves the stroke between these. Intensity is {{ pct(audio.intensity.value) }} now.
        </p>
        <div class="gap-3 grid grid-cols-2">
          <UiSlider v-model="motion.minSpm" label="Slowest" unit=" spm" :min="0" :max="300" :step="1" :reset="20" />
          <UiSlider
            v-model="motion.sessionMaxSpm"
            label="Fastest"
            unit=" spm"
            :min="0"
            :max="300"
            :step="1"
            :reset="130"
            :tone="sessionCapped ? 'warn' : 'accent'"
          />
          <UiSlider v-model="motion.minDepth" label="Shallowest" :format="pct" :reset="0.35" />
          <UiSlider v-model="motion.maxDepth" label="Deepest" :format="pct" :reset="0.95" />
        </div>
        <p v-if="sessionCapped" class="hint text-warn">
          Above the {{ motion.maxSpm }} spm ceiling, so the top of the session is capped there.
        </p>
        <UiButton v-if="!audio.sessionActive.value" size="xs" variant="ghost" icon-right="i-carbon-arrow-right" class="self-start" @click="ui.openInspector('binaural')">
          Start a session
        </UiButton>
      </UiSection>

      <!-- Beat -->
      <UiSection v-else-if="motion.source === 'beat'" key="beat" title="Beat lock" icon="i-carbon-headphones">
        <p class="hint">
          The binaural beat ({{ audio.beatDelta.value.toFixed(1) }} Hz) is divided by a power of two to land the stroke in
          this band.
        </p>
        <div class="gap-3 grid grid-cols-2">
          <UiSlider v-model="motion.beatBandLo" label="Slowest" unit=" spm" :min="10" :max="300" :step="1" :reset="35" />
          <UiSlider
            v-model="motion.beatBandHi"
            label="Fastest"
            unit=" spm"
            :min="10"
            :max="300"
            :step="1"
            :reset="140"
            :tone="beatCapped ? 'warn' : 'accent'"
          />
        </div>
        <p v-if="beatCapped" class="hint text-warn">
          The band reaches past the {{ motion.maxSpm }} spm ceiling; anything faster is capped.
        </p>
        <UiButton v-if="!audio.isPlaying.value" size="xs" variant="ghost" icon-right="i-carbon-arrow-right" class="self-start" @click="ui.openInspector('binaural')">
          Start binaural audio
        </UiButton>
      </UiSection>

      <!-- Pulse -->
      <UiSection v-else-if="motion.source === 'pulse'" key="pulse" title="Pulse lock" icon="i-carbon-wave-period">
        <p class="hint">
          Strokes in phase with the audible session pulse, so what you feel lands on what you hear. Rate comes from the
          pulse; depth from session intensity.
        </p>
        <div class="text-[12px] flex gap-2 items-center">
          <span class="rounded-full shrink-0 h-1.5 w-1.5" :class="audio.isPlaying.value ? 'bg-ok' : 'bg-fg-faint'" />
          <span :class="audio.isPlaying.value ? 'text-fg-muted' : 'text-fg-faint'">
            {{ audio.isPlaying.value ? 'Session audio is playing' : 'Session audio is off' }}
          </span>
          <UiButton v-if="!audio.isPlaying.value" size="xs" variant="ghost" icon-right="i-carbon-arrow-right" class="ml-auto" @click="ui.openInspector('binaural')">
            Binaural
          </UiButton>
        </div>
      </UiSection>

      <!-- Music -->
      <UiSection v-else-if="motion.source === 'music'" key="music" title="Music" icon="i-carbon-music">
        <p class="hint">
          Strokes on the beat of the video's soundtrack, at whichever subdivision of the tempo fits your band, and deeper when the music gets louder. Listening live needs a few bars to settle; an unscripted video's whole soundtrack is analysed in the background, and from then on the beat is there from the first second.
        </p>

        <div v-if="audio.scriptDrive.value" class="text-[12px] text-warn px-2.5 py-2 rounded-[var(--radius-md)] bg-warn/10 flex gap-2 ring-1 ring-warn/20">
          <span class="i-carbon-warning-alt text-[14px] mt-px shrink-0" />
          <span>"Follow the script" is on and takes priority. Turn it off in Binaural to use the music.</span>
        </div>

        <template v-else>
          <MusicScriptCard :make="false" :options="false" />
          <!-- Live listening diagnostics: idle once the whole soundtrack is
               analysed, so showing them then would only contradict the card. -->
          <div v-if="!beatAnalysed" class="gap-2 grid grid-cols-3">
            <div v-tip="beatAnalysed ? 'How clearly the analysed beats stand out' : 'How many recent hits landed on the beat grid'" class="px-2.5 py-2 well flex flex-col gap-0.5">
              <span class="text-[12.5px] font-medium flex gap-1.5 items-center" :class="beatLocked ? 'text-ok' : 'text-fg-muted'">
                <span class="rounded-full bg-current h-1.5 w-1.5" :class="beatLocked ? 'animate-pulse-dot' : ''" />
                {{ beatAnalysed ? 'Analysed' : beatLocked ? 'Locked' : 'Listening' }}
              </span>
              <span class="eyebrow">Beat · {{ pct(videoBeat.confidence.value) }}</span>
            </div>
            <div class="px-2.5 py-2 well flex flex-col gap-0.5">
              <span class="text-[12.5px] font-medium" :class="videoBeat.hasSignal.value ? 'text-ok' : 'text-warn'">
                {{ videoBeat.hasSignal.value ? 'Yes' : 'None' }}
              </span>
              <span class="eyebrow">Audio in</span>
            </div>
            <div class="px-2.5 py-2 well flex flex-col gap-0.5">
              <span class="text-[12.5px] text-fg font-medium num">{{ videoBeat.onsetCount.value }}</span>
              <span class="eyebrow">Onsets</span>
            </div>
          </div>
          <div class="flex flex-col gap-1">
            <div class="flex justify-between">
              <span class="label">Loudness</span>
              <span class="text-[11.5px] text-fg-muted num">{{ pct(motion.musicEnergy) }}</span>
            </div>
            <UiProgress :value="motion.musicEnergy" tone="accent" />
          </div>
          <UiSlider v-model="motion.beatBandLo" label="Slowest" unit=" spm" :min="10" :max="300" :step="1" :reset="35" />
          <UiSlider v-model="motion.beatBandHi" label="Fastest" unit=" spm" :min="10" :max="300" :step="1" :reset="140" hint="The stroke rate stays inside this band: a fast track strokes every second beat or bar, a slow one can double up." />
          <p v-if="!beatAnalysed && !videoBeat.hasSignal.value && (player.isMuted || player.volume === 0)" class="hint text-warn">
            The player is muted, so the analyser only hears silence. Turn the volume down rather than muting.
          </p>
          <p v-if="!videoBeat.available.value" class="hint text-danger">
            This browser could not analyse the video's audio.
          </p>
          <div class="pt-1 border-t border-edge flex flex-col gap-3">
            <span class="eyebrow pt-2">Script from the music</span>
            <p class="hint -mt-1">
              Writes a real funscript from the analysed soundtrack, using the band, ceiling, depth and centre set here, and plays it like any other script.
            </p>
            <MusicScriptCard :status="false" />
          </div>
        </template>
      </UiSection>
    </Transition>

    <!-- ─── Generated motion shape ────────────────────────────────────────── -->
    <UiSection v-if="motion.isGenerated" title="Stroke" icon="i-carbon-waveform">
      <UiField label="Shape" :hint="motion.shape === 'sine' ? 'Smooth and even' : motion.shape === 'ease' ? 'Lingers at the ends' : 'Quick strike, slow return'">
        <UiSegmented v-model="motion.shape" :options="SHAPES" size="xs" />
      </UiField>
      <UiSlider v-model="motion.center" label="Centre" :format="pct" :reset="0.5" hint="Where in the range the stroke is centred" />
      <UiSwitch v-model="motion.secondaryAxes" size="sm" label="Also drive twist and roll" hint="Slower, shallower motion on R0 and R1" />
      <UiSwitch v-model="motion.vibrateFromIntensity" size="sm" label="Vibration follows intensity" hint="Maps session intensity onto V0" />
    </UiSection>

    <!-- ─── Fill idle axes ────────────────────────────────────────────────── -->
    <UiSection title="Fill idle axes" icon="i-carbon-3d-mpr-toggle" :summary="motion.synthEnabled ? 'On' : 'Off'">
      <template #actions>
        <UiSwitch v-model="motion.synthEnabled" size="sm" aria-label="Fill idle axes" />
      </template>
      <p class="hint -mt-1">
        Derives twist, roll and surge from the stroke, so a one-axis script still moves a multi-axis device. Never
        overrides an axis the script drives.
      </p>
      <Transition name="t-collapse">
        <div v-if="motion.synthEnabled">
          <div class="min-h-0 overflow-hidden">
            <div class="pt-0.5 flex flex-col gap-3">
              <div class="gap-1.5 grid grid-cols-3">
                <button
                  v-for="a in SYNTH_AXES"
                  :key="a.key"
                  v-tip="a.hint"
                  type="button"
                  class="text-[12px] font-medium focusable rounded-[var(--radius-sm)] flex gap-1.5 h-7 pressable items-center justify-center"
                  :class="motion[a.key] ? 'bg-accent-soft text-accent-300 ring-1 ring-accent/30' : 'bg-fg/5 text-fg-muted hover:bg-fg/8 hover:text-fg'"
                  :aria-pressed="motion[a.key]"
                  @click="motion[a.key] = !motion[a.key]"
                >
                  {{ a.label }}
                  <span class="text-[10px] font-mono opacity-60">{{ a.channel }}</span>
                </button>
              </div>
              <UiSlider v-model="motion.synthDepth" label="Depth" :format="pct" :reset="0.35" />
              <div v-if="!derivedReady.length" class="text-[12px] text-warn flex gap-2 items-start">
                <span class="i-carbon-warning-alt text-[14px] mt-px shrink-0" />
                <span class="flex-1">Those axes are switched off in the Device panel, so nothing will move.</span>
                <UiButton size="xs" variant="ghost" @click="ui.openInspector('device')">
                  Axes
                </UiButton>
              </div>
              <p v-else class="hint">
                Driving <span class="text-fg-muted font-mono">{{ derivedReady.join(' ') }}</span>.
              </p>
            </div>
          </div>
        </div>
      </Transition>
    </UiSection>

    <!-- ─── Safety ────────────────────────────────────────────────────────── -->
    <section class="card shrink-0 relative overflow-hidden !border-warn/25">
      <div class="safety-stripe w-[3px] bottom-0 left-0 top-0 absolute" />
      <header class="pl-3.5 pr-3 flex gap-2 h-10 items-center">
        <span class="i-carbon-security text-[15px] text-warn shrink-0" />
        <span class="text-[13px] text-fg font-medium">Safety limits</span>
        <span class="text-[11.5px] text-fg-faint num ml-auto">≤ {{ motion.maxSpm }} spm</span>
      </header>
      <div class="pb-3 pl-3.5 pr-3 flex flex-col gap-3">
        <UiSlider
          v-model="motion.maxSpm"
          label="Speed ceiling"
          unit=" spm"
          :min="20"
          :max="240"
          :step="5"
          :reset="150"
          :tone="motion.maxSpm > CEILING_WARN ? 'danger' : 'warn'"
        />
        <Transition name="t-fade">
          <div v-if="motion.maxSpm > CEILING_WARN" class="text-[12px] text-danger px-2.5 py-2 rounded-[var(--radius-md)] bg-danger/10 flex gap-2 ring-1 ring-danger/20">
            <span class="i-carbon-warning-filled text-[14px] mt-px shrink-0" />
            <span>Above {{ CEILING_WARN }} spm most strokers lose position and slam the ends. Raise it only if yours keeps up.</span>
          </div>
        </Transition>
        <div class="gap-3 grid grid-cols-2">
          <UiSlider
            v-model="motion.spmRampPerSec"
            label="Rate ramp"
            unit=" spm/s"
            :min="5"
            :max="100"
            :step="5"
            :reset="25"
            tone="warn"
          />
          <UiSlider
            v-model="motion.depthRampPerSec"
            label="Depth ramp"
            :format="v => `${Math.round(v * 100)}%/s`"
            :min="0.05"
            :max="2"
            :step="0.05"
            :reset="0.4"
            tone="warn"
          />
        </div>
        <p class="hint">
          Generated motion never exceeds the ceiling and eases toward new targets at these rates instead of jumping.
          Scripts are sent as written.
        </p>
      </div>
    </section>

    <!-- ─── Gamepad ───────────────────────────────────────────────────────── -->
    <UiSection
      title="Gamepad"
      icon="i-carbon-game-console"
      :live="motion.gamepadEnabled && pad.connected.value"
      :summary="!motion.gamepadEnabled ? 'Off' : pad.connected.value ? 'Connected' : 'No pad'"
    >
      <template #actions>
        <UiSwitch v-model="motion.gamepadEnabled" size="sm" aria-label="Use gamepad" />
      </template>

      <p v-if="!motion.gamepadEnabled" class="hint -mt-1">
        Drive the manual source and the transport from a controller.
      </p>

      <Transition name="t-collapse">
        <div v-if="motion.gamepadEnabled">
          <div class="min-h-0 overflow-hidden">
            <div class="flex flex-col gap-3">
              <div class="px-2.5 well flex gap-2 h-9 items-center">
                <span class="rounded-full shrink-0 h-2 w-2" :class="pad.connected.value ? 'bg-ok text-ok animate-pulse-dot' : 'bg-fg-faint'" />
                <span class="text-[12.5px] truncate" :class="pad.connected.value ? 'text-fg' : 'text-fg-faint'">
                  {{ pad.connected.value ? (pad.padName.value || 'Gamepad connected') : 'No gamepad detected' }}
                </span>
              </div>

              <p v-if="!pad.connected.value" class="hint">
                Press any button on the pad to wake it. Browsers hide gamepads until they are used.
              </p>

              <!-- Live stick values make "is the stick even being read?" answerable without devtools. -->
              <div v-else class="flex flex-col gap-1.5">
                <div v-for="s in sticks" :key="s.label" class="text-[11px] flex gap-2 items-center">
                  <span class="text-fg-muted shrink-0 w-12">{{ s.label }}</span>
                  <div class="rounded-full bg-surface-700 flex-1 h-1.5 relative overflow-hidden">
                    <div class="bg-edge-strong w-px inset-y-0 left-1/2 absolute" />
                    <div class="rounded-full bg-accent inset-y-0 absolute" :style="stickBar(s.value)" />
                  </div>
                  <span class="text-fg-faint num text-right w-9">{{ s.value.toFixed(2) }}</span>
                  <span class="text-fg-faint text-right w-12">{{ s.role }}</span>
                </div>
                <p v-if="pad.mapping.value && pad.mapping.value !== 'standard'" class="hint text-warn">
                  This pad reports a non-standard layout, so the sticks may sit on other axes:
                  <span class="num">{{ pad.axes.value.map(a => a.toFixed(1)).join(', ') }}</span>
                </p>
                <p class="hint">
                  Moving a stick switches the source to Manual.
                </p>
              </div>

              <dl class="text-[11.5px] gap-x-3 gap-y-1 grid grid-cols-[auto_1fr]">
                <template v-for="[btn, what] in PAD_MAP" :key="btn">
                  <dt><UiKbd>{{ btn }}</UiKbd></dt>
                  <dd class="text-fg-muted self-center">
                    {{ what }}
                  </dd>
                </template>
              </dl>
            </div>
          </div>
        </div>
      </Transition>
    </UiSection>
  </UiPanel>
</template>

<style scoped>
.safety-stripe {
  background: repeating-linear-gradient(
    -45deg,
    var(--warn) 0 6px,
    color-mix(in srgb, var(--warn) 35%, transparent) 6px 12px
  );
}
</style>
