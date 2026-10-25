<script setup lang="ts">
import type { ShellAction } from '~/lib/hotkeys'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import OsrEmulator from '~/components/device/OsrEmulator.vue'
import HypnoOverlay from '~/components/player/HypnoOverlay.vue'
import NowPlayingBar from '~/components/player/NowPlayingBar.vue'
import VideoPlayer from '~/components/player/VideoPlayer.vue'
import AppNav from '~/components/shell/AppNav.vue'
import CommandPalette from '~/components/shell/CommandPalette.vue'
import InspectorDrawer from '~/components/shell/InspectorDrawer.vue'
import InspectorRail from '~/components/shell/InspectorRail.vue'
import PanicCover from '~/components/shell/PanicCover.vue'
import SettingsModal from '~/components/shell/SettingsModal.vue'
import ShortcutsModal from '~/components/shell/ShortcutsModal.vue'
import SplashScreen from '~/components/shell/SplashScreen.vue'
import TitleBar from '~/components/shell/TitleBar.vue'
import ToastHost from '~/components/shell/ToastHost.vue'
import WelcomeScreen from '~/components/shell/WelcomeScreen.vue'
import { useDiscordPresence } from '~/composables/useDiscordPresence'
import { useGamepad } from '~/composables/useGamepad'
import { useHeartRate } from '~/composables/useHeartRate'
import { useMotionEngine } from '~/composables/useMotionEngine'
import { useRemoteHost } from '~/composables/useRemoteHost'
import { useSafety } from '~/composables/useSafety'
import { useScriptPulse } from '~/composables/useScriptPulse'
import { KNOB_STEP, useSessionActions } from '~/composables/useSessionActions'
import { useSessionAudio } from '~/composables/useSessionAudio'
import { useSettings } from '~/composables/useSettings'
import { toast } from '~/composables/useToast'
import { useVibeSync } from '~/composables/useVibeSync'
import { useVideoBeat } from '~/composables/useVideoBeat'
import { desktop, openVideoFile, storage } from '~/lib/browserApi'
import { SHELL_HOTKEYS } from '~/lib/hotkeys'
import { KEYS } from '~/lib/persist'
import { VIEW_COMPONENTS } from '~/lib/viewComponents'
import { useBookmarkStore } from '~/stores/bookmarkStore'
import { useHypnoStore } from '~/stores/hypnoStore'
import { useLibraryStore } from '~/stores/libraryStore'
import { useMotionStore } from '~/stores/motionStore'
import { usePlaybackStore } from '~/stores/playbackStore'
import { usePlayerStore } from '~/stores/playerStore'
import { useSafetyStore } from '~/stores/safetyStore'
import { useSessionControlStore } from '~/stores/sessionControlStore'
import { useStatsStore } from '~/stores/statsStore'
import { useUiStore } from '~/stores/uiStore'

defineOptions({ name: 'IndexPage' })

const ui = useUiStore()
const player = usePlayerStore()
const playback = usePlaybackStore()
const library = useLibraryStore()
const stats = useStatsStore()
const bookmarks = useBookmarkStore()
const safety = useSafetyStore()
const hypno = useHypnoStore()
const sessionControl = useSessionControlStore()
const session = useSessionActions()

// Instantiate these once at the shell level so they keep running whichever
// view or inspector happens to be open.
useMotionEngine()
useSessionAudio()
useScriptPulse()
useVideoBeat()
useHeartRate()
useVibeSync()
useDiscordPresence()

// Panic needs to reach video, audio and the device at once.
const { toggle: togglePanic, resume: resumePanic } = useSafety({
  pauseVideo: () => playback.pause(),
  playVideo: () => playback.resume(),
  isVideoPlaying: () => player.isPlaying,
})

const transport = {
  next: () => void playback.next(),
  prev: () => void playback.prev(),
  random: () => void playback.random(),
  togglePlay: () => playback.togglePlay(),
  panic: () => togglePanic(),
}
// Gamepad: transport on the buttons, stroke rate or position on the sticks.
useGamepad({
  ...transport,
  edge: () => session.edge('gamepad'),
  nudgeIntensity: d => session.nudgeIntensity(d),
  nextPeak: () => session.nextPeak(),
})
// Phone remote, when switched on in the Remote inspector.
useRemoteHost({
  ...transport,
  edge: () => session.edge('remote'),
  release: () => session.release(),
  nudgeIntensity: d => sessionControl.nudgeIntensity(d),
})

// ─── Session control ─────────────────────────────────────────────────────────
// The edge envelope is a function of the clock; advance it every frame, here,
// since the shell is the one thing that always runs. Idle frames write the
// same values back, which Vue ignores.
let controlRaf = 0
function controlLoop() {
  sessionControl.tick()
  controlRaf = requestAnimationFrame(controlLoop)
}
onMounted(() => (controlRaf = requestAnimationFrame(controlLoop)))
onBeforeUnmount(() => cancelAnimationFrame(controlRaf))
// Panic cancels a running edge outright: on resume things come back as they
// were, not halfway through a hold nobody remembers calling.
watch(() => safety.panicked, p => p && sessionControl.reset())

// Device axes and motion settings have to be in place before anything moves,
// not only once their inspector has been opened.
const motion = useMotionStore()
useSettings().load()
{
  const saved = storage.get<unknown>(KEYS.motionConfig.key)
  if (saved)
    motion.deserialize(saved)
}
watch(() => motion.serialize(), v => storage.set(KEYS.motionConfig.key, v), { deep: true })

onMounted(() => {
  // Bring the last folder back at startup, whichever view is open.
  void library.restoreFolder()
})

// ─── Stats ────────────────────────────────────────────────────────────────────
watch(() => player.videoPath, (path) => {
  if (path)
    stats.startSession(path.split(/[\\/]/).pop() ?? path)
  else
    stats.endSession()
})

// ─── Stage: player full size, or a mini player over another view ─────────────
const stageEl = ref<HTMLElement | null>(null)
const stageSize = ref({ w: 0, h: 0 })
let stageRo: ResizeObserver | null = null
onMounted(() => {
  if (!stageEl.value)
    return
  stageRo = new ResizeObserver(([e]) => {
    stageSize.value = { w: e.contentRect.width, h: e.contentRect.height }
  })
  stageRo.observe(stageEl.value)
})
onBeforeUnmount(() => stageRo?.disconnect())

/** Closed by hand while away from the player; comes back on the next track. */
const miniDismissed = ref(false)
watch(() => playback.trackSeq, () => (miniDismissed.value = false))
watch(() => ui.onPlayer, on => on && (miniDismissed.value = false))

const mini = computed(() => !ui.onPlayer)
const playerVisible = computed(() => ui.onPlayer || (!!player.videoUrl && !miniDismissed.value))

const MINI_W = 352
const MINI_MARGIN = 16
const playerBox = computed(() => {
  const { w, h } = stageSize.value
  if (!mini.value)
    return { left: 0, top: 0, width: w, height: h, radius: 0 }
  const mw = Math.min(MINI_W, Math.max(200, w * 0.4))
  const mh = mw * 9 / 16
  return { left: w - mw - MINI_MARGIN, top: h - mh - MINI_MARGIN, width: mw, height: mh, radius: 14 }
})

function closeMini() {
  playback.pause()
  miniDismissed.value = true
}

// ─── Open / drag and drop ─────────────────────────────────────────────────────
async function openSingleVideo() {
  try {
    const file = await openVideoFile()
    if (file) {
      ui.openView('player')
      await playback.playFile(file)
    }
  }
  catch (err) {
    console.error('Failed to open video:', err)
  }
}

const VIDEO_RE = /\.(?:mp4|mkv|webm|avi|mov|m4v|wmv|flv)$/i
const COLLECT_DIR_MAX = 5000
let dragDepth = 0

async function collectDir(entry: any, out: File[]) {
  if (out.length >= COLLECT_DIR_MAX)
    return
  if (entry.isFile) {
    await new Promise<void>(r => entry.file((f: File) => {
      out.push(f)
      r()
    }, () => r()))
  }
  else if (entry.isDirectory) {
    const reader = entry.createReader()
    // readEntries yields at most 100 per call, so loop until it comes back empty.
    let batch: any[]
    do {
      batch = await new Promise<any[]>(r => reader.readEntries(r, () => r([])))
      for (const e of batch) {
        if (out.length >= COLLECT_DIR_MAX)
          break
        await collectDir(e, out)
      }
    } while (batch.length > 0 && out.length < COLLECT_DIR_MAX)
  }
}

function hasFiles(e: DragEvent) {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files')
}

function onDragEnter(e: DragEvent) {
  if (!hasFiles(e))
    return
  dragDepth++
  ui.dragging = true
}
function onDragLeave(e: DragEvent) {
  if (!hasFiles(e))
    return
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0)
    ui.dragging = false
}
function onDragOver(e: DragEvent) {
  if (hasFiles(e))
    e.preventDefault()
}

async function onDrop(e: DragEvent) {
  if (!hasFiles(e))
    return
  e.preventDefault()
  dragDepth = 0
  ui.dragging = false
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
    const videos = files.filter(f => VIDEO_RE.test(f.name))
    if (!videos.length) {
      toast.warn('Nothing playable in that drop', { detail: 'Drop a video file or a folder of videos' })
      return
    }
    if (files.length > 1) {
      await library.addFiles(files)
      library.loadedAt = Date.now()
      toast.success(`Added ${videos.length} video${videos.length === 1 ? '' : 's'}`, { icon: 'i-carbon-folder' })
      if (videos.length > 1) {
        ui.openView('library')
        return
      }
    }
    ui.openView('player')
    await playback.playFile(videos[0])
  }
  catch (err) {
    console.error('Failed to handle dropped files:', err)
    toast.error('Could not read the dropped files')
  }
}

// ─── Hotkeys ──────────────────────────────────────────────────────────────────
function runShellAction(action: ShellAction) {
  switch (action) {
    case 'bookmark': {
      if (!player.videoPath)
        return
      const name = player.videoPath.split(/[\\/]/).pop() ?? player.videoPath
      bookmarks.add(name, player.currentTime)
      toast('Bookmark added', { icon: 'i-carbon-bookmark', key: 'bookmark' })
      break
    }
    case 'star': {
      const entry = playback.currentEntry
      if (!entry)
        return
      library.toggleStar(entry)
      toast(entry.starred ? 'Starred' : 'Unstarred', { icon: entry.starred ? 'i-carbon-star-filled' : 'i-carbon-star', key: 'star' })
      break
    }
    case 'next': transport.next(); break
    case 'prev': transport.prev(); break
    case 'random': transport.random(); break
    case 'panic': togglePanic(); break
    case 'help': ui.shortcutsOpen = !ui.shortcutsOpen; break
    case 'shuffle': playback.toggleShuffle(); break
    case 'repeat': playback.cycleRepeat(); break
    case 'view-player': ui.openView('player'); break
    case 'view-library': ui.openView('library'); break
    case 'view-playlists': ui.openView('playlists'); break
    case 'queue': ui.toggleInspector('queue'); break
    case 'library-panel': ui.toggleInspector('library-panel'); break
    case 'device': ui.toggleInspector('device'); break
    case 'palette': ui.paletteOpen = !ui.paletteOpen; break
    case 'edge': session.edge('key'); break
    case 'edge-release': session.release(); break
    case 'intensity-up': session.nudgeIntensity(KNOB_STEP); break
    case 'intensity-down': session.nudgeIntensity(-KNOB_STEP); break
    case 'next-peak': session.nextPeak(); break
    case 'finish': session.finish(); break
  }
}

function onGlobalKeyDown(e: KeyboardEvent) {
  // Ctrl/Cmd+K opens the palette from anywhere, even inside a field.
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyK') {
    e.preventDefault()
    runShellAction('palette')
    return
  }

  const t = e.target as HTMLElement
  if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
    return
  // Leave browser and OS shortcuts alone.
  if (e.ctrlKey || e.metaKey || e.altKey)
    return
  // A dialog is up: it owns the keyboard.
  if (ui.paletteOpen || ui.settingsOpen)
    return

  // '?' is a shifted key, so match the character rather than the code.
  if (e.key === '?') {
    e.preventDefault()
    runShellAction('help')
    return
  }

  const hit = SHELL_HOTKEYS.find(h => h.code === e.code && h.shift === e.shiftKey)
    ?? (e.code === 'Escape' || e.code === 'Backquote' ? SHELL_HOTKEYS.find(h => h.code === e.code) : undefined)
  if (!hit)
    return

  // Panic is the only thing that still works while the screen is covered.
  if (safety.panicked && hit.action !== 'panic')
    return
  // Esc closes the shortcuts sheet before it panics.
  if (hit.action === 'panic' && e.code === 'Escape' && ui.shortcutsOpen) {
    ui.shortcutsOpen = false
    return
  }

  e.preventDefault()
  runShellAction(hit.action)
}

onMounted(() => window.addEventListener('keydown', onGlobalKeyDown))
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKeyDown))

const stageView = computed(() => (ui.view === 'player' ? null : VIEW_COMPONENTS[ui.view]))
</script>

<template>
  <div
    class="text-fg bg-surface-950 flex flex-col h-screen select-none overflow-hidden"
    @dragenter="onDragEnter"
    @dragleave="onDragLeave"
    @dragover="onDragOver"
    @drop="onDrop"
  >
    <SplashScreen />
    <!-- The desktop window is frameless; the page draws its title bar. -->
    <TitleBar v-if="desktop?.window" />

    <div class="flex flex-1 min-h-0">
      <AppNav @open="openSingleVideo" />

      <!-- Stage -->
      <main ref="stageEl" class="flex-1 min-w-0 relative overflow-hidden">
        <Transition name="t-view" mode="out-in">
          <KeepAlive :max="4" :include="['LibraryView', 'PlaylistsView', 'EroScriptsView', 'OrganizerView']">
            <component :is="stageView" v-if="stageView" :key="ui.view" class="h-full w-full inset-0 absolute" />
          </KeepAlive>
        </Transition>

        <!-- The player never unmounts: script sync and the device follow the
             video, so it shrinks to a corner instead of going away. -->
        <div
          v-show="playerVisible"
          class="player-box bg-black absolute z-10 overflow-hidden"
          :class="mini ? 'shadow-[var(--shadow-lg)] ring-1 ring-edge-strong' : ''"
          :style="{
            left: `${playerBox.left}px`,
            top: `${playerBox.top}px`,
            width: `${playerBox.width}px`,
            height: `${playerBox.height}px`,
            borderRadius: `${playerBox.radius}px`,
          }"
        >
          <VideoPlayer :mini="mini" @expand="ui.openView('player')" @close-mini="closeMini">
            <template #overlay>
              <!-- Fades back with an edge, like everything else that stimulates. -->
              <div v-if="hypno.enabled && !mini" class="inset-0 absolute" :style="{ opacity: 1 - sessionControl.holdBack }">
                <HypnoOverlay />
              </div>
            </template>
          </VideoPlayer>
          <Transition name="t-fade">
            <WelcomeScreen v-if="!player.videoUrl && !mini" class="inset-0 absolute z-20" @open-file="openSingleVideo" />
          </Transition>
        </div>
      </main>

      <InspectorDrawer />
      <InspectorRail />
    </div>

    <NowPlayingBar />

    <ToastHost />
    <CommandPalette @open-file="openSingleVideo" />
    <ShortcutsModal />
    <SettingsModal />

    <!-- Floating windows over whichever view is open -->
    <OsrEmulator v-if="ui.isFloatingOpen('emulator')" />

    <!-- Drop target -->
    <Transition name="t-fade">
      <div
        v-if="ui.dragging"
        class="p-6 bg-black/50 pointer-events-none inset-0 fixed z-[800] backdrop-blur-sm"
      >
        <div class="border-2 border-accent/60 rounded-[var(--radius-xl)] border-dashed bg-accent-soft flex flex-col gap-3 h-full w-full animate-scale-in items-center justify-center">
          <div class="text-accent-300 rounded-[var(--radius-lg)] bg-surface-850 center h-16 w-16 shadow-[var(--shadow-lg)]">
            <span class="i-carbon-drop-photo text-[30px]" />
          </div>
          <p class="text-[18px] text-fg font-semibold">
            Drop to play
          </p>
          <p class="text-[13px] text-fg-muted">
            A video plays straight away — a folder goes into the library
          </p>
        </div>
      </div>
    </Transition>

    <PanicCover v-if="safety.panicked" @resume="resumePanic" />
  </div>
</template>

<style scoped>
.player-box {
  transition:
    left var(--dur-slow) var(--ease-out),
    top var(--dur-slow) var(--ease-out),
    width var(--dur-slow) var(--ease-out),
    height var(--dur-slow) var(--ease-out),
    border-radius var(--dur-slow) var(--ease-out);
}
</style>
