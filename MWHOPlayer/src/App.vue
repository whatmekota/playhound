<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { usePlayerStore } from '@/stores/playerStore'
import { useLibraryStore } from '@/stores/libraryStore'
import { useDeviceStore } from '@/stores/deviceStore'
import { useScriptStore } from '@/stores/scriptStore'
import { useQueueStore } from '@/stores/queueStore'
import { useStatsStore } from '@/stores/statsStore'
import { useBookmarkStore } from '@/stores/bookmarkStore'
import { useFunscript } from '@/composables/useFunscript'

import { openVideoFile } from '@/lib/browserApi'
import { storage } from '@/lib/browserApi'
import type { VideoEntry, ScriptMatch } from '@/stores/libraryStore'
import VideoPlayer from '@/components/VideoPlayer.vue'
import VideoLibrary from '@/components/VideoLibrary.vue'
import FunscriptTimeline from '@/components/FunscriptTimeline.vue'
import LoopControls from '@/components/LoopControls.vue'
import SpeedControl from '@/components/SpeedControl.vue'
import DevicePanel from '@/components/DevicePanel.vue'
import ScriptPanel from '@/components/ScriptPanel.vue'
import OsrEmulator from '@/components/OsrEmulator.vue'
import ThemePicker from '@/components/ThemePicker.vue'
import ScriptOffsetControl from '@/components/ScriptOffsetControl.vue'
import SerialLogViewer from '@/components/SerialLogViewer.vue'
import PlaylistPanel from '@/components/PlaylistPanel.vue'
import SplashScreen from '@/components/SplashScreen.vue'
import BookmarkPanel from '@/components/BookmarkPanel.vue'
import StatsDashboard from '@/components/StatsDashboard.vue'
import EroScriptsPanel from '@/components/EroScriptsPanel.vue'
import OrganizerPanel from '@/components/OrganizerPanel.vue'

// Keep volume range track fill in sync
function updateVolumeFill(e: Event) {
  const el = e.target as HTMLInputElement
  const pct = (parseFloat(el.value) / parseFloat(el.max)) * 100
  el.style.setProperty('--pct', `${pct}%`)
  videoPlayerRef.value?.setVolume(parseFloat(el.value))
}

const playerStore = usePlayerStore()
const library = useLibraryStore()
const deviceStore = useDeviceStore()
const scriptStore = useScriptStore()
const queueStore = useQueueStore()
const statsStore = useStatsStore()
const bookmarkStore = useBookmarkStore()
const { autoDetectFromFiles, lastRawMetadata } = useFunscript()

const videoPlayerRef = ref<InstanceType<typeof VideoPlayer> | null>(null)
const osrEmuRef = ref<InstanceType<typeof OsrEmulator> | null>(null)

const showKeybinds = ref(false)

function starCurrentVideo() {
  if (!playerStore.videoPath) return
  const name = playerStore.videoPath.split(/[\\/]/).pop() ?? playerStore.videoPath
  const entry = library.videos.find(v => v.name === name)
  if (entry) library.toggleStar(entry)
}

const currentStarred = computed(() => {
  if (!playerStore.videoPath) return false
  const name = playerStore.videoPath.split(/[\\/]/).pop() ?? playerStore.videoPath
  return library.videos.find(v => v.name === name)?.starred ?? false
})



// Sidebar panel: 'library' | 'scripts' | 'device' | 'playlists' | 'bookmarks' | 'stats' | null
const sidePanel = ref<'library' | 'scripts' | 'device' | 'playlists' | 'bookmarks' | 'stats' | 'eroscripts' | 'organizer' | null>('library')
const showSidebar = computed(() => sidePanel.value !== null)

// ─── Resizable sidebar ────────────────────────────────────────────────────────
const sidebarWidth = ref(320)
const SIDEBAR_MIN = 220
const SIDEBAR_MAX = 600
let sidebarDragStart: { mx: number; w: number } | null = null

function onSidebarDragDown(e: MouseEvent) {
  e.preventDefault()
  sidebarDragStart = { mx: e.clientX, w: sidebarWidth.value }
  window.addEventListener('mousemove', onSidebarDragMove)
  window.addEventListener('mouseup', onSidebarDragUp)
}
function onSidebarDragMove(e: MouseEvent) {
  if (!sidebarDragStart) return
  // Sidebar is on the right, so dragging left = wider
  sidebarWidth.value = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX,
    sidebarDragStart.w - (e.clientX - sidebarDragStart.mx)
  ))
}
function onSidebarDragUp() {
  sidebarDragStart = null
  window.removeEventListener('mousemove', onSidebarDragMove)
  window.removeEventListener('mouseup', onSidebarDragUp)
}

// Emulator panel visible
const showEmu = ref(false)
const emuModel = ref<'OSR2' | 'SR6'>('OSR2')

// ─── Persist UI state ─────────────────────────────────────────────────────────
onMounted(() => {
  const ui = storage.get<{ sidebarWidth?: number; showEmu?: boolean; emuModel?: 'OSR2'|'SR6'; sidePanel?: string|null }>('uiState')
  if (ui) {
    if (ui.sidebarWidth) sidebarWidth.value = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, ui.sidebarWidth))
    if (typeof ui.showEmu === 'boolean') showEmu.value = ui.showEmu
    if (ui.emuModel === 'OSR2' || ui.emuModel === 'SR6') emuModel.value = ui.emuModel
    if (ui.sidePanel !== undefined) sidePanel.value = ui.sidePanel as any ?? null
  }
})

watch([sidebarWidth, showEmu, emuModel, sidePanel], () => {
  storage.set('uiState', {
    sidebarWidth: sidebarWidth.value,
    showEmu: showEmu.value,
    emuModel: emuModel.value,
    sidePanel: sidePanel.value,
  })
})

// ─── File handling ────────────────────────────────────────────────────────────

/** Called when user picks a video from library or playlist */
async function onVideoSelected(entry: VideoEntry) {
  await loadVideoFile(entry.file, entry.scriptMatches, true)
}

/** Called alongside onVideoSelected — seeds the queue from the current sorted view */
function onQueue(entries: VideoEntry[], selected: VideoEntry) {
  queueStore.setQueue(entries, selected)
}

/** Pick a random scripted video from the library */
function randomVideo() {
  const pool = library.videos.filter(v => v.hasScript)
  if (!pool.length) return
  queueStore.setShuffle(true)
  queueStore.setQueue(pool, pool[Math.floor(Math.random() * pool.length)])
  const current = queueStore.current
  if (current) onVideoSelected(current)
}

async function openSingleVideo() {
  try {
    const file = await openVideoFile()
    if (file) await loadVideoFile(file, [], false)
  } catch (err) {
    console.error('Failed to open video:', err)
  }
}

/** Called when the video element fires 'ended' */
async function onVideoEnded() {
  const next = queueStore.next()
  if (next) await loadVideoFile(next.file, next.scriptMatches, true)
}

async function playNext() {
  const next = queueStore.next()
  if (next) await loadVideoFile(next.file, next.scriptMatches, true)
}

async function playPrev() {
  const prev = queueStore.prev()
  if (prev) await loadVideoFile(prev.file, prev.scriptMatches, true)
}

async function loadVideoFile(file: File, scriptMatches?: ScriptMatch[], autoplay = false) {
  try {
    if (playerStore.videoUrl?.startsWith('blob:')) URL.revokeObjectURL(playerStore.videoUrl)
  const url = URL.createObjectURL(file)
  playerStore.setVideo(file.name, url)
  playerStore.clearLoop()
  await autoDetectFromFiles(file, scriptMatches ?? [])

  // If a single .funscript file produced multiple axes, it's a merged script —
  // mark the library entry so the glow/badge shows correctly.
  const uniqueFiles = new Set(scriptStore.scripts.map(s => s.filename))
  const isMerged = uniqueFiles.size === 1 && scriptStore.scripts.length > 1
  const libEntry = library.videos.find(v => v.file === file)
  if (libEntry) {
    if (isMerged) {
      libEntry.scriptType = 'merged'
      libEntry.scriptCount = Math.max(libEntry.scriptCount, scriptStore.scripts.length)
    }
    // Extract metadata from the parsed funscript's raw metadata block (topic_tags etc.)
    if (!libEntry.scriptMeta && lastRawMetadata.value) {
      const fm = lastRawMetadata.value
      libEntry.scriptMeta = {
        tags:    Array.isArray(fm.topic_tags) ? (fm.topic_tags as string[]) : undefined,
        creator: typeof fm.topic_creator === 'string' ? fm.topic_creator : undefined,
        date:    typeof fm.topic_date === 'string' ? fm.topic_date : undefined,
        url:     typeof fm.topic_url === 'string' ? fm.topic_url : undefined,
      }
    }
  }

  // Enable device axes for every enabled script so emu + device both receive data
  for (const s of scriptStore.scripts) {
    if (s.enabled && deviceStore.axisConfigs[s.channel]) {
      deviceStore.axisConfigs[s.channel].enabled = true
    }
  }

  if (autoplay) {
    setTimeout(() => videoPlayerRef.value?.play(), 80)
  }
  } catch (err) {
    console.error('Failed to load video:', err)
  }
}


// Drag-and-drop onto main area
function onDragOver(e: DragEvent) { e.preventDefault() }

async function onDrop(e: DragEvent) {
  e.preventDefault()
  const files: File[] = []
  try {
    for (const item of Array.from(e.dataTransfer?.items ?? [])) {
      if (item.kind !== 'file') continue
      const entry = item.webkitGetAsEntry?.()
      if (entry?.isDirectory) {
        await collectDir(entry as any, files)
      } else {
        const f = item.getAsFile()
        if (f) files.push(f)
      }
    }

    if (files.length) {
      const videoFiles = files.filter(f => /\.(mp4|mkv|webm|avi|mov|m4v|wmv|flv)$/i.test(f.name))
      if (videoFiles.length > 1 || (files.length > 1 && videoFiles.length)) {
        await library.setFiles(files)
        sidePanel.value = 'library'
      } else if (videoFiles.length === 1) {
        await library.setFiles(files)
        const entry = library.videos.find(v => v.name === videoFiles[0].name)
        await loadVideoFile(videoFiles[0], entry?.scriptMatches ?? [])
      }
    }
  } catch (err) {
    console.error('Failed to handle dropped files:', err)
  }
}

const COLLECT_DIR_MAX = 5000

async function collectDir(entry: any, out: File[]) {
  if (out.length >= COLLECT_DIR_MAX) return
  if (entry.isFile) {
    await new Promise<void>(r => entry.file((f: File) => { out.push(f); r() }))
  } else if (entry.isDirectory) {
    const reader = entry.createReader()
    // readEntries returns at most 100 items per call — must loop until empty
    let batch: any[]
    do {
      batch = await new Promise<any[]>(r => reader.readEntries(r))
      for (const e of batch) {
        if (out.length >= COLLECT_DIR_MAX) break
        await collectDir(e, out)
      }
    } while (batch.length > 0 && out.length < COLLECT_DIR_MAX)
  }
}

// ─── Controls ─────────────────────────────────────────────────────────────────

function togglePlay() { videoPlayerRef.value?.togglePlay() }
function seek(t: number) { videoPlayerRef.value?.seek(t) }
function seekRelative(d: number) { videoPlayerRef.value?.seekRelative(d) }
function setSpeed(s: number) { videoPlayerRef.value?.setSpeed(s) }
function toggleFullscreen() { videoPlayerRef.value?.toggleFullscreen() }
function togglePanel(p: 'library' | 'scripts' | 'device' | 'playlists' | 'bookmarks' | 'stats' | 'eroscripts' | 'organizer') {
  sidePanel.value = sidePanel.value === p ? null : p
}

// ─── Stats tracking ───────────────────────────────────────────────────────────
watch(() => playerStore.videoPath, (path) => {
  if (path) statsStore.startSession(path.split(/[\\/]/).pop() ?? path)
  else statsStore.endSession()
})

function recordFinish() {
  if (!playerStore.videoPath) return
  const name = playerStore.videoPath.split(/[\\/]/).pop() ?? playerStore.videoPath
  statsStore.recordFinish(name, playerStore.currentTime)
}

// ─── Bookmark hotkey ──────────────────────────────────────────────────────────
function onGlobalKeyDown(e: KeyboardEvent) {
  if ((e.target as HTMLElement).tagName === 'INPUT') return
  if (e.code === 'KeyB') {
    if (!playerStore.videoPath) return
    const name = playerStore.videoPath.split(/[\\/]/).pop() ?? playerStore.videoPath
    bookmarkStore.add(name, playerStore.currentTime)
  }
  if (e.key === '?' || e.code === 'Slash' && e.shiftKey) {
    showKeybinds.value = !showKeybinds.value
  }
  if (e.code === 'KeyS' && !e.ctrlKey && !e.metaKey) {
    starCurrentVideo()
  }
}

onMounted(() => {
  window.addEventListener('keydown', onGlobalKeyDown)
})

function onSidebarEnter(el: Element, done: () => void) {
  const e = el as HTMLElement
  e.style.width = '0'
  e.style.opacity = '0'
  requestAnimationFrame(() => {
    e.style.transition = 'width 0.2s ease, opacity 0.15s ease'
    e.style.width = sidebarWidth.value + 'px'
    e.style.opacity = '1'
    window.setTimeout(done, 200)
  })
}

function onSidebarLeave(el: Element, done: () => void) {
  const e = el as HTMLElement
  e.style.transition = 'width 0.2s ease, opacity 0.15s ease'
  e.style.width = '0'
  e.style.opacity = '0'
  window.setTimeout(done, 200)
}

const keybindGroups = [
  {
    label: 'Playback',
    keys: [
      { key: 'Space', desc: 'Play / Pause' },
      { key: '← / →', desc: 'Seek −5s / +5s' },
      { key: 'F', desc: 'Toggle fullscreen' },
      { key: 'M', desc: 'Mute / Unmute' },
    ],
  },
  {
    label: 'Library',
    keys: [
      { key: 'S', desc: 'Star / unstar current video' },
      { key: 'B', desc: 'Add bookmark at current time' },
    ],
  },
  {
    label: 'Speed ramp',
    keys: [
      { key: '[', desc: 'Speed down' },
      { key: ']', desc: 'Speed up' },
      { key: '\\', desc: 'Reset speed to 1×' },
    ],
  },
  {
    label: 'UI',
    keys: [
      { key: '?', desc: 'Toggle this shortcuts panel' },
    ],
  },
]

function formatTime(s: number) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60)
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
  return `${m}:${String(sec).padStart(2,'0')}`
}
</script>

<template>
  <div class="flex flex-col h-screen bg-surface-950 text-white overflow-hidden select-none"
    @dragover="onDragOver" @drop="onDrop">

    <SplashScreen />

    <!-- ─── Toolbar ─────────────────────────────────────────────────────────── -->
    <header class="flex items-center gap-2 px-3 h-10 bg-surface-900 border-b border-white/5 shrink-0 z-20">
      <!-- Logo -->
      <svg class="w-4 h-4 text-accent-400 shrink-0" fill="currentColor" viewBox="0 0 24 24">
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z"/>
      </svg>
<!--      <span class="text-xs font-semibold text-white/40 tracking-widest mr-1">MWHOPLAYER</span>-->

      <!-- Current video name -->
      <span v-if="playerStore.videoPath" class="text-xs text-white/40 truncate flex-1 min-w-0 flex items-center gap-1.5">
        <svg v-if="currentStarred" class="w-3 h-3 text-amber-400 shrink-0" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
        <span class="truncate">{{ playerStore.videoPath.split(/[\\/]/).pop() }}</span>
      </span>
      <span v-else class="flex-1" />

      <div class="flex items-center gap-0.5 shrink-0">
        <!-- Open single video -->
        <button class="btn-ghost text-xs px-2 py-1" title="Open video file" @click="openSingleVideo">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M15 10l4.553-2.276A1 1 0 0121 8.723v6.554a1 1 0 01-1.447.894L15 14M3 8a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z"/>
          </svg>
        </button>

        <div class="w-px h-4 bg-white/10 mx-0.5" />

        <!-- OSR Emulator toggle -->
        <button class="btn-ghost px-2 py-1" :class="showEmu ? 'text-accent-400 bg-accent-600/20' : ''" title="OSR Emulator" @click="showEmu = !showEmu">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/>
          </svg>
        </button>

        <div class="w-px h-4 bg-white/10 mx-0.5" />

        <!-- Panel toggles -->
        <button class="btn-ghost px-2 py-1" :class="sidePanel==='library'?'text-accent-400 bg-accent-600/20':''" title="Library" @click="togglePanel('library')">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 10h16M4 14h16M4 18h16"/>
          </svg>
        </button>
        <button class="btn-ghost px-2 py-1" :class="sidePanel==='playlists'?'text-accent-400 bg-accent-600/20':''" title="Playlists" @click="togglePanel('playlists')">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3"/>
          </svg>
        </button>
        <button class="btn-ghost px-2 py-1" :class="sidePanel==='scripts'?'text-accent-400 bg-accent-600/20':''" title="Scripts" @click="togglePanel('scripts')">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0W 01-2 2z"/>
          </svg>
        </button>
        <button class="btn-ghost px-2 py-1" :class="sidePanel==='device'?'text-accent-400 bg-accent-600/20':''" title="Device" @click="togglePanel('device')">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0h10a2 2 0 002-2V9M9 21H5a2 2 0 01-2-2V9m0 0h18"/>
          </svg>
        </button>
        <button class="btn-ghost px-2 py-1" :class="sidePanel==='bookmarks'?'text-amber-400 bg-amber-500/20':''" title="Bookmarks (B to add)" @click="togglePanel('bookmarks')">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z"/>
          </svg>
        </button>
        <button class="btn-ghost px-2 py-1" :class="sidePanel==='stats'?'text-pink-400 bg-pink-500/20':''" title="Cum Stats" @click="togglePanel('stats')">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/>
          </svg>
        </button>
        <button class="btn-ghost px-2 py-1" :class="sidePanel==='eroscripts'?'text-rose-400 bg-rose-500/20':''" title="EroScripts" @click="togglePanel('eroscripts')">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9"/>
          </svg>
        </button>
        <button class="btn-ghost px-2 py-1" :class="sidePanel==='organizer'?'text-accent-400 bg-accent-600/20':''" title="Organizer — rename videos &amp; scripts" @click="togglePanel('organizer')">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
          </svg>
        </button>
        <!-- Random scripted video -->
        <button
          class="btn-ghost px-2 py-1 text-white/30 hover:text-white/70 transition-colors"
          :disabled="!library.hasVideos"
          title="Play random scripted video"
          @click="randomVideo"
        >
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15M15 5l3 3-3 3"/>
          </svg>
        </button>

        <div class="w-px h-4 bg-white/10 mx-0.5" />
        <SerialLogViewer />
        <ThemePicker />
        <button
          class="btn-ghost text-xs px-2 py-1 text-white/25 hover:text-white/60 font-bold"
          title="Keyboard shortcuts (?)"
          @click="showKeybinds = true"
        >?</button>
      </div>
    </header>

    <!-- ─── Main ──────────────────────────────────────────────────────────── -->
    <div class="flex flex-1 overflow-hidden">

      <div class="flex-1 flex flex-col overflow-hidden min-w-0">

        <!-- Video area -->
        <div class="flex-1 overflow-hidden flex relative group">
          <div class="flex-1 bg-black overflow-hidden">
            <VideoPlayer ref="videoPlayerRef" @ended="onVideoEnded" @select="onVideoSelected" @queue="onQueue" />
          </div>

          <!-- Star button — appears on hover over video -->
          <button
            v-if="playerStore.videoUrl"
            class="absolute top-3 right-3 z-10 w-9 h-9 rounded-full flex items-center justify-center transition-all duration-200 opacity-0 group-hover:opacity-100"
            :class="currentStarred
              ? 'bg-amber-500/90 text-white shadow-lg shadow-amber-500/30'
              : 'bg-black/50 text-white/50 hover:bg-black/70 hover:text-amber-400 backdrop-blur-sm'"
            :title="currentStarred ? 'Unstar (S)' : 'Star this video (S)'"
            @click="starCurrentVideo"
          >
            <svg class="w-4 h-4 transition-transform duration-150" :class="currentStarred ? 'scale-110' : ''" fill="currentColor" viewBox="0 0 24 24">
              <path v-if="currentStarred" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
              <path v-else fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
            </svg>
          </button>
        </div>

        <!-- Controls bar -->
        <div class="shrink-0 flex flex-col gap-2 px-4 pt-2 pb-3 bg-surface-900 border-t border-white/5">
          <FunscriptTimeline @seek="seek" />

          <div class="flex items-center gap-2 text-xs text-white/40 font-mono">
            <span>{{ formatTime(playerStore.currentTime) }}</span>
            <span class="text-white/20">/</span>
            <span>{{ formatTime(playerStore.videoDuration) }}</span>
          </div>

          <div class="flex items-center gap-1.5 flex-wrap">
            <button class="btn-ghost px-2 py-1.5" title="Previous video" :disabled="!queueStore.hasPrev" @click="playPrev">
              <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
            </button>
            <button class="btn-ghost px-2 py-1.5" title="−5s (←)" @click="seekRelative(-5)">
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/></svg>
            </button>

            <button class="w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors" @click="togglePlay">
              <svg v-if="!playerStore.isPlaying" class="w-5 h-5 ml-0.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
              <svg v-else class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
            </button>

            <button class="btn-ghost px-2 py-1.5" title="+5s (→)" @click="seekRelative(5)">
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
            </button>
            <button class="btn-ghost px-2 py-1.5" title="Next video" :disabled="!queueStore.hasNext" @click="playNext">
              <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M6 18l8.5-6L6 6v12zm2.5-6l5.5 4V8z"/><path d="M16 6h2v12h-2z"/></svg>
            </button>

            <div class="w-px h-5 bg-white/10 mx-1" />

            <!-- Shuffle -->
            <button
              class="btn-ghost px-1.5 py-1.5 transition-colors"
              :class="queueStore.shuffle ? 'text-accent-400' : 'text-white/30 hover:text-white/60'"
              title="Shuffle"
              @click="queueStore.setShuffle(!queueStore.shuffle)"
            >
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4"/>
              </svg>
            </button>

            <!-- Repeat: cycle off → all → one -->
            <button
              class="btn-ghost px-1.5 py-1.5 relative transition-colors"
              :class="queueStore.repeatMode !== 'off' ? 'text-accent-400' : 'text-white/30 hover:text-white/60'"
              :title="queueStore.repeatMode === 'off' ? 'Repeat off' : queueStore.repeatMode === 'all' ? 'Repeat all' : 'Repeat one'"
              @click="queueStore.setRepeat(queueStore.repeatMode === 'off' ? 'all' : queueStore.repeatMode === 'all' ? 'one' : 'off')"
            >
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
              </svg>
              <!-- "1" badge for repeat-one -->
              <span v-if="queueStore.repeatMode === 'one'"
                class="absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full text-[8px] flex items-center justify-center font-bold bg-accent-500 text-white leading-none">1</span>
            </button>

            <div class="w-px h-5 bg-white/10 mx-1" />

            <button class="btn-ghost px-1.5" @click="videoPlayerRef?.toggleMute()">
              <svg v-if="playerStore.isMuted || playerStore.volume===0" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15zM17 14l-4-4m0 4l4-4"/></svg>
              <svg v-else class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5L6 9H2v6h4l5 4V5zM19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07"/></svg>
            </button>
            <input type="range" min="0" max="1" step="0.02"
              :value="playerStore.isMuted ? 0 : playerStore.volume"
              class="w-20 accent filled"
              :style="{ '--pct': ((playerStore.isMuted ? 0 : playerStore.volume) * 100) + '%' }"
              @input="updateVolumeFill"
            />

            <div class="flex-1" />

            <LoopControls />
            <ScriptOffsetControl />
            <div class="w-px h-5 bg-white/10 mx-1" />
            <SpeedControl @speed="setSpeed" />

            <div class="w-px h-5 bg-white/10 mx-1" />

            <!-- SBS 180° mode -->
            <button class="btn-ghost text-xs px-2 py-1.5 font-medium" :class="playerStore.sbs180 ? 'text-accent-400 bg-accent-600/20' : ''" @click="playerStore.toggleSbs()">180°</button>

            <!-- Cum button -->
            <button
              v-if="playerStore.videoUrl"
              class="btn-ghost text-xs px-2.5 py-1.5 font-semibold text-pink-400 hover:bg-pink-500/20 transition-colors rounded"
              title="I came 💦"
              @click="recordFinish"
            >💦 Cum</button>

            <button class="btn-ghost px-2 py-1.5" title="Fullscreen (F)" @click="toggleFullscreen">
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"/></svg>
            </button>
          </div>
        </div>
      </div>

      <!-- ─── Side panel ──────────────────────────────────────────────────── -->
      <Transition :css="false" @enter="onSidebarEnter" @leave="onSidebarLeave">
        <aside v-if="showSidebar" class="shrink-0 border-l border-white/5 bg-surface-900 overflow-hidden flex relative"
          :style="{ width: sidebarWidth + 'px' }">
          <!-- Resize handle on the left edge -->
          <div
            class="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-accent-600/50 transition-colors z-10"
            @mousedown="onSidebarDragDown"
          />
          <div class="flex-1 overflow-hidden flex flex-col relative">
            <VideoLibrary v-if="sidePanel==='library'" @select="onVideoSelected" @queue="onQueue" />
            <ScriptPanel v-else-if="sidePanel==='scripts'" />
            <DevicePanel v-else-if="sidePanel==='device'" />
            <PlaylistPanel v-else-if="sidePanel==='playlists'" @select="onVideoSelected" @queue="onQueue" />
            <BookmarkPanel v-else-if="sidePanel==='bookmarks'" @seek="seekFromBookmark" />
            <StatsDashboard v-else-if="sidePanel==='stats'" />
            <EroScriptsPanel v-else-if="sidePanel==='eroscripts'" />
            <OrganizerPanel v-else-if="sidePanel==='organizer'" />
          </div>
        </aside>
      </Transition>
    </div>
    <!-- OSR Emulator — floating widget, rendered at root so it can go anywhere -->
    <OsrEmulator v-show="showEmu" ref="osrEmuRef" v-model:model="emuModel" :visible="showEmu" />

    <!-- ─── Keybinds modal ───────────────────────────────────────────────── -->
    <Transition name="fade">
      <div v-if="showKeybinds"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
        @click.self="showKeybinds = false">
        <div class="bg-surface-900 border border-white/10 rounded-xl shadow-2xl w-[480px] max-h-[80vh] overflow-y-auto p-6">
          <div class="flex items-center justify-between mb-5">
            <h2 class="text-sm font-semibold text-white/90 tracking-wide uppercase">Keyboard Shortcuts</h2>
            <button class="text-white/30 hover:text-white/80 transition-colors text-lg leading-none" @click="showKeybinds = false">✕</button>
          </div>
          <div class="space-y-4">
            <div v-for="group in keybindGroups" :key="group.label">
              <div class="text-[10px] font-semibold text-white/30 uppercase tracking-widest mb-2">{{ group.label }}</div>
              <div class="space-y-1">
                <div v-for="kb in group.keys" :key="kb.key" class="flex items-center justify-between gap-4 py-1 border-b border-white/5 last:border-0">
                  <span class="text-xs text-white/60">{{ kb.desc }}</span>
                  <kbd class="shrink-0 px-2 py-0.5 rounded bg-white/10 text-white/80 text-[11px] font-mono border border-white/15">{{ kb.key }}</kbd>
                </div>
              </div>
            </div>
          </div>
          <p class="mt-5 text-[10px] text-white/20 text-center">Press <kbd class="px-1.5 py-0.5 rounded bg-white/10 font-mono">?</kbd> to toggle this panel</p>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.fade-enter-active, .fade-leave-active { transition: opacity 0.15s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
