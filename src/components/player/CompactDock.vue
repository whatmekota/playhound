<script setup lang="ts">
import { useLocalStorage } from '@vueuse/core'
import { computed, ref, watch } from 'vue'
import MobileSheet from '~/components/shell/MobileSheet.vue'
import UiSlider from '~/components/ui/UiSlider.vue'
import { playerChrome } from '~/composables/playerChrome'
import { useAutoDirector } from '~/composables/useAutoDirector'
import { useRailLayout } from '~/composables/useCompactLayout'
import { useScriptAnalysis } from '~/composables/useScriptAnalysis'
import { useSessionActions } from '~/composables/useSessionActions'
import { useSmoothPlayhead } from '~/composables/useSmoothPlayhead'
import { isAndroidApp } from '~/lib/android/detect'
import { chapterAt, chaptersForScript, nextChapter, prevChapter } from '~/lib/chapters'
import { KEYS } from '~/lib/persist'
import { ensureThumb } from '~/lib/thumbs'
import { formatTime } from '~/lib/time'
import { useLibraryStore } from '~/stores/libraryStore'
import { usePlaybackStore } from '~/stores/playbackStore'
import { usePlayerStore } from '~/stores/playerStore'
import { useQueueStore } from '~/stores/queueStore'
import { useScriptStore } from '~/stores/scriptStore'
import { useSessionControlStore } from '~/stores/sessionControlStore'
import { useSubtitleStore } from '~/stores/subtitleStore'
import { useUiStore } from '~/stores/uiStore'
import FunscriptTimeline from './FunscriptTimeline.vue'
import LoopControls from './LoopControls.vue'
import PlayPauseIcon from './PlayPauseIcon.vue'
import ScriptOffsetControl from './ScriptOffsetControl.vue'
import SpeedControl from './SpeedControl.vue'
import VrControls from './VrControls.vue'

/**
 * The player bar in the phone layout (useCompactLayout), in place of the
 * desktop dock (NowPlayingBar), which keeps everything on one wide row.
 *
 * - Upright, on the player: the timeline across the full width with the time
 *   gone and left under it, then one row: Edge, previous / play / next,
 *   fullscreen and "…". Everything else (chapters, peaks, subtitles, volume,
 *   queue, speed, loop…) is in the "…" sheet; phones have volume buttons.
 * - Sideways (the rail layout): one row over the bottom of the video that
 *   fades with the player's own controls while it plays.
 * - Over another view: what is playing, with play and next.
 *
 * Every target is at least 44 px.
 */
const ui = useUiStore()
const player = usePlayerStore()
const playback = usePlaybackStore()
const queue = useQueueStore()
const scripts = useScriptStore()
const library = useLibraryStore()
const control = useSessionControlStore()
const subs = useSubtitleStore()
const session = useSessionActions()
const director = useAutoDirector()
const rail = useRailLayout()

const heatmap = useLocalStorage(KEYS.timelineHeatmap.key, true)
const hasTrack = computed(() => !!player.videoUrl)
const canNext = computed(() => !!playback.takeover || queue.hasNext || director.enabled.value)
const title = computed(() => {
  if (playback.currentEntry)
    return playback.currentEntry.basename
  const name = player.videoPath?.split(/[\\/]/).pop() ?? ''
  return name.replace(/\.[^.]+$/, '')
})

const elapsed = computed(() => formatTime(player.currentTime, '0:00'))
const remaining = computed(() => `-${formatTime(Math.max(0, player.videoDuration - player.currentTime), '0:00')}`)

/** The "…" sheet: everything that is not the transport. */
const sheet = ref(false)
/** Sideways on the player, the bar lies over the video and fades with its controls. */
const overlay = computed(() => (rail.value || player.isFullscreen) && ui.onPlayer && hasTrack.value)
const faded = computed(() => overlay.value && !playerChrome.shown && !sheet.value)

// ─── Thumbnail (over other views) ────────────────────────────────────────────
const thumb = ref<string | null>(null)
watch(() => [playback.trackSeq, playback.currentEntry?.thumbnailUrl] as const, () => {
  const e = playback.currentEntry
  thumb.value = e?.thumbnailUrl ?? null
  if (e && !e.thumbnailUrl)
    void ensureThumb(e).catch(() => {})
}, { immediate: true })

// ─── Slim progress (over other views) ────────────────────────────────────────
const progressEl = ref<HTMLElement | null>(null)
const { redraw } = useSmoothPlayhead((t) => {
  const d = player.videoDuration
  progressEl.value?.style.setProperty('--p', String(d > 0 ? Math.min(1, t / d) : 0))
})
watch(progressEl, el => el && redraw())

// ─── Edge ────────────────────────────────────────────────────────────────────
const edgeLive = computed(() => control.phase !== 'idle')
const holding = computed(() => control.phase === 'falling' || control.phase === 'holding')
const edgeCountdown = computed(() => formatTime(Math.ceil(holding.value
  ? Math.max(0, control.remainingSec - control.settings.rebuildSec)
  : control.remainingSec), '0:00'))

// ─── Chapters ────────────────────────────────────────────────────────────────
const { analysis, source } = useScriptAnalysis()
const chapters = computed(() => chaptersForScript(source.value, player.videoDuration, analysis.value?.peaks, playback.scriptMetadata))
const currentChapter = computed(() =>
  chapters.value.length > 1 ? chapterAt(chapters.value, player.currentTime * 1000) : null)

function skipChapter(dir: -1 | 1) {
  const ms = player.currentTime * 1000
  const c = dir > 0 ? nextChapter(chapters.value, ms) : prevChapter(chapters.value, ms)
  if (c)
    playback.seek(c.start / 1000)
}

// ─── The "…" sheet ───────────────────────────────────────────────────────────
// Opening a panel or another view from the sheet closes it.
watch(() => [ui.inspector, ui.view, ui.settingsOpen] as const, () => (sheet.value = false))

function openPanel(id: 'queue' | 'scripts' | 'device' | 'motion' | 'bookmarks') {
  sheet.value = false
  if (ui.pinned && ui.pinned !== id)
    ui.closeInspector(ui.pinned)
  ui.openInspector(id)
}

const knob = computed({
  get: () => control.intensityScale,
  set: (v: number) => control.setIntensityScale(v),
})
const volume = computed({
  get: () => (player.isMuted ? 0 : player.volume),
  set: (v: number) => playback.setVolume(v),
})

/** A pop-out window needs Document Picture-in-Picture or Electron; the Android WebView has neither. */
const canPopOut = !isAndroidApp

function toggleStar() {
  if (playback.currentEntry)
    library.toggleStar(playback.currentEntry)
}
</script>

<template>
  <footer
    v-if="hasTrack"
    class="cd-dock border-t border-edge bg-surface-900 shrink-0 z-30"
    :class="[overlay ? 'is-overlay' : 'relative', faded ? 'is-faded' : '']"
    @pointerdown="playerChrome.poke()"
  >
    <!-- ═══ Over another view: what is playing ═══ -->
    <template v-if="!ui.onPlayer">
      <div ref="progressEl" class="bg-fg/10 h-[2px] inset-x-0 top-0 absolute" aria-hidden="true">
        <div class="cd-fill bg-accent h-full w-full origin-left" />
      </div>
      <div class="pl-2 pr-1 flex gap-2 h-[60px] items-center">
        <button type="button" class="text-left flex flex-1 gap-2.5 h-full min-w-0 items-center" :aria-label="`Open the player: ${title}`" @click="ui.openView('player')">
          <span class="rounded-[var(--radius-sm)] bg-surface-800 shrink-0 h-[36px] w-[64px] ring-1 ring-edge relative overflow-hidden">
            <img v-if="thumb" :src="thumb" alt="" class="h-full w-full inset-0 absolute object-cover">
            <span v-else :class="player.audioOnly ? 'i-carbon-music' : 'i-carbon-video'" class="text-[16px] text-fg-faint left-1/2 top-1/2 absolute -translate-x-1/2 -translate-y-1/2" />
          </span>
          <span class="min-w-0">
            <span class="text-[13px] text-fg leading-tight font-medium block truncate">{{ title }}</span>
            <span class="text-[11.5px] text-fg-faint num mt-0.5 block">{{ elapsed }} / {{ formatTime(player.videoDuration, '0:00') }}</span>
          </span>
        </button>
        <button type="button" class="cd-btn cd-play" :aria-label="player.isPlaying ? 'Pause' : 'Play'" @click="playback.togglePlay()">
          <PlayPauseIcon :playing="player.isPlaying" />
        </button>
        <button type="button" class="cd-btn" aria-label="Next" :disabled="!canNext" @click="playback.next()">
          <span class="i-carbon-skip-forward-filled" />
        </button>
      </div>
    </template>

    <!-- ═══ On the player ═══ -->
    <template v-else>
      <!-- Upright: the timeline on a row of its own, the times under it -->
      <div v-if="!rail" class="px-3 pt-2.5">
        <FunscriptTimeline class="h-10" :heatmap="heatmap" />
        <div class="text-[12px] mt-1 flex gap-2 items-center justify-between">
          <span class="text-fg num shrink-0">{{ elapsed }}</span>
          <span v-if="currentChapter" class="text-[11.5px] text-fg-muted text-center min-w-0 truncate">{{ currentChapter.name }}</span>
          <span class="text-fg-muted num shrink-0">{{ remaining }}</span>
        </div>
      </div>

      <div class="cd-row" :class="rail ? 'is-one-row' : ''">
        <!-- Edge: a button of its own; while one runs, its countdown -->
        <div class="cd-side justify-start">
          <button
            type="button"
            class="cd-edge"
            :class="edgeLive ? 'is-live' : ''"
            :aria-label="edgeLive ? `Edge running, ${edgeCountdown} left. Tap if still close` : 'Edge: back everything off'"
            @click="session.edge('ui')"
          >
            <span class="i-carbon-temperature-hot text-[17px] shrink-0" />
            <span v-if="edgeLive" class="num">{{ edgeCountdown }}</span>
            <span v-else>Edge</span>
          </button>
        </div>

        <div class="flex shrink-0 gap-1 items-center">
          <button type="button" class="cd-btn" aria-label="Previous" @click="playback.prev()">
            <span class="i-carbon-skip-back-filled" />
          </button>
          <button type="button" class="cd-btn cd-play is-big" :aria-label="player.isPlaying ? 'Pause' : 'Play'" @click="playback.togglePlay()">
            <PlayPauseIcon :playing="player.isPlaying" />
          </button>
          <button type="button" class="cd-btn" aria-label="Next" :disabled="!canNext" @click="playback.next()">
            <span class="i-carbon-skip-forward-filled" />
          </button>
        </div>

        <!-- Sideways: the timeline between the transport and the rest -->
        <div v-if="rail" class="flex flex-1 gap-2 min-w-0 items-center">
          <span class="text-[12px] text-fg num shrink-0">{{ elapsed }}</span>
          <FunscriptTimeline class="flex-1 h-9 min-w-0" :heatmap="heatmap" />
          <span class="text-[12px] text-fg-muted num shrink-0">{{ remaining }}</span>
        </div>

        <div class="cd-side justify-end">
          <button type="button" class="cd-btn" :aria-label="player.isFullscreen ? 'Exit fullscreen' : 'Fullscreen'" @click="playback.toggleFullscreen()">
            <span :class="player.isFullscreen ? 'i-carbon-minimize' : 'i-carbon-maximize'" />
          </button>
          <button type="button" class="cd-btn" :class="sheet ? 'is-on' : ''" aria-label="More controls" :aria-expanded="sheet" @click="sheet = !sheet">
            <span class="i-carbon-overflow-menu-horizontal" />
          </button>
        </div>
      </div>
    </template>
  </footer>

  <MobileSheet v-model:open="sheet" label="Player controls">
    <!-- One column upright; two side by side when the phone is held sideways. -->
    <div class="cd-sheet">
      <div class="cd-col">
        <!-- What is playing -->
        <div class="flex gap-2 min-w-0 items-center">
          <div class="flex-1 min-w-0">
            <p class="text-[14px] text-fg font-medium truncate">
              {{ title }}
            </p>
            <p class="text-[12px] text-fg-faint num">
              {{ elapsed }} / {{ formatTime(player.videoDuration, '0:00') }}
              <template v-if="scripts.activeScripts.length">
                · {{ [...new Set(scripts.activeScripts.map(s => s.channel))].join(' · ') }}
              </template>
            </p>
          </div>
          <button
            v-if="playback.currentEntry"
            type="button"
            class="cd-btn"
            :class="playback.currentEntry.starred ? '!text-warn' : ''"
            :aria-label="playback.currentEntry.starred ? 'Unstar' : 'Star'"
            @click="toggleStar"
          >
            <span :class="playback.currentEntry.starred ? 'i-carbon-star-filled' : 'i-carbon-star'" />
          </button>
        </div>

        <!-- Chapters -->
        <section v-if="chapters.length > 1" class="flex flex-col gap-1.5">
          <span class="eyebrow">Chapters</span>
          <div class="flex gap-1 items-center">
            <button type="button" class="cd-btn" aria-label="Previous chapter" @click="skipChapter(-1)">
              <span class="i-carbon-skip-back-outline" />
            </button>
            <span class="text-[13px] text-fg text-center flex-1 min-w-0 truncate">
              {{ currentChapter?.name ?? 'Chapters' }}
              <span v-if="currentChapter" class="text-fg-faint num">{{ currentChapter.index + 1 }}/{{ chapters.length }}</span>
            </span>
            <button type="button" class="cd-btn" aria-label="Next chapter" @click="skipChapter(1)">
              <span class="i-carbon-skip-forward-outline" />
            </button>
          </div>
          <div class="cd-chapters flex flex-col gap-0.5">
            <button
              v-for="c in chapters"
              :key="c.index"
              type="button"
              class="text-[13px] px-2 text-left rounded-[var(--radius-sm)] flex shrink-0 gap-2 h-11 items-center"
              :class="c === currentChapter ? 'bg-accent-soft text-accent-300' : 'text-fg'"
              @click="playback.seek(c.start / 1000)"
            >
              <span class="flex-1 truncate">{{ c.name }}</span>
              <span class="text-[11.5px] text-fg-faint num">{{ formatTime(c.start / 1000) }}</span>
            </button>
          </div>
        </section>

        <!-- Session and panels -->
        <section class="flex flex-col gap-2">
          <span class="eyebrow">Session</span>
          <div class="mobile-grid">
            <button type="button" class="mobile-tile" @click="session.nextPeak()">
              <span class="i-carbon-fire text-[22px]" />
              <span class="text-[11.5px] leading-tight">Next peak</span>
            </button>
            <button type="button" class="mobile-tile" @click="session.finish()">
              <span class="i-carbon-flag-filled text-[22px]" />
              <span class="text-[11.5px] leading-tight">Finish</span>
            </button>
            <button type="button" class="mobile-tile" @click="session.came()">
              <span class="i-carbon-rain-drop text-[22px]" />
              <span class="text-[11.5px] leading-tight">I came</span>
            </button>
            <button v-if="holding" type="button" class="mobile-tile text-ok" @click="session.release()">
              <span class="i-carbon-checkmark text-[22px]" />
              <span class="text-[11.5px] leading-tight">I'm OK</span>
            </button>
          </div>
          <UiSlider v-model="knob" label="Intensity" :min="0.1" :max="1" :step="0.05" :reset="1" :format="v => `${Math.round(v * 100)}%`" />
        </section>
      </div>

      <div class="cd-col">
        <section class="flex flex-col gap-2">
          <span class="eyebrow">Playback</span>
          <div class="mobile-grid">
            <button type="button" class="mobile-tile" :class="queue.shuffle ? 'text-accent-300 bg-accent-soft' : ''" @click="playback.toggleShuffle()">
              <span class="i-carbon-shuffle text-[22px]" />
              <span class="text-[11.5px] leading-tight">Shuffle</span>
            </button>
            <button type="button" class="mobile-tile" :class="queue.repeatMode !== 'off' ? 'text-accent-300 bg-accent-soft' : ''" @click="playback.cycleRepeat()">
              <span :class="queue.repeatMode === 'one' ? 'i-carbon-repeat-one' : 'i-carbon-repeat'" class="text-[22px]" />
              <span class="text-[11.5px] leading-tight">Repeat {{ queue.repeatMode === 'off' ? 'off' : queue.repeatMode }}</span>
            </button>
            <button type="button" class="mobile-tile" :class="heatmap ? 'text-accent-300 bg-accent-soft' : ''" @click="heatmap = !heatmap">
              <span class="i-carbon-chart-histogram text-[22px]" />
              <span class="text-[11.5px] leading-tight">Heatmap</span>
            </button>
            <button type="button" class="mobile-tile" @click="openPanel('queue')">
              <span class="i-carbon-list-boxes text-[22px]" />
              <span class="text-[11.5px] leading-tight">Queue{{ queue.upcoming.length ? ` · ${queue.upcoming.length}` : '' }}</span>
            </button>
            <button type="button" class="mobile-tile" @click="openPanel('scripts')">
              <span class="i-carbon-chart-line-data text-[22px]" />
              <span class="text-[11.5px] leading-tight">Scripts</span>
            </button>
            <button type="button" class="mobile-tile" @click="openPanel('bookmarks')">
              <span class="i-carbon-bookmark text-[22px]" />
              <span class="text-[11.5px] leading-tight">Marks</span>
            </button>
            <button v-if="canPopOut" type="button" class="mobile-tile" @click="sheet = false; playback.togglePopout()">
              <span class="i-carbon-popup text-[22px]" />
              <span class="text-[11.5px] leading-tight">Pop out</span>
            </button>
          </div>
        </section>

        <!-- Subtitles -->
        <section class="flex flex-col gap-1.5">
          <span class="eyebrow">Subtitles</span>
          <p v-if="!subs.tracks.length" class="hint">
            None for this video. A .srt or .vtt beside it, with the same name, is picked up.
          </p>
          <div v-else class="flex flex-wrap gap-1.5">
            <button type="button" class="cd-chip" :class="!subs.activeId ? 'is-on' : ''" @click="subs.select(null)">
              Off
            </button>
            <button v-for="t in subs.tracks" :key="t.id" type="button" class="cd-chip" :class="subs.activeId === t.id ? 'is-on' : ''" @click="subs.select(t.id)">
              {{ t.label }}
            </button>
          </div>
        </section>

        <!-- Volume: phones have buttons for it, so it lives here -->
        <section class="flex gap-2 items-center">
          <button type="button" class="cd-btn" :aria-label="player.isMuted ? 'Unmute' : 'Mute'" @click="playback.toggleMute()">
            <span :class="player.isMuted || player.volume === 0 ? 'i-carbon-volume-mute' : 'i-carbon-volume-up'" />
          </button>
          <UiSlider v-model="volume" class="flex-1" label="Volume" :class="player.isMuted ? 'opacity-50' : ''" :format="v => `${Math.round(v * 100)}%`" />
        </section>

        <div class="divider-y" />
        <SpeedControl inline />
        <div class="divider-y" />
        <LoopControls inline />
        <div class="divider-y" />
        <ScriptOffsetControl inline />
        <div class="divider-y" />
        <VrControls />
      </div>
    </div>
  </MobileSheet>
</template>

<style scoped>
.cd-sheet,
.cd-col {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}
/* Upright the chapter list scrolls on its own, so the rest stays in reach. */
.cd-chapters {
  max-height: 28vh;
  overflow-y: auto;
  overscroll-behavior: contain;
}
/* Sideways the sheet is wide and short: two columns, and the sheet itself
   scrolls, so nothing is cut off mid-item. */
:global(.ph-rail .cd-sheet) {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 24px;
  align-items: start;
}
:global(.ph-rail .cd-chapters) {
  max-height: none;
  overflow: visible;
}

.cd-dock {
  transition:
    opacity var(--dur) var(--ease-out),
    transform var(--dur) var(--ease-out);
}
/* Sideways on the player: over the bottom of the video, beside the rail. */
.cd-dock.is-overlay {
  position: fixed;
  left: var(--phone-rail-w, 0px);
  right: 0;
  bottom: 0;
  border-top-color: transparent;
  background: color-mix(in srgb, var(--bg-900) 82%, transparent);
  backdrop-filter: blur(14px);
}
.cd-dock.is-faded {
  opacity: 0;
  transform: translateY(12px);
  pointer-events: none;
}

.cd-row {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 64px;
  padding: 0 8px;
}
.cd-row.is-one-row {
  height: 60px;
  gap: 8px;
}
/* Upright: the transport stays centred whatever is either side of it. */
.cd-row:not(.is-one-row) > .cd-side {
  flex: 1 1 0;
}
.cd-side {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
}

.cd-btn {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 999px;
  font-size: 21px;
  color: var(--text-muted);
}
.cd-btn:active {
  background: color-mix(in srgb, var(--text) 9%, transparent);
}
.cd-btn:disabled {
  opacity: 0.35;
}
.cd-btn.is-on {
  color: var(--accent-light);
  background: var(--accent-soft);
}
.cd-play {
  color: var(--accent-contrast);
  background: var(--accent);
  font-size: 18px;
}
.cd-play :deep(svg) {
  width: 22px;
  height: 22px;
}
.cd-play.is-big {
  width: 52px;
  height: 52px;
  margin: 0 4px;
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.18) inset,
    0 6px 16px -6px var(--accent);
}
.cd-play.is-big :deep(svg) {
  width: 26px;
  height: 26px;
}

.cd-edge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 44px;
  padding: 0 14px 0 12px;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  color: var(--warn);
  background: color-mix(in srgb, var(--warn) 12%, transparent);
}
.cd-edge.is-live {
  background: color-mix(in srgb, var(--warn) 20%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--warn) 40%, transparent);
}
.cd-edge:active {
  background: color-mix(in srgb, var(--warn) 24%, transparent);
}

.cd-chip {
  height: 36px;
  padding: 0 14px;
  border-radius: 999px;
  font-size: 13px;
  color: var(--text-muted);
  background: color-mix(in srgb, var(--text) 6%, transparent);
}
.cd-chip.is-on {
  color: var(--accent-light);
  background: var(--accent-soft);
}

.cd-fill {
  transform: scaleX(var(--p, 0));
}
</style>
