<script setup lang="ts">
import { computed } from 'vue'
import { useAutoDirector } from '~/composables/useAutoDirector'
import { useAudioStore } from '~/stores/audio'
import { useLibraryStore } from '~/stores/libraryStore'

const director = useAutoDirector()
const library = useLibraryStore()
const audio = useAudioStore()

const scripted = computed(() => library.videos.filter(v => v.hasScript).length)
const ready = computed(() => director.readyCount())
const pending = computed(() => Math.max(0, scripted.value - ready.value))

const sweepPct = computed(() =>
  director.sweepTotal.value > 0
    ? Math.round((director.sweepDone.value / director.sweepTotal.value) * 100)
    : 0,
)

const nextUp = computed(() => director.pickNext()?.basename ?? null)
</script>

<template>
  <div class="flex flex-col h-full">
    <div class="p-3 space-y-4">
      <button
        class="text-xs font-medium px-3 py-2 rounded-lg flex gap-2 w-full transition-colors items-center justify-center"
        :class="director.enabled.value
          ? 'bg-teal-500/20 text-teal-300 hover:bg-teal-500/30'
          : 'bg-fg/5 text-fg-muted hover:bg-fg/10'"
        @click="director.enabled.value = !director.enabled.value"
      >
        <div :class="director.enabled.value ? 'i-carbon-pause-filled' : 'i-carbon-play-filled'" />
        {{ director.enabled.value ? 'Directing' : 'Off' }}
      </button>

      <p class="hint">
        Chooses the next video by matching a script's shape to where the session
        is — gentler scripts while it builds, busier ones at the peak — instead
        of shuffling blindly. Falls back to the queue when nothing suitable has
        been analysed.
      </p>

      <!-- Coverage -->
      <section class="p-2.5 panel space-y-2">
        <div class="flex items-baseline justify-between">
          <p class="label">
            Analysed
          </p>
          <p class="text-[11px] text-fg-muted font-mono">
            {{ ready }} / {{ scripted }}
          </p>
        </div>

        <div class="rounded-full bg-fg/10 h-1 overflow-hidden">
          <div
            class="bg-teal-400 h-full transition-all"
            :style="{ width: scripted ? `${(ready / scripted) * 100}%` : '0%' }"
          />
        </div>

        <p v-if="pending > 0" class="hint">
          {{ pending }} not analysed yet. They are analysed as you play them, or
          all at once below.
        </p>

        <button
          v-if="!director.sweeping.value"
          class="btn-subtle text-[11px] py-1.5 w-full"
          :disabled="pending === 0"
          @click="director.sweep()"
        >
          Analyse the rest
        </button>

        <div v-else class="space-y-1.5">
          <div class="text-[10px] text-fg-faint flex justify-between">
            <span>Analysing…</span>
            <span class="font-mono">{{ director.sweepDone.value }} / {{ director.sweepTotal.value }}</span>
          </div>
          <div class="rounded-full bg-fg/10 h-1 overflow-hidden">
            <div class="bg-accent-500 h-full transition-all" :style="{ width: `${sweepPct}%` }" />
          </div>
          <button class="btn-subtle text-[11px] py-1.5 w-full" @click="director.cancelSweep()">
            Stop
          </button>
        </div>
      </section>

      <!-- What it would pick now -->
      <section v-if="director.enabled.value" class="space-y-1.5">
        <p class="label">
          Next up
        </p>
        <p v-if="nextUp" class="text-xs text-fg-muted truncate" :title="nextUp">
          {{ nextUp }}
        </p>
        <p v-else class="hint">
          Nothing to choose from yet — analyse the library, or play a few
          scripted videos first.
        </p>
        <p class="hint">
          Matching against intensity {{ (audio.intensity.value * 100).toFixed(0) }}%.
        </p>
      </section>
    </div>
  </div>
</template>
