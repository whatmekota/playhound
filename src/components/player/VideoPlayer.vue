<script setup lang="ts">
import type { VideoEntry } from '~/stores/libraryStore'
import { useLocalStorage } from '@vueuse/core'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiIconButton from '~/components/ui/UiIconButton.vue'
import UiSlider from '~/components/ui/UiSlider.vue'
import UiSpinner from '~/components/ui/UiSpinner.vue'
import { useAutoDirector } from '~/composables/useAutoDirector'
import { useLoopSection } from '~/composables/useLoopSection'
import { useScriptAnalysis } from '~/composables/useScriptAnalysis'
import { sessionNotice, useSessionActions } from '~/composables/useSessionActions'
import { useSmoothPlayhead } from '~/composables/useSmoothPlayhead'
import { useVideoSync } from '~/composables/useVideoSync'
import { chapterAt, chaptersForScript, nextChapter, prevChapter } from '~/lib/chapters'
import { KEYS } from '~/lib/persist'
import { requestStrip } from '~/lib/previews'
import { ensureThumb, prefetchThumbs } from '~/lib/thumbs'
import { formatTime } from '~/lib/time'
import { useLibraryStore } from '~/stores/libraryStore'
import { usePlaybackStore } from '~/stores/playbackStore'
import { usePlayerStore } from '~/stores/playerStore'
import { useQueueStore } from '~/stores/queueStore'
import { useSafetyStore } from '~/stores/safetyStore'
import { useScriptStore } from '~/stores/scriptStore'
import { useSessionControlStore } from '~/stores/sessionControlStore'
import { useUiStore } from '~/stores/uiStore'
import EdgeBadge from './EdgeBadge.vue'
import FunscriptTimeline from './FunscriptTimeline.vue'
import PlayPauseIcon from './PlayPauseIcon.vue'
import SbsViewer from './SbsViewer.vue'

/**
 * The video, and everything drawn over it.
 *
 * It never unmounts: script sync and the device follow the <video> element,
 * so on other views the shell shrinks it to a corner (`mini`) instead.
 * Transport lives in the dock; over the video there is only what helps while
 * watching — the title, gesture feedback, the end-of-video card and, in
 * fullscreen, a control bar of its own (the dock is not there to use).
 */
const props = defineProps<{ mini?: boolean }>()
const emit = defineEmits<{ 'expand': [], 'close-mini': [] }>()

const player = usePlayerStore()
const playback = usePlaybackStore()
const queue = useQueueStore()
const scriptStore = useScriptStore()
const library = useLibraryStore()
const ui = useUiStore()
const safety = useSafetyStore()
const director = useAutoDirector()
const { attach, start, stop, onSeeked } = useVideoSync()
const { checkLoop } = useLoopSection()
const control = useSessionControlStore()
const sessionActions = useSessionActions()
const knobModel = computed({
  get: () => control.intensityScale,
  set: (v: number) => control.setIntensityScale(v),
})

const rootEl = ref<HTMLDivElement | null>(null)
const videoEl = ref<HTMLVideoElement | null>(null)

const hasVideo = computed(() => !!player.videoUrl)
/** Fullscreen always gets the full chrome, even if it was entered from the mini player. */
const isMini = computed(() => !!props.mini && !player.isFullscreen)
const heatmap = useLocalStorage(KEYS.timelineHeatmap.key, true)
/** The end-of-video card, while it counts down. */
const upNext = ref<{ entry: VideoEntry, directed: boolean, key: number } | null>(null)
/** In-player menu open in fullscreen (popovers cannot show there). */
const fsMenu = ref<'speed' | null>(null)

const title = computed(() => {
  if (playback.currentEntry)
    return playback.currentEntry.basename
  const name = player.videoPath?.split(/[\\/]/).pop() ?? ''
  return name.replace(/\.[^.]+$/, '')
})
const axes = computed(() => [...new Set(scriptStore.activeScripts.map(s => s.channel))])
// A running programme always has a next clip.
const canNext = computed(() => !!playback.takeover || queue.hasNext || director.enabled.value)

// ─── Media element ───────────────────────────────────────────────────────────
/** Waiting on data; the spinner only shows if it lasts, so quick seeks do not flash it. */
const stalled = ref(false)
const showSpinner = ref(false)
/** Reached the end with nothing to go on to. */
const ended = ref(false)
let spinnerTimer: ReturnType<typeof setTimeout> | undefined

watch(() => stalled.value || playback.loading, (on) => {
  clearTimeout(spinnerTimer)
  if (on)
    spinnerTimer = setTimeout(() => (showSpinner.value = true), 250)
  else
    showSpinner.value = false
})

function onLoadedMetadata() {
  // With preload="metadata" a paused video may never reach canplay, so this
  // is the point a fresh load stops counting as stalled.
  stalled.value = false
  if (videoEl.value)
    player.videoDuration = videoEl.value.duration
}

function onTimeUpdate() {
  const v = videoEl.value
  if (!v)
    return
  player.currentTime = v.currentTime
  const seekTo = checkLoop(v.currentTime)
  if (seekTo !== null)
    v.currentTime = seekTo
}

function onPlay() {
  player.isPlaying = true
  // Playing again (a replay, a seek back) overrides the countdown.
  clearUpNextTimers()
  upNext.value = null
  ended.value = false
  start()
}

function onPause() {
  player.isPlaying = false
  stop()
}

function onMediaEnded() {
  player.isPlaying = false
  stop()
  handleEnded()
}

// Re-attach the sync every time the <video> element is created; it is v-if'd
// on the URL, so each load is a new node.
watch(videoEl, (el) => {
  if (!el)
    return
  stalled.value = true
  ended.value = false
  attach(el)
  el.volume = player.volume
  el.muted = player.isMuted
  el.playbackRate = player.playbackSpeed
})

watch(() => player.playbackSpeed, (s) => {
  if (videoEl.value)
    videoEl.value.playbackRate = s
})
watch(() => player.volume, (v) => {
  if (videoEl.value)
    videoEl.value.volume = v
})
watch(() => player.isMuted, (m) => {
  if (videoEl.value)
    videoEl.value.muted = m
})

// ─── Controls (registered with the playback store) ──────────────────────────
function play() {
  // play() rejects when autoplay is refused or a newer load interrupts it;
  // either way the paused state already tells the story.
  videoEl.value?.play().catch(() => {})
}

function pause() {
  videoEl.value?.pause()
}

function togglePlay() {
  const v = videoEl.value
  if (!v)
    return
  if (v.paused)
    play()
  else
    v.pause()
}

function seek(seconds: number) {
  const v = videoEl.value
  if (!v)
    return
  const d = player.videoDuration || v.duration || 0
  v.currentTime = Math.max(0, Math.min(d, seconds))
  player.currentTime = v.currentTime
  ended.value = false
}

function seekRelative(delta: number) {
  seek((videoEl.value?.currentTime ?? player.currentTime) + delta)
}

// Speed and volume are settings as much as element state, so they apply even
// with nothing loaded; the watchers above carry them to the element.
function setSpeed(speed: number) {
  player.playbackSpeed = Math.max(0.1, Math.min(10, speed))
}

function setVolume(vol: number) {
  player.volume = Math.max(0, Math.min(1, vol))
  if (vol > 0)
    player.isMuted = false
}

function toggleMute() {
  if (player.isMuted && player.volume === 0)
    player.volume = 0.5
  player.isMuted = !player.isMuted
}

function toggleFullscreen() {
  if (document.fullscreenElement)
    void document.exitFullscreen().catch(() => {})
  else
    void rootEl.value?.requestFullscreen().catch(() => {})
}

function onFullscreenChange() {
  player.isFullscreen = !!rootEl.value && document.fullscreenElement === rootEl.value
  if (!player.isFullscreen)
    fsMenu.value = null
  poke()
}

// The panic cover is outside this element, so it would be invisible over a
// fullscreen video. Leave fullscreen first.
watch(() => safety.panicked, (p) => {
  if (p && document.fullscreenElement)
    void document.exitFullscreen().catch(() => {})
})

// ─── Chrome visibility ───────────────────────────────────────────────────────
const IDLE_MS = 2600
const awake = ref(true)
const overChrome = ref(false)
let idleTimer: ReturnType<typeof setTimeout> | undefined

function poke() {
  awake.value = true
  clearTimeout(idleTimer)
  idleTimer = setTimeout(() => (awake.value = false), IDLE_MS)
}

function onPointerLeave() {
  clearTimeout(idleTimer)
  awake.value = false
  overChrome.value = false
}

const chromeVisible = computed(() =>
  hasVideo.value && !isMini.value
  && (awake.value || overChrome.value || !player.isPlaying || fsMenu.value !== null || !!upNext.value))
const hideCursor = computed(() => hasVideo.value && !isMini.value && player.isPlaying && !chromeVisible.value)

// ─── Feedback: play/pause flash, seek ripple, OSD ────────────────────────────
const flash = ref<{ playing: boolean, key: number } | null>(null)
let flashTimer: ReturnType<typeof setTimeout> | undefined
let flashSeq = 0

function togglePlayWithFlash() {
  const v = videoEl.value
  if (!v)
    return
  const willPlay = v.paused
  togglePlay()
  if (isMini.value)
    return
  flash.value = { playing: willPlay, key: ++flashSeq }
  clearTimeout(flashTimer)
  flashTimer = setTimeout(() => (flash.value = null), 650)
}

const SKIP = 10
const ripple = ref<{ side: 'left' | 'right', amount: number, key: number } | null>(null)
let rippleTimer: ReturnType<typeof setTimeout> | undefined
let rippleSeq = 0
let lastSkip = { side: '' as '' | 'left' | 'right', at: 0 }

function skip(side: 'left' | 'right') {
  seekRelative(side === 'left' ? -SKIP : SKIP)
  const prev = ripple.value
  ripple.value = { side, amount: prev?.side === side ? prev.amount + SKIP : SKIP, key: ++rippleSeq }
  clearTimeout(rippleTimer)
  rippleTimer = setTimeout(() => (ripple.value = null), 800)
  lastSkip = { side, at: performance.now() }
}

const osd = ref<{ icon: string, text: string, sub?: string, level?: number, key: number } | null>(null)
let osdTimer: ReturnType<typeof setTimeout> | undefined
let osdSeq = 0

function showOsd(icon: string, text: string, extra: { sub?: string, level?: number } = {}) {
  if (isMini.value || !hasVideo.value)
    return
  osd.value = { icon, text, ...extra, key: ++osdSeq }
  clearTimeout(osdTimer)
  osdTimer = setTimeout(() => (osd.value = null), 900)
}

const volumeIcon = computed(() => {
  if (player.isMuted || player.volume === 0)
    return 'i-carbon-volume-mute'
  return player.volume < 0.5 ? 'i-carbon-volume-down' : 'i-carbon-volume-up'
})

// Volume and speed can change from the dock, a hotkey or the remote; the OSD
// answers all of them the same way.
watch(() => [player.volume, player.isMuted] as const, ([v, muted]) => {
  const off = muted || v === 0
  showOsd(
    off ? 'i-carbon-volume-mute-filled' : v < 0.5 ? 'i-carbon-volume-down-filled' : 'i-carbon-volume-up-filled',
    off ? 'Muted' : `${Math.round(v * 100)}%`,
    { level: off ? 0 : v },
  )
})
watch(() => player.playbackSpeed, s => showOsd('i-carbon-meter', `${Number(s.toFixed(2))}×`, { sub: 'Speed' }))

function seekWithOsd(delta: number) {
  seekRelative(delta)
  showOsd(
    delta < 0 ? 'i-carbon-rewind-5' : 'i-carbon-forward-5',
    `${delta < 0 ? '−' : '+'}${Math.abs(delta)}s`,
    { sub: formatTime(videoEl.value?.currentTime ?? player.currentTime, '0:00') },
  )
}

// ─── Clicks on the video ─────────────────────────────────────────────────────
/** A second click inside this window makes it a double-click. */
const DOUBLE_MS = 280
/** Further clicks on the same edge within this window keep skipping. */
const CHAIN_MS = 700
let pendingToggle: ReturnType<typeof setTimeout> | null = null

function zoneOf(clientX: number): 'left' | 'centre' | 'right' {
  const r = rootEl.value?.getBoundingClientRect()
  if (!r || !r.width)
    return 'centre'
  const f = (clientX - r.left) / r.width
  return f < 1 / 3 ? 'left' : f > 2 / 3 ? 'right' : 'centre'
}

/**
 * Single click plays/pauses, but only once it is clear no second click is
 * coming; otherwise a double-click to seek would also pause.
 */
function onSurfaceClick(e: MouseEvent) {
  if (isMini.value) {
    emit('expand')
    return
  }
  poke()
  const zone = zoneOf(e.clientX)
  if (zone !== 'centre' && lastSkip.side === zone && performance.now() - lastSkip.at < CHAIN_MS) {
    skip(zone)
    return
  }
  if (pendingToggle) {
    clearTimeout(pendingToggle)
    pendingToggle = null
    if (zone === 'centre')
      toggleFullscreen()
    else
      skip(zone)
    return
  }
  pendingToggle = setTimeout(() => {
    pendingToggle = null
    togglePlayWithFlash()
  }, DOUBLE_MS)
}

// The 180° viewer drags to look around and reports clicks itself, without
// coordinates, so it gets play/pause and fullscreen but no edge seeking.
function onSbsClick() {
  if (isMini.value) {
    emit('expand')
    return
  }
  if (pendingToggle)
    clearTimeout(pendingToggle)
  pendingToggle = setTimeout(() => {
    pendingToggle = null
    togglePlayWithFlash()
  }, DOUBLE_MS)
}

function onSbsDblClick() {
  if (pendingToggle)
    clearTimeout(pendingToggle)
  pendingToggle = null
  if (!isMini.value)
    toggleFullscreen()
}

// ─── Chapters ────────────────────────────────────────────────────────────────
const { analysis, source } = useScriptAnalysis()
const chapters = computed(() => chaptersForScript(source.value, player.videoDuration, analysis.value?.peaks, playback.scriptMetadata))
const currentChapter = computed(() =>
  chapters.value.length > 1 ? chapterAt(chapters.value, player.currentTime * 1000) : null)

function skipChapter(dir: -1 | 1) {
  if (chapters.value.length < 2) {
    showOsd('i-carbon-list', 'No chapters', { sub: hasVideo.value && !source.value ? 'No script' : undefined })
    return
  }
  const ms = (videoEl.value?.currentTime ?? player.currentTime) * 1000
  const c = dir > 0 ? nextChapter(chapters.value, ms) : prevChapter(chapters.value, ms)
  if (!c) {
    showOsd('i-carbon-skip-forward-outline', 'Last chapter')
    return
  }
  seek(c.start / 1000)
  showOsd(dir > 0 ? 'i-carbon-skip-forward-outline' : 'i-carbon-skip-back-outline', c.name, {
    sub: `${c.index + 1} of ${chapters.value.length} · ${formatTime(c.start / 1000, '0:00')}`,
  })
}

// Session controls (knob nudges, peak jumps) report here while the player
// is what is on screen; elsewhere they toast.
watch(sessionNotice, (n) => {
  if (n)
    showOsd(n.icon, n.text, { sub: n.sub, level: n.level })
})

// ─── Scrub previews ──────────────────────────────────────────────────────────
// The playing video's strip is built first, but not straight away: the
// strip decodes on a second <video>, and the first seconds of playback
// deserve the decoder to themselves.
const STRIP_DELAY_MS = 4000
let releaseStrip: (() => void) | null = null
let stripTimer: ReturnType<typeof setTimeout> | undefined
watch(() => playback.currentEntry, (entry) => {
  clearTimeout(stripTimer)
  releaseStrip?.()
  releaseStrip = null
  if (entry)
    stripTimer = setTimeout(() => (releaseStrip = requestStrip(entry, 'now')), STRIP_DELAY_MS)
}, { immediate: true })

// ─── Keyboard ────────────────────────────────────────────────────────────────
function onKeyDown(e: KeyboardEvent) {
  if (e.ctrlKey || e.metaKey || e.altKey)
    return
  const t = e.target as HTMLElement | null
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable))
    return
  // A dialog is up, or the screen is covered: it owns the keyboard.
  if (ui.paletteOpen || ui.settingsOpen || ui.shortcutsOpen || safety.panicked)
    return
  if (!hasVideo.value)
    return

  switch (e.code) {
    case 'Space':
      // A button reached with Tab keeps Space; one that merely kept focus
      // after a mouse click should not swallow play/pause.
      if (t?.tagName === 'BUTTON' && t.matches(':focus-visible'))
        return
      e.preventDefault()
      togglePlayWithFlash()
      break
    case 'ArrowRight':
    case 'ArrowLeft': {
      e.preventDefault()
      const step = e.shiftKey ? 30 : 5
      seekWithOsd(e.code === 'ArrowLeft' ? -step : step)
      if (player.isFullscreen)
        poke()
      break
    }
    case 'ArrowUp':
      e.preventDefault()
      setVolume(Math.round((player.volume + 0.05) * 100) / 100)
      break
    case 'ArrowDown':
      e.preventDefault()
      setVolume(Math.round((player.volume - 0.05) * 100) / 100)
      break
    case 'KeyM':
      if (e.shiftKey)
        return
      toggleMute()
      break
    case 'KeyF':
      if (e.shiftKey)
        return
      e.preventDefault()
      toggleFullscreen()
      break
    case 'BracketRight':
      e.preventDefault()
      setSpeed(Math.min(4, Math.round((player.playbackSpeed + 0.25) * 100) / 100))
      break
    case 'BracketLeft':
      e.preventDefault()
      setSpeed(Math.max(0.25, Math.round((player.playbackSpeed - 0.25) * 100) / 100))
      break
    case 'Backslash':
      e.preventDefault()
      setSpeed(1)
      break
    case 'Comma':
    case 'Period':
      if (e.shiftKey)
        return
      e.preventDefault()
      skipChapter(e.code === 'Comma' ? -1 : 1)
      if (player.isFullscreen)
        poke()
      break
  }
}

// ─── End of video: "Up next" ─────────────────────────────────────────────────
/**
 * Seconds the "Up next" card waits before playing on; 0 skips the card and
 * plays the next video straight away. Settings → Playback, or the card's own
 * "always skip" link.
 */
const upNextDelay = useLocalStorage<number>(KEYS.upNextDelay.key, 5)
const upNextThumb = ref<string | null>(null)
const upNextLeft = ref(5)
let upNextTimer: ReturnType<typeof setTimeout> | undefined
let upNextTick: ReturnType<typeof setInterval> | undefined
let upNextSeq = 0

/**
 * What would play next. The director chooses by script shape when it is on,
 * and picks at random from a shortlist, so the choice is made once here and
 * then played exactly, rather than asking again on commit.
 */
function resolveUpNext(): { entry: VideoEntry, directed: boolean } | null {
  if (director.enabled.value) {
    const pick = director.pickNext(player.videoPath ?? undefined)
    if (pick)
      return { entry: pick, directed: true }
  }
  const entry = queue.peekNext()
  return entry ? { entry, directed: false } : null
}

async function loadThumb(entry: VideoEntry) {
  // Failure just leaves the placeholder.
  await ensureThumb(entry).catch(() => {})
  return entry.thumbnailUrl
}

function handleEnded() {
  // A running programme decides what comes next; the card would offer the
  // queue's idea instead and stall the reel for five seconds.
  if (playback.takeover) {
    void playback.onEnded()
    return
  }
  // Repeat-one and "nothing follows" are the store's call; only a real next
  // video earns the card.
  const choice = queue.repeatMode === 'one' ? null : resolveUpNext()
  if (!choice) {
    ended.value = queue.repeatMode !== 'one'
    void playback.onEnded()
    return
  }
  const delayMs = Math.max(0, upNextDelay.value) * 1000
  if (delayMs === 0) {
    // Instant: no card, straight on — exactly what "Play now" would do.
    if (choice.directed)
      void playback.play(choice.entry)
    else
      void playback.next()
    return
  }
  upNext.value = { ...choice, key: ++upNextSeq }
  upNextThumb.value = choice.entry.thumbnailUrl
  void loadThumb(choice.entry).then((url) => {
    if (upNext.value?.entry === choice.entry)
      upNextThumb.value = url
  })
  const deadline = Date.now() + delayMs
  upNextLeft.value = Math.ceil(delayMs / 1000)
  clearInterval(upNextTick)
  upNextTick = setInterval(() => (upNextLeft.value = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))), 200)
  clearTimeout(upNextTimer)
  upNextTimer = setTimeout(commitUpNext, delayMs)
}

function clearUpNextTimers() {
  clearTimeout(upNextTimer)
  clearInterval(upNextTick)
}

function commitUpNext() {
  const choice = upNext.value
  clearUpNextTimers()
  upNext.value = null
  if (!choice)
    return
  if (choice.directed)
    void playback.play(choice.entry)
  else
    void playback.next()
}

function cancelUpNext() {
  if (!upNext.value)
    return
  clearUpNextTimers()
  upNext.value = null
  ended.value = true
}

function replay() {
  ended.value = false
  seek(0)
  play()
}

watch(() => playback.trackSeq, () => {
  clearUpNextTimers()
  upNext.value = null
  ended.value = false
})

/** Ring circumference for r = 21. */
const RING = 2 * Math.PI * 21

// ─── Fullscreen extras ───────────────────────────────────────────────────────
const sheetOpen = useLocalStorage(KEYS.fsUpNext.key, false)
const FS_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2]

const upcoming = computed(() => queue.upcoming.slice(0, 60))
watch([sheetOpen, () => player.isFullscreen, upcoming], ([open, fs]) => {
  if (open && fs)
    prefetchThumbs(upcoming.value.slice(0, 24).map(q => q.entry))
})

const volumeModel = computed({
  get: () => (player.isMuted ? 0 : player.volume),
  set: (v: number) => setVolume(v),
})

const timeText = computed(() => formatTime(player.currentTime, '0:00'))
const durationText = computed(() => formatTime(player.videoDuration, '0:00'))

function toggleStar() {
  if (playback.currentEntry)
    library.toggleStar(playback.currentEntry)
}

// ─── Mini progress line ──────────────────────────────────────────────────────
const miniBar = ref<HTMLElement | null>(null)
const { redraw: redrawMiniBar } = useSmoothPlayhead((t) => {
  const d = player.videoDuration
  miniBar.value?.style.setProperty('--p', String(d > 0 ? Math.min(1, t / d) : 0))
})
watch(miniBar, el => el && redrawMiniBar())

function closeMini() {
  // The shell's contract predates the camelCase rule.
  // eslint-disable-next-line vue/custom-event-name-casing
  emit('close-mini')
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────
onMounted(() => {
  playback.bindPlayer({ play, pause, togglePlay, seek, seekRelative, setSpeed, setVolume, toggleMute, toggleFullscreen })
  window.addEventListener('keydown', onKeyDown)
  document.addEventListener('fullscreenchange', onFullscreenChange)
  poke()
})

onBeforeUnmount(() => {
  playback.bindPlayer(null)
  window.removeEventListener('keydown', onKeyDown)
  document.removeEventListener('fullscreenchange', onFullscreenChange)
  for (const t of [idleTimer, flashTimer, rippleTimer, osdTimer, spinnerTimer, pendingToggle ?? undefined])
    clearTimeout(t)
  clearUpNextTimers()
  clearTimeout(stripTimer)
  releaseStrip?.()
  stop()
})

defineExpose({ play, pause, togglePlay, seek, seekRelative, setSpeed, setVolume, toggleMute, toggleFullscreen })
</script>

<template>
  <div
    ref="rootEl"
    class="group/vp bg-black h-full w-full select-none relative overflow-hidden"
    :class="hideCursor ? 'cursor-none' : ''"
    @pointermove="poke"
    @pointerleave="onPointerLeave"
  >
    <video
      v-if="player.videoUrl"
      ref="videoEl"
      class="h-full w-full inset-0 absolute object-contain"
      :class="player.sbs180 ? 'invisible' : ''"
      :src="player.videoUrl"
      :muted="player.isMuted"
      preload="metadata"
      playsinline
      @loadstart="stalled = true"
      @loadedmetadata="onLoadedMetadata"
      @timeupdate="onTimeUpdate"
      @play="onPlay"
      @pause="onPause"
      @ended="onMediaEnded"
      @seeked="onSeeked()"
      @waiting="stalled = true"
      @canplay="stalled = false"
      @playing="stalled = false"
      @error="stalled = false"
    />

    <!-- 180° viewer over the (hidden but live) video -->
    <SbsViewer
      v-if="player.sbs180 && player.videoUrl"
      :video-el="videoEl"
      class="inset-0 absolute z-[1]"
      @click="onSbsClick"
      @dblclick="onSbsDblClick"
    />

    <!-- Gesture surface: click, double-click edges and centre -->
    <div
      v-if="player.videoUrl && !player.sbs180"
      class="inset-0 absolute z-[1]"
      :class="isMini ? 'cursor-pointer' : ''"
      @click="onSurfaceClick"
    />

    <!-- Layers the shell draws over the picture (hypno). Inside the player's
         root so they come along into fullscreen. -->
    <div class="pointer-events-none inset-0 absolute z-[2]">
      <slot name="overlay" />
    </div>

    <!-- Buffering -->
    <Transition name="t-fade">
      <div v-if="showSpinner && hasVideo" class="text-white/85 center pointer-events-none inset-0 absolute z-[5]">
        <div class="rounded-full bg-black/45 center backdrop-blur-md" :class="isMini ? 'h-10 w-10' : 'h-16 w-16'">
          <UiSpinner :size="isMini ? 18 : 28" />
        </div>
      </div>
    </Transition>

    <!-- ═══ Mini player ═══════════════════════════════════════════════════ -->
    <template v-if="isMini && hasVideo">
      <div class="pointer-events-none inset-0 absolute z-20">
        <div
          class="transition-opacity duration-200 inset-0 absolute from-black/65 to-black/55 via-black/10 bg-gradient-to-b group-hover/vp:opacity-100"
          :class="player.isPlaying ? 'opacity-0' : 'opacity-100'"
        />
        <div
          class="px-2 pt-2 flex gap-1 transition-opacity duration-200 items-start inset-x-0 top-0 absolute group-hover/vp:opacity-100"
          :class="player.isPlaying ? 'opacity-0' : 'opacity-100'"
        >
          <p class="text-[12px] text-white font-medium pl-1 pt-1 flex-1 min-w-0 truncate drop-shadow">
            {{ title }}
          </p>
          <UiIconButton
            icon="i-carbon-maximize" label="Back to the player" variant="glass" size="xs" tip="bottom"
            class="pointer-events-auto" @click.stop="emit('expand')"
          />
          <UiIconButton
            icon="i-carbon-close" label="Close mini player" variant="glass" size="xs" tip="bottom"
            class="pointer-events-auto" @click.stop="closeMini"
          />
        </div>
        <button
          type="button"
          class="text-[18px] text-white rounded-full bg-black/45 center h-11 w-11 pointer-events-auto pressable transition-opacity duration-200 left-1/2 top-1/2 absolute backdrop-blur-md hover:bg-black/60 group-hover/vp:opacity-100 -translate-x-1/2 -translate-y-1/2"
          :class="player.isPlaying ? 'opacity-0' : 'opacity-100'"
          :aria-label="player.isPlaying ? 'Pause' : 'Play'"
          @click.stop="togglePlay()"
        >
          <PlayPauseIcon :playing="player.isPlaying" />
        </button>
        <div class="bg-white/20 h-[3px] transition-[height] duration-150 inset-x-0 bottom-0 absolute group-hover/vp:h-1">
          <div ref="miniBar" class="mini-fill bg-accent h-full origin-left" />
        </div>
      </div>
    </template>

    <!-- ═══ Full player ═══════════════════════════════════════════════════ -->
    <template v-else-if="hasVideo">
      <!-- Top: what this is -->
      <Transition name="t-fade">
        <div
          v-if="chromeVisible"
          class="pb-10 pointer-events-none inset-x-0 top-0 absolute z-20 from-black/75 to-transparent via-black/30 bg-gradient-to-b"
        >
          <div class="px-5 pt-4 flex gap-3 items-start">
            <Transition name="vp-title" mode="out-in">
              <div :key="playback.trackSeq" class="flex-1 min-w-0">
                <h2 class="text-[16px] text-white tracking-[-0.01em] font-semibold truncate drop-shadow">
                  {{ title }}
                </h2>
                <div class="text-[11.5px] text-white/65 mt-1.5 flex flex-wrap gap-1.5 items-center">
                  <span v-if="playback.loading" class="vp-chip text-white/60">
                    <span class="i-carbon-renew text-[11px] animate-spin" />
                    Reading script…
                  </span>
                  <template v-else-if="axes.length">
                    <span v-for="a in axes" :key="a" class="vp-chip font-mono">{{ a }}</span>
                    <span v-if="playback.currentEntry?.scriptType === 'merged'" class="vp-chip">merged</span>
                  </template>
                  <span v-else class="vp-chip text-white/55">No script</span>
                  <span v-if="player.playbackSpeed !== 1" class="vp-chip vp-chip-accent font-mono">{{ Number(player.playbackSpeed.toFixed(2)) }}×</span>
                  <span v-if="player.loopActive" class="vp-chip vp-chip-accent font-mono">A–B</span>
                  <Transition name="t-fade" mode="out-in">
                    <span v-if="currentChapter" :key="currentChapter.index" class="vp-chip">
                      <span class="i-carbon-bookmark text-[10px] opacity-70" />
                      {{ currentChapter.name }}
                      <span class="text-white/50 num">{{ currentChapter.index + 1 }}/{{ chapters.length }}</span>
                    </span>
                  </Transition>
                  <span v-if="queue.sourceLabel && queue.length > 1" class="ml-1 truncate">
                    {{ queue.sourceLabel }} · {{ queue.pos + 1 }} of {{ queue.length }}
                  </span>
                </div>
              </div>
            </Transition>
            <UiIconButton
              v-if="playback.currentEntry"
              :icon="playback.currentEntry.starred ? 'i-carbon-star-filled' : 'i-carbon-star'"
              :label="playback.currentEntry.starred ? 'Unstar' : 'Star'"
              kbd="S"
              variant="glass"
              size="md"
              tip="bottom"
              class="pointer-events-auto"
              :class="playback.currentEntry.starred ? '!text-warn' : ''"
              @click="toggleStar"
            />
          </div>
        </div>
      </Transition>

      <!-- Play / pause flash -->
      <div v-if="flash" :key="flash.key" class="center pointer-events-none inset-0 absolute z-10">
        <div class="vp-flash text-[30px] text-white rounded-full bg-black/45 center h-[72px] w-[72px] backdrop-blur-md">
          <span :class="flash.playing ? 'i-carbon-play-filled-alt' : 'i-carbon-pause-filled'" />
        </div>
      </div>

      <!-- Double-click seek ripple -->
      <Transition name="t-fade">
        <div
          v-if="ripple"
          class="text-white flex flex-col gap-1 w-[36%] pointer-events-none items-center inset-y-0 justify-center absolute z-10"
          :class="ripple.side === 'left' ? 'left-0 vp-ripple-l' : 'right-0 vp-ripple-r'"
        >
          <div :key="ripple.key" class="vp-chevrons text-[18px] flex" :class="ripple.side === 'left' ? 'flex-row-reverse' : ''">
            <span v-for="i in 3" :key="i" :class="ripple.side === 'left' ? 'i-carbon-caret-left' : 'i-carbon-caret-right'" :style="{ animationDelay: `${(i - 1) * 90}ms` }" />
          </div>
          <span class="text-[13px] font-semibold num">{{ ripple.amount }} seconds</span>
        </div>
      </Transition>

      <!-- OSD: volume, speed, seek -->
      <Transition name="t-fade">
        <div v-if="osd" class="flex pointer-events-none inset-x-0 top-[16%] justify-center absolute z-30">
          <div :key="osd.key" class="vp-osd text-white px-4 rounded-full bg-black/60 flex gap-2.5 h-11 shadow-[var(--shadow-lg)] items-center backdrop-blur-xl">
            <span :class="osd.icon" class="text-[18px]" />
            <span class="text-[15px] font-semibold num">{{ osd.text }}</span>
            <span v-if="osd.sub" class="text-[12px] text-white/60 num">{{ osd.sub }}</span>
            <span v-if="osd.level !== undefined" class="rounded-full bg-white/25 h-1 w-24 overflow-hidden">
              <span class="rounded-full bg-white h-full block transition-[width] duration-150" :style="{ width: `${osd.level * 100}%` }" />
            </span>
          </div>
        </div>
      </Transition>

      <!-- A running edge: countdown and "I'm OK", clear of the title -->
      <div
        class="vp-edge pointer-events-auto right-4 absolute z-30"
        :class="chromeVisible ? 'top-[68px]' : 'top-4'"
      >
        <EdgeBadge variant="overlay" />
      </div>

      <!-- Ended, nothing next: offer a replay -->
      <Transition name="t-pop">
        <button
          v-if="ended && !upNext && !showSpinner"
          type="button"
          class="text-[26px] text-white rounded-full bg-black/50 center h-16 w-16 pressable left-1/2 top-1/2 absolute z-20 backdrop-blur-md hover:bg-black/65 -translate-x-1/2 -translate-y-1/2"
          aria-label="Replay"
          @click="replay"
        >
          <span class="i-carbon-restart" />
        </button>
      </Transition>

      <!-- Fullscreen: control bar -->
      <Transition name="vp-bar">
        <div
          v-if="player.isFullscreen && chromeVisible"
          class="px-5 pb-4 pt-16 inset-x-0 bottom-0 absolute z-30 from-black/85 to-transparent via-black/45 bg-gradient-to-t"
          @pointerenter="overChrome = true"
          @pointerleave="overChrome = false"
        >
          <FunscriptTimeline variant="overlay" :heatmap="heatmap" class="h-10" />
          <div class="text-white mt-2.5 flex gap-1 items-center">
            <UiIconButton icon="i-carbon-skip-back-filled" label="Previous" kbd="P" variant="glass" size="md" :disabled="!hasVideo" @click="playback.prev()" />
            <button
              type="button"
              class="text-[20px] text-black rounded-full bg-white center h-10 w-10 shadow-[var(--shadow-md)] pressable hover:bg-white/90"
              :aria-label="player.isPlaying ? 'Pause' : 'Play'"
              @click="togglePlay()"
            >
              <PlayPauseIcon :playing="player.isPlaying" />
            </button>
            <UiIconButton icon="i-carbon-skip-forward-filled" label="Next" kbd="N" variant="glass" size="md" :disabled="!canNext" @click="playback.next()" />

            <div class="ml-2 flex gap-1.5 items-center">
              <UiIconButton :icon="volumeIcon" :label="player.isMuted ? 'Unmute' : 'Mute'" kbd="M" variant="glass" size="md" @click="toggleMute()" />
              <UiSlider v-model="volumeModel" class="w-24" hide-value />
            </div>

            <!-- Session: the dock is not there to use in fullscreen -->
            <div class="ml-2 flex gap-1.5 items-center">
              <UiIconButton
                icon="i-carbon-temperature-hot"
                label="Edge — back everything off"
                kbd="E"
                variant="glass"
                size="md"
                :active="control.phase !== 'idle'"
                @click="sessionActions.edge('ui')"
              />
              <span class="i-carbon-meter-alt text-[15px] text-white/70" aria-hidden="true" />
              <UiSlider v-model="knobModel" class="w-20" :min="0.1" :max="1" :step="0.05" :reset="1" hide-value />
              <span class="text-[12px] text-white/75 num w-9">{{ Math.round(control.intensityScale * 100) }}%</span>
            </div>

            <span class="text-[12.5px] text-white/85 num ml-2">
              {{ timeText }} <span class="text-white/45">/ {{ durationText }}</span>
            </span>

            <div v-if="chapters.length > 1" class="ml-3 flex gap-0.5 min-w-0 items-center">
              <UiIconButton icon="i-carbon-skip-back-outline" label="Previous chapter" kbd="," variant="glass" size="sm" @click="skipChapter(-1)" />
              <span class="text-[12px] text-white/75 px-1 max-w-40 truncate">{{ currentChapter?.name }}</span>
              <UiIconButton icon="i-carbon-skip-forward-outline" label="Next chapter" kbd="." variant="glass" size="sm" @click="skipChapter(1)" />
              <UiIconButton icon="i-carbon-fire" label="Next peak" kbd="G" variant="glass" size="sm" @click="sessionActions.nextPeak()" />
              <UiIconButton icon="i-carbon-flag-filled" label="Finish — the most intense part" kbd="⇧G" variant="glass" size="sm" @click="sessionActions.finish()" />
            </div>

            <div class="flex-1" />

            <UiIconButton icon="i-carbon-shuffle" :label="queue.shuffle ? 'Shuffle on' : 'Shuffle off'" kbd="⇧S" variant="glass" size="md" :active="queue.shuffle" @click="playback.toggleShuffle()" />
            <UiIconButton
              :icon="queue.repeatMode === 'one' ? 'i-carbon-repeat-one' : 'i-carbon-repeat'"
              :label="queue.repeatMode === 'off' ? 'Repeat off' : queue.repeatMode === 'all' ? 'Repeat all' : 'Repeat one'"
              kbd="⇧R" variant="glass" size="md" :active="queue.repeatMode !== 'off'" @click="playback.cycleRepeat()"
            />
            <UiIconButton icon="i-carbon-chart-histogram" label="Speed heatmap on the timeline" variant="glass" size="md" :active="heatmap" @click="heatmap = !heatmap" />

            <!-- Speed. Popovers teleport to <body>, which is not shown in
                 fullscreen, so this menu lives inside the player. -->
            <div class="relative">
              <button
                type="button"
                class="text-[12.5px] font-medium num px-2.5 rounded-[var(--radius-md)] h-8 pressable"
                :class="fsMenu === 'speed' || player.playbackSpeed !== 1 ? 'text-accent-300 bg-accent-soft' : 'text-white/85 hover:text-white hover:bg-white/14'"
                aria-label="Playback speed"
                @click="fsMenu = fsMenu === 'speed' ? null : 'speed'"
              >
                {{ Number(player.playbackSpeed.toFixed(2)) }}×
              </button>
              <Transition name="t-pop">
                <div
                  v-if="fsMenu === 'speed'"
                  class="mb-2 p-1 rounded-[var(--radius-md)] bg-black/75 flex flex-col min-w-24 ring-1 ring-white/12 bottom-full right-0 absolute backdrop-blur-xl"
                >
                  <button
                    v-for="s in FS_SPEEDS"
                    :key="s"
                    type="button"
                    class="text-[12.5px] num px-3 text-left rounded-[var(--radius-sm)] flex h-7 items-center justify-between"
                    :class="player.playbackSpeed === s ? 'text-accent-300 bg-white/8' : 'text-white/85 hover:bg-white/12'"
                    @click="setSpeed(s); fsMenu = null"
                  >
                    {{ s }}×
                    <span v-if="player.playbackSpeed === s" class="i-carbon-checkmark text-[12px]" />
                  </button>
                </div>
              </Transition>
            </div>

            <UiIconButton
              icon="i-carbon-list-boxes"
              :label="sheetOpen ? 'Hide up next' : 'Up next'"
              variant="glass"
              size="md"
              :active="sheetOpen"
              @click="sheetOpen = !sheetOpen"
            >
              <span
                v-if="queue.upcoming.length"
                class="text-[9.5px] text-accent-contrast leading-[14px] font-semibold num px-1 rounded-full bg-accent h-3.5 min-w-3.5 right-0 top-0 absolute"
              >{{ queue.upcoming.length > 99 ? '99+' : queue.upcoming.length }}</span>
            </UiIconButton>
            <UiIconButton icon="i-carbon-minimize" label="Exit fullscreen" kbd="F" variant="glass" size="md" @click="toggleFullscreen()" />
          </div>
        </div>
      </Transition>

      <!-- Click-away for the fullscreen speed menu -->
      <div v-if="fsMenu" class="inset-0 absolute z-[25]" @click="fsMenu = null" />

      <!-- Fullscreen: up next sheet -->
      <Transition name="t-slide-right">
        <aside
          v-if="player.isFullscreen && sheetOpen && chromeVisible"
          class="text-white rounded-[var(--radius-lg)] bg-black/65 flex flex-col w-80 ring-1 ring-white/10 shadow-[var(--shadow-lg)] bottom-[124px] right-4 top-4 absolute z-30 overflow-hidden backdrop-blur-xl"
          @pointerenter="overChrome = true"
          @pointerleave="overChrome = false"
        >
          <header class="pl-4 pr-2 border-b border-white/10 flex shrink-0 gap-2 h-12 items-center">
            <div class="flex-1 min-w-0">
              <p class="text-[13px] font-semibold">
                Up next
              </p>
              <p class="text-[11px] text-white/50 truncate">
                {{ queue.sourceLabel || 'Queue' }} · {{ queue.upcoming.length }} to go
              </p>
            </div>
            <UiIconButton icon="i-carbon-close" label="Close" variant="glass" size="sm" tip="left" @click="sheetOpen = false" />
          </header>
          <div v-if="upcoming.length" class="p-1.5 scroll-y flex-1">
            <button
              v-for="(q, i) in upcoming"
              :key="q.uid"
              type="button"
              class="group p-1.5 text-left rounded-[var(--radius-md)] flex gap-2.5 w-full transition-colors items-center hover:bg-white/10"
              @click="playback.jumpTo(q.uid)"
            >
              <div class="rounded-[var(--radius-sm)] bg-white/8 shrink-0 h-9 w-16 relative overflow-hidden">
                <img v-if="q.entry.thumbnailUrl" :src="q.entry.thumbnailUrl" alt="" class="h-full w-full object-cover">
                <span v-else class="i-carbon-video text-[14px] text-white/30 left-1/2 top-1/2 absolute -translate-x-1/2 -translate-y-1/2" />
                <span class="text-[16px] bg-black/50 opacity-0 center transition-opacity inset-0 absolute group-hover:opacity-100">
                  <span class="i-carbon-play-filled-alt" />
                </span>
              </div>
              <div class="flex-1 min-w-0">
                <p class="text-[12.5px] text-white/90 leading-snug line-clamp-2">
                  {{ q.entry.basename }}
                </p>
                <p class="text-[10.5px] text-white/45 mt-0.5 flex gap-1.5 items-center">
                  <span class="num">{{ i + 1 }}</span>
                  <span v-if="q.entry.hasScript" class="text-accent-300">{{ q.entry.scriptCount > 1 ? `${q.entry.scriptCount} axes` : 'script' }}</span>
                  <span v-if="q.manual">queued</span>
                </p>
              </div>
            </button>
          </div>
          <div v-else class="px-6 text-center flex flex-1 flex-col gap-2 items-center justify-center">
            <span class="i-carbon-list-boxes text-[26px] text-white/30" />
            <p class="text-[13px] text-white/80 font-medium">
              Nothing queued
            </p>
            <p class="text-[12px] text-white/50">
              Play from the library or a playlist and the rest lines up here.
            </p>
          </div>
        </aside>
      </Transition>
    </template>

    <!-- ═══ End of video: up next ═════════════════════════════════════════ -->
    <Transition name="t-fade">
      <div
        v-if="upNext && isMini"
        class="text-white px-4 bg-black/75 flex flex-col gap-1 items-center inset-0 justify-center absolute z-40"
        @click.stop
      >
        <button type="button" class="center h-12 w-12 pressable relative" aria-label="Play now" @click="commitUpNext">
          <svg viewBox="0 0 48 48" class="h-full w-full inset-0 absolute -rotate-90">
            <circle cx="24" cy="24" r="21" fill="none" stroke="currentColor" stroke-opacity="0.25" stroke-width="3" />
            <circle :key="upNext.key" class="vp-ring" cx="24" cy="24" r="21" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" :stroke-dasharray="RING" :style="{ '--ring': RING }" />
          </svg>
          <span class="i-carbon-play-filled-alt text-[18px]" />
        </button>
        <p class="text-[10.5px] text-white/55 tracking-[0.08em] font-semibold mt-1 uppercase">
          Up next
        </p>
        <p class="text-[12px] font-medium max-w-full truncate">
          {{ upNext.entry.basename }}
        </p>
        <button type="button" class="text-[11px] text-white/55 hover:text-white" @click="cancelUpNext">
          Cancel
        </button>
      </div>
      <div
        v-else-if="upNext"
        class="p-4 bg-black/40 center inset-0 absolute z-40"
        @click.self="cancelUpNext"
      >
        <div class="vp-card text-white p-4 rounded-[var(--radius-xl)] bg-black/70 max-w-full w-[440px] ring-1 ring-white/12 shadow-[var(--shadow-lg)] backdrop-blur-xl">
          <div class="flex items-center justify-between">
            <span class="text-[10.5px] text-white/60 tracking-[0.08em] font-semibold uppercase">Up next</span>
            <span class="text-[12px] text-white/60 num">in {{ upNextLeft }}s</span>
          </div>
          <div class="mt-3 flex gap-3.5">
            <button
              type="button"
              class="group rounded-[var(--radius-md)] bg-white/8 shrink-0 h-[90px] w-[160px] relative overflow-hidden"
              aria-label="Play now"
              @click="commitUpNext"
            >
              <img v-if="upNextThumb" :src="upNextThumb" alt="" class="h-full w-full inset-0 absolute object-cover">
              <span v-else class="i-carbon-video text-[24px] text-white/25 left-1/2 top-1/2 absolute -translate-x-1/2 -translate-y-1/2" />
              <span class="bg-black/40 center transition-colors inset-0 absolute group-hover:bg-black/25">
                <span class="center h-12 w-12 relative">
                  <svg viewBox="0 0 48 48" class="h-full w-full inset-0 absolute -rotate-90">
                    <circle cx="24" cy="24" r="21" fill="none" stroke="white" stroke-opacity="0.3" stroke-width="3" />
                    <circle :key="upNext.key" class="vp-ring" cx="24" cy="24" r="21" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" :stroke-dasharray="RING" :style="{ '--ring': RING }" />
                  </svg>
                  <span class="i-carbon-play-filled-alt text-[18px] transition-transform group-hover:scale-110" />
                </span>
              </span>
            </button>
            <div class="py-0.5 flex-1 min-w-0">
              <p class="text-[14px] leading-snug font-semibold line-clamp-2">
                {{ upNext.entry.basename }}
              </p>
              <p class="text-[12px] text-white/60 mt-1">
                {{ upNext.directed ? 'Picked by the director to match the session' : queue.sourceLabel ? `Next in ${queue.sourceLabel}` : 'Next in the queue' }}
              </p>
              <div class="mt-2 flex gap-1.5">
                <span v-if="upNext.entry.hasScript" class="vp-chip vp-chip-accent">
                  {{ upNext.entry.scriptCount > 1 ? `${upNext.entry.scriptCount} axes` : 'Scripted' }}
                </span>
                <span v-else class="vp-chip text-white/55">No script</span>
                <span v-if="upNext.entry.duration" class="vp-chip num">{{ formatTime(upNext.entry.duration) }}</span>
              </div>
            </div>
          </div>
          <div class="mt-4 flex gap-2 items-center justify-end">
            <button
              type="button"
              class="text-[12px] text-white/55 mr-auto underline-offset-2 hover:text-white hover:underline"
              @click="upNextDelay = 0; commitUpNext()"
            >
              Always skip the countdown
            </button>
            <UiButton variant="ghost" size="sm" class="!text-white/80 hover:!text-white hover:!bg-white/12" @click="cancelUpNext">
              Cancel
            </UiButton>
            <UiButton variant="primary" size="sm" icon="i-carbon-play-filled-alt" @click="commitUpNext">
              Play now
            </UiButton>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.vp-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 20px;
  padding: 0 6px;
  border-radius: var(--radius-xs);
  font-size: 10.5px;
  font-weight: 500;
  background: rgba(255, 255, 255, 0.14);
  color: rgba(255, 255, 255, 0.9);
  backdrop-filter: blur(8px);
}
.vp-chip-accent {
  background: color-mix(in srgb, var(--accent) 30%, transparent);
  color: white;
}

.mini-fill {
  transform: scaleX(var(--p, 0));
}

/* Title swaps on track change: the old one lifts away, the new one rises in. */
.vp-title-enter-active,
.vp-title-leave-active {
  transition:
    opacity var(--dur) var(--ease-out),
    transform var(--dur-slow) var(--ease-out);
}
.vp-title-enter-from {
  opacity: 0;
  transform: translateY(6px);
}
.vp-title-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

/* Fullscreen bar slides up out of the bottom edge. */
.vp-bar-enter-active,
.vp-bar-leave-active {
  transition:
    opacity var(--dur) var(--ease-out),
    transform var(--dur-slow) var(--ease-out);
}
.vp-bar-enter-from,
.vp-bar-leave-to {
  opacity: 0;
  transform: translateY(12px);
}

.vp-flash {
  animation: vp-flash 650ms var(--ease-out) both;
}
@keyframes vp-flash {
  0% {
    opacity: 0;
    transform: scale(0.7);
  }
  25% {
    opacity: 1;
    transform: scale(1);
  }
  100% {
    opacity: 0;
    transform: scale(1.35);
  }
}

.vp-ripple-l {
  background: radial-gradient(ellipse at 0% 50%, rgba(255, 255, 255, 0.16), rgba(255, 255, 255, 0.04) 70%, transparent);
}
.vp-ripple-r {
  background: radial-gradient(
    ellipse at 100% 50%,
    rgba(255, 255, 255, 0.16),
    rgba(255, 255, 255, 0.04) 70%,
    transparent
  );
}
.vp-chevrons > span {
  animation: vp-chevron 600ms ease-out both;
}
@keyframes vp-chevron {
  0% {
    opacity: 0.15;
  }
  40% {
    opacity: 1;
  }
  100% {
    opacity: 0.15;
  }
}

.vp-edge {
  transition: top var(--dur-slow) var(--ease-out);
}

.vp-osd {
  animation: vp-osd 220ms var(--ease-spring) both;
}
@keyframes vp-osd {
  from {
    opacity: 0;
    transform: scale(0.9);
  }
}

.vp-card {
  animation: ph-rise var(--dur-slow) var(--ease-out) both;
}

.vp-ring {
  stroke-dashoffset: var(--ring);
  animation: vp-ring 5s linear forwards;
}
@keyframes vp-ring {
  to {
    stroke-dashoffset: 0;
  }
}
</style>
