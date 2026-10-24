<script setup lang="ts">
import { useHypnoStore } from '~/stores/hypnoStore'

const hypno = useHypnoStore()
</script>

<template>
  <div class="flex flex-col h-full">
    <div class="p-3 space-y-4">
      <button
        class="text-xs font-medium px-3 py-2 rounded-lg flex gap-2 w-full transition-colors items-center justify-center"
        :class="hypno.enabled
          ? 'bg-teal-500/20 text-teal-300 hover:bg-teal-500/30'
          : 'bg-fg/5 text-fg-muted hover:bg-fg/10'"
        @click="hypno.enabled = !hypno.enabled"
      >
        <div :class="hypno.enabled ? 'i-carbon-view-filled' : 'i-carbon-view-off'" />
        {{ hypno.enabled ? 'Overlay on' : 'Overlay off' }}
      </button>

      <p class="hint">
        Layers over whatever is playing and turns with the session pulse, so it
        keeps time with the audio and the device rather than drifting on its own.
      </p>

      <!-- Spiral -->
      <section class="panel p-2.5 space-y-2.5">
        <div class="flex items-center justify-between">
          <p class="label">
            Spiral
          </p>
          <label class="text-[11px] text-fg-muted flex gap-1.5 cursor-pointer items-center">
            <input v-model="hypno.spiral" type="checkbox">
            On
          </label>
        </div>

        <div v-if="hypno.spiral" class="space-y-2.5">
          <div>
            <div class="text-[10px] text-fg-faint mb-1 flex justify-between">
              <span>Strength</span>
              <span class="font-mono">{{ (hypno.spiralOpacity * 100).toFixed(0) }}%</span>
            </div>
            <input v-model.number="hypno.spiralOpacity" type="range" min="0" max="0.6" step="0.01" class="accent w-full">
          </div>

          <div>
            <div class="text-[10px] text-fg-faint mb-1 flex justify-between">
              <span>Speed</span>
              <span class="font-mono">{{ hypno.spiralRate.toFixed(2) }}</span>
            </div>
            <input v-model.number="hypno.spiralRate" type="range" min="0.01" max="0.5" step="0.01" class="accent w-full">
          </div>

          <div>
            <div class="text-[10px] text-fg-faint mb-1 flex justify-between">
              <span>Arms</span>
              <span class="font-mono">{{ hypno.spiralArms }}</span>
            </div>
            <input v-model.number="hypno.spiralArms" type="range" min="1" max="6" step="1" class="accent w-full">
          </div>

          <label class="text-[11px] text-fg-muted flex gap-2 cursor-pointer items-center">
            <input v-model="hypno.spiralReverse" type="checkbox">
            Turn the other way
          </label>

          <div class="flex gap-2 items-center">
            <input v-model="hypno.spiralColor" type="color" class="swatch">
            <span class="text-[11px] text-fg-muted flex-1">Colour</span>
            <label class="text-[11px] text-fg-muted flex gap-1.5 cursor-pointer items-center">
              <input v-model="hypno.spiralTwoTone" type="checkbox">
              Two-tone
            </label>
          </div>
          <div v-if="hypno.spiralTwoTone" class="flex gap-2 items-center">
            <input v-model="hypno.spiralColor2" type="color" class="swatch">
            <span class="text-[11px] text-fg-muted">Alternating arms</span>
          </div>
        </div>
      </section>

      <!-- Text -->
      <section class="panel p-2.5 space-y-2.5">
        <div class="flex items-center justify-between">
          <p class="label">
            Words
          </p>
          <label class="text-[11px] text-fg-muted flex gap-1.5 cursor-pointer items-center">
            <input v-model="hypno.text" type="checkbox">
            On
          </label>
        </div>

        <div v-if="hypno.text" class="space-y-2.5">
          <textarea
            v-model="hypno.words"
            rows="4"
            class="input text-xs font-mono w-full resize-y"
            placeholder="One per line, or comma separated"
          />

          <div>
            <div class="text-[10px] text-fg-faint mb-1 flex justify-between">
              <span>Hold each for</span>
              <span class="font-mono">{{ hypno.wordEvery }} pulses</span>
            </div>
            <input v-model.number="hypno.wordEvery" type="range" min="1" max="32" step="1" class="accent w-full">
          </div>

          <div>
            <div class="text-[10px] text-fg-faint mb-1 flex justify-between">
              <span>Size</span>
              <span class="font-mono">{{ hypno.textSize }}px</span>
            </div>
            <input v-model.number="hypno.textSize" type="range" min="16" max="140" step="2" class="accent w-full">
          </div>

          <div>
            <div class="text-[10px] text-fg-faint mb-1 flex justify-between">
              <span>Strength</span>
              <span class="font-mono">{{ (hypno.textOpacity * 100).toFixed(0) }}%</span>
            </div>
            <input v-model.number="hypno.textOpacity" type="range" min="0" max="1" step="0.01" class="accent w-full">
          </div>

          <div class="flex gap-2 items-center">
            <input v-model="hypno.textColor" type="color" class="swatch">
            <span class="text-[11px] text-fg-muted">Colour</span>
          </div>
        </div>
      </section>

      <!-- Breathing ring -->
      <section class="panel p-2.5 space-y-2.5">
        <div class="flex items-center justify-between">
          <p class="label">
            Breathing ring
          </p>
          <label class="text-[11px] text-fg-muted flex gap-1.5 cursor-pointer items-center">
            <input v-model="hypno.ring" type="checkbox">
            On
          </label>
        </div>
        <p class="hint">
          Expands and contracts at the breath rate set in the Binaural panel,
          longer out than in.
        </p>
        <div v-if="hypno.ring">
          <div class="text-[10px] text-fg-faint mb-1 flex justify-between">
            <span>Strength</span>
            <span class="font-mono">{{ (hypno.ringOpacity * 100).toFixed(0) }}%</span>
          </div>
          <input v-model.number="hypno.ringOpacity" type="range" min="0" max="0.8" step="0.01" class="accent w-full">
          <div class="mt-2 flex gap-2 items-center">
            <input v-model="hypno.ringColor" type="color" class="swatch">
            <span class="text-[11px] text-fg-muted">Colour</span>
          </div>
        </div>
      </section>

      <!-- Vignette -->
      <section class="space-y-1.5">
        <div class="text-[10px] text-fg-faint mb-1 flex justify-between">
          <span class="label">Vignette</span>
          <span class="font-mono">{{ (hypno.vignette * 100).toFixed(0) }}%</span>
        </div>
        <input v-model.number="hypno.vignette" type="range" min="0" max="0.9" step="0.01" class="accent w-full">
        <p class="hint">
          Darkens the edges so attention falls to the middle.
        </p>
      </section>
    </div>
  </div>
</template>

<style scoped>
/* Native colour inputs are chrome-heavy; trim them to a swatch. */
.swatch {
  width: 26px;
  height: 20px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  flex-shrink: 0;
}
.swatch::-webkit-color-swatch-wrapper {
  padding: 2px;
}
.swatch::-webkit-color-swatch {
  border: none;
  border-radius: 4px;
}
</style>
