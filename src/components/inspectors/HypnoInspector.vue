<script setup lang="ts">
import { useLocalStorage } from '@vueuse/core'
import { computed } from 'vue'
import HypnoOverlay from '~/components/player/HypnoOverlay.vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiPanel from '~/components/ui/UiPanel.vue'
import UiSection from '~/components/ui/UiSection.vue'
import UiSegmented from '~/components/ui/UiSegmented.vue'
import UiSlider from '~/components/ui/UiSlider.vue'
import UiSwitch from '~/components/ui/UiSwitch.vue'
import { parseWords } from '~/lib/hypno'
import { useAudioStore } from '~/stores/audio'
import { useHypnoStore } from '~/stores/hypnoStore'
import { useUiStore } from '~/stores/uiStore'

const hypno = useHypnoStore()
const ui = useUiStore()
const { isPlaying, pulseCpm, breathPeriod, breathInhaleRatio } = useAudioStore()

/** Double-click targets: the store's first-run values. */
const DEFAULT = {
  spiralOpacity: 0.18,
  spiralRate: 0.12,
  spiralArms: 3,
  wordEvery: 8,
  textSize: 48,
  textOpacity: 0.5,
  ringOpacity: 0.25,
  vignette: 0,
}

const pct = (v: number) => `${Math.round(v * 100)}%`

const openSpiral = useLocalStorage('ph:ui.hypno.spiralOpen', true)
const openWords = useLocalStorage('ph:ui.hypno.wordsOpen', false)
const openRing = useLocalStorage('ph:ui.hypno.ringOpen', false)
const openFrame = useLocalStorage('ph:ui.hypno.frameOpen', false)

const direction = computed({
  get: () => (hypno.spiralReverse ? 'ccw' : 'cw'),
  set: (v: 'cw' | 'ccw') => { hypno.spiralReverse = v === 'ccw' },
})
const DIRECTIONS = [
  { value: 'cw' as const, label: 'Clockwise', icon: 'i-carbon-rotate-clockwise' },
  { value: 'ccw' as const, label: 'Counter', icon: 'i-carbon-rotate-counterclockwise' },
]

const words = computed(() => parseWords(hypno.words))
const WORD_CHIPS = 14

/** Without the audio engine the overlay keeps its own 0.8 Hz clock. */
const pulseSource = computed(() => isPlaying.value
  ? `Turning with the session pulse · ${pulseCpm.value}/min`
  : 'Audio off — keeping its own 48/min clock')

const spiralSummary = computed(() => hypno.spiral ? `${pct(hypno.spiralOpacity)} · ${hypno.spiralArms} arm${hypno.spiralArms === 1 ? '' : 's'}` : 'off')
const wordsSummary = computed(() => hypno.text ? `${words.value.length} word${words.value.length === 1 ? '' : 's'} · every ${hypno.wordEvery}` : 'off')
const ringSummary = computed(() => hypno.ring ? `${(60 / breathPeriod.value).toFixed(1)}/min · ${pct(hypno.ringOpacity)}` : 'off')
const frameSummary = computed(() => hypno.vignette > 0 ? `vignette ${pct(hypno.vignette)}` : 'none')
</script>

<template>
  <UiPanel>
    <!-- ─── Hero: live preview and the master switch ──────────────────────── -->
    <section class="p-3 card flex flex-col gap-3">
      <!-- A shrunken stage. Black, because it stands in for video, where the
           overlay's own white-on-black is what you will actually see. -->
      <div
        class="preview rounded-[var(--radius-md)] aspect-video ring-1 ring-edge relative overflow-hidden"
        :class="hypno.enabled ? '' : 'is-off'"
      >
        <HypnoOverlay preview />
        <div class="left-2 top-2 absolute">
          <UiBadge :tone="hypno.enabled ? 'ok' : 'neutral'" size="xs" :dot="hypno.enabled" :pulse="hypno.enabled">
            {{ hypno.enabled ? 'On stage' : 'Preview' }}
          </UiBadge>
        </div>
      </div>

      <UiSwitch v-model="hypno.enabled" label="Overlay" :hint="pulseSource" />
      <p class="hint">
        Layers over whatever is playing and turns with the session pulse, so it
        keeps time with the audio and the device rather than drifting on its own.
      </p>
    </section>

    <!-- ─── Spiral ────────────────────────────────────────────────────────── -->
    <UiSection v-model:open="openSpiral" title="Spiral" icon="i-carbon-rotate-360" :summary="spiralSummary" collapsible>
      <template #actions>
        <UiSwitch v-model="hypno.spiral" size="sm" />
      </template>
      <div class="flex flex-col gap-3 transition-opacity" :class="hypno.spiral ? '' : 'opacity-45'" :inert="!hypno.spiral">
        <UiSlider v-model="hypno.spiralOpacity" label="Strength" :max="0.6" :format="pct" :reset="DEFAULT.spiralOpacity" />
        <UiSlider
          v-model="hypno.spiralRate"
          label="Speed"
          :min="0.01"
          :max="0.5"
          :format="v => `${v.toFixed(2)} turns/pulse`"
          :reset="DEFAULT.spiralRate"
        />
        <UiSlider v-model="hypno.spiralArms" label="Arms" :min="1" :max="6" :step="1" :reset="DEFAULT.spiralArms" />
        <UiSegmented v-model="direction" :options="DIRECTIONS" size="xs" block />
        <div class="flex flex-wrap gap-x-4 gap-y-2 items-center">
          <label class="swatch-row">
            <input v-model="hypno.spiralColor" type="color" class="swatch" aria-label="Spiral colour">
            <span>Colour</span>
          </label>
          <Transition name="t-fade">
            <label v-if="hypno.spiralTwoTone" class="swatch-row">
              <input v-model="hypno.spiralColor2" type="color" class="swatch" aria-label="Alternate arm colour">
              <span>Alternate arms</span>
            </label>
          </Transition>
          <div class="ml-auto">
            <UiSwitch v-model="hypno.spiralTwoTone" v-tip="'Alternate arms in a second colour'" size="sm">
              <span class="text-[12px] text-fg-muted">Two-tone</span>
            </UiSwitch>
          </div>
        </div>
      </div>
    </UiSection>

    <!-- ─── Words ─────────────────────────────────────────────────────────── -->
    <UiSection v-model:open="openWords" title="Words" icon="i-carbon-text-font" :summary="wordsSummary" collapsible>
      <template #actions>
        <UiSwitch v-model="hypno.text" size="sm" />
      </template>
      <div class="flex flex-col gap-3 transition-opacity" :class="hypno.text ? '' : 'opacity-45'" :inert="!hypno.text">
        <div class="flex flex-col gap-1.5">
          <textarea
            v-model="hypno.words"
            rows="4"
            spellcheck="false"
            class="words text-[12.5px] text-fg px-2.5 py-2 rounded-[var(--radius-md)] bg-surface-900 w-full resize-y ring-1 ring-edge transition-shadow placeholder:text-fg-faint focus:outline-none focus:ring-accent/60"
            placeholder="One per line, or comma separated"
          />
          <TransitionGroup v-if="words.length" name="t-list" tag="div" class="flex flex-wrap gap-1">
            <span
              v-for="(w, i) in words.slice(0, WORD_CHIPS)"
              :key="`${i}:${w}`"
              class="text-[11px] text-fg-muted px-1.5 rounded-[var(--radius-xs)] bg-fg/6 inline-flex h-5 max-w-full items-center"
            ><span class="truncate">{{ w }}</span></span>
            <span v-if="words.length > WORD_CHIPS" key="more" class="text-[11px] text-fg-faint px-1 inline-flex h-5 items-center">
              +{{ words.length - WORD_CHIPS }}
            </span>
          </TransitionGroup>
          <span v-else class="hint text-warn">No words yet — nothing will show.</span>
        </div>
        <UiSlider
          v-model="hypno.wordEvery"
          label="Hold each for"
          :min="1"
          :max="32"
          :step="1"
          :format="v => `${v} pulse${v === 1 ? '' : 's'}`"
          :reset="DEFAULT.wordEvery"
        />
        <div class="gap-3 grid grid-cols-2">
          <UiSlider v-model="hypno.textSize" label="Size" :min="16" :max="140" :step="2" unit="px" :reset="DEFAULT.textSize" />
          <UiSlider v-model="hypno.textOpacity" label="Strength" :format="pct" :reset="DEFAULT.textOpacity" />
        </div>
        <label class="swatch-row">
          <input v-model="hypno.textColor" type="color" class="swatch" aria-label="Word colour">
          <span>Colour</span>
        </label>
      </div>
    </UiSection>

    <!-- ─── Breathing ring ────────────────────────────────────────────────── -->
    <UiSection v-model:open="openRing" title="Breathing ring" icon="i-carbon-circle-dash" :summary="ringSummary" collapsible>
      <template #actions>
        <UiSwitch v-model="hypno.ring" size="sm" />
      </template>
      <div class="flex flex-col gap-3 transition-opacity" :class="hypno.ring ? '' : 'opacity-45'" :inert="!hypno.ring">
        <div class="px-2.5 py-2 well flex gap-2 items-center">
          <span class="i-carbon-rain-drop text-info shrink-0" />
          <span class="text-[11.5px] text-fg-muted flex-1 min-w-0">
            Breathes at <span class="text-fg num">{{ (60 / breathPeriod).toFixed(1) }}/min</span>,
            <span class="num">{{ Math.round(breathInhaleRatio * 100) }}/{{ 100 - Math.round(breathInhaleRatio * 100) }}</span> in/out
          </span>
          <UiButton v-tip="'Breath pacing lives in the Binaural panel'" size="xs" variant="ghost" icon-right="i-carbon-arrow-right" @click="ui.openInspector('binaural')">
            Change
          </UiButton>
        </div>
        <UiSlider v-model="hypno.ringOpacity" label="Strength" :max="0.8" :format="pct" :reset="DEFAULT.ringOpacity" />
        <label class="swatch-row">
          <input v-model="hypno.ringColor" type="color" class="swatch" aria-label="Ring colour">
          <span>Colour</span>
        </label>
      </div>
    </UiSection>

    <!-- ─── Framing ───────────────────────────────────────────────────────── -->
    <UiSection v-model:open="openFrame" title="Framing" icon="i-carbon-center-square" :summary="frameSummary" collapsible>
      <UiSlider
        v-model="hypno.vignette"
        label="Vignette"
        :max="0.9"
        :format="v => v > 0 ? pct(v) : 'Off'"
        :reset="DEFAULT.vignette"
        hint="Darkens the edges so attention falls to the middle."
      />
    </UiSection>
  </UiPanel>
</template>

<style scoped>
.preview {
  /* Stands in for a dim video frame. Fixed, not themed: the overlay is drawn over video. */
  background:
    radial-gradient(ellipse at 50% 40%, rgba(255, 255, 255, 0.06), transparent 60%),
    linear-gradient(160deg, #15151b, #050507);
  transition: filter var(--dur-slow) var(--ease-out);
}
.preview.is-off {
  filter: saturate(0.4) brightness(0.75);
}

.swatch-row {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-muted);
  cursor: pointer;
}

/* Native colour inputs are chrome-heavy; trim them to a swatch. */
.swatch {
  width: 28px;
  height: 22px;
  padding: 0;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: transparent;
  cursor: pointer;
  flex-shrink: 0;
  transition: transform var(--dur-fast) var(--ease-out);
}
.swatch:hover {
  transform: scale(1.06);
}
.swatch:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent) 60%, transparent);
  outline-offset: 1px;
}
.swatch::-webkit-color-swatch-wrapper {
  padding: 2px;
}
.swatch::-webkit-color-swatch {
  border: none;
  border-radius: 4px;
}
.swatch::-moz-color-swatch {
  border: none;
  border-radius: 4px;
}

.words {
  font-family: inherit;
  line-height: 1.5;
}
</style>
