<script setup lang="ts">
import { useElementSize, useLocalStorage } from '@vueuse/core'
import { computed, defineComponent, h, ref, watch } from 'vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import UiIconButton from '~/components/ui/UiIconButton.vue'
import UiPopover from '~/components/ui/UiPopover.vue'
import UiSlider from '~/components/ui/UiSlider.vue'
import UiSpinner from '~/components/ui/UiSpinner.vue'
import UiSwitch from '~/components/ui/UiSwitch.vue'
import { useAutoDirector } from '~/composables/useAutoDirector'
import { useBinauralBeats } from '~/composables/useBinauralBeats'
import { useSmoothPlayhead } from '~/composables/useSmoothPlayhead'
import { ensureThumb } from '~/lib/thumbs'
import { formatTime } from '~/lib/time'
import { useAudioStore } from '~/stores/audio'
import { useDeviceStore } from '~/stores/deviceStore'
import { useLibraryStore } from '~/stores/libraryStore'
import { MOTION_SOURCES, useMotionStore } from '~/stores/motionStore'
import { usePlaybackStore } from '~/stores/playbackStore'
import { usePlayerStore } from '~/stores/playerStore'
import { useQueueStore } from '~/stores/queueStore'
import { useScriptStore } from '~/stores/scriptStore'
import { useUiStore } from '~/stores/uiStore'
import FunscriptTimeline from './FunscriptTimeline.vue'
import LoopControls from './LoopControls.vue'
import PlayPauseIcon from './PlayPauseIcon.vue'
import ScriptOffsetControl from './ScriptOffsetControl.vue'
import SpeedControl from './SpeedControl.vue'

/**
 * The dock: what is playing, the transport, and the session's vital signs.
 *
 * Always on screen, whichever view owns the stage. On the player view the
 * script timeline spans its top edge; elsewhere a slim progress line does.
 * The right side gives way as the window narrows: tools go into an overflow
 * menu first, then the status readouts, then the volume slider.
 */
const ui = useUiStore()
const player = usePlayerStore()
const playback = usePlaybackStore()
const queue = useQueueStore()
const scriptStore = useScriptStore()
const library = useLibraryStore()
const device = useDeviceStore()
const motion = useMotionStore()
const audio = useAudioStore()
const director = useAutoDirector()
const binaural = useBinauralBeats()

const heatmap = useLocalStorage('ph-timeline-heatmap', true)

const hasTrack = computed(() => !!player.videoUrl)
const title = computed(() => {
  if (playback.currentEntry)
    return playback.currentEntry.basename
  const name = player.videoPath?.split(/[\\/]/).pop() ?? ''
  return name.replace(/\.[^.]+$/, '')
})
const axes = computed(() => [...new Set(scriptStore.activeScripts.map(s => s.channel))])
const canNext = computed(() => queue.hasNext || director.enabled.value)

// Computed strings only notify when the text changes, so the dock re-renders
// once a second rather than on every timeupdate.
const timeText = computed(() => formatTime(player.currentTime, '0:00'))
const durationText = computed(() => formatTime(player.videoDuration, '0:00'))

// ─── Thumbnail ───────────────────────────────────────────────────────────────
const thumb = ref<string | null>(null)
watch(() => [playback.trackSeq, playback.currentEntry?.thumbnailUrl] as const, () => {
  const e = playback.currentEntry
  thumb.value = e?.thumbnailUrl ?? null
  // Lands in entry.thumbnailUrl, which this watch is already following.
  if (e && !e.thumbnailUrl)
    void ensureThumb(e).catch(() => {})
}, { immediate: true })

function toggleStar() {
  if (playback.currentEntry)
    library.toggleStar(playback.currentEntry)
}

// ─── Volume ──────────────────────────────────────────────────────────────────
const volumeModel = computed({
  get: () => (player.isMuted ? 0 : player.volume),
  set: (v: number) => playback.setVolume(v),
})
const volumeIcon = computed(() => {
  if (player.isMuted || player.volume === 0)
    return 'i-carbon-volume-mute'
  return player.volume < 0.5 ? 'i-carbon-volume-down' : 'i-carbon-volume-up'
})

function onVolumeWheel(e: WheelEvent) {
  e.preventDefault()
  const step = e.deltaY < 0 ? 0.05 : -0.05
  playback.setVolume(Math.round(Math.max(0, Math.min(1, player.volume + step)) * 100) / 100)
}

// ─── Status: device, motion, binaural ───────────────────────────────────────
const motionLabel = computed(() => {
  if (!motion.enabled)
    return 'Off'
  return MOTION_SOURCES.find(s => s.id === motion.source)?.label ?? motion.source
})

/* eslint-disable vue/one-component-per-file -- two tiny render-only readouts,
   kept here because they exist only to isolate re-renders from the dock. */
/**
 * Live stroke meter. Its own component so following the stroke position, which
 * moves every frame, re-renders these few bars rather than the whole dock.
 */
const MotionMeter = defineComponent({
  name: 'MotionMeter',
  setup() {
    const m = useMotionStore()
    return () => h('span', { 'class': 'flex gap-px h-3.5 w-10 items-end', 'aria-hidden': 'true' }, Array.from({ length: 9 }, (_, i) => {
      const d = Math.abs(i / 8 - m.currentPos)
      return h('span', {
        class: ['rounded-[1px] flex-1 transition-[height] duration-75', m.running ? 'bg-ok' : 'bg-fg/18'],
        style: { height: `${Math.max(0.18, 1 - d * 2.4) * 100}%` },
      })
    }))
  },
})

const MotionRate = defineComponent({
  name: 'MotionRate',
  setup() {
    const m = useMotionStore()
    return () => h('span', { class: 'num text-fg-muted' }, m.running ? `${m.currentSpm.toFixed(0)} spm` : '—')
  },
})

function toggleBinaural() {
  if (audio.isPlaying.value) {
    binaural.stop()
    audio.isPlaying.value = false
  }
  else {
    binaural.start(audio.baseFrequency.value, audio.beatDelta.value, audio.volume.value, audio.waveType.value)
    audio.isPlaying.value = true
  }
}

const binauralLabel = computed(() => `${audio.baseFrequency.value} Hz · Δ${audio.beatDelta.value.toFixed(1)}`)

// ─── Slim progress (off the player view) ────────────────────────────────────
const scrubEl = ref<HTMLElement | null>(null)
const scrubHover = ref(false)
const scrubX = ref(0)
const scrubbing = ref(false)
const scrubW = useElementSize(scrubEl).width

const { redraw: redrawScrub } = useSmoothPlayhead((t) => {
  if (scrubbing.value)
    return
  const d = player.videoDuration
  scrubEl.value?.style.setProperty('--p', String(d > 0 ? Math.min(1, t / d) : 0))
})
watch(scrubEl, el => el && redrawScrub())

function scrubFraction(clientX: number) {
  const r = scrubEl.value?.getBoundingClientRect()
  return r && r.width ? Math.max(0, Math.min(1, (clientX - r.left) / r.width)) : 0
}

let seekRaf = 0
let pendingSeek = 0
function scrubTo(clientX: number) {
  const f = scrubFraction(clientX)
  scrubEl.value?.style.setProperty('--p', String(f))
  pendingSeek = f * player.videoDuration
  if (seekRaf)
    return
  seekRaf = requestAnimationFrame(() => {
    seekRaf = 0
    playback.seek(pendingSeek)
  })
}

function onScrubDown(e: PointerEvent) {
  if (e.button !== 0 || player.videoDuration <= 0)
    return
  scrubEl.value?.setPointerCapture(e.pointerId)
  scrubbing.value = true
  scrubTo(e.clientX)
}
function onScrubMove(e: PointerEvent) {
  const r = scrubEl.value?.getBoundingClientRect()
  if (r)
    scrubX.value = Math.max(0, Math.min(r.width, e.clientX - r.left))
  if (scrubbing.value)
    scrubTo(e.clientX)
}
function onScrubUp(e: PointerEvent) {
  if (scrubEl.value?.hasPointerCapture(e.pointerId))
    scrubEl.value.releasePointerCapture(e.pointerId)
  setTimeout(() => (scrubbing.value = false), 120)
}
const scrubHoverTime = computed(() => (scrubW.value ? (scrubX.value / scrubW.value) * player.videoDuration : 0))

// ─── Responsive right side ───────────────────────────────────────────────────
/**
 * How much the right side can show, from the room it actually has. Tools
 * (speed, loop, offset, 180°) fold away first, then the status readouts,
 * then the volume slider and the shuffle/repeat toggles.
 */
const rightEl = ref<HTMLElement | null>(null)
const rightW = useElementSize(rightEl).width
const level = computed(() => {
  const w = rightW.value
  if (!w)
    return 0
  if (w >= 620)
    return 0
  if (w >= 450)
    return 1
  if (w >= 230)
    return 2
  return 3
})
const showTools = computed(() => level.value === 0)
const showStatus = computed(() => level.value <= 1)
const showVolumeSlider = computed(() => level.value <= 2)
const showModes = computed(() => level.value <= 2)
const needsOverflow = computed(() => level.value > 0)
</script>

<template>
  <footer class="np-dock border-t border-edge bg-surface-900 shrink-0 relative z-30">
    <!-- Slim progress along the top edge, off the player view -->
    <div
      v-if="!ui.onPlayer && hasTrack"
      ref="scrubEl"
      class="group/scrub h-3 cursor-pointer inset-x-0 absolute z-1 -top-1.5"
      role="slider"
      aria-label="Seek"
      :aria-valuemin="0"
      :aria-valuemax="Math.round(player.videoDuration)"
      :aria-valuetext="`${timeText} of ${durationText}`"
      @pointerdown="onScrubDown"
      @pointermove="onScrubMove"
      @pointerup="onScrubUp"
      @pointercancel="onScrubUp"
      @pointerenter="scrubHover = true"
      @pointerleave="scrubHover = false"
    >
      <div class="bg-fg/10 h-[2px] transition-[height] duration-150 inset-x-0 top-1/2 absolute group-hover/scrub:h-1.5 -translate-y-1/2">
        <div v-if="scrubHover" class="bg-fg/12 inset-y-0 left-0 absolute" :style="{ width: `${scrubX}px` }" />
        <div class="np-fill bg-accent h-full w-full origin-left inset-y-0 left-0 absolute" />
      </div>
      <span class="np-knob rounded-full bg-fg opacity-0 h-3 w-3 shadow-[var(--shadow-md)] transition-opacity top-1/2 absolute group-hover/scrub:opacity-100 -translate-x-1/2 -translate-y-1/2" />
      <Transition name="t-fade">
        <span
          v-if="scrubHover && player.videoDuration > 0"
          class="text-[11px] text-fg font-medium num px-1.5 py-0.5 rounded-[var(--radius-xs)] bg-surface-700 pointer-events-none shadow-[var(--shadow-md)] absolute -translate-x-1/2 -top-6"
          :style="{ left: `${Math.max(24, Math.min(scrubW - 24, scrubX))}px` }"
        >{{ formatTime(scrubHoverTime, '0:00') }}</span>
      </Transition>
    </div>

    <!-- Script timeline across the top, on the player view -->
    <Transition name="t-collapse">
      <div v-if="ui.onPlayer && hasTrack" class="np-tl">
        <div class="np-tl-inner min-h-0">
          <div class="px-4 pt-2.5 flex gap-2 items-center">
            <FunscriptTimeline class="flex-1 h-11" :heatmap="heatmap" />
            <UiIconButton
              icon="i-carbon-chart-histogram"
              label="Speed heatmap on the timeline"
              size="xs"
              :active="heatmap"
              @click="heatmap = !heatmap"
            />
          </div>
        </div>
      </div>
    </Transition>

    <div class="px-4 gap-4 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1.4fr)] h-[var(--dock-h)] items-center">
      <!-- ═══ Now playing ═══ -->
      <div class="flex gap-2 min-w-0 items-center">
        <template v-if="hasTrack">
          <button
            type="button"
            class="group/np p-1 text-left focusable rounded-[var(--radius-md)] flex gap-3 min-w-0 transition-colors items-center -m-1"
            :class="ui.onPlayer ? 'cursor-default' : 'hover:bg-fg/5'"
            :aria-label="ui.onPlayer ? title : `Open the player: ${title}`"
            @click="ui.openView('player')"
          >
            <div
              v-if="level < 3"
              class="rounded-[var(--radius-sm)] bg-surface-800 shrink-0 h-[46px] w-[82px] ring-1 ring-edge relative overflow-hidden"
            >
              <Transition name="t-fade">
                <img v-if="thumb" :key="thumb" :src="thumb" alt="" class="h-full w-full inset-0 absolute object-cover">
              </Transition>
              <span v-if="!thumb" class="i-carbon-video text-[18px] text-fg-faint left-1/2 top-1/2 absolute -translate-x-1/2 -translate-y-1/2" />
              <!-- Equaliser while playing -->
              <span v-if="player.isPlaying && !playback.loading" class="p-0.5 rounded-[3px] bg-black/55 flex gap-[2px] h-3.5 items-end bottom-1 left-1 absolute">
                <span v-for="i in 3" :key="i" class="np-eq rounded-[1px] bg-white h-full w-[2px] origin-bottom" :style="{ animationDelay: `${i * -0.27}s` }" />
              </span>
              <span v-if="playback.loading" class="text-white bg-black/50 center inset-0 absolute">
                <UiSpinner :size="16" />
              </span>
              <span
                v-else-if="!ui.onPlayer"
                class="text-[16px] text-white bg-black/50 opacity-0 center transition-opacity inset-0 absolute group-hover/np:opacity-100"
              >
                <span class="i-carbon-maximize" />
              </span>
            </div>
            <div class="min-w-0">
              <Transition name="np-swap" mode="out-in">
                <div :key="playback.trackSeq" class="min-w-0">
                  <p class="text-[13px] text-fg leading-tight font-medium truncate">
                    {{ title }}
                  </p>
                  <div class="text-[11.5px] text-fg-faint mt-1.5 flex gap-1.5 min-w-0 items-center">
                    <span v-if="playback.loading" class="skeleton rounded-[var(--radius-xs)] h-4 w-16" />
                    <UiBadge
                      v-else-if="axes.length"
                      v-tip="axes.join(' · ')"
                      tone="accent"
                      size="xs"
                      icon="i-carbon-activity"
                      class="num"
                    >
                      {{ axes.length === 1 ? axes[0] : `${axes.length} axes` }}
                    </UiBadge>
                    <UiBadge v-else size="xs">
                      No script
                    </UiBadge>
                    <UiBadge v-if="playback.currentEntry?.scriptType === 'merged'" size="xs">
                      merged
                    </UiBadge>
                    <span v-if="queue.length > 1" class="num truncate">{{ queue.pos + 1 }} / {{ queue.length }}</span>
                  </div>
                </div>
              </Transition>
            </div>
          </button>
          <UiIconButton
            v-if="playback.currentEntry"
            :icon="playback.currentEntry.starred ? 'i-carbon-star-filled' : 'i-carbon-star'"
            :label="playback.currentEntry.starred ? 'Unstar' : 'Star'"
            kbd="S"
            size="sm"
            :class="playback.currentEntry.starred ? '!text-warn' : ''"
            @click="toggleStar"
          />
        </template>

        <div v-else class="flex gap-3 min-w-0 items-center">
          <div class="text-fg-faint border border-edge-strong rounded-[var(--radius-sm)] border-dashed center shrink-0 h-[46px] w-[82px]">
            <span class="i-carbon-music text-[18px]" />
          </div>
          <div class="min-w-0">
            <p class="text-[13px] text-fg-muted font-medium">
              Nothing playing
            </p>
            <button
              v-if="!ui.onPlayer || library.hasVideos"
              type="button"
              class="text-[11.5px] text-fg-faint mt-1 focusable truncate hover:text-accent-300"
              @click="ui.openView('library')"
            >
              {{ library.hasVideos ? 'Pick something from the library' : 'Open a folder in the library' }}
            </button>
            <p v-else class="text-[11.5px] text-fg-faint mt-1 truncate">
              Drop a video anywhere to play it
            </p>
          </div>
        </div>
      </div>

      <!-- ═══ Transport ═══ -->
      <div class="flex gap-1 items-center">
        <span class="text-[11.5px] text-fg-muted num text-right w-12" :class="hasTrack ? '' : 'opacity-0'">{{ timeText }}</span>
        <UiIconButton
          v-if="showModes"
          icon="i-carbon-shuffle"
          :label="queue.shuffle ? 'Shuffle on' : 'Shuffle off'"
          kbd="⇧S"
          size="sm"
          :active="queue.shuffle"
          @click="playback.toggleShuffle()"
        />
        <UiIconButton icon="i-carbon-skip-back-filled" label="Previous" kbd="P" size="md" :disabled="!hasTrack" @click="playback.prev()" />
        <button
          type="button"
          class="np-play text-[18px] text-accent-contrast mx-1 focusable rounded-full bg-accent center shrink-0 h-10 w-10 transition-[transform,filter,box-shadow] duration-150 disabled:opacity-40 active:scale-[0.92] hover:brightness-110"
          :disabled="!hasTrack"
          :aria-label="player.isPlaying ? 'Pause' : 'Play'"
          @click="playback.togglePlay()"
        >
          <PlayPauseIcon :playing="player.isPlaying" />
        </button>
        <UiIconButton icon="i-carbon-skip-forward-filled" label="Next" kbd="N" size="md" :disabled="!canNext" @click="playback.next()" />
        <UiIconButton
          v-if="showModes"
          :icon="queue.repeatMode === 'one' ? 'i-carbon-repeat-one' : 'i-carbon-repeat'"
          :label="queue.repeatMode === 'off' ? 'Repeat off' : queue.repeatMode === 'all' ? 'Repeat all' : 'Repeat one'"
          kbd="⇧R"
          size="sm"
          :active="queue.repeatMode !== 'off'"
          @click="playback.cycleRepeat()"
        />
        <span class="text-[11.5px] text-fg-faint num w-12" :class="hasTrack ? '' : 'opacity-0'">{{ durationText }}</span>
      </div>

      <!-- ═══ Tools and status ═══ -->
      <div ref="rightEl" class="flex gap-1 min-w-0 items-center justify-end">
        <template v-if="showStatus">
          <button
            v-tip="device.connected ? 'Device connected' : 'No device — open the device panel'"
            type="button"
            class="np-chip"
            :class="ui.inspector === 'device' ? 'bg-fg/8 text-fg' : ''"
            @click="ui.toggleInspector('device')"
          >
            <span class="rounded-full shrink-0 h-1.5 w-1.5" :class="device.connected ? 'bg-ok animate-pulse-dot text-ok' : 'bg-fg/25'" />
            <span class="i-carbon-plug text-[14px]" />
          </button>
          <button
            v-tip="`Motion: ${motionLabel}`"
            type="button"
            class="np-chip"
            :class="ui.inspector === 'motion' ? 'bg-fg/8 text-fg' : ''"
            @click="ui.toggleInspector('motion')"
          >
            <MotionMeter />
            <MotionRate />
          </button>
          <div class="flex items-center">
            <button
              v-tip="audio.isPlaying.value ? 'Stop binaural tone' : 'Play binaural tone'"
              type="button"
              class="text-[11px] focusable rounded-[var(--radius-sm)] center h-7 w-6 pressable"
              :class="audio.isPlaying.value ? 'text-info bg-info/14 hover:bg-info/22' : 'text-fg-muted hover:text-fg hover:bg-fg/7'"
              :aria-label="audio.isPlaying.value ? 'Stop binaural tone' : 'Play binaural tone'"
              @click="toggleBinaural"
            >
              <span :class="audio.isPlaying.value ? 'i-carbon-stop-filled-alt' : 'i-carbon-play-filled-alt'" />
            </button>
            <button
              v-tip="'Binaural settings'"
              type="button"
              class="np-chip num"
              :class="[ui.inspector === 'binaural' ? 'bg-fg/8 text-fg' : '', audio.isPlaying.value ? '!text-info' : '']"
              @click="ui.toggleInspector('binaural')"
            >
              Δ{{ audio.beatDelta.value.toFixed(1) }}
              <span v-if="audio.phase.value !== 'idle'" class="font-sans capitalize">· {{ audio.phase.value }}</span>
            </button>
          </div>
          <div class="mx-1.5 divider-x" />
        </template>

        <template v-if="showTools">
          <SpeedControl />
          <LoopControls />
          <ScriptOffsetControl />
          <button
            v-tip="'180° side-by-side VR'"
            type="button"
            class="text-[11.5px] font-semibold num px-2 focusable rounded-[var(--radius-sm)] h-7 pressable"
            :class="player.sbs180 ? 'text-accent-300 bg-accent-soft' : 'text-fg-muted hover:text-fg hover:bg-fg/7'"
            :aria-pressed="player.sbs180"
            @click="player.toggleSbs()"
          >
            180°
          </button>
          <div class="mx-1.5 divider-x" />
        </template>

        <div class="flex gap-1 items-center" @wheel="onVolumeWheel">
          <UiIconButton :icon="volumeIcon" :label="player.isMuted ? 'Unmute' : 'Mute'" kbd="M" size="sm" @click="playback.toggleMute()" />
          <UiSlider
            v-if="showVolumeSlider"
            v-model="volumeModel"
            class="w-22"
            :class="player.isMuted ? 'opacity-50' : ''"
            hide-value
          />
        </div>

        <UiIconButton
          icon="i-carbon-list-boxes"
          label="Queue"
          kbd="Q"
          size="sm"
          :active="ui.inspector === 'queue'"
          @click="ui.toggleInspector('queue')"
        >
          <span
            v-if="queue.upcoming.length"
            class="text-[9.5px] text-accent-contrast leading-[14px] font-semibold num px-1 rounded-full bg-accent h-3.5 min-w-3.5 pointer-events-none absolute -right-0.5 -top-0.5"
          >{{ queue.upcoming.length > 99 ? '99+' : queue.upcoming.length }}</span>
        </UiIconButton>

        <!-- Overflow: whatever the width could not fit -->
        <UiPopover v-if="needsOverflow" placement="top" align="end" width="296px">
          <template #trigger="{ toggle, open }">
            <UiIconButton icon="i-carbon-overflow-menu-horizontal" label="More" size="sm" :active="open" @click="toggle" />
          </template>
          <div class="p-1 flex flex-col gap-3 max-h-[70vh] overflow-y-auto">
            <template v-if="!showModes">
              <div class="flex flex-col gap-1.5">
                <span class="eyebrow">Queue</span>
                <UiSwitch :model-value="queue.shuffle" label="Shuffle" @update:model-value="playback.toggleShuffle()" />
                <div class="flex items-center justify-between">
                  <span class="text-[13px] text-fg">Repeat</span>
                  <button
                    type="button"
                    class="text-[12px] px-2 focusable rounded-[var(--radius-sm)] flex gap-1.5 h-7 pressable items-center"
                    :class="queue.repeatMode !== 'off' ? 'bg-accent-soft text-accent-300' : 'bg-fg/6 text-fg-muted hover:text-fg'"
                    @click="playback.cycleRepeat()"
                  >
                    <span :class="queue.repeatMode === 'one' ? 'i-carbon-repeat-one' : 'i-carbon-repeat'" />
                    {{ queue.repeatMode === 'off' ? 'Off' : queue.repeatMode === 'all' ? 'All' : 'One' }}
                  </button>
                </div>
              </div>
              <div class="divider-y" />
            </template>

            <template v-if="!showStatus">
              <div class="flex flex-col gap-1">
                <span class="eyebrow mb-0.5">Status</span>
                <button type="button" class="np-row" @click="ui.toggleInspector('device')">
                  <span class="rounded-full shrink-0 h-1.5 w-1.5" :class="device.connected ? 'bg-ok' : 'bg-fg/25'" />
                  <span class="flex-1">{{ device.connected ? 'Device connected' : 'No device' }}</span>
                  <span class="i-carbon-chevron-right text-fg-faint" />
                </button>
                <button type="button" class="np-row" @click="ui.toggleInspector('motion')">
                  <MotionMeter />
                  <span class="flex-1">Motion · {{ motionLabel }}</span>
                  <MotionRate />
                </button>
                <div class="np-row !pr-1">
                  <span class="i-carbon-headphones text-fg-muted" />
                  <button type="button" class="text-left flex-1 hover:text-accent-300" @click="ui.toggleInspector('binaural')">
                    Binaural <span class="text-fg-faint num">{{ binauralLabel }}</span>
                  </button>
                  <UiIconButton
                    :icon="audio.isPlaying.value ? 'i-carbon-stop-filled-alt' : 'i-carbon-play-filled-alt'"
                    :label="audio.isPlaying.value ? 'Stop tone' : 'Play tone'"
                    size="xs"
                    :active="audio.isPlaying.value"
                    @click="toggleBinaural"
                  />
                </div>
              </div>
              <div class="divider-y" />
            </template>

            <template v-if="!showTools">
              <SpeedControl inline />
              <div class="divider-y" />
              <LoopControls inline />
              <div class="divider-y" />
              <ScriptOffsetControl inline />
              <div class="divider-y" />
              <UiSwitch v-model="player.sbs180" label="180° VR view" hint="Side-by-side 180° video, drag to look around" />
            </template>
          </div>
        </UiPopover>

        <UiIconButton
          icon="i-carbon-maximize"
          label="Fullscreen"
          kbd="F"
          size="sm"
          :disabled="!hasTrack"
          @click="playback.toggleFullscreen()"
        />
      </div>
    </div>
  </footer>
</template>

<style scoped>
.np-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 8px;
  border-radius: var(--radius-sm);
  font-size: 11.5px;
  color: var(--text-muted);
  white-space: nowrap;
  transition:
    background-color var(--dur-fast),
    color var(--dur-fast),
    transform var(--dur-fast);
}
.np-chip:hover {
  background: color-mix(in srgb, var(--text) 7%, transparent);
  color: var(--text);
}
.np-chip:active {
  transform: scale(0.97);
}
.np-chip:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 60%, transparent);
}

.np-row {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 32px;
  padding: 0 8px;
  border-radius: var(--radius-sm);
  font-size: 12.5px;
  color: var(--text);
  text-align: left;
  transition: background-color var(--dur-fast);
}
button.np-row:hover {
  background: color-mix(in srgb, var(--text) 7%, transparent);
}

.np-fill {
  transform: scaleX(var(--p, 0));
}
.np-knob {
  left: calc(var(--p, 0) * 100%);
}

.np-play {
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.18) inset,
    0 6px 16px -6px var(--accent);
}
.np-play:hover {
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.18) inset,
    0 8px 22px -6px var(--accent);
}

.np-eq {
  animation: ph-eq 0.8s ease-in-out infinite;
}

/* The timeline's hover readout sits above it, so the row only clips while it
   is opening or closing. */
.np-tl.t-collapse-enter-active > .np-tl-inner,
.np-tl.t-collapse-leave-active > .np-tl-inner {
  overflow: hidden;
}

/* Title swaps on track change. */
.np-swap-enter-active,
.np-swap-leave-active {
  transition:
    opacity var(--dur) var(--ease-out),
    transform var(--dur-slow) var(--ease-out);
}
.np-swap-enter-from {
  opacity: 0;
  transform: translateY(6px);
}
.np-swap-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
