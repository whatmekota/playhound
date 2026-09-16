<script setup lang="ts">
import type { NoiseType, SessionPhase } from '~/stores/audio'
import { useLocalStorage } from '@vueuse/core'
import { useScriptPulse } from '~/composables/useScriptPulse'
import { useVideoBeat } from '~/composables/useVideoBeat'
import { useAudioStore } from '~/stores/audio'
import { useScriptStore } from '~/stores/scriptStore'
import CollapsibleSection from './CollapsibleSection.vue'

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
  musicDrive,
} = useAudioStore()

const videoBeat = useVideoBeat()

const openBeat = useLocalStorage('ph-sec-beat', false)
const openLayers = useLocalStorage('ph-sec-layers', false)
const openSession = useLocalStorage('ph-sec-session', false)

const beatSummary = computed(() =>
  `${baseFrequency.value.toFixed(0)} Hz · Δ${beatDelta.value.toFixed(1)}`,
)
const layerSummary = computed(() =>
  noiseEnabled.value ? `${noiseType.value} noise` : 'off',
)
const sessionSummary = computed(() => {
  if (scriptDrive.value)
    return 'script'
  if (sessionActive.value)
    return phase.value
  return sessionArc.value
})

const scriptPulse = useScriptPulse()
const scriptStore = useScriptStore()
const hasScript = computed(() => scriptStore.activeScripts.length > 0)

const BEAT_MODES = [
  { id: 'binaural', label: 'Binaural', hint: 'One tone per ear. The beat exists only in your head — the gentlest, and the weakest at driving a response.' },
  { id: 'monaural', label: 'Monaural', hint: 'Both tones in both ears, so the beat is physically in the air. Stronger, and works without headphones.' },
  { id: 'isochronic', label: 'Isochronic', hint: 'A single tone gated on and off. Strongest cortical response of the three, and impossible to ignore.' },
] as const

const ARCS = [
  { id: 'smooth', label: 'Smooth', hint: 'One rise and one fall.' },
  { id: 'edged', label: 'Edged', hint: 'Repeated build, hold, then partial retreat — each pass reaching a little higher.' },
] as const

const beatModeHint = computed(() => BEAT_MODES.find(m => m.id === beatMode.value)?.hint ?? '')
const arcHint = computed(() => ARCS.find(a => a.id === sessionArc.value)?.hint ?? '')
const carrierOutOfRange = computed(() => baseFrequency.value < 250 || baseFrequency.value > 450)
const breathPerMinute = computed(() => (60 / breathPeriod.value).toFixed(1))

const binaural = useBinauralBeats()
const session = useSessionEngine()

const PRESETS = [
  { name: 'Delta', desc: 'Deep sleep', hz: '0.5–4 Hz', base: 100, delta: 2, color: '#818cf8' },
  { name: 'Theta', desc: 'Meditation', hz: '4–8 Hz', base: 180, delta: 6, color: '#a78bfa' },
  { name: 'Alpha', desc: 'Relaxation', hz: '8–12 Hz', base: 220, delta: 10, color: '#2dd4bf' },
  { name: 'Beta', desc: 'Focus', hz: '12–30 Hz', base: 300, delta: 20, color: '#34d399' },
  // 40 Hz would exceed Oster's fusion limit and stop being heard as a beat.
  { name: 'Gamma', desc: 'Flow state', hz: '30-35 Hz', base: 400, delta: 32, color: '#fbbf24' },
]

const WAVE_TYPES: { value: OscillatorType, label: string }[] = [
  { value: 'sine', label: 'Sine' },
  { value: 'triangle', label: 'Triangle' },
  { value: 'sawtooth', label: 'Sawtooth' },
  { value: 'square', label: 'Square' },
]

const NOISE_TYPES: { value: NoiseType, label: string, desc: string }[] = [
  { value: 'brown', label: 'Brown', desc: 'Deep rumble' },
  { value: 'pink', label: 'Pink', desc: 'Balanced' },
  { value: 'white', label: 'White', desc: 'Full spectrum' },
]

const PHASE_META: Record<string, { label: string, color: string }> = {
  idle: { label: 'Idle', color: '#52525b' },
  entry: { label: 'Entry', color: '#60a5fa' },
  build: { label: 'Build', color: '#2dd4bf' },
  peak: { label: 'Peak', color: '#fbbf24' },
  descent: { label: 'Descent', color: '#a78bfa' },
}

// Solfeggio / tuning base-frequency presets
const SOLFEGGIO = [
  { hz: 396, label: '396' },
  { hz: 432, label: '432' },
  { hz: 528, label: '528' },
  { hz: 639, label: '639' },
  { hz: 741, label: '741' },
  { hz: 852, label: '852' },
]

// --- Preset morphing ---

let morphAnimFrame: number | null = null

function applyPreset(p: typeof PRESETS[0]) {
  currentPreset.value = p.name
  if (isPlaying.value) {
    const startBase = baseFrequency.value
    const startDelta = beatDelta.value
    const startTime = Date.now()
    const dur = 5000

    if (morphAnimFrame !== null)
      cancelAnimationFrame(morphAnimFrame)
    binaural.morphTo(p.base, p.delta, 5)

    function frame() {
      const t = Math.min(1, (Date.now() - startTime) / dur)
      const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
      baseFrequency.value = startBase + (p.base - startBase) * eased
      beatDelta.value = startDelta + (p.delta - startDelta) * eased
      if (t < 1)
        morphAnimFrame = requestAnimationFrame(frame)
    }
    morphAnimFrame = requestAnimationFrame(frame)
  }
  else {
    baseFrequency.value = p.base
    beatDelta.value = p.delta
  }
}

// --- Manual controls ---

function onBaseFreq(e: Event) {
  const v = +(e.target as HTMLInputElement).value
  baseFrequency.value = v
  currentPreset.value = ''
  binaural.stopMorph()
  if (isPlaying.value)
    binaural.setFrequencies(v, beatDelta.value)
}

function setBaseFreq(hz: number) {
  baseFrequency.value = hz
  currentPreset.value = ''
  binaural.stopMorph()
  if (isPlaying.value)
    binaural.setFrequencies(hz, beatDelta.value)
}

function onBeatDelta(e: Event) {
  const v = +(e.target as HTMLInputElement).value
  beatDelta.value = v
  currentPreset.value = ''
  binaural.stopMorph()
  binaural.stopBeatDrift()
  if (isPlaying.value)
    binaural.setFrequencies(baseFrequency.value, v)
}

function onVolume(e: Event) {
  const v = +(e.target as HTMLInputElement).value
  volume.value = v
  if (isPlaying.value)
    binaural.setVolume(v)
}

function onWaveType(t: OscillatorType) {
  waveType.value = t
  if (isPlaying.value)
    binaural.setWaveType(t)
}

// --- Master intensity ---

function onIntensity(e: Event) {
  const v = +(e.target as HTMLInputElement).value
  intensity.value = v
  const newDelta = 1 + v * 38
  beatDelta.value = newDelta
  binaural.stopMorph()
  binaural.stopBeatDrift()
  currentPreset.value = ''
  if (isPlaying.value)
    binaural.setFrequencies(baseFrequency.value, newDelta)
  if (noiseEnabled.value && isPlaying.value)
    binaural.setNoiseVolume(0.05 + v * 0.35)
}

// --- Noise layer ---

watch([noiseEnabled, isPlaying], ([noiseOn, playing]) => {
  if (noiseOn && playing) {
    binaural.startNoise(noiseVolume.value)
    binaural.morphNoise(noiseType.value, 0.5)
  }
  else if (!noiseOn) {
    binaural.stopNoise()
  }
})

function onNoiseVolume(e: Event) {
  const v = +(e.target as HTMLInputElement).value
  noiseVolume.value = v
  if (isPlaying.value && noiseEnabled.value)
    binaural.setNoiseVolume(v)
}

function setNoiseType(t: NoiseType) {
  noiseType.value = t
  if (isPlaying.value && noiseEnabled.value)
    binaural.morphNoise(t, 3)
}

// --- Harmonics ---

watch(harmonicsEnabled, (on) => {
  if (isPlaying.value)
    binaural.setHarmonics(on)
})

// --- Beat drift ---

watch(beatDriftEnabled, (on) => {
  if (on && isPlaying.value) {
    binaural.startBeatDrift(
      () => baseFrequency.value,
      () => beatDelta.value,
      (newDelta) => { beatDelta.value = newDelta },
    )
  }
  else {
    binaural.stopBeatDrift()
  }
})

// --- Drift mode ---

watch(driftMode, (on) => {
  if (sessionActive.value) {
    if (on)
      session.startDrift()
    else session.stopDrift()
  }
})

// --- Main play / stop (with fade-in / fade-out) ---

function togglePlay() {
  if (isPlaying.value) {
    isPlaying.value = false
    binaural.fadeOut(2)
    if (sessionActive.value)
      session.stopSession()
  }
  else {
    binaural.start(baseFrequency.value, beatDelta.value, volume.value, waveType.value)
    if (harmonicsEnabled.value)
      binaural.setHarmonics(true)
    if (noiseEnabled.value) {
      binaural.startNoise(noiseVolume.value)
      binaural.morphNoise(noiseType.value, 0.5)
    }
    if (beatDriftEnabled.value) {
      binaural.startBeatDrift(
        () => baseFrequency.value,
        () => beatDelta.value,
        (newDelta) => { beatDelta.value = newDelta },
      )
    }
    isPlaying.value = true
  }
}

// --- Session ---

function toggleSession() {
  if (sessionActive.value) {
    session.stopSession()
  }
  else {
    if (!isPlaying.value)
      togglePlay()
    session.startSession()
  }
}

// --- Computed ---

const waveSpeed = computed(() => isPlaying.value ? 1 : 0.15)
const rightFreq = computed(() => baseFrequency.value + beatDelta.value)
const phaseColor = computed(() => PHASE_META[phase.value]?.color ?? '#52525b')
const phaseLabel = computed(() => PHASE_META[phase.value]?.label ?? 'Idle')

// Beat pulse: period clamped to [80ms, 4s] so it's always visually readable
const beatPulsePeriod = computed(() => {
  const period = 1 / Math.max(0.25, beatDelta.value)
  return Math.max(0.08, Math.min(period, 4)).toFixed(3)
})
</script>

<template>
  <div class="bg-surface-950 h-full overflow-y-auto">
    <div class="mx-auto px-3 py-3 max-w-2xl space-y-4">
      <!-- Wave visualization + beat pulse -->
      <div class="border border-edge rounded-2xl bg-surface-900 flex h-24 items-center relative overflow-hidden">
        <svg
          class="h-full w-full inset-0 absolute"
          viewBox="0 0 600 96"
          preserveAspectRatio="none"
        >
          <path
            class="wave1"
            :style="{ '--speed': waveSpeed }"
            d="M-200 48 Q-150 12 -100 48 Q-50 84 0 48 Q50 12 100 48 Q150 84 200 48 Q250 12 300 48 Q350 84 400 48 Q450 12 500 48 Q550 84 600 48 Q650 12 700 48 Q750 84 800 48"
            fill="none"
            stroke="#2dd4bf"
            stroke-width="2"
            opacity="0.7"
          />
          <path
            class="wave2"
            :style="{ '--speed': waveSpeed }"
            d="M-200 48 Q-150 20 -100 48 Q-50 76 0 48 Q50 20 100 48 Q150 76 200 48 Q250 20 300 48 Q350 76 400 48 Q450 20 500 48 Q550 76 600 48 Q650 20 700 48 Q750 76 800 48"
            fill="none"
            stroke="#0f766e"
            stroke-width="1.5"
            opacity="0.5"
          />
        </svg>

        <!-- Beat pulse ring -->
        <div
          v-if="isPlaying"
          class="flex pointer-events-none items-center inset-0 justify-center absolute"
        >
          <div
            class="beat-pulse-ring border border-teal-400/40 rounded-full"
            :style="{ '--pulse-period': `${beatPulsePeriod}s` }"
          />
        </div>

        <div class="text-center w-full relative z-10">
          <p class="text-xs text-fg-muted">
            L: {{ baseFrequency.toFixed(0) }} Hz &nbsp;·&nbsp; R: {{ rightFreq.toFixed(1) }} Hz &nbsp;·&nbsp; Beat: {{ beatDelta.toFixed(1) }} Hz
          </p>
          <p v-if="currentPreset" class="text-sm text-teal-400 font-medium mt-1">
            {{ currentPreset }}
          </p>
          <p v-if="phase !== 'idle'" class="text-xs font-medium mt-1" :style="{ color: phaseColor }">
            ● {{ phaseLabel }}
          </p>
        </div>
      </div>

      <!-- Play button -->
      <div class="pb-4 flex justify-center">
        <button
          class="text-base font-semibold py-3.5 rounded-2xl w-48 transition-all active:scale-95"
          :class="isPlaying
            ? 'bg-surface-700 hover:bg-fg/15 text-fg'
            : 'bg-teal-600 hover:bg-teal-500 text-white shadow-lg shadow-teal-900/40'"
          @click="togglePlay"
        >
          {{ isPlaying ? '■ Stop' : '▶ Play' }}
        </button>
      </div>
      <!-- Master Intensity -->
      <div class="p-4 border border-edge rounded-2xl bg-surface-900">
        <div class="mb-2 flex items-center justify-between">
          <label class="text-sm text-fg-muted font-medium">Master Intensity</label>
          <span class="text-sm text-teal-400 font-mono">{{ Math.round(intensity * 100) }}%</span>
        </div>
        <input
          type="range" min="0" max="1" step="0.01"
          :value="intensity"
          class="primary-slider w-full"
          @input="onIntensity"
        >
        <p class="text-[10px] text-fg-faint mt-1">
          Drives beat Hz, noise level, and visual intensity simultaneously
        </p>
      </div>

      <!-- Drive from the funscript -->
      <div class="p-3 panel space-y-2.5">
        <div class="flex items-center justify-between">
          <p class="label">
            Follow the script
          </p>
          <label class="text-[11px] text-fg-muted flex gap-1.5 cursor-pointer items-center">
            <input v-model="scriptDrive" type="checkbox">
            On
          </label>
        </div>
        <p class="hint">
          Builds the beat from the funscript you are watching: the pulse locks
          to the stroke phase rather than running on its own tempo, so the audio
          lands on the strokes.
        </p>

        <label
          v-if="scriptDrive"
          class="text-xs text-fg-muted flex gap-2 cursor-pointer items-center"
        >
          <input v-model="scriptDriveIntensity" type="checkbox">
          Stroke speed also drives intensity
        </label>

        <p v-if="scriptDrive && !hasScript" class="hint text-amber-400/80">
          No script loaded — nothing to follow yet.
        </p>

        <div
          v-else-if="scriptDrive"
          class="text-[11px] font-mono flex gap-2 items-center"
        >
          <span
            class="rounded-full shrink-0 h-1.5 w-1.5"
            :class="scriptPulse.locked.value ? 'bg-teal-400' : 'bg-fg/25'"
          />
          <span :class="scriptPulse.locked.value ? 'text-teal-400' : 'text-fg-faint'">
            {{ scriptPulse.locked.value ? 'locked' : 'searching' }}
          </span>
          <span class="text-fg-faint">·</span>
          <span class="text-fg-muted">{{ scriptPulse.scriptSpm.value.toFixed(0) }} spm</span>
          <span class="text-fg-faint">·</span>
          <span class="text-fg-muted">{{ (scriptPulse.scriptIntensity.value * 100).toFixed(0) }}%</span>
        </div>
      </div>

      <CollapsibleSection
        v-model:open="openBeat"
        title="Beat"
        icon="i-carbon-waveform"
        :summary="beatSummary"
        :active="isPlaying"
      >
        <!-- Beat mode -->
        <div>
          <p class="label mb-2">
            Beat mode
          </p>
          <div class="gap-1 grid grid-cols-3">
            <button
              v-for="m in BEAT_MODES"
              :key="m.id"
              class="text-[11px] font-medium px-2 py-1.5 border rounded-lg transition-colors"
              :class="beatMode === m.id
                ? 'border-teal-500/40 bg-teal-500/10 text-teal-300'
                : 'border-edge bg-surface-900 text-fg-muted hover:bg-surface-800'"
              @click="beatMode = m.id"
            >
              {{ m.label }}
            </button>
          </div>
          <p class="hint mt-1.5">
            {{ beatModeHint }}
          </p>
        </div>

        <!-- Presets -->
        <div>
          <p class="label mb-2">
            Presets <span class="text-fg-faint font-normal normal-case">&mdash; morphs smoothly while playing</span>
          </p>
          <div class="gap-1.5 grid grid-cols-2 xl:grid-cols-3">
            <button
              v-for="p in PRESETS"
              :key="p.name"
              class="px-2 py-1.5 text-left border rounded-lg transition-colors"
              :class="currentPreset === p.name
                ? 'border-accent-500/40 bg-accent-500/10'
                : 'border-edge bg-surface-900 hover:bg-surface-800'"
              @click="applyPreset(p)"
            >
              <div class="flex gap-1.5 items-center">
                <span class="rounded-full shrink-0 h-1.5 w-1.5" :style="{ background: p.color }" />
                <p class="text-[11px] text-fg font-semibold truncate">
                  {{ p.name }}
                </p>
              </div>
              <p class="text-[10px] text-fg-muted leading-tight mt-0.5">
                {{ p.desc }}
              </p>
              <p class="text-[10px] mt-1" :style="{ color: p.color }">
                {{ p.hz }}
              </p>
            </button>
          </div>
        </div>

        <!-- Manual controls -->
        <div class="p-5 border border-edge rounded-2xl bg-surface-900 space-y-5">
          <p class="text-xs text-fg-muted tracking-wider uppercase">
            Manual
          </p>

          <div>
            <div class="mb-2 flex justify-between">
              <label class="text-sm text-fg-muted">Base Frequency</label>
              <span class="text-sm text-teal-400 font-mono">{{ baseFrequency.toFixed(0) }} Hz</span>
            </div>
            <input
              type="range" min="40" max="500" step="1"
              :value="baseFrequency"
              class="primary-slider w-full"
              @input="onBaseFreq"
            >
            <div class="text-[10px] text-fg-faint mb-1 mt-1 flex justify-between">
              <span>40 Hz</span><span>500 Hz</span>
            </div>
            <p v-if="carrierOutOfRange" class="hint text-amber-400/80 mb-2">
              Beat perception is widest around 250&ndash;450 Hz, and falls away
              entirely above about 1 kHz. Outside that band the beat gets harder to
              hear, whatever the delta says.
            </p>
            <!-- Solfeggio / tuning presets -->
            <div class="flex flex-wrap gap-1">
              <button
                v-for="sf in SOLFEGGIO"
                :key="sf.hz"
                class="text-[10px] px-1.5 py-0.5 rounded transition-colors"
                :class="baseFrequency === sf.hz
                  ? 'bg-teal-700 text-teal-100'
                  : 'bg-surface-800 text-fg-muted hover:text-fg'"
                @click="setBaseFreq(sf.hz)"
              >
                {{ sf.label }}
              </button>
            </div>
          </div>

          <div>
            <div class="mb-2 flex justify-between">
              <label class="text-sm text-fg-muted">Beat Delta</label>
              <span class="text-sm text-teal-400 font-mono">{{ beatDelta.toFixed(1) }} Hz</span>
            </div>
            <input
              type="range" min="0.5" max="40" step="0.5"
              :value="beatDelta"
              class="primary-slider w-full"
              @input="onBeatDelta"
            >
            <div class="text-[10px] text-fg-faint mt-1 flex justify-between">
              <span>0.5 Hz (Delta)</span><span>40 Hz (Gamma)</span>
            </div>
          </div>

          <div>
            <div class="mb-2 flex justify-between">
              <label class="text-sm text-fg-muted">Volume</label>
              <span class="text-sm text-teal-400 font-mono">{{ Math.round(volume * 100) }}%</span>
            </div>
            <input
              type="range" min="0" max="1" step="0.01"
              :value="volume"
              class="primary-slider w-full"
              @input="onVolume"
            >
          </div>

          <div>
            <label class="text-sm text-fg-muted mb-2 block">Wave Shape</label>
            <div class="flex gap-2">
              <button
                v-for="wt in WAVE_TYPES"
                :key="wt.value"
                class="text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
                :class="waveType === wt.value
                  ? 'bg-teal-600 text-white'
                  : 'bg-surface-800 text-fg-muted hover:bg-surface-700 hover:text-fg'"
                @click="onWaveType(wt.value)"
              >
                {{ wt.label }}
              </button>
            </div>
          </div>
        </div>
      </CollapsibleSection>

      <CollapsibleSection
        v-model:open="openLayers"
        title="Layers"
        icon="i-carbon-layers"
        :summary="layerSummary"
        :active="noiseEnabled"
      >
        <!-- Audio Layers -->
        <div class="p-5 border border-edge rounded-2xl bg-surface-900 space-y-5">
          <p class="text-xs text-fg-muted tracking-wider uppercase">
            Audio Layers
          </p>

          <!-- Noise -->
          <div class="space-y-3">
            <div class="flex items-center justify-between">
              <label class="text-sm text-fg-muted font-medium">Ambient Noise</label>
              <button
                class="text-xs font-medium px-3 py-1 rounded-full transition-colors"
                :class="noiseEnabled ? 'bg-teal-600 text-white' : 'bg-surface-800 text-fg-muted hover:bg-surface-700'"
                @click="noiseEnabled = !noiseEnabled"
              >
                {{ noiseEnabled ? 'On' : 'Off' }}
              </button>
            </div>

            <Transition name="expand">
              <div v-if="noiseEnabled" class="pl-3 border-l border-edge space-y-3">
                <div class="flex gap-2">
                  <button
                    v-for="nt in NOISE_TYPES"
                    :key="nt.value"
                    class="text-xs font-medium py-2 text-center rounded-lg flex-1 transition-colors"
                    :class="noiseType === nt.value
                      ? 'bg-teal-700 text-white'
                      : 'bg-surface-800 text-fg-muted hover:bg-surface-700'"
                    @click="setNoiseType(nt.value)"
                  >
                    <div class="font-semibold">
                      {{ nt.label }}
                    </div>
                    <div class="text-[10px] text-fg-muted mt-0.5">
                      {{ nt.desc }}
                    </div>
                  </button>
                </div>

                <div>
                  <div class="mb-1.5 flex justify-between">
                    <label class="text-xs text-fg-muted">Noise Volume</label>
                    <span class="text-xs text-teal-400 font-mono">{{ Math.round(noiseVolume * 100) }}%</span>
                  </div>
                  <input
                    type="range" min="0.01" max="0.6" step="0.01"
                    :value="noiseVolume"
                    class="primary-slider w-full"
                    @input="onNoiseVolume"
                  >
                </div>
              </div>
            </Transition>
          </div>

          <!-- Harmonics -->
          <div class="flex items-center justify-between">
            <div>
              <p class="text-sm text-fg-muted font-medium">
                Harmonic Stack
              </p>
              <p class="text-[10px] text-fg-faint mt-0.5">
                Adds +1 and +2 octave layers (35%, 18% gain)
              </p>
            </div>
            <button
              class="text-xs font-medium px-3 py-1 rounded-full transition-colors"
              :class="harmonicsEnabled ? 'bg-teal-600 text-white' : 'bg-surface-800 text-fg-muted hover:bg-surface-700'"
              @click="harmonicsEnabled = !harmonicsEnabled"
            >
              {{ harmonicsEnabled ? 'On' : 'Off' }}
            </button>
          </div>

          <!-- Beat Drift -->
          <div class="flex items-center justify-between">
            <div>
              <p class="text-sm text-fg-muted font-medium">
                Beat Drift
              </p>
              <p class="text-[10px] text-fg-faint mt-0.5">
                ±0.4 Hz micro-variation every 2.5–6s
              </p>
            </div>
            <button
              class="text-xs font-medium px-3 py-1 rounded-full transition-colors"
              :class="beatDriftEnabled ? 'bg-teal-600 text-white' : 'bg-surface-800 text-fg-muted hover:bg-surface-700'"
              @click="beatDriftEnabled = !beatDriftEnabled"
            >
              {{ beatDriftEnabled ? 'On' : 'Off' }}
            </button>
          </div>
        </div>
      </CollapsibleSection>

      <CollapsibleSection
        v-model:open="openSession"
        title="Session"
        icon="i-carbon-flow"
        :summary="sessionSummary"
        :active="sessionActive"
      >
        <!-- Follow the music in the video -->
        <div class="p-3 panel space-y-2.5">
          <div class="flex items-center justify-between">
            <p class="label">
              Follow the music
            </p>
            <label class="text-[11px] text-fg-muted flex gap-1.5 cursor-pointer items-center">
              <input v-model="musicDrive" type="checkbox">
              On
            </label>
          </div>
          <p class="hint">
            Takes the tempo from the video's own soundtrack, so the pulse, the
            device and the slideshow land on the track's beat. Meant for PMVs.
          </p>

          <p v-if="musicDrive && scriptDrive" class="hint text-amber-400/80">
            A script is driving, and it wins — turn "Follow the script" off to use
            the music instead.
          </p>

          <div
            v-else-if="musicDrive"
            class="text-[11px] font-mono flex gap-2 items-center"
          >
            <span
              class="rounded-full shrink-0 h-1.5 w-1.5"
              :class="videoBeat.locked.value ? 'bg-teal-400' : 'bg-fg/25'"
            />
            <span :class="videoBeat.locked.value ? 'text-teal-400' : 'text-fg-faint'">
              {{ videoBeat.locked.value ? 'locked' : 'listening' }}
            </span>
            <template v-if="videoBeat.bpm.value">
              <span class="text-fg-faint">·</span>
              <span class="text-fg-muted">{{ videoBeat.bpm.value }} bpm</span>
            </template>
          </div>

          <p v-if="musicDrive && !videoBeat.available.value" class="hint text-red-400">
            The video's audio could not be analysed in this browser.
          </p>
        </div>

        <!-- Session pulse -->
        <div class="p-3 panel space-y-2.5">
          <div class="flex items-center justify-between">
            <p class="label">
              Session pulse
            </p>
            <label class="text-[11px] text-fg-muted flex gap-1.5 cursor-pointer items-center">
              <input v-model="pulseEnabled" type="checkbox">
              Audible
            </label>
          </div>
          <p class="hint">
            A slow swell the device stroke and the slideshow lock to in phase, so
            what you hear and what you feel are the same beat.
          </p>

          <label class="text-[11px] text-fg-muted flex gap-1.5 cursor-pointer items-center">
            <input v-model="pulseFollowsSession" type="checkbox">
            Follow session intensity
          </label>

          <div>
            <div class="text-[10px] text-fg-faint mb-1 flex justify-between">
              <span>Tempo</span>
              <span class="font-mono">{{ pulseCpm }} / min</span>
            </div>
            <input
              v-model.number="pulseCpm" type="range" min="12" max="160" step="1"
              class="accent w-full" :disabled="pulseFollowsSession"
            >
          </div>

          <div>
            <div class="text-[10px] text-fg-faint mb-1 flex justify-between">
              <span>Depth</span>
              <span class="font-mono">{{ (pulseDepth * 100).toFixed(0) }}%</span>
            </div>
            <input v-model.number="pulseDepth" type="range" min="0" max="1" step="0.01" class="accent w-full">
          </div>
        </div>

        <!-- Session arc -->
        <div>
          <p class="label mb-2">
            Session arc
          </p>
          <div class="gap-1 grid grid-cols-2">
            <button
              v-for="a in ARCS"
              :key="a.id"
              class="text-[11px] font-medium px-2 py-1.5 border rounded-lg transition-colors"
              :class="sessionArc === a.id
                ? 'border-teal-500/40 bg-teal-500/10 text-teal-300'
                : 'border-edge bg-surface-900 text-fg-muted hover:bg-surface-800'"
              @click="sessionArc = a.id"
            >
              {{ a.label }}
            </button>
          </div>
          <p class="hint mt-1.5">
            {{ arcHint }}
          </p>
          <div v-if="sessionArc === 'edged'" class="mt-2">
            <div class="text-[10px] text-fg-faint mb-1 flex justify-between">
              <span>Passes before wind-down</span>
              <span class="font-mono">{{ edgeCycles }}</span>
            </div>
            <input v-model.number="edgeCycles" type="range" min="1" max="8" step="1" class="accent w-full">
          </div>
        </div>

        <!-- Breath pacing -->
        <div class="p-3 panel space-y-2.5">
          <div class="flex items-center justify-between">
            <p class="label">
              Breath pacing
            </p>
            <label class="text-[11px] text-fg-muted flex gap-1.5 cursor-pointer items-center">
              <input v-model="breathEnabled" type="checkbox">
              On
            </label>
          </div>
          <p class="hint">
            Swells the noise bed to breathe along with, longer out than in. Needs
            the noise layer on. This is the one part of this panel with a solid
            physiological mechanism behind it rather than entrainment folklore.
          </p>
          <div>
            <div class="text-[10px] text-fg-faint mb-1 flex justify-between">
              <span>Rate</span>
              <span class="font-mono">{{ breathPerMinute }} / min</span>
            </div>
            <input v-model.number="breathPeriod" type="range" min="4" max="20" step="0.5" class="accent w-full">
          </div>
          <div>
            <div class="text-[10px] text-fg-faint mb-1 flex justify-between">
              <span>In / out</span>
              <span class="font-mono">{{ (breathInhaleRatio * 100).toFixed(0) }} / {{ (100 - breathInhaleRatio * 100).toFixed(0) }}</span>
            </div>
            <input v-model.number="breathInhaleRatio" type="range" min="0.25" max="0.5" step="0.01" class="accent w-full">
          </div>
        </div>

        <!-- Session Engine -->
        <div class="p-5 border border-edge rounded-2xl bg-surface-900 space-y-4">
          <div class="flex items-center justify-between">
            <p class="text-xs text-fg-muted tracking-wider uppercase">
              Session Engine
            </p>
            <div v-if="phase !== 'idle'" class="flex gap-2 items-center">
              <div class="rounded-full h-2 w-2 animate-pulse" :style="{ background: phaseColor }" />
              <span class="text-xs font-medium" :style="{ color: phaseColor }">{{ phaseLabel }}</span>
            </div>
          </div>

          <p class="text-xs text-fg-faint">
            Automatically evolves beat, noise and visual intensity through entry → build → peak → descent phases.
          </p>

          <!-- Phase timeline -->
          <div v-if="sessionActive" class="flex gap-1 h-1.5">
            <div
              v-for="ph in ['entry', 'build', 'peak', 'descent']"
              :key="ph"
              class="rounded-full flex-1 transition-all duration-500"
              :style="{
                background: PHASE_META[ph].color,
                opacity: phase === ph ? 1 : 0.25,
              }"
            />
          </div>

          <!-- Phase jump buttons (only during active session) -->
          <div v-if="sessionActive" class="flex gap-1">
            <button
              v-for="ph in (['entry', 'build', 'peak', 'descent'] as SessionPhase[])"
              :key="ph"
              class="text-[10px] font-medium px-2 py-1 rounded-lg flex-1 transition-all"
              :class="phase === ph
                ? 'text-fg-faint font-semibold'
                : 'bg-surface-800 text-fg-muted hover:text-fg'"
              :style="phase === ph ? { background: PHASE_META[ph].color } : {}"
              @click="session.jumpToPhase(ph)"
            >
              {{ PHASE_META[ph].label }}
            </button>
          </div>

          <div class="flex gap-3">
            <button
              class="text-sm font-semibold py-2.5 rounded-xl flex-1 transition-all active:scale-95"
              :class="sessionActive
                ? 'bg-surface-700 hover:bg-fg/15 text-fg'
                : 'bg-teal-600 hover:bg-teal-500 text-white'"
              @click="toggleSession"
            >
              {{ sessionActive ? '■ End Session' : '▶ Start Session' }}
            </button>

            <button
              class="text-xs font-medium px-3 rounded-xl transition-colors"
              :class="driftMode ? 'bg-purple-700 text-white' : 'bg-surface-800 text-fg-muted hover:bg-surface-700'"
              @click="driftMode = !driftMode"
            >
              Drift Mode
            </button>
          </div>
        </div>
      </CollapsibleSection>
    </div>
  </div>
</template>

<style scoped>
.primary-slider {
  -webkit-appearance: none;
  appearance: none;
  background: #3f3f46;
  border-radius: 4px;
  height: 5px;
  outline: none;
  width: 100%;
}
.primary-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 16px;
  height: 16px;
  background: #2dd4bf;
  border-radius: 50%;
  cursor: pointer;
  transition: transform 0.1s;
}
.primary-slider::-webkit-slider-thumb:hover {
  transform: scale(1.2);
}
.primary-slider::-moz-range-thumb {
  width: 16px;
  height: 16px;
  background: #2dd4bf;
  border-radius: 50%;
  cursor: pointer;
  border: none;
}

@keyframes wave-flow {
  from {
    transform: translateX(0);
  }
  to {
    transform: translateX(200px);
  }
}
.wave1 {
  animation: wave-flow calc(4s / var(--speed, 1)) linear infinite;
}
.wave2 {
  animation: wave-flow calc(6s / var(--speed, 1)) linear infinite reverse;
}

@keyframes beat-ring {
  0% {
    width: 20px;
    height: 20px;
    opacity: 0.6;
  }
  100% {
    width: 72px;
    height: 72px;
    opacity: 0;
  }
}
.beat-pulse-ring {
  animation: beat-ring var(--pulse-period, 1s) ease-out infinite;
}

.expand-enter-active,
.expand-leave-active {
  transition:
    opacity 0.3s ease,
    max-height 0.3s ease;
  max-height: 200px;
  overflow: hidden;
}
.expand-enter-from,
.expand-leave-to {
  opacity: 0;
  max-height: 0;
}
</style>
