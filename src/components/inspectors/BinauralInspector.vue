<script setup lang="ts">
import type { BeatMode, NoiseType, SessionPhase } from '~/stores/audio'
import { useIntervalFn, useLocalStorage } from '@vueuse/core'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiPanel from '~/components/ui/UiPanel.vue'
import UiSection from '~/components/ui/UiSection.vue'
import UiSegmented from '~/components/ui/UiSegmented.vue'
import UiSlider from '~/components/ui/UiSlider.vue'
import UiStat from '~/components/ui/UiStat.vue'
import UiSwitch from '~/components/ui/UiSwitch.vue'
import { useBinauralBeats } from '~/composables/useBinauralBeats'
import { useScriptPulse } from '~/composables/useScriptPulse'
import { useSessionEngine } from '~/composables/useSessionEngine'
import { CARRIER_MAX, CARRIER_RECOMMENDED, MAX_BEAT_HZ, useAudioStore } from '~/stores/audio'
import { useScriptStore } from '~/stores/scriptStore'

const {
  baseFrequency,
  beatDelta,
  volume,
  waveType,
  isPlaying,
  currentPreset,
  intensity,
  phase,
  driftMode,
  sessionActive,
  noiseEnabled,
  noiseVolume,
  noiseType,
  harmonicsEnabled,
  beatDriftEnabled,
  beatMode,
  pulseEnabled,
  pulseCpm,
  pulseDepth,
  pulseFollowsSession,
  breathEnabled,
  breathPeriod,
  breathInhaleRatio,
  sessionArc,
  edgeCycles,
  scriptDrive,
  scriptDriveIntensity,
} = useAudioStore()

const binaural = useBinauralBeats()
const session = useSessionEngine()
const { locked, scriptSpm, scriptIntensity } = useScriptPulse()
const scriptStore = useScriptStore()
const hasScript = computed(() => scriptStore.activeScripts.length > 0)

// ─── Reference data ─────────────────────────────────────────────────────────

/** Double-click targets: the store's own first-run values. */
const DEFAULT = {
  carrier: 300,
  beat: 6,
  volume: 0.4,
  intensity: 0.5,
  noise: 0.15,
  pulseCpm: 50,
  pulseDepth: 0.45,
  edgeCycles: 3,
  breathPeriod: 10,
  inhale: 0.4,
}

const PRESETS = [
  { name: 'Delta', desc: 'Deep sleep', hz: '0.5–4', base: 100, delta: 2 },
  { name: 'Theta', desc: 'Meditation', hz: '4–8', base: 180, delta: 6 },
  { name: 'Alpha', desc: 'Relaxation', hz: '8–12', base: 220, delta: 10 },
  { name: 'Beta', desc: 'Focus', hz: '12–30', base: 300, delta: 20 },
  // 40 Hz would exceed Oster's fusion limit and stop being heard as a beat.
  { name: 'Gamma', desc: 'Flow state', hz: '30–35', base: 400, delta: 32 },
] as const
type Preset = typeof PRESETS[number]

const SOLFEGGIO = [396, 432, 528, 639, 741, 852]

const BEAT_MODES: { value: BeatMode, label: string, hint: string }[] = [
  { value: 'binaural', label: 'Binaural', hint: 'One tone per ear. The beat exists only in your head — the gentlest, and the weakest at driving a response.' },
  { value: 'monaural', label: 'Monaural', hint: 'Both tones in both ears, so the beat is physically in the air. Stronger, and works without headphones.' },
  { value: 'isochronic', label: 'Isochronic', hint: 'A single tone gated on and off. Strongest cortical response of the three, and impossible to ignore.' },
]

const WAVES: { value: OscillatorType, label: string }[] = [
  { value: 'sine', label: 'Sine' },
  { value: 'triangle', label: 'Triangle' },
  { value: 'sawtooth', label: 'Saw' },
  { value: 'square', label: 'Square' },
]

const NOISES: { value: NoiseType, label: string, title: string }[] = [
  { value: 'brown', label: 'Brown', title: 'Deep rumble' },
  { value: 'pink', label: 'Pink', title: 'Balanced' },
  { value: 'white', label: 'White', title: 'Full spectrum' },
]

const ARCS: { value: 'smooth' | 'edged', label: string, hint: string }[] = [
  { value: 'smooth', label: 'Smooth', hint: 'One rise and one fall.' },
  { value: 'edged', label: 'Edged', hint: 'Repeated build, hold, then partial retreat — each pass reaching a little higher.' },
]

const PHASES: Exclude<SessionPhase, 'idle'>[] = ['entry', 'build', 'peak', 'descent']
const PHASE_LABEL: Record<SessionPhase, string> = { idle: 'Idle', entry: 'Entry', build: 'Build', peak: 'Peak', descent: 'Descent' }
const PHASE_TONE: Record<SessionPhase, string> = {
  idle: 'var(--text-faint)',
  entry: 'var(--info)',
  build: 'var(--ok)',
  peak: 'var(--warn)',
  descent: 'var(--accent)',
}
/**
 * Mid-points of the engine's phase durations, in seconds. The engine varies
 * each by ±20% and does not expose its timers, so the timeline is an estimate
 * that never claims to be finished before the phase actually changes.
 */
const PHASE_NOMINAL: Record<SessionPhase, number> = { idle: 1, entry: 75, build: 120, peak: 150, descent: 90 }
/** Mean hold at the top of an edged pass. */
const EDGE_HOLD = 40

function bandOf(hz: number) {
  if (hz < 4)
    return 'Delta'
  if (hz < 8)
    return 'Theta'
  if (hz < 12)
    return 'Alpha'
  if (hz < 30)
    return 'Beta'
  return 'Gamma'
}

const pct = (v: number) => `${Math.round(v * 100)}%`

// ─── Section state ──────────────────────────────────────────────────────────

const openTone = useLocalStorage('ph-bin-open-tone', true)
const openScript = useLocalStorage('ph-bin-open-script', false)
const openLayers = useLocalStorage('ph-bin-open-layers', false)
const openPulse = useLocalStorage('ph-bin-open-pulse', false)
const openSession = useLocalStorage('ph-bin-open-session', false)
const openBreath = useLocalStorage('ph-bin-open-breath', false)

// ─── Preset morphing ────────────────────────────────────────────────────────

let morphRaf: number | null = null
function cancelMorphAnim() {
  if (morphRaf !== null) {
    cancelAnimationFrame(morphRaf)
    morphRaf = null
  }
}
onBeforeUnmount(cancelMorphAnim)

/**
 * While playing, a preset glides there over five seconds rather than jumping;
 * the engine ramps the oscillators and this mirrors it into the store so the
 * readouts move with the sound.
 */
function applyPreset(p: Preset) {
  currentPreset.value = p.name
  cancelMorphAnim()
  if (!isPlaying.value) {
    baseFrequency.value = p.base
    beatDelta.value = p.delta
    return
  }
  const startBase = baseFrequency.value
  const startDelta = beatDelta.value
  const startTime = Date.now()
  const dur = 5000
  binaural.morphTo(p.base, p.delta, 5)

  const frame = () => {
    const t = Math.min(1, (Date.now() - startTime) / dur)
    const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
    baseFrequency.value = startBase + (p.base - startBase) * eased
    beatDelta.value = startDelta + (p.delta - startDelta) * eased
    morphRaf = t < 1 ? requestAnimationFrame(frame) : null
  }
  morphRaf = requestAnimationFrame(frame)
}

/** A hand on a control ends any glide in progress, or it would fight the hand. */
function takeManual() {
  currentPreset.value = ''
  cancelMorphAnim()
  binaural.stopMorph()
}

// ─── Manual controls ────────────────────────────────────────────────────────

function setCarrier(hz: number) {
  baseFrequency.value = hz
  takeManual()
  if (isPlaying.value)
    binaural.setFrequencies(hz, beatDelta.value)
}

const carrier = computed({ get: () => baseFrequency.value, set: setCarrier })

const beat = computed({
  get: () => beatDelta.value,
  set: (v: number) => {
    beatDelta.value = v
    takeManual()
    binaural.stopBeatDrift()
    if (isPlaying.value)
      binaural.setFrequencies(baseFrequency.value, v)
  },
})

const vol = computed({
  get: () => volume.value,
  set: (v: number) => {
    volume.value = v
    if (isPlaying.value)
      binaural.setVolume(v)
  },
})

const wave = computed({
  get: () => waveType.value,
  set: (t: OscillatorType) => {
    waveType.value = t
    if (isPlaying.value)
      binaural.setWaveType(t)
  },
})

/** One knob for the whole session: beat rate, noise level and visual drive together. */
const master = computed({
  get: () => intensity.value,
  set: (v: number) => {
    intensity.value = v
    const nextDelta = 1 + v * 38
    beatDelta.value = nextDelta
    takeManual()
    binaural.stopBeatDrift()
    if (isPlaying.value)
      binaural.setFrequencies(baseFrequency.value, nextDelta)
    if (noiseEnabled.value && isPlaying.value)
      binaural.setNoiseVolume(0.05 + v * 0.35)
  },
})

// ─── Layers ─────────────────────────────────────────────────────────────────

// Layer on/off, harmonics, drift and drift mode are applied by useSessionAudio,
// which runs whether or not this panel is open.

const noiseVol = computed({
  get: () => noiseVolume.value,
  set: (v: number) => {
    noiseVolume.value = v
    if (isPlaying.value && noiseEnabled.value)
      binaural.setNoiseVolume(v)
  },
})

/** Changing colour cross-fades over three seconds instead of cutting. */
const noiseKind = computed({
  get: () => noiseType.value,
  set: (t: NoiseType) => {
    noiseType.value = t
    if (isPlaying.value && noiseEnabled.value)
      binaural.morphNoise(t, 3)
  },
})

// ─── Transport ──────────────────────────────────────────────────────────────

/** Starts with every enabled layer in place; stopping fades out over two seconds. */
function togglePlay() {
  if (isPlaying.value) {
    isPlaying.value = false
    binaural.fadeOut(2)
    if (sessionActive.value)
      session.stopSession()
    return
  }
  binaural.start(baseFrequency.value, beatDelta.value, volume.value, waveType.value)
  // Layers come up from useSessionAudio's isPlaying watcher.
  isPlaying.value = true
}

/** A session needs sound, so starting one starts the tone too. */
function toggleSession() {
  if (sessionActive.value) {
    session.stopSession()
    return
  }
  if (!isPlaying.value)
    togglePlay()
  session.startSession()
}

// ─── Session clock ──────────────────────────────────────────────────────────

const now = ref(Date.now())
const phaseStartedAt = ref(Date.now())
const sessionStartedAt = ref(Date.now())

const clock = useIntervalFn(() => { now.value = Date.now() }, 500, { immediate: false })

watch(sessionActive, (on) => {
  if (on) {
    sessionStartedAt.value = Date.now()
    now.value = Date.now()
    clock.resume()
  }
  else {
    clock.pause()
  }
}, { immediate: true })

watch(phase, () => {
  phaseStartedAt.value = Date.now()
  now.value = Date.now()
})

const phaseElapsed = computed(() => Math.max(0, (now.value - phaseStartedAt.value) / 1000))
const sessionElapsed = computed(() => Math.max(0, (now.value - sessionStartedAt.value) / 1000))

/** Where we are in the edged peak loop; read off the engine on each tick. */
const edgePass = computed(() => {
  void now.value
  const arc = session.getArc()
  return arc.arc === 'edged' ? { pass: arc.pass, of: arc.cfg.cycles } : null
})

function phaseFill(ph: SessionPhase): number {
  if (!sessionActive.value)
    return 0
  const cur = PHASES.indexOf(phase.value as Exclude<SessionPhase, 'idle'>)
  const idx = PHASES.indexOf(ph as Exclude<SessionPhase, 'idle'>)
  if (idx < cur)
    return 1
  if (idx > cur)
    return 0
  if (ph === 'peak' && edgePass.value) {
    const within = Math.min(0.95, phaseElapsed.value / EDGE_HOLD)
    return Math.min(0.98, (edgePass.value.pass + within) / edgePass.value.of)
  }
  return Math.min(0.98, phaseElapsed.value / PHASE_NOMINAL[ph])
}

function mmss(sec: number) {
  const s = Math.floor(sec)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// ─── Readouts ───────────────────────────────────────────────────────────────

const rightFreq = computed(() => baseFrequency.value + beatDelta.value)
const band = computed(() => bandOf(beatDelta.value))
const phaseTone = computed(() => PHASE_TONE[phase.value])

/** The beat itself, slowed to something the eye can follow at high rates. */
const beatPeriod = computed(() => `${Math.max(0.09, Math.min(4, 1 / Math.max(0.25, beatDelta.value))).toFixed(3)}s`)

/** The session pulse the device and visuals lock to: the script's tempo when it is driving. */
const pulseRate = computed(() => (scriptDrive.value && locked.value && scriptSpm.value > 0) ? scriptSpm.value : pulseCpm.value)
const pulsePeriod = computed(() => `${(60 / Math.max(6, pulseRate.value)).toFixed(3)}s`)

const carrierOutOfRange = computed(() => baseFrequency.value < CARRIER_RECOMMENDED[0] || baseFrequency.value > CARRIER_RECOMMENDED[1])
const beatModeHint = computed(() => BEAT_MODES.find(m => m.value === beatMode.value)?.hint ?? '')
const arcHint = computed(() => ARCS.find(a => a.value === sessionArc.value)?.hint ?? '')
const breathNeedsNoise = computed(() => breathEnabled.value && !noiseEnabled.value)

// ─── Summaries ──────────────────────────────────────────────────────────────

const toneSummary = computed(() => `${baseFrequency.value.toFixed(0)} Hz · Δ${beatDelta.value.toFixed(1)} · ${beatMode.value}`)
const scriptSummary = computed(() => {
  if (!scriptDrive.value)
    return 'off'
  if (!hasScript.value)
    return 'no script'
  return locked.value ? `locked · ${scriptSpm.value.toFixed(0)} spm` : 'searching'
})
const layersSummary = computed(() => {
  const on = [
    noiseEnabled.value ? `${noiseType.value} noise` : '',
    harmonicsEnabled.value ? 'harmonics' : '',
    beatDriftEnabled.value ? 'drift' : '',
  ].filter(Boolean)
  return on.length ? on.join(' · ') : 'tone only'
})
const pulseSummary = computed(() => `${pulseCpm.value}/min · ${pulseEnabled.value ? pct(pulseDepth.value) : 'silent'}`)
const sessionSummary = computed(() => {
  const arc = sessionArc.value === 'edged' ? `edged ×${edgeCycles.value}` : 'smooth'
  return driftMode.value ? `${arc} · drift` : arc
})
const breathSummary = computed(() => breathEnabled.value ? `${(60 / breathPeriod.value).toFixed(1)}/min` : 'off')

// ─── Scope drawing ──────────────────────────────────────────────────────────

/** A long sine strip that scrolls by exactly one period, so the loop is seamless. */
function wavePath(amp: number, mid = 32): string {
  let d = `M-200 ${mid}`
  for (let x = -200; x < 800; x += 100)
    d += ` Q${x + 25} ${mid - amp} ${x + 50} ${mid} Q${x + 75} ${mid + amp} ${x + 100} ${mid}`
  return d
}
const WAVE_A = wavePath(18)
const WAVE_B = wavePath(11)
</script>

<template>
  <UiPanel>
    <!-- ─── Hero: transport, live readout, session timeline ─────────────── -->
    <section
      class="hero p-3 card flex flex-col gap-3"
      :class="isPlaying ? 'is-live' : ''"
      :style="{ '--phase': phaseTone, '--beat': beatPeriod, '--pulse': pulsePeriod }"
    >
      <div class="flex gap-3 items-center">
        <button
          v-tip="isPlaying ? 'Stop (fades out)' : 'Start the tone'"
          type="button"
          :aria-label="isPlaying ? 'Stop' : 'Play'"
          class="focusable rounded-full center shrink-0 h-12 w-12 pressable"
          :class="isPlaying
            ? 'bg-surface-700 text-fg ring-1 ring-edge-strong hover:bg-surface-600'
            : 'bg-accent text-accent-contrast shadow-[0_8px_20px_-8px_var(--accent)] hover:brightness-110'"
          @click="togglePlay"
        >
          <Transition name="t-pop" mode="out-in">
            <span :key="String(isPlaying)" :class="isPlaying ? 'i-carbon-stop-filled-alt' : 'i-carbon-play-filled-alt'" class="text-[20px]" />
          </Transition>
        </button>

        <div class="flex flex-1 gap-4 min-w-0">
          <UiStat label="Carrier" :value="baseFrequency.toFixed(0)" unit="Hz" />
          <UiStat :label="`Beat · ${band}`" :value="beatDelta.toFixed(1)" unit="Hz" tone="accent" />
        </div>

        <Transition name="t-pop">
          <UiBadge v-if="currentPreset" tone="accent" size="xs" class="self-start">
            {{ currentPreset }}
          </UiBadge>
        </Transition>
      </div>

      <!-- Scope: two carriers drifting past each other, the beat pulsing in
           the middle at its real rate, the session pulse as a slow halo. -->
      <div class="scope rounded-[var(--radius-md)] bg-surface-950/70 h-16 ring-1 ring-edge relative overflow-hidden">
        <svg class="h-full w-full inset-0 absolute" viewBox="0 0 600 64" preserveAspectRatio="none" aria-hidden="true">
          <path class="wave wave-a" :d="WAVE_A" />
          <path class="wave wave-b" :d="WAVE_B" />
        </svg>
        <div class="center inset-0 absolute" aria-hidden="true">
          <span class="halo" />
          <span class="ring" />
          <span class="ring-late ring" />
          <span class="core" />
        </div>
        <span class="text-[10.5px] text-fg-faint num left-2 top-1.5 absolute">L {{ baseFrequency.toFixed(0) }}</span>
        <span class="text-[10.5px] text-fg-faint num right-2 top-1.5 absolute">R {{ rightFreq.toFixed(1) }}</span>
        <span class="eyebrow bottom-1.5 left-2 absolute">{{ beatMode }}</span>
        <span class="text-[10.5px] text-fg-faint num bottom-1.5 right-2 absolute">pulse {{ pulseRate.toFixed(0) }}/min</span>
      </div>

      <!-- Session timeline -->
      <div class="flex flex-col gap-1.5">
        <div class="flex gap-1">
          <button
            v-for="ph in PHASES"
            :key="ph"
            v-tip="sessionActive ? `Jump to ${PHASE_LABEL[ph]}` : undefined"
            type="button"
            :aria-label="`${PHASE_LABEL[ph]} phase`"
            :disabled="!sessionActive"
            class="group py-1 focusable flex flex-col gap-1 min-w-0 disabled:cursor-default"
            :style="{ flexGrow: PHASE_NOMINAL[ph] }"
            @click="session.jumpToPhase(ph)"
          >
            <span class="rounded-full bg-surface-700 h-1.5 w-full block overflow-hidden">
              <span
                class="rounded-full h-full block transition-[width] duration-500 ease-linear"
                :style="{ width: `${phaseFill(ph) * 100}%`, background: PHASE_TONE[ph] }"
              />
            </span>
            <span
              class="text-[10.5px] font-medium text-left truncate transition-colors"
              :class="sessionActive && phase === ph ? '' : 'text-fg-faint group-hover:text-fg-muted'"
              :style="sessionActive && phase === ph ? { color: PHASE_TONE[ph] } : undefined"
            >{{ PHASE_LABEL[ph] }}</span>
          </button>
        </div>

        <div class="flex gap-2 min-h-7 items-center">
          <div class="flex flex-1 flex-col min-w-0">
            <template v-if="sessionActive">
              <span class="text-[12px] font-medium flex gap-1.5 items-center" :style="{ color: phaseTone }">
                <span class="rounded-full bg-current h-1.5 w-1.5 animate-pulse-dot" />
                {{ PHASE_LABEL[phase] }}
                <span class="text-fg-faint font-normal num">{{ mmss(phaseElapsed) }}</span>
                <span v-if="phase === 'peak' && edgePass" class="text-fg-faint font-normal">· pass {{ Math.min(edgePass.pass + 1, edgePass.of) }}/{{ edgePass.of }}</span>
              </span>
              <span class="hint num">session {{ mmss(sessionElapsed) }}</span>
            </template>
            <span v-else class="hint">Evolves beat, noise and visuals through four phases.</span>
          </div>
          <UiButton
            v-tip="'Small random wander of the beat while a session runs'"
            variant="ghost"
            size="sm"
            icon="i-carbon-chart-line-smooth"
            :active="driftMode"
            @click="driftMode = !driftMode"
          >
            Drift
          </UiButton>
          <UiButton
            :variant="sessionActive ? 'secondary' : 'primary'"
            size="sm"
            :icon="sessionActive ? 'i-carbon-stop-filled-alt' : 'i-carbon-flow'"
            @click="toggleSession"
          >
            {{ sessionActive ? 'End' : 'Session' }}
          </UiButton>
        </div>
      </div>

      <div class="gap-3 grid grid-cols-2">
        <UiSlider
          v-model="master"
          label="Intensity"
          :format="pct"
          :reset="DEFAULT.intensity"
          hint="Beat, noise and visuals"
        />
        <UiSlider
          v-model="vol"
          label="Volume"
          :format="pct"
          :reset="DEFAULT.volume"
        />
      </div>
    </section>

    <!-- ─── Tone ──────────────────────────────────────────────────────────── -->
    <UiSection v-model:open="openTone" title="Tone" icon="i-carbon-waveform" :summary="toneSummary" collapsible :live="isPlaying">
      <div class="flex flex-col gap-1.5">
        <span class="label">Presets <span class="text-fg-faint font-normal">· glide while playing</span></span>
        <div class="gap-1 grid grid-cols-5">
          <button
            v-for="p in PRESETS"
            :key="p.name"
            v-tip="`${p.desc} · ${p.base} Hz carrier, ${p.delta} Hz beat`"
            type="button"
            class="px-1 py-1.5 focusable rounded-[var(--radius-sm)] flex flex-col gap-0.5 ring-1 pressable items-center"
            :class="currentPreset === p.name
              ? 'bg-accent-soft ring-accent/40 text-accent-300'
              : 'bg-surface-800 ring-edge text-fg hover:bg-surface-700'"
            @click="applyPreset(p)"
          >
            <span class="text-[12px] font-semibold">{{ p.name }}</span>
            <span class="text-[10px] num opacity-60">{{ p.hz }}</span>
          </button>
        </div>
      </div>

      <div class="flex flex-col gap-1.5">
        <span class="label">Beat mode</span>
        <UiSegmented v-model="beatMode" :options="BEAT_MODES" block />
        <span class="hint">{{ beatModeHint }}</span>
      </div>

      <div class="flex flex-col gap-1.5">
        <UiSlider v-model="carrier" label="Carrier" unit=" Hz" :min="40" :max="CARRIER_MAX" :step="1" :reset="DEFAULT.carrier" />
        <div class="flex flex-wrap gap-1 items-center">
          <span class="text-[10.5px] text-fg-faint mr-0.5">Tunings</span>
          <button
            v-for="hz in SOLFEGGIO"
            :key="hz"
            type="button"
            class="text-[10.5px] num px-1.5 focusable rounded-[var(--radius-xs)] h-5 pressable"
            :class="Math.round(baseFrequency) === hz ? 'bg-accent-soft text-accent-300' : 'bg-fg/6 text-fg-muted hover:text-fg hover:bg-fg/10'"
            @click="setCarrier(hz)"
          >
            {{ hz }}
          </button>
        </div>
        <Transition name="t-fade">
          <p v-if="carrierOutOfRange" class="hint text-warn flex gap-1.5">
            <span class="i-carbon-warning-alt mt-px shrink-0" />
            <span>Beats are heard best around {{ CARRIER_RECOMMENDED[0] }}–{{ CARRIER_RECOMMENDED[1] }} Hz and fade out above ~1 kHz, whatever the delta says.</span>
          </p>
        </Transition>
      </div>

      <UiSlider
        v-model="beat"
        label="Beat Δ"
        :min="0.5"
        :max="MAX_BEAT_HZ"
        :step="0.1"
        :format="v => `${v.toFixed(1)} Hz · ${bandOf(v)}`"
        :reset="DEFAULT.beat"
      />

      <div class="flex flex-col gap-1.5">
        <span class="label">Wave shape</span>
        <UiSegmented v-model="wave" :options="WAVES" size="xs" block />
      </div>
    </UiSection>

    <!-- ─── Follow the script ─────────────────────────────────────────────── -->
    <UiSection
      v-model:open="openScript"
      title="Follow script"
      icon="i-carbon-chart-line-data"
      :summary="scriptSummary"
      collapsible
      :live="scriptDrive && locked"
    >
      <template #actions>
        <UiSwitch v-model="scriptDrive" size="sm" />
      </template>
      <p class="hint">
        Builds the beat from the funscript you are watching: the pulse locks to
        the stroke phase rather than running on its own tempo, so the audio lands
        on the strokes.
      </p>
      <UiSwitch v-model="scriptDriveIntensity" label="Stroke speed drives intensity" :disabled="!scriptDrive" size="sm" />
      <Transition name="t-fade" mode="out-in">
        <p v-if="scriptDrive && !hasScript" key="none" class="hint text-warn flex gap-1.5 items-center">
          <span class="i-carbon-warning-alt shrink-0" /> No script loaded — nothing to follow yet.
        </p>
        <div v-else-if="scriptDrive" key="live" class="px-2.5 py-2 well flex gap-3 items-center">
          <span class="text-[11.5px] font-medium flex gap-1.5 items-center" :class="locked ? 'text-ok' : 'text-fg-faint'">
            <span class="rounded-full bg-current h-1.5 w-1.5" :class="locked ? 'animate-pulse-dot' : ''" />
            {{ locked ? 'Locked' : 'Searching' }}
          </span>
          <span class="text-[11.5px] text-fg-muted num ml-auto">{{ scriptSpm.toFixed(0) }} spm</span>
          <span class="divider-x" />
          <span class="text-[11.5px] text-fg-muted num">{{ pct(scriptIntensity) }}</span>
        </div>
      </Transition>
    </UiSection>

    <!-- ─── Layers ────────────────────────────────────────────────────────── -->
    <UiSection
      v-model:open="openLayers"
      title="Layers"
      icon="i-carbon-layers"
      :summary="layersSummary"
      collapsible
      :live="isPlaying && noiseEnabled"
    >
      <UiSwitch v-model="noiseEnabled" label="Noise bed" hint="A cushion under the tone; also carries the breath cue." />
      <div class="pl-3 border-l border-edge flex flex-col gap-3 transition-opacity" :class="noiseEnabled ? '' : 'opacity-45'" :inert="!noiseEnabled">
        <UiSegmented v-model="noiseKind" :options="NOISES" size="xs" block />
        <UiSlider v-model="noiseVol" label="Noise level" :min="0.01" :max="0.6" :format="pct" :reset="DEFAULT.noise" />
      </div>
      <div class="divider-y" />
      <UiSwitch v-model="harmonicsEnabled" label="Harmonic stack" hint="Adds +1 and +2 octaves at 35% and 18%." />
      <UiSwitch v-model="beatDriftEnabled" label="Beat micro-drift" hint="±0.4 Hz wander every 2.5–6 s, so the beat never sits dead still." />
    </UiSection>

    <!-- ─── Session pulse ─────────────────────────────────────────────────── -->
    <UiSection
      v-model:open="openPulse"
      title="Pulse"
      icon="i-carbon-activity"
      :summary="pulseSummary"
      collapsible
      :live="isPlaying && pulseEnabled"
    >
      <template #actions>
        <UiSwitch v-model="pulseEnabled" v-tip="'Audible'" size="sm" />
      </template>
      <p class="hint">
        A slow swell the device stroke and the slideshow lock to in phase, so what
        you hear and what you feel are the same beat. The switch makes it audible;
        it keeps time either way.
      </p>
      <UiSwitch v-model="pulseFollowsSession" label="Follow session intensity" size="sm" />
      <UiSlider
        v-model="pulseCpm"
        label="Tempo"
        :min="12"
        :max="160"
        :step="1"
        unit="/min"
        :reset="DEFAULT.pulseCpm"
        :disabled="pulseFollowsSession"
        :hint="pulseFollowsSession ? 'Set by intensity while following the session.' : undefined"
      />
      <UiSlider v-model="pulseDepth" label="Depth" :format="pct" :reset="DEFAULT.pulseDepth" :disabled="!pulseEnabled" />
    </UiSection>

    <!-- ─── Session shape ─────────────────────────────────────────────────── -->
    <UiSection
      v-model:open="openSession"
      title="Session shape"
      icon="i-carbon-flow"
      :summary="sessionSummary"
      collapsible
      :live="sessionActive"
    >
      <div class="flex flex-col gap-1.5">
        <UiSegmented v-model="sessionArc" :options="ARCS" block />
        <span class="hint">{{ arcHint }}</span>
      </div>
      <Transition name="t-collapse">
        <div v-if="sessionArc === 'edged'">
          <div class="min-h-0 overflow-hidden">
            <UiSlider v-model="edgeCycles" label="Passes before wind-down" :min="1" :max="8" :step="1" :reset="DEFAULT.edgeCycles" />
          </div>
        </div>
      </Transition>
      <UiSwitch v-model="driftMode" label="Drift" hint="Lets the beat wander a little while a session runs." size="sm" />
    </UiSection>

    <!-- ─── Breath pacing ─────────────────────────────────────────────────── -->
    <UiSection
      v-model:open="openBreath"
      title="Breath pacing"
      icon="i-carbon-rain-drop"
      :summary="breathSummary"
      collapsible
      :live="isPlaying && breathEnabled && noiseEnabled"
    >
      <template #actions>
        <UiSwitch v-model="breathEnabled" size="sm" />
      </template>
      <p class="hint">
        Swells the noise bed to breathe along with, longer out than in. The one
        part of this panel with a solid physiological mechanism behind it rather
        than entrainment folklore.
      </p>
      <Transition name="t-fade">
        <div v-if="breathNeedsNoise" class="px-2.5 py-2 well flex gap-2 items-center">
          <span class="i-carbon-warning-alt text-warn shrink-0" />
          <span class="text-[11.5px] text-fg-muted flex-1">Needs the noise bed on.</span>
          <UiButton size="xs" variant="subtle" @click="noiseEnabled = true">
            Turn on
          </UiButton>
        </div>
      </Transition>
      <UiSlider
        v-model="breathPeriod"
        label="Rate"
        :min="4"
        :max="20"
        :step="0.5"
        :format="v => `${(60 / v).toFixed(1)}/min · ${v}s`"
        :reset="DEFAULT.breathPeriod"
      />
      <UiSlider
        v-model="breathInhaleRatio"
        label="In / out"
        :min="0.25"
        :max="0.5"
        :format="v => `${Math.round(v * 100)} / ${100 - Math.round(v * 100)}`"
        :reset="DEFAULT.inhale"
      />
    </UiSection>
  </UiPanel>
</template>

<style scoped>
/* A faint wash of the current phase colour, so the hero reads the session at a glance. */
.hero {
  background: linear-gradient(180deg, color-mix(in srgb, var(--phase) 9%, var(--bg-850)) 0%, var(--bg-850) 70%);
  transition: background var(--dur-slow) var(--ease-out);
}

.wave {
  fill: none;
  vector-effect: non-scaling-stroke;
  animation: wave-flow 4s linear infinite;
  animation-play-state: paused;
  transition: opacity var(--dur-slow) var(--ease-out);
}
.wave-a {
  stroke: var(--accent);
  stroke-width: 1.75;
  opacity: 0.35;
}
.wave-b {
  stroke: var(--info);
  stroke-width: 1.25;
  opacity: 0.2;
  animation-duration: 6s;
  animation-direction: reverse;
}
.is-live .wave {
  animation-play-state: running;
}
.is-live .wave-a {
  opacity: 0.75;
}
.is-live .wave-b {
  opacity: 0.5;
}
@keyframes wave-flow {
  to {
    transform: translateX(100px);
  }
}

.core,
.ring,
.halo {
  position: absolute;
  border-radius: 9999px;
}
.core {
  width: 10px;
  height: 10px;
  background: var(--accent);
  opacity: 0.35;
  transition: opacity var(--dur) var(--ease-out);
}
.ring {
  width: 14px;
  height: 14px;
  border: 1.5px solid var(--accent);
  opacity: 0;
}
.halo {
  width: 56px;
  height: 56px;
  background: radial-gradient(circle, color-mix(in srgb, var(--info) 30%, transparent) 0%, transparent 70%);
  opacity: 0;
}
.is-live .core {
  opacity: 1;
  box-shadow: 0 0 14px var(--accent);
  animation: beat-core var(--beat) ease-in-out infinite;
}
.is-live .ring {
  animation: beat-ring var(--beat) ease-out infinite;
}
.is-live .ring-late {
  animation-delay: calc(var(--beat) / 2);
}
.is-live .halo {
  animation: pulse-halo var(--pulse) ease-in-out infinite;
}
@keyframes beat-core {
  0%,
  100% {
    transform: scale(0.7);
  }
  50% {
    transform: scale(1.15);
  }
}
@keyframes beat-ring {
  from {
    transform: scale(0.8);
    opacity: 0.75;
  }
  to {
    transform: scale(3.4);
    opacity: 0;
  }
}
@keyframes pulse-halo {
  0%,
  100% {
    transform: scale(0.6);
    opacity: 0.2;
  }
  50% {
    transform: scale(1.25);
    opacity: 0.9;
  }
}
</style>
