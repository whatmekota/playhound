<script setup lang="ts">
import { computed } from 'vue'
import { useSoundtrack } from '~/composables/useSoundtrack'

/**
 * The playing video's soundtrack analysis, and a funscript made from it.
 *
 * Shared by the Motion inspector (where the analysis drives the Music source)
 * and the Scripts inspector (where a video without a script can get one).
 */
const props = withDefaults(defineProps<{
  /** Show the analysis status row. */
  status?: boolean
  /** Show the button that makes a script, and the generated script's card. */
  make?: boolean
  /** Show the options that shape a generated script. */
  options?: boolean
}>(), { status: true, make: true, options: true })

const {
  current,
  analysis,
  canAnalyse,
  analyseCurrent,
  makeScript,
  saveScript,
  making,
  generated,
  generatedLoaded,
  scriptOptions,
} = useSoundtrack()

const pct = (v: number) => `${Math.round(v * 100)}%`

const busy = computed(() => current.value?.status === 'decoding' || current.value?.status === 'analysing')
const noBeat = computed(() => !!analysis.value && analysis.value.beats.length < 2)

const head = computed<{ tone: 'ok' | 'warn' | 'danger' | 'muted', title: string, detail: string }>(() => {
  const st = current.value
  if (!canAnalyse.value)
    return { tone: 'muted', title: 'Listening live', detail: 'Whole-track analysis needs a local video file' }
  switch (st?.status) {
    case 'decoding':
      return { tone: 'muted', title: 'Decoding the soundtrack…', detail: 'Reading the whole audio track' }
    case 'analysing':
      return { tone: 'muted', title: `Finding the beat… ${pct(st.progress)}`, detail: 'Tempo, beats, bars and loudness' }
    case 'failed':
      return { tone: 'danger', title: 'Could not analyse', detail: `${st.error ?? 'The analysis failed.'} Listening live instead.` }
    case 'ready': {
      const a = st.analysis!
      if (noBeat.value)
        return { tone: 'warn', title: 'No steady beat found', detail: 'Listening live instead' }
      const gaps = a.gaps.filter(g => g.start > 0 && g.end < a.duration).length
      return {
        tone: 'ok',
        title: `Analysed · ${Math.round(a.bpm)} bpm`,
        detail: `${a.beats.length.toLocaleString()} beats · ${pct(a.confidence)} sure${gaps ? ` · ${gaps} ${gaps === 1 ? 'break' : 'breaks'}` : ''}`,
      }
    }
    default:
      return { tone: 'muted', title: 'Listening live', detail: 'Analyse the whole track for a steady beat from the first second' }
  }
})

const TONE = { ok: 'text-ok', warn: 'text-warn', danger: 'text-danger', muted: 'text-fg-muted' }
</script>

<template>
  <div class="flex flex-col gap-3">
    <!-- Analysis status -->
    <div v-if="props.status" class="px-2.5 py-2 well flex flex-col gap-2">
      <div class="flex gap-2.5 items-center">
        <span
          class="text-[15px] shrink-0"
          :class="[busy ? 'i-carbon-renew animate-spin text-accent' : head.tone === 'ok' ? 'i-carbon-checkmark-filled' : head.tone === 'danger' ? 'i-carbon-warning-filled' : 'i-carbon-music', busy ? '' : TONE[head.tone]]"
        />
        <div class="flex flex-1 flex-col min-w-0">
          <span class="text-[12.5px] text-fg font-medium truncate">{{ head.title }}</span>
          <span v-tip="head.detail" class="hint truncate">{{ head.detail }}</span>
        </div>
        <UiButton
          v-if="canAnalyse && !busy && (!current || current.status === 'idle' || current.status === 'failed')"
          size="xs"
          :icon="current?.status === 'failed' ? 'i-carbon-renew' : 'i-carbon-analytics'"
          @click="analyseCurrent()"
        >
          {{ current?.status === 'failed' ? 'Retry' : 'Analyse soundtrack' }}
        </UiButton>
      </div>
      <Transition name="t-fade">
        <UiProgress v-if="busy" :value="current?.status === 'analysing' ? current.progress : undefined" />
      </Transition>
    </div>

    <!-- Generated script loaded -->
    <Transition v-if="props.make" name="t-fade" mode="out-in">
      <div v-if="generatedLoaded && generated" key="saved" class="px-2.5 py-2 rounded-[var(--radius-md)] bg-accent-soft flex flex-col gap-2 ring-1 ring-accent/25">
        <div class="flex gap-2 items-center">
          <span class="i-carbon-music text-[14px] text-accent-300 shrink-0" />
          <div class="flex flex-1 flex-col min-w-0">
            <span class="text-[12.5px] text-fg font-medium">Playing a generated script</span>
            <span v-tip="generated.filename" class="hint truncate">Made from the music, not by hand · {{ generated.filename }}</span>
          </div>
        </div>
        <div class="flex gap-2 items-center">
          <UiButton size="xs" variant="primary" icon="i-carbon-download" @click="saveScript">
            Save .funscript
          </UiButton>
          <UiButton size="xs" variant="ghost" icon="i-carbon-renew" :loading="making" @click="makeScript()">
            Remake
          </UiButton>
        </div>
        <p class="hint">
          Put the saved file next to the video, with the same name, and it loads by itself next time.
        </p>
      </div>

      <div v-else key="make" class="flex flex-col gap-2">
        <UiButton
          block
          icon="i-carbon-chart-line"
          :loading="making"
          :disabled="!canAnalyse || noBeat"
          @click="makeScript()"
        >
          {{ making && busy ? (current?.status === 'decoding' ? 'Decoding the soundtrack…' : 'Finding the beat…') : 'Make a script from the music' }}
        </UiButton>
        <UiProgress v-if="making && busy && !props.status" :value="current?.status === 'analysing' ? current.progress : undefined" />
      </div>
    </Transition>

    <div v-if="props.make && props.options" class="flex flex-col gap-3">
      <UiSlider
        v-model="scriptOptions.centreRange"
        label="Follow pitch"
        :min="0"
        :max="1"
        :step="0.05"
        :reset="0.5"
        :format="pct"
        hint="How far brighter passages lift the centre of the stroke in a generated script"
      />
      <UiSwitch v-model="scriptOptions.restInGaps" size="sm" label="Rest in breaks" hint="Hold still where the music has no beat" />
    </div>
  </div>
</template>
