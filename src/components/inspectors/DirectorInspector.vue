<script setup lang="ts">
import type { VideoEntry } from '~/stores/libraryStore'
import { useLocalStorage } from '@vueuse/core'
import { computed, ref, shallowRef, watch } from 'vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiEmpty from '~/components/ui/UiEmpty.vue'
import UiPanel from '~/components/ui/UiPanel.vue'
import UiProgress from '~/components/ui/UiProgress.vue'
import UiSection from '~/components/ui/UiSection.vue'
import UiStat from '~/components/ui/UiStat.vue'
import UiSwitch from '~/components/ui/UiSwitch.vue'
import { useAutoDirector } from '~/composables/useAutoDirector'
import { toast } from '~/composables/useToast'
import { speedToIntensity } from '~/lib/funscriptAnalysis'
import { thumbDb } from '~/lib/idb'
import { useAudioStore } from '~/stores/audio'
import { useLibraryStore } from '~/stores/libraryStore'
import { usePlaybackStore } from '~/stores/playbackStore'
import { useUiStore } from '~/stores/uiStore'

const director = useAutoDirector()
const { enabled, sweeping, sweepDone, sweepTotal, summaries } = director
const library = useLibraryStore()
const playback = usePlaybackStore()
const ui = useUiStore()
const { intensity, sessionActive, phase } = useAudioStore()

const openHow = useLocalStorage('ph:ui.director.howOpen', true)
const openCoverage = useLocalStorage('ph:ui.director.coverageOpen', true)

const pct = (v: number) => `${Math.round(v * 100)}%`

// ─── Coverage ───────────────────────────────────────────────────────────────

const scripted = computed(() => library.videos.filter(v => v.hasScript))
const ready = computed(() => director.readyCount())
const pending = computed(() => Math.max(0, scripted.value.length - ready.value))
const coverage = computed(() => scripted.value.length ? ready.value / scripted.value.length : 0)
const sweepPct = computed(() => sweepTotal.value > 0 ? sweepDone.value / sweepTotal.value : 0)

async function sweep() {
  await director.sweep()
  // A cancelled sweep stops short of its total; only a finished one is news.
  if (sweepTotal.value > 0 && sweepDone.value >= sweepTotal.value) {
    toast.success('Library analysed', {
      detail: `${sweepTotal.value} script${sweepTotal.value === 1 ? '' : 's'} ready to choose from`,
      icon: 'i-carbon-chart-evaluation',
      key: 'director-sweep',
    })
  }
}

// ─── The pick ───────────────────────────────────────────────────────────────

/**
 * pickNext() draws at random from a shortlist, so it cannot live in a computed
 * — the card would reshuffle on every intensity tick. Hold one pick and only
 * draw again when it goes stale: asked to, the session has moved on, or the
 * pick is now what is playing.
 */
const pick = shallowRef<VideoEntry | null>(null)
const pickThumb = ref<string | null>(null)
let pickedAt = -1

/** How far intensity can move before the shown pick no longer fits. */
const STALE_AFTER = 0.12

async function loadThumb(entry: VideoEntry) {
  if (entry.thumbnailUrl) {
    pickThumb.value = entry.thumbnailUrl
    return
  }
  pickThumb.value = null
  try {
    const cached = await thumbDb.get(entry.name)
    if (cached && pick.value?.name === entry.name) {
      entry.thumbnailUrl = cached
      pickThumb.value = cached
    }
  }
  catch {
    // no thumbnail yet; the placeholder is fine
  }
}

function repick() {
  pick.value = director.pickNext(playback.currentEntry?.name)
  pickedAt = intensity.value
  if (pick.value)
    void loadThumb(pick.value)
  else
    pickThumb.value = null
}

watch(
  [ready, () => playback.currentEntry?.name],
  ([, playing]) => {
    if (!pick.value || pick.value.name === playing)
      repick()
  },
  { immediate: true },
)

watch(intensity, (v) => {
  if (Math.abs(v - pickedAt) > STALE_AFTER)
    repick()
})

const pickSummary = computed(() => pick.value ? summaries.value[pick.value.name] ?? null : null)
const pickIntensity = computed(() => pickSummary.value ? speedToIntensity(pickSummary.value.meanSpeed) : null)

function duration(ms: number) {
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function playPick() {
  if (pick.value)
    playback.play(pick.value)
}

function queuePick() {
  if (pick.value)
    playback.playNextInQueue(pick.value)
}

// ─── How it picks: the library laid out by intensity ────────────────────────

const BINS = 24

/** Analysed scripts bucketed by the intensity they suit, with the shortlist marked. */
const histogram = computed(() => {
  const counts = Array.from({ length: BINS }, () => 0)
  const near = Array.from({ length: BINS }, () => false)
  const scored: { bin: number, delta: number }[] = []
  for (const v of scripted.value) {
    const s = summaries.value[v.name]
    if (!s)
      continue
    const i = speedToIntensity(s.meanSpeed)
    const bin = Math.min(BINS - 1, Math.floor(i * BINS))
    counts[bin]++
    scored.push({ bin, delta: Math.abs(i - intensity.value) })
  }
  // Same shortlist size the director draws from.
  scored.sort((a, b) => a.delta - b.delta).slice(0, 5).forEach(s => (near[s.bin] = true))
  const max = Math.max(1, ...counts)
  return counts.map((c, i) => ({ h: c / max, count: c, near: near[i] }))
})

const targetLabel = computed(() => sessionActive.value
  ? `${phase.value} phase · ${pct(intensity.value)}`
  : `no session · ${pct(intensity.value)}`)
</script>

<template>
  <UiPanel>
    <!-- ─── Hero: what it is, and the switch ──────────────────────────────── -->
    <section class="p-3 card flex flex-col gap-3">
      <div class="flex gap-3 items-start">
        <div
          class="text-[18px] rounded-[var(--radius-md)] center shrink-0 h-9 w-9 ring-1 transition-colors"
          :class="enabled ? 'bg-accent-soft text-accent-300 ring-accent/30' : 'bg-surface-800 text-fg-muted ring-edge'"
        >
          <span class="i-carbon-direction-fork" />
        </div>
        <div class="flex flex-1 flex-col gap-0.5 min-w-0">
          <span class="text-[13px] text-fg font-medium">Auto-director</span>
          <span class="hint">Chooses what plays next by matching a script's pace to where the session is.</span>
        </div>
        <UiSwitch v-model="enabled" />
      </div>
      <div class="flex gap-2 items-center">
        <UiBadge :tone="enabled ? 'ok' : 'neutral'" :dot="enabled" :pulse="enabled && sessionActive">
          {{ enabled ? 'Directing Next' : 'Off — Next follows the queue' }}
        </UiBadge>
        <span v-if="enabled" class="text-[11.5px] text-fg-faint num ml-auto">target {{ pct(intensity) }}</span>
      </div>
    </section>

    <!-- ─── Nothing to direct ─────────────────────────────────────────────── -->
    <section v-if="!library.hasVideos" class="card">
      <UiEmpty icon="i-carbon-folder" title="No library yet" description="Open a folder and the director can start choosing between your scripted videos." size="sm">
        <UiButton variant="primary" size="sm" icon="i-carbon-folder" @click="ui.openView('library')">
          Go to library
        </UiButton>
      </UiEmpty>
    </section>
    <section v-else-if="!scripted.length" class="card">
      <UiEmpty icon="i-carbon-chart-line-data" title="No scripted videos" description="The director picks by script shape, so it needs videos with a funscript beside them." size="sm" />
    </section>

    <template v-else>
      <!-- ─── Current pick ────────────────────────────────────────────────── -->
      <section class="p-3 card flex flex-col gap-2.5">
        <div class="flex items-center justify-between">
          <span class="eyebrow">{{ enabled ? 'Next up' : 'Would pick' }}</span>
          <UiButton
            v-if="pick"
            v-tip="'Draw again from the shortlist'"
            size="xs"
            variant="ghost"
            icon="i-carbon-shuffle"
            @click="repick"
          >
            Another
          </UiButton>
        </div>

        <Transition name="t-fade" mode="out-in">
          <div v-if="pick" :key="pick.name" class="flex flex-col gap-2.5">
            <div class="flex gap-3 min-w-0">
              <div class="rounded-[var(--radius-sm)] bg-surface-800 shrink-0 h-[63px] w-28 ring-1 ring-edge relative overflow-hidden">
                <img v-if="pickThumb" :src="pickThumb" alt="" class="h-full w-full animate-fade-in object-cover">
                <div v-else class="text-[20px] text-fg-faint center h-full">
                  <span class="i-carbon-video" />
                </div>
              </div>
              <div class="flex flex-1 flex-col gap-1 min-w-0">
                <span v-tip="pick.basename" class="title text-[13px] text-fg leading-snug font-medium">{{ pick.basename }}</span>
                <div v-if="pickSummary" class="text-[11px] text-fg-faint num flex flex-wrap gap-x-2">
                  <span>suits {{ pct(pickIntensity ?? 0) }}</span>
                  <span>{{ Math.round(pickSummary.meanSpm) }} spm</span>
                  <span>{{ duration(pickSummary.durationMs) }}</span>
                </div>
              </div>
            </div>
            <div class="flex gap-2">
              <UiButton variant="primary" size="sm" icon="i-carbon-play-filled-alt" class="flex-1" @click="playPick">
                Play it
              </UiButton>
              <UiButton size="sm" icon="i-carbon-list-boxes" @click="queuePick">
                Play next
              </UiButton>
            </div>
          </div>
          <p v-else class="hint">
            Nothing to choose from yet — analyse the library below, or play a few
            scripted videos; each one is analysed as it plays.
          </p>
        </Transition>
      </section>

      <!-- ─── Coverage ────────────────────────────────────────────────────── -->
      <UiSection
        v-model:open="openCoverage"
        title="Library analysis"
        icon="i-carbon-chart-evaluation"
        :summary="`${ready} / ${scripted.length}`"
        collapsible
        :live="sweeping"
      >
        <div class="flex gap-4 items-end">
          <UiStat label="Analysed" :value="ready" :unit="`of ${scripted.length}`" />
          <span class="text-[11.5px] text-fg-faint num mb-[15px] ml-auto">{{ pct(coverage) }}</span>
        </div>
        <UiProgress :value="coverage" :tone="pending ? 'accent' : 'ok'" />

        <Transition name="t-fade" mode="out-in">
          <div v-if="sweeping" key="sweeping" class="px-2.5 py-2 well flex flex-col gap-2">
            <div class="text-[11.5px] flex items-center justify-between">
              <span class="text-fg-muted flex gap-1.5 items-center">
                <span class="i-carbon-renew [animation:ph-spin_1.2s_linear_infinite]" />
                Analysing…
              </span>
              <span class="text-fg-faint num">{{ sweepDone }} / {{ sweepTotal }}</span>
            </div>
            <UiProgress :value="sweepPct" />
            <UiButton size="xs" variant="subtle" icon="i-carbon-stop-filled-alt" class="self-end" @click="director.cancelSweep()">
              Stop
            </UiButton>
          </div>
          <div v-else-if="pending > 0" key="pending" class="flex gap-2 items-center">
            <span class="hint flex-1">{{ pending }} not analysed yet. Each is analysed as it plays, or all at once here.</span>
            <UiButton size="sm" icon="i-carbon-chart-evaluation" @click="sweep">
              Analyse {{ pending }}
            </UiButton>
          </div>
          <p v-else key="done" class="hint text-ok flex gap-1.5 items-center">
            <span class="i-carbon-checkmark-outline" /> Every scripted video is analysed.
          </p>
        </Transition>
      </UiSection>

      <!-- ─── How it picks ────────────────────────────────────────────────── -->
      <UiSection v-model:open="openHow" title="How it picks" icon="i-carbon-idea" :summary="targetLabel" collapsible>
        <p class="hint">
          Each script's mean stroke speed maps to the session intensity it suits —
          gentle while the session builds, busy at the peak. It draws at random
          from the five closest so a session never becomes a loop, and falls
          back to the queue when nothing has been analysed.
        </p>

        <div v-if="ready" class="flex flex-col gap-1">
          <div class="hist flex gap-px h-14 items-end relative" aria-hidden="true">
            <span
              v-for="(b, i) in histogram"
              :key="i"
              class="rounded-t-[2px] flex-1 transition-[height,background-color] duration-300"
              :class="b.near ? 'bg-accent' : 'bg-surface-600'"
              :style="{ height: b.count ? `${Math.max(8, b.h * 100)}%` : '2px' }"
            />
            <span
              class="target bg-fg w-px bottom-0 top-0 absolute"
              :style="{ left: `${intensity * 100}%` }"
            />
          </div>
          <div class="text-[10.5px] text-fg-faint flex justify-between">
            <span>gentle</span>
            <span class="text-fg-muted flex gap-1.5 items-center">
              <span class="rounded-full bg-accent h-1.5 w-1.5" /> shortlist
              <span class="ml-1.5 bg-fg h-2.5 w-px" /> now
            </span>
            <span>busy</span>
          </div>
        </div>

        <div class="px-2.5 py-2 well flex gap-2 items-center">
          <span class="i-carbon-meter text-fg-muted shrink-0" />
          <span class="text-[11.5px] text-fg-muted flex-1">
            Target follows the session.
            <template v-if="!sessionActive">Start one in Binaural to make it move.</template>
          </span>
          <UiButton v-if="!sessionActive" size="xs" variant="ghost" icon-right="i-carbon-arrow-right" @click="ui.openInspector('binaural')">
            Open
          </UiButton>
        </div>
      </UiSection>
    </template>
  </UiPanel>
</template>

<style scoped>
.title {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}

.target {
  transition: left var(--dur-slow) var(--ease-out);
  box-shadow: 0 0 0 1px var(--bg-850);
}
</style>
