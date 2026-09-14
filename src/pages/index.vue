<script setup lang="ts">
import type { PanelId } from '~/lib/panels'
import type { ScriptMatch, VideoEntry } from '~/stores/libraryStore'
import { useLocalStorage } from '@vueuse/core'
import { computed, onMounted, ref, watch } from 'vue'
import FunscriptTimeline from '~/components/FunscriptTimeline.vue'
import LoopControls from '~/components/LoopControls.vue'
import OsrEmulator from '~/components/OsrEmulator.vue'
import PanelHost from '~/components/PanelHost.vue'
import PanelRail from '~/components/PanelRail.vue'
import PanicCover from '~/components/PanicCover.vue'
import ScriptOffsetControl from '~/components/ScriptOffsetControl.vue'
import SerialLogViewer from '~/components/SerialLogViewer.vue'
import SpeedControl from '~/components/SpeedControl.vue'
import SplashScreen from '~/components/SplashScreen.vue'
import StatusBar from '~/components/StatusBar.vue'
import ThemePicker from '~/components/ThemePicker.vue'
import VideoPlayer from '~/components/VideoPlayer.vue'
import { useAutoDirector } from '~/composables/useAutoDirector'
import { useFunscript } from '~/composables/useFunscript'
import { useGamepad } from '~/composables/useGamepad'
import { useMotionEngine } from '~/composables/useMotionEngine'
import { useSafety } from '~/composables/useSafety'
import { useScriptPulse } from '~/composables/useScriptPulse'
import { useSessionAudio } from '~/composables/useSessionAudio'
import { openVideoFile, storage } from '~/lib/browserApi'
import { findPanel, isMainSurface, isOverlaySurface } from '~/lib/panels'
import { formatTime } from '~/lib/time'
import { useBookmarkStore } from '~/stores/bookmarkStore'
import { useDeviceStore } from '~/stores/deviceStore'
import { useLibraryStore } from '~/stores/libraryStore'
import { useMotionStore } from '~/stores/motionStore'
import { usePlayerStore } from '~/stores/playerStore'
import { useQueueStore } from '~/stores/queueStore'
import { useSafetyStore } from '~/stores/safetyStore'
import { useScriptStore } from '~/stores/scriptStore'
import { useStatsStore } from '~/stores/statsStore'

defineOptions({ name: 'IndexPage' })

const playerStore = usePlayerStore()
const library = useLibraryStore()
const deviceStore = useDeviceStore()
const scriptStore = useScriptStore()
const queueStore = useQueueStore()
const statsStore = useStatsStore()
const bookmarkStore = useBookmarkStore()
const motionStore = useMotionStore()
const safety = useSafetyStore()
const director = useAutoDirector()
const showHeatmap = useLocalStorage('ph-timeline-heatmap', true)
const { autoDetectFromFiles, lastRawMetadata } = useFunscript()

// Instantiate these once at the shell level so they keep running no matter
// which panel happens to be open.
useMotionEngine()
useSessionAudio()
useScriptPulse()

const videoPlayerRef = ref<InstanceType<typeof VideoPlayer> | null>(null)
const showKeybinds = ref(false)
// Panic needs to reach video, audio and the device at once.
const { toggle: togglePanic, resume: resumePanic } = useSafety({
  pauseVideo: () => videoPlayerRef.value?.pause(),
  playVideo: () => videoPlayerRef.value?.play(),
  isVideoPlaying: () => playerStore.isPlaying,
})

// Gamepad: transport on the buttons, stroke rate or position on the sticks.
useGamepad({
  next: () => playNext(),
  prev: () => playPrev(),
  random: () => randomVideo(),
  togglePlay: () => togglePlay(),
  panic: () => togglePanic(),
})

// ─── Panels ───────────────────────────────────────────────────────────────────
const activePanel = ref<PanelId | null>('library')
const pinnedPanel = ref<PanelId | null>(null)

/** Floating windows layered over whatever view is open. */
const overlayPanels = ref<PanelId[]>([])
const emuModel = ref<'OSR2' | 'SR6'>('OSR2')

function isOverlayOpen(id: PanelId) {
  return overlayPanels.value.includes(id)
}

function toggleOverlay(id: PanelId) {
  const i = overlayPanels.value.indexOf(id)
  if (i >= 0)
    overlayPanels.value.splice(i, 1)
  else
    overlayPanels.value.push(id)
}

/** Canvas panels (media wall, slideshow) replace the player instead of being
 *  squeezed into the sidebar. */
const mainPanel = computed(() => (isMainSurface(activePanel.value) ? activePanel.value : null))
const sidePanel = computed(() => (isMainSurface(activePanel.value) ? null : activePanel.value))
const showSidebar = computed(() => sidePanel.value !== null || pinnedPanel.value !== null)

function selectPanel(id: PanelId) {
  // Floating windows toggle in place; they never take over a slot.
  if (isOverlaySurface(id)) {
    toggleOverlay(id)
    return
  }
  // Clicking the pinned panel's own icon focuses it rather than stacking twice.
  if (pinnedPanel.value === id) {
    pinnedPanel.value = null
    activePanel.value = id
    return
  }
  activePanel.value = activePanel.value === id ? null : id
}

function togglePin(id: PanelId) {
  if (isOverlaySurface(id)) {
    toggleOverlay(id)
    return
  }
  // Canvas panels cannot be pinned into the sidebar strip.
  if (isMainSurface(id)) {
    activePanel.value = id
    return
  }
  if (pinnedPanel.value === id) {
    pinnedPanel.value = null
    return
  }
  pinnedPanel.value = id
  if (activePanel.value === id)
    activePanel.value = null
}

function closePanel(id: PanelId) {
  if (isOverlaySurface(id)) {
    overlayPanels.value = overlayPanels.value.filter(o => o !== id)
    return
  }
  if (pinnedPanel.value === id)
    pinnedPanel.value = null
  else if (activePanel.value === id)
    activePanel.value = null
}

// ─── Resizable sidebar ────────────────────────────────────────────────────────
const sidebarWidth = ref(320)
const SIDEBAR_MIN = 220
const SIDEBAR_MAX = 600
let sidebarDragStart: { mx: number, w: number } | null = null

function onSidebarDragDown(e: MouseEvent) {
  e.preventDefault()
  sidebarDragStart = { mx: e.clientX, w: sidebarWidth.value }
  window.addEventListener('mousemove', onSidebarDragMove)
  window.addEventListener('mouseup', onSidebarDragUp)
}
function onSidebarDragMove(e: MouseEvent) {
  if (!sidebarDragStart)
    return
  // Sidebar sits on the right, so dragging left widens it.
  sidebarWidth.value = Math.max(
    SIDEBAR_MIN,
    Math.min(SIDEBAR_MAX, sidebarDragStart.w - (e.clientX - sidebarDragStart.mx)),
  )
}
function onSidebarDragUp() {
  sidebarDragStart = null
  window.removeEventListener('mousemove', onSidebarDragMove)
  window.removeEventListener('mouseup', onSidebarDragUp)
}

/** Height split between the pinned panel and the active one, as a percentage. */
const pinnedHeight = ref(45)
let splitDragStart: { my: number, h: number, total: number } | null = null

function onSplitDragDown(e: MouseEvent) {
  e.preventDefault()
  const host = (e.target as HTMLElement).parentElement
  splitDragStart = { my: e.clientY, h: pinnedHeight.value, total: host?.clientHeight ?? 600 }
  window.addEventListener('mousemove', onSplitDragMove)
  window.addEventListener('mouseup', onSplitDragUp)
}
function onSplitDragMove(e: MouseEvent) {
  if (!splitDragStart)
    return
  const delta = ((e.clientY - splitDragStart.my) / splitDragStart.total) * 100
  pinnedHeight.value = Math.max(20, Math.min(80, splitDragStart.h + delta))
}
function onSplitDragUp() {
  splitDragStart = null
  window.removeEventListener('mousemove', onSplitDragMove)
  window.removeEventListener('mouseup', onSplitDragUp)
}

// ─── Persist UI state ─────────────────────────────────────────────────────────
interface UiState {
  sidebarWidth?: number
  activePanel?: PanelId | null
  pinnedPanel?: PanelId | null
  pinnedHeight?: number
  overlayPanels?: PanelId[]
  emuModel?: 'OSR2' | 'SR6'
  motion?: unknown
}

onMounted(() => {
  const ui = storage.get<UiState>('uiState')
  if (ui) {
    if (ui.sidebarWidth)
      sidebarWidth.value = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, ui.sidebarWidth))
    if (ui.activePanel !== undefined)
      activePanel.value = ui.activePanel ?? null
    if (ui.pinnedPanel !== undefined)
      pinnedPanel.value = ui.pinnedPanel ?? null
    if (typeof ui.pinnedHeight === 'number')
      pinnedHeight.value = Math.max(20, Math.min(80, ui.pinnedHeight))
    if (Array.isArray(ui.overlayPanels))
      overlayPanels.value = ui.overlayPanels
    if (ui.emuModel === 'OSR2' || ui.emuModel === 'SR6')
      emuModel.value = ui.emuModel
    if (ui.motion)
      motionStore.deserialize(ui.motion)
  }
  window.addEventListener('keydown', onGlobalKeyDown)
})

watch(
  [sidebarWidth, activePanel, pinnedPanel, pinnedHeight, overlayPanels, emuModel, () => motionStore.serialize()],
  () => {
    storage.set('uiState', {
      sidebarWidth: sidebarWidth.value,
      activePanel: activePanel.value,
      pinnedPanel: pinnedPanel.value,
      pinnedHeight: pinnedHeight.value,
      overlayPanels: overlayPanels.value,
      emuModel: emuModel.value,
      motion: motionStore.serialize(),
    })
  },
  { deep: true },
)

// ─── Library / playback ───────────────────────────────────────────────────────
async function onVideoSelected(entry: VideoEntry) {
  await loadVideoFile(entry.file, entry.scriptMatches, true)
}

function onQueue(entries: VideoEntry[], selected: VideoEntry) {
  queueStore.setQueue(entries, selected)
}

function randomVideo() {
  const pool = library.videos.filter(v => v.hasScript)
  if (!pool.length)
    return
  queueStore.setShuffle(true)
  queueStore.setQueue(pool, pool[Math.floor(Math.random() * pool.length)])
  const current = queueStore.current
  if (current)
    onVideoSelected(current)
}

async function openSingleVideo() {
  try {
    const file = await openVideoFile()
    if (file)
      await loadVideoFile(file, [], false)
  }
  catch (err) {
    console.error('Failed to open video:', err)
  }
}

/**
 * The director chooses by script shape rather than queue order, falling back to
 * the queue when it has nothing analysed to choose between.
 */
function directedNext() {
  if (!director.enabled.value)
    return null
  return director.pickNext(playerStore.videoPath ?? undefined)
}

async function onVideoEnded() {
  const picked = directedNext()
  if (picked) {
    await loadVideoFile(picked.file, picked.scriptMatches, true)
    return
  }
  const next = queueStore.next()
  if (next)
    await loadVideoFile(next.file, next.scriptMatches, true)
}

async function playNext() {
  const picked = directedNext()
  if (picked) {
    await loadVideoFile(picked.file, picked.scriptMatches, true)
    return
  }
  const next = queueStore.next()
  if (next)
    await loadVideoFile(next.file, next.scriptMatches, true)
}

async function playPrev() {
  const prev = queueStore.prev()
  if (prev)
    await loadVideoFile(prev.file, prev.scriptMatches, true)
}

async function loadVideoFile(file: File, scriptMatches?: ScriptMatch[], autoplay = false) {
  try {
    if (playerStore.videoUrl?.startsWith('blob:'))
      URL.revokeObjectURL(playerStore.videoUrl)

    const url = URL.createObjectURL(file)
    playerStore.setVideo(file.name, url)
    playerStore.clearLoop()
    await autoDetectFromFiles(file, scriptMatches ?? [])

    // A single .funscript yielding several axes means a merged script — flag the
    // library entry so the badge and glow render correctly.
    const uniqueFiles = new Set(scriptStore.scripts.map(s => s.filename))
    const isMerged = uniqueFiles.size === 1 && scriptStore.scripts.length > 1
    const libEntry = library.videos.find(v => v.file === file)
    if (libEntry) {
      if (isMerged) {
        libEntry.scriptType = 'merged'
        libEntry.scriptCount = Math.max(libEntry.scriptCount, scriptStore.scripts.length)
      }
      if (!libEntry.scriptMeta && lastRawMetadata.value) {
        const fm = lastRawMetadata.value
        libEntry.scriptMeta = {
          tags: Array.isArray(fm.topic_tags) ? (fm.topic_tags as string[]) : undefined,
          creator: typeof fm.topic_creator === 'string' ? fm.topic_creator : undefined,
          date: typeof fm.topic_date === 'string' ? fm.topic_date : undefined,
          url: typeof fm.topic_url === 'string' ? fm.topic_url : undefined,
        }
      }
    }

    // Enable a device axis for every loaded script so emulator and hardware agree.
    for (const s of scriptStore.scripts) {
      if (s.enabled && deviceStore.axisConfigs[s.channel])
        deviceStore.axisConfigs[s.channel].enabled = true
    }

    // Learn this video's shape as a side effect of playing it, so the
    // director gets smarter without anyone running a sweep.
    if (libEntry)
      void director.summarise(libEntry)

    if (autoplay)
      setTimeout(() => videoPlayerRef.value?.play(), 80)
  }
  catch (err) {
    console.error('Failed to load video:', err)
  }
}

// ─── Drag and drop ────────────────────────────────────────────────────────────
function onDragOver(e: DragEvent) {
  e.preventDefault()
}

const COLLECT_DIR_MAX = 5000

async function collectDir(entry: any, out: File[]) {
  if (out.length >= COLLECT_DIR_MAX)
    return
  if (entry.isFile) {
    await new Promise<void>(r => entry.file((f: File) => {
      out.push(f)
      r()
    }))
  }
  else if (entry.isDirectory) {
    const reader = entry.createReader()
    // readEntries yields at most 100 per call, so loop until it comes back empty.
    let batch: any[]
    do {
      batch = await new Promise<any[]>(r => reader.readEntries(r))
      for (const e of batch) {
        if (out.length >= COLLECT_DIR_MAX)
          break
        await collectDir(e, out)
      }
    } while (batch.length > 0 && out.length < COLLECT_DIR_MAX)
  }
}

async function onDrop(e: DragEvent) {
  e.preventDefault()
  const files: File[] = []
  try {
    for (const item of Array.from(e.dataTransfer?.items ?? [])) {
      if (item.kind !== 'file')
        continue
      const entry = item.webkitGetAsEntry?.()
      if (entry?.isDirectory) {
        await collectDir(entry as any, files)
      }
      else {
        const f = item.getAsFile()
        if (f)
          files.push(f)
      }
    }

    if (files.length) {
      const videoFiles = files.filter(f => /\.(?:mp4|mkv|webm|avi|mov|m4v|wmv|flv)$/i.test(f.name))
      if (videoFiles.length > 1 || (files.length > 1 && videoFiles.length)) {
        await library.setFiles(files)
        activePanel.value = 'library'
      }
      else if (videoFiles.length === 1) {
        await library.setFiles(files)
        const entry = library.videos.find(v => v.name === videoFiles[0].name)
        await loadVideoFile(videoFiles[0], entry?.scriptMatches ?? [])
      }
    }
  }
  catch (err) {
    console.error('Failed to handle dropped files:', err)
  }
}

// ─── Transport ────────────────────────────────────────────────────────────────
function togglePlay() {
  videoPlayerRef.value?.togglePlay()
}
function seek(t: number) {
  videoPlayerRef.value?.seek(t)
}
function seekRelative(d: number) {
  videoPlayerRef.value?.seekRelative(d)
}
function setSpeed(s: number) {
  videoPlayerRef.value?.setSpeed(s)
}
function toggleFullscreen() {
  videoPlayerRef.value?.toggleFullscreen()
}
function seekFromBookmark(t: number) {
  seek(t)
}

function updateVolumeFill(e: Event) {
  const el = e.target as HTMLInputElement
  const pct = (Number.parseFloat(el.value) / Number.parseFloat(el.max)) * 100
  el.style.setProperty('--pct', `${pct}%`)
  videoPlayerRef.value?.setVolume(Number.parseFloat(el.value))
}

function starCurrentVideo() {
  if (!playerStore.videoPath)
    return
  const name = playerStore.videoPath.split(/[\\/]/).pop() ?? playerStore.videoPath
  const entry = library.videos.find(v => v.name === name)
  if (entry)
    library.toggleStar(entry)
}

const currentStarred = computed(() => {
  if (!playerStore.videoPath)
    return false
  const name = playerStore.videoPath.split(/[\\/]/).pop() ?? playerStore.videoPath
  return library.videos.find(v => v.name === name)?.starred ?? false
})

const activeDef = computed(() => findPanel(activePanel.value))

// ─── Stats ────────────────────────────────────────────────────────────────────
watch(() => playerStore.videoPath, (path) => {
  if (path)
    statsStore.startSession(path.split(/[\\/]/).pop() ?? path)
  else
    statsStore.endSession()
})

// ─── Hotkeys ──────────────────────────────────────────────────────────────────
function onGlobalKeyDown(e: KeyboardEvent) {
  const tag = (e.target as HTMLElement).tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA')
    return

  if (e.code === 'KeyB') {
    if (!playerStore.videoPath)
      return
    const name = playerStore.videoPath.split(/[\\/]/).pop() ?? playerStore.videoPath
    bookmarkStore.add(name, playerStore.currentTime)
  }
  if (e.key === '?' || (e.code === 'Slash' && e.shiftKey))
    showKeybinds.value = !showKeybinds.value
  if (e.code === 'KeyS' && !e.ctrlKey && !e.metaKey)
    starCurrentVideo()

  // Panic: reachable without thinking about it, and the same key puts it back.
  if (e.code === 'Escape' || e.code === 'Backquote') {
    e.preventDefault()
    togglePanic()
    return
  }

  // Nothing else should act while the screen is covered.
  if (safety.panicked)
    return

  if (e.code === 'KeyN' && !e.ctrlKey && !e.metaKey)
    playNext()
  if (e.code === 'KeyP' && !e.ctrlKey && !e.metaKey)
    playPrev()
  if (e.code === 'KeyR' && !e.ctrlKey && !e.metaKey)
    randomVideo()
}
</script>

<template>
  <div
    class="text-white bg-surface-950 flex flex-col h-screen select-none overflow-hidden"
    @dragover="onDragOver"
    @drop="onDrop"
  >
    <SplashScreen />

    <!-- Header: identity and global actions only. Panel navigation lives in the rail. -->
    <header class="px-3 border-b border-edge bg-surface-900 flex shrink-0 gap-1.5 h-10 items-center z-20">
      <div class="pr-1 flex shrink-0 gap-2 items-center">
        <span class="text-[13px] tracking-tight font-bold">
          play<span class="text-accent-400">hound</span>
        </span>
      </div>

      <div class="divider-x" />

      <button class="btn-ghost text-xs px-2.5 py-1.5" title="Open a video file" @click="openSingleVideo">
        <div class="i-carbon-document text-sm" />
        Open
      </button>
      <button class="btn-ghost text-xs px-2.5 py-1.5" title="Play a random scripted video" @click="randomVideo">
        <div class="i-carbon-shuffle text-sm" />
        Random
      </button>

      <div class="divider-x" />

      <p
        class="text-xs px-1 flex-1 min-w-0 truncate"
        :class="playerStore.videoPath ? 'text-fg-muted' : 'text-fg-faint'"
        :title="playerStore.videoPath || undefined"
      >
        {{ playerStore.videoPath || 'No video loaded' }}
      </p>

      <button
        v-if="playerStore.videoPath"
        class="btn-icon"
        :class="currentStarred ? 'text-amber-400' : ''"
        title="Star this video (S)"
        @click="starCurrentVideo"
      >
        <div :class="currentStarred ? 'i-carbon-star-filled' : 'i-carbon-star'" class="text-sm" />
      </button>

      <div class="divider-x" />
      <SerialLogViewer />
      <ThemePicker />
      <button class="btn-icon" title="Keyboard shortcuts (?)" @click="showKeybinds = !showKeybinds">
        <div class="i-carbon-keyboard text-sm" />
      </button>
    </header>

    <div class="flex flex-1 overflow-hidden">
      <!-- Player -->
      <div class="flex flex-1 flex-col min-w-0 overflow-hidden">
        <div class="group flex flex-1 relative overflow-hidden">
          <!-- The player stays mounted behind a canvas panel so playback and
               script sync survive a detour into the wall or slideshow. -->
          <div v-show="!mainPanel" class="bg-black flex-1 overflow-hidden">
            <VideoPlayer
              ref="videoPlayerRef"
              @ended="onVideoEnded"
              @select="onVideoSelected"
              @queue="onQueue"
            />
          </div>

          <PanelHost
            v-if="mainPanel"
            :id="mainPanel"
            class="bg-surface-950 flex-1 min-w-0"
            @select="onVideoSelected"
            @queue="onQueue"
            @seek="seekFromBookmark"
            @pin="togglePin"
            @close="closePanel"
          />
        </div>

        <!-- Hidden behind a canvas panel: the player is not visible, the canvas
             brings its own controls, and two transport bars stacked is worse
             than none. -->
        <div
          v-if="!mainPanel"
          class="px-4 pb-2.5 pt-2 border-t border-edge bg-surface-900 flex shrink-0 flex-col gap-1.5"
        >
          <FunscriptTimeline @seek="seek" />

          <div class="flex gap-2 items-center">
            <!-- Left: elapsed / duration and volume -->
            <div class="flex flex-1 gap-2 min-w-0 items-center">
              <span class="text-[11px] text-fg-muted font-mono shrink-0 tabular-nums">
                {{ formatTime(playerStore.currentTime, '0:00') }}
                <span class="text-fg-faint">/</span>
                {{ formatTime(playerStore.videoDuration, '0:00') }}
              </span>

              <div class="divider-x" />

              <button class="btn-icon shrink-0" title="Mute" @click="videoPlayerRef?.toggleMute()">
                <div class="i-carbon-volume-up text-sm" />
              </button>
              <input
                type="range" min="0" max="1" step="0.01" :value="playerStore.volume"
                class="accent filled shrink-0 w-20" title="Volume" @input="updateVolumeFill"
              >
            </div>

            <!-- Centre: transport -->
            <div class="flex shrink-0 gap-1 items-center">
              <button class="btn-icon" title="Previous" :disabled="!queueStore.hasPrev" @click="playPrev">
                <div class="i-carbon-skip-back text-sm" />
              </button>
              <button class="btn-icon" title="Back 5s (left arrow)" @click="seekRelative(-5)">
                <div class="i-carbon-rewind-5 text-sm" />
              </button>
              <button
                class="text-white focusable rounded-full bg-accent-500 flex h-10 w-10 shadow-accent-500/20 shadow-lg transition items-center justify-center active:scale-95 hover:brightness-115"
                :title="playerStore.isPlaying ? 'Pause (space)' : 'Play (space)'"
                @click="togglePlay"
              >
                <div :class="playerStore.isPlaying ? 'i-carbon-pause-filled' : 'i-carbon-play-filled-alt'" class="text-base" />
              </button>
              <button class="btn-icon" title="Forward 5s (right arrow)" @click="seekRelative(5)">
                <div class="i-carbon-forward-5 text-sm" />
              </button>
              <button class="btn-icon" title="Next" :disabled="!queueStore.hasNext" @click="playNext">
                <div class="i-carbon-skip-forward text-sm" />
              </button>
            </div>

            <!-- Right: tools -->
            <div class="flex flex-1 gap-1 min-w-0 items-center justify-end">
              <LoopControls />
              <ScriptOffsetControl />
              <div class="divider-x" />
              <SpeedControl @speed="setSpeed" />
              <div class="divider-x" />
              <button
                class="btn-ghost text-[11px] font-semibold px-2 py-1.5"
                :class="playerStore.sbs180 ? 'text-accent-400 bg-accent-500/15' : ''"
                title="180 degree side-by-side VR"
                @click="playerStore.toggleSbs()"
              >
                180&deg;
              </button>
              <button
                class="btn-icon"
                :class="showHeatmap ? 'text-accent-400' : ''"
                title="Script heatmap and shape on the timeline"
                @click="showHeatmap = !showHeatmap"
              >
                <div class="i-carbon-chart-histogram text-sm" />
              </button>
              <button class="btn-icon" title="Fullscreen (F)" @click="toggleFullscreen">
                <div class="i-carbon-fit-to-screen text-sm" />
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Sidebar: pinned panel above, active panel below -->
      <aside
        v-if="showSidebar"
        class="border-l border-white/5 bg-surface-900 flex shrink-0 relative"
        :style="{ width: `${sidebarWidth}px` }"
      >
        <div
          class="w-1 cursor-col-resize bottom-0 left-0 top-0 absolute z-10 hover:bg-accent-500/40"
          @mousedown="onSidebarDragDown"
        />

        <div class="flex flex-1 flex-col min-w-0 overflow-hidden">
          <PanelHost
            v-if="pinnedPanel"
            :id="pinnedPanel"
            pinned
            :style="sidePanel ? { height: `${pinnedHeight}%` } : { flex: '1 1 0%' }"
            class="shrink-0"
            @select="onVideoSelected"
            @queue="onQueue"
            @seek="seekFromBookmark"
            @pin="togglePin"
            @close="closePanel"
          />

          <div
            v-if="pinnedPanel && sidePanel"
            class="bg-white/5 shrink-0 h-1 cursor-row-resize hover:bg-accent-500/40"
            @mousedown="onSplitDragDown"
          />

          <PanelHost
            v-if="sidePanel"
            :id="sidePanel"
            class="flex-1 min-h-0"
            @select="onVideoSelected"
            @queue="onQueue"
            @seek="seekFromBookmark"
            @pin="togglePin"
            @close="closePanel"
          />
        </div>
      </aside>

      <PanelRail
        :active="activePanel"
        :pinned="pinnedPanel"
        :overlays="overlayPanels"
        @select="selectPanel"
        @pin="togglePin"
      />
    </div>

    <StatusBar />

    <PanicCover v-if="safety.panicked" @resume="resumePanic" />

    <!-- Floating windows: layered over whichever view is open -->
    <OsrEmulator
      v-if="isOverlayOpen('emulator')"
      v-model:model="emuModel"
      visible
      @close="closePanel('emulator')"
    />

    <!-- Keybinds overlay -->
    <div
      v-if="showKeybinds"
      class="bg-black/70 flex items-center inset-0 justify-center absolute z-50"
      @click="showKeybinds = false"
    >
      <div class="text-xs p-5 panel w-80 space-y-2" @click.stop>
        <h3 class="text-sm font-semibold mb-3">
          Shortcuts
        </h3>
        <div
          v-for="k in [
            ['Space', 'Play / pause'],
            ['&#8592; / &#8594;', 'Seek 5 seconds'],
            ['F', 'Fullscreen'],
            ['B', 'Add bookmark'],
            ['S', 'Star current video'],
            ['?', 'This list'],
          ]" :key="k[0]" class="text-white/60 flex justify-between"
        >
          <span class="text-white/40 font-mono" v-html="k[0]" />
          <span>{{ k[1] }}</span>
        </div>
        <p class="text-[10px] text-white/30 pt-2">
          Middle-click a rail icon to pin that panel.
        </p>
      </div>
    </div>

    <p v-if="activeDef" class="sr-only">
      {{ activeDef.hint }}
    </p>
  </div>
</template>
