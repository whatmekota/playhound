<script setup lang="ts">
import type { VideoEntry } from '~/stores/libraryStore'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useLoopSection } from '~/composables/useLoopSection'
import { useVideoSync } from '~/composables/useVideoSync'
import { formatTime } from '~/lib/time'
import { useLibraryStore } from '~/stores/libraryStore'
import { usePlayerStore } from '~/stores/playerStore'
import { useQueueStore } from '~/stores/queueStore'
import { useScriptStore } from '~/stores/scriptStore'
import SbsViewer from './SbsViewer.vue'

const emit = defineEmits<{ ended: [], select: [entry: VideoEntry], queue: [entries: VideoEntry[], selected: VideoEntry] }>()
const playerStore = usePlayerStore()
const scriptStore = useScriptStore()
const queueStore = useQueueStore()
const library = useLibraryStore()
const { attach, start, stop, onSeeked } = useVideoSync()
const { checkLoop } = useLoopSection()

// ─── Fullscreen sidebar ───────────────────────────────────────────────────────
const fsSidebarHover = ref(false)
const fsSidebarSearch = ref('')
const fsSidebarFiltered = computed(() => {
  const q = fsSidebarSearch.value.toLowerCase()
  return q ? library.videos.filter(v => v.basename.toLowerCase().includes(q)) : library.videos
})

const videoEl = ref<HTMLVideoElement | null>(null)
const containerEl = ref<HTMLDivElement | null>(null)
const isBuffering = ref(false)

function onWaiting() { isBuffering.value = true }
function onCanPlay() { isBuffering.value = false }
function onLoadStart() { isBuffering.value = true }

// ─── Fullscreen overlay seek bar ──────────────────────────────────────────────
const fsBarEl = ref<HTMLDivElement | null>(null)
const fsCanvasEl = ref<HTMLCanvasElement | null>(null)
const fsHover = ref(false) // bottom-zone hover → expand bar
const fsDragging = ref(false)

function drawFsBar() {
  const canvas = fsCanvasEl.value
  if (!canvas)
    return
  const ctx = canvas.getContext('2d')
  if (!ctx)
    return
  const W = canvas.width; const H = canvas.height
  ctx.clearRect(0, 0, W, H)
  const duration = playerStore.videoDuration
  if (duration === 0)
    return

  // background track
  ctx.fillStyle = 'rgba(255,255,255,0.15)'
  ctx.fillRect(0, 0, W, H)

  // funscript waveform
  const primary = scriptStore.primaryScript
  if (primary && primary.parsed.actions.length > 0) {
    const actions = primary.parsed.actions
    ctx.beginPath()
    ctx.strokeStyle = 'rgba(217, 70, 239, 0.7)'
    ctx.lineWidth = 1.5
    for (let i = 0; i < actions.length; i++) {
      const x = (actions[i].at / (duration * 1000)) * W
      const y = H - actions[i].pos * H
      if (i === 0)
        ctx.moveTo(x, y); else ctx.lineTo(x, y)
    }
    ctx.stroke()
  }

  // loop region
  if (playerStore.loopStart !== null && playerStore.loopEnd !== null) {
    const lx0 = (playerStore.loopStart / duration) * W
    const lx1 = (playerStore.loopEnd / duration) * W
    ctx.fillStyle = 'rgba(217, 70, 239, 0.18)'
    ctx.fillRect(lx0, 0, lx1 - lx0, H)
    ctx.strokeStyle = 'rgba(217, 70, 239, 0.9)'
    ctx.lineWidth = 2
    ctx.beginPath(); ctx.moveTo(lx0, 0); ctx.lineTo(lx0, H)
    ctx.moveTo(lx1, 0); ctx.lineTo(lx1, H); ctx.stroke()
  }

  // played fill
  const px = (playerStore.currentTime / duration) * W
  ctx.fillStyle = 'rgba(217, 70, 239, 0.45)'
  ctx.fillRect(0, 0, px, H)

  // playhead
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = 2
  ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke()
  if (fsHover.value) {
    ctx.fillStyle = '#fff'
    ctx.beginPath(); ctx.arc(px, H / 2, 6, 0, Math.PI * 2); ctx.fill()
  }
}

watch(
  [() => playerStore.currentTime, () => playerStore.loopStart, () => playerStore.loopEnd, () => scriptStore.primaryScript, () => playerStore.videoDuration, fsHover],
  drawFsBar,
  { flush: 'post' },
)

function fsPosToTime(clientX: number) {
  if (!fsCanvasEl.value)
    return 0
  const rect = fsCanvasEl.value.getBoundingClientRect()
  return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * playerStore.videoDuration
}

function onFsBarMouseDown(e: MouseEvent) {
  if (e.button !== 0)
    return
  fsDragging.value = true
  const t = fsPosToTime(e.clientX)
  seek(t)
  playerStore.showControls()
}

function onFsBarMouseMove(e: MouseEvent) {
  if (fsDragging.value) {
    seek(fsPosToTime(e.clientX))
    playerStore.showControls()
  }
}

function onFsBarMouseUp() { fsDragging.value = false }

// resize canvas when bar is shown / window resizes
let fsResizeObs: ResizeObserver | null = null

// ─── Video event handlers ─────────────────────────────────────────────────────

function onLoadedMetadata() {
  if (!videoEl.value)
    return
  playerStore.videoDuration = videoEl.value.duration
}

function onTimeUpdate() {
  if (!videoEl.value)
    return
  playerStore.currentTime = videoEl.value.currentTime

  // A-B loop check
  const seekTo = checkLoop(videoEl.value.currentTime)
  if (seekTo !== null) {
    videoEl.value.currentTime = seekTo
  }
}

function onPlay() {
  playerStore.isPlaying = true
  start()
}

function onPause() {
  playerStore.isPlaying = false
  stop()
}

function onEnded() {
  playerStore.isPlaying = false
  stop()
  emit('ended')
}

function onSeekedEvent() {
  onSeeked()
}

// ─── Public API (called from controls) ───────────────────────────────────────

function play() {
  videoEl.value?.play()
}

function pause() {
  videoEl.value?.pause()
}

function togglePlay() {
  if (!videoEl.value)
    return
  if (videoEl.value.paused)
    videoEl.value.play()
  else videoEl.value.pause()
}

function seek(seconds: number) {
  if (!videoEl.value)
    return
  videoEl.value.currentTime = Math.max(0, Math.min(playerStore.videoDuration, seconds))
}

function seekRelative(delta: number) {
  seek(playerStore.currentTime + delta)
}

function setSpeed(speed: number) {
  if (!videoEl.value)
    return
  playerStore.playbackSpeed = speed
  videoEl.value.playbackRate = speed
}

function setVolume(vol: number) {
  if (!videoEl.value)
    return
  playerStore.volume = vol
  videoEl.value.volume = vol
  if (vol > 0)
    playerStore.isMuted = false
}

function toggleMute() {
  if (!videoEl.value)
    return
  playerStore.isMuted = !playerStore.isMuted
  videoEl.value.muted = playerStore.isMuted
}

// ─── Keyboard shortcuts ───────────────────────────────────────────────────────

function onKeyDown(e: KeyboardEvent) {
  // Don't capture if focus is in an input
  if ((e.target as HTMLElement).tagName === 'INPUT')
    return

  switch (e.code) {
    case 'Space':
      e.preventDefault()
      togglePlay()
      break
    case 'ArrowRight':
      e.preventDefault()
      seekRelative(e.shiftKey ? 30 : 5)
      break
    case 'ArrowLeft':
      e.preventDefault()
      seekRelative(e.shiftKey ? -30 : -5)
      break
    case 'ArrowUp':
      e.preventDefault()
      setVolume(Math.min(1, playerStore.volume + 0.05))
      break
    case 'ArrowDown':
      e.preventDefault()
      setVolume(Math.max(0, playerStore.volume - 0.05))
      break
    case 'KeyM':
      toggleMute()
      break
    case 'KeyF':
      toggleFullscreen()
      break
    case 'BracketRight': // ] → speed up
      e.preventDefault()
      setSpeed(Math.min(4.0, Math.round((playerStore.playbackSpeed + 0.25) * 100) / 100))
      showSpeedOsd()
      break
    case 'BracketLeft': // [ → slow down
      e.preventDefault()
      setSpeed(Math.max(0.25, Math.round((playerStore.playbackSpeed - 0.25) * 100) / 100))
      showSpeedOsd()
      break
    case 'Backslash': // \ → reset speed
      e.preventDefault()
      setSpeed(1.0)
      showSpeedOsd()
      break
  }
}

// ─── Speed OSD ────────────────────────────────────────────────────────────────
const speedOsd = ref(false)
let speedOsdTimer: ReturnType<typeof setTimeout> | null = null
function showSpeedOsd() {
  speedOsd.value = true
  if (speedOsdTimer)
    clearTimeout(speedOsdTimer)
  speedOsdTimer = setTimeout(() => { speedOsd.value = false }, 1200)
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    containerEl.value?.requestFullscreen()
    playerStore.isFullscreen = true
  }
  else {
    document.exitFullscreen()
    playerStore.isFullscreen = false
  }
}

// ─── Watch for external store changes ────────────────────────────────────────

watch(() => playerStore.playbackSpeed, (speed) => {
  if (videoEl.value)
    videoEl.value.playbackRate = speed
})

watch(() => playerStore.volume, (vol) => {
  if (videoEl.value)
    videoEl.value.volume = vol
})

watch(() => playerStore.isMuted, (muted) => {
  if (videoEl.value)
    videoEl.value.muted = muted
})

// ─── Lifecycle ────────────────────────────────────────────────────────────────

onMounted(() => {
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('mouseup', onFsBarMouseUp)
  window.addEventListener('mousemove', onFsBarMouseMove)
  document.addEventListener('fullscreenchange', () => {
    playerStore.isFullscreen = !!document.fullscreenElement
    setTimeout(() => {
      if (fsCanvasEl.value && fsBarEl.value) {
        fsCanvasEl.value.width = fsBarEl.value.clientWidth
        fsCanvasEl.value.height = fsBarEl.value.clientHeight
        drawFsBar()
      }
    }, 50)
  })
})

// Re-attach useVideoSync every time the <video> element is created/replaced
// (it's v-if'd on videoUrl, so it's a new DOM node on each video load)
watch(videoEl, (el) => {
  if (el) {
    isBuffering.value = true // new element = new video loading
    attach(el)
    el.volume = playerStore.volume
    el.muted = playerStore.isMuted
    el.playbackRate = playerStore.playbackSpeed
  }
})

watch(fsBarEl, (el) => {
  fsResizeObs?.disconnect()
  if (el) {
    fsResizeObs = new ResizeObserver(() => {
      if (fsCanvasEl.value) {
        fsCanvasEl.value.width = el.clientWidth
        fsCanvasEl.value.height = el.clientHeight
        drawFsBar()
      }
    })
    fsResizeObs.observe(el)
    if (fsCanvasEl.value) {
      fsCanvasEl.value.width = el.clientWidth
      fsCanvasEl.value.height = el.clientHeight
      drawFsBar()
    }
  }
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('mouseup', onFsBarMouseUp)
  window.removeEventListener('mousemove', onFsBarMouseMove)
  fsResizeObs?.disconnect()
  stop()
})

defineExpose({ play, pause, togglePlay, seek, seekRelative, setSpeed, setVolume, toggleMute, toggleFullscreen })
</script>

<template>
  <div
    ref="containerEl"
    class="bg-black flex h-full w-full items-center justify-center relative overflow-hidden"
    @mousemove="playerStore.showControls()"
    @dblclick.prevent="toggleFullscreen()"
  >
    <!-- No video loaded state -->
    <div
      v-if="!playerStore.videoUrl"
      class="text-white/30 flex flex-col gap-3 pointer-events-none select-none items-center"
    >
      <svg class="opacity-30 h-20 w-20" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          stroke-linecap="round" stroke-linejoin="round" stroke-width="1"
          d="M15 10l4.553-2.276A1 1 0 0121 8.723v6.554a1 1 0 01-1.447.894L15 14M3 8a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z"
        />
      </svg>
      <p class="text-sm">
        Drop a video file here, or use Open above
      </p>
    </div>

    <!-- Video element — hidden visually (but alive) when SBS 180° is on -->
    <video
      v-if="playerStore.videoUrl"
      ref="videoEl"
      class="h-full w-full object-contain"
      :class="{ 'invisible absolute': playerStore.sbs180 }"
      :src="playerStore.videoUrl"
      :volume="playerStore.volume"
      :muted="playerStore.isMuted"
      preload="metadata"
      @loadedmetadata="onLoadedMetadata"
      @timeupdate="onTimeUpdate"
      @play="onPlay"
      @pause="onPause"
      @ended="onEnded"
      @seeked="onSeekedEvent"
      @waiting="onWaiting"
      @canplay="onCanPlay"
      @loadstart="onLoadStart"
      @click.stop="togglePlay()"
    />

    <!-- 180° SBS Three.js viewer overlaid on top of the hidden video -->
    <SbsViewer
      v-if="playerStore.sbs180 && playerStore.videoUrl"
      :video-el="videoEl"
      class="inset-0 absolute z-10"
      @click="togglePlay()"
      @dblclick="toggleFullscreen()"
      @mousemove="playerStore.showControls()"
    />

    <!-- Pause overlay indicator (brief flash) -->
    <Transition name="fade-quick">
      <div
        v-if="!playerStore.isPlaying && playerStore.videoUrl"
        class="flex pointer-events-none items-center inset-0 justify-center absolute"
      >
        <div class="p-5 rounded-full bg-black/40">
          <svg class="text-white h-10 w-10" fill="currentColor" viewBox="0 0 24 24">
            <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
          </svg>
        </div>
      </div>
    </Transition>

    <!-- Speed OSD -->
    <Transition name="fade-quick">
      <div v-if="speedOsd" class="text-sm text-white font-mono px-3 py-1.5 rounded-lg bg-black/60 pointer-events-none right-4 top-4 absolute">
        {{ playerStore.playbackSpeed }}×
      </div>
    </Transition>

    <!-- Buffering spinner -->
    <Transition name="fade-quick">
      <div
        v-if="isBuffering && playerStore.videoUrl"
        class="flex flex-col gap-3 pointer-events-none items-center inset-0 justify-center absolute"
      >
        <div class="px-6 py-4 rounded-2xl bg-black/50 flex flex-col gap-3 items-center">
          <div class="border-2 border-white/20 border-t-white/80 rounded-full h-10 w-10 animate-spin" />
          <span class="text-xs text-white/70 tracking-wide font-medium">Buffering…</span>
        </div>
      </div>
    </Transition>

    <!-- ─── Fullscreen overlay controls ──────────────────────────────────── -->
    <Transition name="fs-bar">
      <div
        v-if="playerStore.isFullscreen && playerStore.videoUrl"
        class="group/fsbar bottom-0 left-0 right-0 absolute z-30"
        @mouseenter="fsHover = true; playerStore.showControls()"
        @mouseleave="fsHover = false"
      >
        <!-- gradient backdrop — expands with the bar -->
        <div
          class="pointer-events-none transition-all duration-200 inset-0 absolute from-black/80 to-transparent via-black/30 bg-gradient-to-t"
          :class="fsHover || !playerStore.isPlaying ? 'h-full' : 'h-16'"
        />

        <!-- Controls row — shown when hovering or paused -->
        <Transition name="fade-quick">
          <div
            v-if="fsHover || !playerStore.isPlaying"
            class="text-white px-4 pb-2 pt-1 flex gap-2 select-none items-center relative"
          >
            <!-- Prev -->
            <button
              class="rounded flex shrink-0 h-7 w-7 transition-colors items-center justify-center hover:bg-white/20 disabled:opacity-30"
              :disabled="!queueStore.hasPrev" @click.stop="$emit('ended')"
            >
              <svg class="h-4 w-4" fill="currentColor" viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" /></svg>
            </button>

            <!-- Play/Pause -->
            <button
              class="rounded-full flex shrink-0 h-8 w-8 transition-colors items-center justify-center hover:bg-white/20"
              @click.stop="togglePlay()"
            >
              <svg v-if="!playerStore.isPlaying" class="ml-0.5 h-5 w-5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
              <svg v-else class="h-5 w-5" fill="currentColor" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" /></svg>
            </button>

            <!-- Next -->
            <button
              class="rounded flex shrink-0 h-7 w-7 transition-colors items-center justify-center hover:bg-white/20 disabled:opacity-30"
              :disabled="!queueStore.hasNext" @click.stop="$emit('ended')"
            >
              <svg class="h-4 w-4" fill="currentColor" viewBox="0 0 24 24"><path d="M6 18l8.5-6L6 6v12zm2.5-6l5.5 4V8z" /><path d="M16 6h2v12h-2z" /></svg>
            </button>

            <!-- Time -->
            <span class="text-xs text-white/80 font-mono shrink-0">
              {{ formatTime(playerStore.currentTime) }} / {{ formatTime(playerStore.videoDuration) }}
            </span>

            <div class="flex-1" />

            <!-- Shuffle indicator -->
            <button
              class="rounded flex shrink-0 h-7 w-7 transition-colors items-center justify-center"
              :class="queueStore.shuffle ? 'text-accent-400 bg-accent-600/20' : 'hover:bg-white/20 text-white/50'"
              @click.stop="queueStore.setShuffle(!queueStore.shuffle)"
            >
              <svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4" />
              </svg>
            </button>

            <!-- Speed badge -->
            <span v-if="playerStore.playbackSpeed !== 1" class="text-xs text-accent-400 font-mono shrink-0">
              {{ playerStore.playbackSpeed }}×
            </span>

            <!-- Mute -->
            <button
              class="rounded flex shrink-0 h-7 w-7 transition-colors items-center justify-center hover:bg-white/20"
              @click.stop="toggleMute()"
            >
              <svg v-if="playerStore.isMuted || playerStore.volume === 0" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15zM17 14l-4-4m0 4l4-4" />
              </svg>
              <svg v-else class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5L6 9H2v6h4l5 4V5zM19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07" />
              </svg>
            </button>

            <!-- Exit fullscreen -->
            <button
              class="rounded flex shrink-0 h-7 w-7 transition-colors items-center justify-center hover:bg-white/20"
              @click.stop="toggleFullscreen()"
            >
              <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 9L4 4m0 0v4m0-4h4M15 9l5-5m0 0v4m0-4h-4M9 15l-5 5m0 0v-4m0 4h4M15 15l5 5m0 0v-4m0 4h-4" />
              </svg>
            </button>
          </div>
        </Transition>

        <!-- Seek bar -->
        <div
          ref="fsBarEl"
          class="w-full cursor-pointer transition-all duration-200 ease-out relative"
          :class="fsHover || !playerStore.isPlaying ? 'h-10' : 'h-1'"
          @mousedown.stop="onFsBarMouseDown"
        >
          <canvas ref="fsCanvasEl" class="h-full w-full inset-0 absolute" />
        </div>
      </div>
    </Transition>

    <!-- ─── Fullscreen right sidebar (library) ────────────────────────────── -->
    <Transition name="fs-sidebar">
      <div
        v-if="playerStore.isFullscreen && library.hasVideos"
        class="flex bottom-0 right-0 top-0 absolute z-40"
        @mouseenter="fsSidebarHover = true; playerStore.showControls()"
        @mouseleave="fsSidebarHover = false"
      >
        <!-- Hover trigger strip -->
        <div class="h-full w-3" />

        <!-- Sidebar panel — slides in on hover -->
        <Transition name="fs-sidebar-panel">
          <div
            v-if="fsSidebarHover"
            class="border-l border-white/10 bg-black/85 flex flex-col h-full w-72 shadow-2xl backdrop-blur-md"
          >
            <!-- Header -->
            <div class="px-3 py-2 border-b border-white/10 flex shrink-0 gap-2 items-center">
              <svg class="text-white/40 h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 10h16M4 14h16M4 18h16" /></svg>
              <span class="text-xs text-white/60 font-medium flex-1">Library</span>
              <span class="text-[10px] text-white/25">{{ library.videos.length }} videos</span>
            </div>
            <!-- Search -->
            <div class="px-2 py-1.5 border-b border-white/5 shrink-0">
              <input v-model="fsSidebarSearch" type="text" placeholder="Search…" class="input text-xs py-1 h-7 w-full" @click.stop>
            </div>
            <!-- List -->
            <div class="flex-1 overflow-y-auto" @click.stop>
              <div
                v-for="entry in fsSidebarFiltered" :key="entry.name"
                class="group px-3 py-2 border-b border-white/[0.04] flex gap-2 cursor-pointer transition-colors items-center hover:bg-white/10"
                :class="playerStore.videoPath?.endsWith(entry.name) ? 'bg-accent-600/20' : ''"
                @click.stop="emit('select', entry); emit('queue', fsSidebarFiltered, entry)"
              >
                <div class="rounded bg-surface-800 shrink-0 h-7 w-12 overflow-hidden">
                  <img v-if="entry.thumbnailUrl" :src="entry.thumbnailUrl" class="h-full w-full object-cover">
                  <div v-else class="flex h-full w-full items-center justify-center">
                    <svg class="text-white/15 h-3 w-3" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
                  </div>
                </div>
                <div class="flex-1 min-w-0">
                  <p class="text-[11px] text-white/70 truncate transition-colors group-hover:text-white">
                    {{ entry.basename }}
                  </p>
                  <div class="mt-0.5 flex gap-1 items-center">
                    <span v-if="entry.hasScript" class="text-accent-300 text-[9px]">✦</span>
                    <span class="text-[9px] text-white/25">{{ (entry.file.size / 1024 / 1024).toFixed(0) }}MB</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </Transition>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.fade-quick-enter-active,
.fade-quick-leave-active {
  transition: opacity 0.15s;
}
.fade-quick-enter-from,
.fade-quick-leave-to {
  opacity: 0;
}
.fs-bar-enter-active,
.fs-bar-leave-active {
  transition: opacity 0.3s ease;
}
.fs-bar-enter-from,
.fs-bar-leave-to {
  opacity: 0;
}
.fs-sidebar-panel-enter-active,
.fs-sidebar-panel-leave-active {
  transition:
    transform 0.2s ease,
    opacity 0.2s ease;
}
.fs-sidebar-panel-enter-from,
.fs-sidebar-panel-leave-to {
  transform: translateX(100%);
  opacity: 0;
}
</style>
