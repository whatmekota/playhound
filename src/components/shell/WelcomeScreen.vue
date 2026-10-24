<script setup lang="ts">
import type { VideoEntry } from '~/stores/libraryStore'
import { computed, ref, watch } from 'vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import UiKbd from '~/components/ui/UiKbd.vue'
import UiSpinner from '~/components/ui/UiSpinner.vue'
import { toast } from '~/composables/useToast'
import { thumbDb } from '~/lib/idb'
import { formatTime } from '~/lib/time'
import { useLibraryStore } from '~/stores/libraryStore'
import { usePlaybackStore } from '~/stores/playbackStore'
import { useStatsStore } from '~/stores/statsStore'
import { useUiStore } from '~/stores/uiStore'
import BrandMark from './BrandMark.vue'

/**
 * What the player stage shows with nothing loaded: the first thing anyone sees.
 *
 * It answers "what now?" for whichever state the app is in — a brand-new
 * install (open a folder), a remembered folder the browser wants a click for
 * (reconnect), or a library that is ready (continue, browse, random).
 */
const emit = defineEmits<{ openFile: [] }>()

const library = useLibraryStore()
const playback = usePlaybackStore()
const stats = useStatsStore()
const ui = useUiStore()

const busy = ref<'pick' | 'reconnect' | null>(null)

async function openFolder() {
  if (busy.value)
    return
  busy.value = 'pick'
  try {
    if (await library.pickFolder())
      ui.openView('library')
  }
  catch (err) {
    console.error('Folder pick failed:', err)
  }
  finally {
    busy.value = null
  }
}

async function reconnect() {
  if (busy.value)
    return
  busy.value = 'reconnect'
  try {
    const ok = await library.reconnect()
    if (!ok && library.needsReconnect)
      toast.warn('The browser did not allow access', { detail: 'Try again, or open the folder afresh' })
  }
  finally {
    busy.value = null
  }
}

const scriptedCount = computed(() => library.videos.reduce((n, v) => n + (v.hasScript ? 1 : 0), 0))

// ─── Greeting ────────────────────────────────────────────────────────────────
const greeting = computed(() => {
  const h = new Date().getHours()
  return h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
})

const headline = computed(() => {
  if (library.restoring)
    return 'Bringing your library back…'
  if (library.needsReconnect)
    return 'Pick up where you left off'
  if (library.hasVideos)
    return 'What are we playing?'
  return 'Point me at your videos'
})

const lede = computed(() => {
  if (library.needsReconnect)
    return `Your folder “${library.savedFolderName}” is remembered — the browser just wants one click before reading it again.`
  if (library.hasVideos)
    return `${library.videos.length.toLocaleString()} videos in ${library.folderName || 'your library'}, ${scriptedCount.value.toLocaleString()} with scripts.`
  return 'Open a folder and playhound pairs every video with its funscripts, then drives your device in sync.'
})

// ─── Actions ─────────────────────────────────────────────────────────────────
interface Action {
  id: string
  icon: string
  title: string
  sub: string
  primary?: boolean
  loading?: boolean
  disabled?: boolean
  kbd?: string
  run: () => void
}

const actions = computed<Action[]>(() => {
  const list: Action[] = []
  if (library.restoring) {
    list.push({ id: 'restoring', icon: 'i-carbon-folder', title: `Restoring ${library.savedFolderName || 'library'}`, sub: 'Reading the folder…', primary: true, loading: true, disabled: true, run: () => {} })
  }
  else if (library.needsReconnect && library.savedFolderName) {
    list.push({ id: 'reconnect', icon: 'i-carbon-connect', title: `Reconnect “${library.savedFolderName}”`, sub: 'One click to grant access again', primary: true, loading: busy.value === 'reconnect', run: reconnect })
  }
  else if (library.hasVideos) {
    list.push({ id: 'library', icon: 'i-carbon-video-chat', title: 'Browse library', sub: `${library.videos.length.toLocaleString()} videos`, primary: true, kbd: '2', run: () => ui.openView('library') })
  }

  const firstRun = !list.length
  list.push({
    id: 'folder',
    icon: 'i-carbon-folder-add',
    title: firstRun ? 'Open a folder' : library.hasVideos ? 'Switch folder' : 'Open another folder',
    sub: firstRun ? 'Videos and their scripts, together' : 'Index a different folder',
    primary: firstRun,
    loading: busy.value === 'pick',
    run: openFolder,
  })
  list.push({ id: 'file', icon: 'i-carbon-document-video', title: 'Open a file', sub: 'Play a single video', run: () => emit('openFile') })
  if (library.hasVideos)
    list.push({ id: 'random', icon: 'i-carbon-shuffle', title: 'Surprise me', sub: scriptedCount.value ? 'A random scripted video' : 'A random video', kbd: 'R', run: () => void playback.random() })
  return list
})

// ─── Continue ────────────────────────────────────────────────────────────────
interface ContinueItem {
  entry: VideoEntry
  reason: 'recent' | 'starred'
  at: number
}

const CONTINUE_MAX = 6

const continueItems = computed<ContinueItem[]>(() => {
  if (!library.hasVideos)
    return []
  const byName = new Map(library.videos.map(v => [v.name, v]))
  const out: ContinueItem[] = []
  const seen = new Set<string>()
  // Stats are keyed by file name, which is what the library keys on too.
  for (const s of stats.allStats()) {
    if (out.length >= CONTINUE_MAX)
      break
    const entry = byName.get(s.videoName)
    if (entry && s.lastPlayedAt) {
      out.push({ entry, reason: 'recent', at: s.lastPlayedAt })
      seen.add(entry.name)
    }
  }
  for (const v of library.videos) {
    if (out.length >= CONTINUE_MAX)
      break
    if (v.starred && !seen.has(v.name))
      out.push({ entry: v, reason: 'starred', at: 0 })
  }
  return out
})

// Thumbnails live in IndexedDB once the library has rendered them; pull in any
// the entries do not carry yet.
watch(continueItems, async (items) => {
  for (const { entry } of items) {
    if (entry.thumbnailUrl)
      continue
    try {
      const cached = await thumbDb.get(entry.name)
      if (cached)
        entry.thumbnailUrl = cached
    }
    catch {}
  }
}, { immediate: true })

function ago(ts: number) {
  const s = (Date.now() - ts) / 1000
  if (s < 60)
    return 'Just now'
  if (s < 3600)
    return `${Math.floor(s / 60)} min ago`
  if (s < 86400)
    return `${Math.floor(s / 3600)} h ago`
  const d = Math.floor(s / 86400)
  return d === 1 ? 'Yesterday' : d < 30 ? `${d} days ago` : new Date(ts).toLocaleDateString()
}

const SCRIPT_TONE = { none: 'neutral', single: 'accent', multi: 'info', merged: 'info' } as const

// ─── Background ──────────────────────────────────────────────────────────────
// Two periods (300 and 400 units) that both divide 1200, so a 2400-wide path
// translated by half its width loops without a seam.
function wavePath(amp: number, phase: number) {
  const pts: string[] = []
  for (let x = 0; x <= 2400; x += 12) {
    const y = 60
      + amp * Math.sin((x / 300) * Math.PI * 2 + phase)
      + amp * 0.45 * Math.sin((x / 400) * Math.PI * 2 + phase * 1.7)
    pts.push(`${x},${y.toFixed(1)}`)
  }
  return `M${pts.join('L')}`
}
const WAVE_A = wavePath(22, 0)
const WAVE_B = wavePath(14, 1.3)
</script>

<template>
  <div class="welcome text-fg scroll-y bg-surface-950 select-none">
    <!-- Ambient background: two slow colour drifts, a dot grid and a waveform.
         Transform-only animations, so the compositor does all the work. -->
    <div class="pointer-events-none inset-0 absolute overflow-hidden" aria-hidden="true">
      <div class="wl-blob wl-blob-a" />
      <div class="wl-blob wl-blob-b" />
      <div class="wl-grid" />
      <svg class="wl-wave" viewBox="0 0 2400 120" preserveAspectRatio="none">
        <path :d="WAVE_B" class="wl-wave-b" />
        <path :d="WAVE_A" class="wl-wave-a" />
      </svg>
    </div>

    <div class="mx-auto px-8 py-10 flex flex-col gap-9 max-w-[880px] min-h-full justify-center relative">
      <!-- Hero -->
      <header class="text-center flex flex-col gap-4 animate-rise items-center">
        <div class="wl-mark">
          <BrandMark :size="60" />
        </div>
        <div class="flex flex-col gap-2 items-center">
          <span class="eyebrow">{{ greeting }}</span>
          <h1 class="text-[26px] leading-tight tracking-[-0.025em] font-semibold m-0">
            {{ headline }}
          </h1>
          <p class="text-[13.5px] text-fg-muted leading-relaxed m-0 max-w-[520px]">
            {{ lede }}
          </p>
        </div>
      </header>

      <!-- Actions -->
      <section class="gap-3 grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))]" aria-label="Get started">
        <button
          v-for="(a, i) in actions"
          :key="a.id"
          type="button"
          class="group p-4 text-left focusable border rounded-[var(--radius-lg)] flex flex-col gap-3 min-h-[118px] transition-[transform,border-color,background-color,box-shadow] duration-200 animate-rise relative overflow-hidden"
          :class="[
            a.primary
              ? 'wl-primary border-transparent text-accent-contrast'
              : 'border-edge bg-surface-850/80 hover:bg-surface-800 hover:border-edge-strong',
            a.disabled ? 'cursor-default' : 'hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.99]',
          ]"
          :style="{ animationDelay: `${80 + i * 50}ms` }"
          :disabled="a.disabled || a.loading"
          @click="a.run()"
        >
          <span
            class="rounded-[var(--radius-md)] center h-9 w-9 transition-transform duration-200"
            :class="[a.primary ? 'bg-accent-contrast/15' : 'bg-accent-soft text-accent-300', a.disabled ? '' : 'group-hover:scale-105']"
          >
            <UiSpinner v-if="a.loading" :size="16" />
            <span v-else :class="a.icon" class="text-[18px]" />
          </span>
          <span class="flex flex-col gap-0.5 min-w-0">
            <span class="text-[14px] font-semibold truncate">{{ a.title }}</span>
            <span class="text-[12px] truncate" :class="a.primary ? 'opacity-80' : 'text-fg-muted'">{{ a.sub }}</span>
          </span>
          <UiKbd v-if="a.kbd" class="right-3 top-3 absolute" :class="a.primary ? '!bg-accent-contrast/15 !border-accent-contrast/25 !text-current' : ''">
            {{ a.kbd }}
          </UiKbd>
          <span
            v-else-if="!a.disabled"
            class="i-carbon-arrow-right text-[14px] opacity-0 transition-all duration-200 right-3.5 top-3.5 absolute group-hover:opacity-70 -translate-x-1 group-hover:translate-x-0"
          />
        </button>
      </section>

      <!-- Continue -->
      <section v-if="continueItems.length" class="flex flex-col gap-3 animate-rise" style="animation-delay: 220ms">
        <div class="flex items-center justify-between">
          <span class="eyebrow">Continue</span>
          <button type="button" class="text-[12px] text-fg-muted focusable rounded-[var(--radius-sm)] flex gap-1 transition-colors items-center hover:text-fg" @click="ui.openView('library')">
            All videos <span class="i-carbon-arrow-right text-[12px]" />
          </button>
        </div>
        <div class="gap-3 grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))]">
          <button
            v-for="it in continueItems"
            :key="it.entry.name"
            v-tip="it.entry.basename"
            type="button"
            class="group text-left focusable rounded-[var(--radius-md)] flex flex-col gap-1.5 min-w-0"
            @click="playback.play(it.entry)"
          >
            <span class="rounded-[var(--radius-md)] bg-surface-800 w-full aspect-video block ring-1 ring-edge transition-shadow duration-200 relative overflow-hidden group-hover:ring-accent/50 group-hover:shadow-[var(--shadow-md)]">
              <img
                v-if="it.entry.thumbnailUrl"
                :src="it.entry.thumbnailUrl"
                alt=""
                class="h-full w-full transition-transform duration-500 ease-[var(--ease-out)] object-cover group-hover:scale-105"
                loading="lazy"
              >
              <span v-else class="wl-thumb-empty text-fg-faint center inset-0 absolute">
                <span class="i-carbon-video text-[22px]" />
              </span>
              <!-- Over a thumbnail, so white on a dark scrim is right here. -->
              <span class="bg-black/35 opacity-0 center transition-opacity duration-200 inset-0 absolute group-hover:opacity-100">
                <span class="text-white rounded-full bg-black/45 center h-9 w-9 backdrop-blur-sm">
                  <span class="i-carbon-play-filled-alt text-[15px]" />
                </span>
              </span>
              <span v-if="it.entry.duration" class="text-[10.5px] text-white num px-1.5 py-px rounded-[var(--radius-xs)] bg-black/60 bottom-1.5 right-1.5 absolute">
                {{ formatTime(it.entry.duration) }}
              </span>
              <span v-if="it.entry.starred" class="i-carbon-star-filled text-[13px] text-warn left-1.5 top-1.5 absolute drop-shadow" />
            </span>
            <span class="text-[12.5px] text-fg font-medium px-0.5 truncate">{{ it.entry.basename }}</span>
            <span class="text-[11px] text-fg-faint px-0.5 flex gap-1.5 items-center">
              <span class="truncate">{{ it.reason === 'recent' ? ago(it.at) : 'Starred' }}</span>
              <UiBadge v-if="it.entry.hasScript" size="xs" :tone="SCRIPT_TONE[it.entry.scriptType]">
                {{ it.entry.scriptCount > 1 ? `${it.entry.scriptCount} axes` : 'Script' }}
              </UiBadge>
            </span>
          </button>
        </div>
      </section>

      <!-- Skeleton while the folder restores, so the layout does not jump -->
      <section v-else-if="library.restoring" class="flex flex-col gap-3" aria-hidden="true">
        <span class="skeleton rounded h-3 w-20" />
        <div class="gap-3 grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))]">
          <div v-for="n in 4" :key="n" class="flex flex-col gap-1.5">
            <span class="skeleton rounded-[var(--radius-md)] aspect-video" />
            <span class="skeleton rounded h-3 w-3/4" />
          </div>
        </div>
      </section>

      <!-- Drop + keys -->
      <footer class="flex flex-col gap-4 animate-fade-in items-center" style="animation-delay: 300ms">
        <div class="text-[12.5px] text-fg-muted px-4 py-2.5 border border-edge-strong rounded-full border-dashed flex gap-2 items-center">
          <span class="i-carbon-drop-photo text-[15px] text-fg-faint" />
          Drop a video to play it, or a folder to add it to the library
        </div>
        <div class="text-[12px] text-fg-faint flex flex-wrap gap-x-5 gap-y-2 items-center justify-center">
          <span class="flex gap-1.5 items-center"><UiKbd>Ctrl</UiKbd><UiKbd>K</UiKbd> Search &amp; commands</span>
          <span class="flex gap-1.5 items-center"><UiKbd>?</UiKbd> Shortcuts</span>
          <span class="flex gap-1.5 items-center"><UiKbd>Esc</UiKbd> Panic</span>
        </div>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.welcome {
  overflow-x: hidden;
}

.wl-mark {
  position: relative;
  animation: wl-float 6s ease-in-out infinite;
}
.wl-mark::before {
  content: '';
  position: absolute;
  inset: -22px;
  border-radius: 9999px;
  background: radial-gradient(closest-side, color-mix(in srgb, var(--accent) 30%, transparent), transparent);
  z-index: -1;
}

.wl-primary {
  background: linear-gradient(135deg, var(--accent-light) -20%, var(--accent) 45%, var(--accent-strong));
  box-shadow:
    0 1px 0 color-mix(in srgb, var(--accent-contrast) 25%, transparent) inset,
    0 12px 28px -14px var(--accent);
}
.wl-primary:not(:disabled):hover {
  box-shadow:
    0 1px 0 color-mix(in srgb, var(--accent-contrast) 25%, transparent) inset,
    0 16px 36px -14px var(--accent);
}

.wl-thumb-empty {
  background: linear-gradient(135deg, var(--bg-800), var(--bg-700));
}

.wl-blob {
  position: absolute;
  width: 70%;
  aspect-ratio: 1;
  border-radius: 9999px;
  will-change: transform;
}
.wl-blob-a {
  left: -18%;
  top: -30%;
  background: radial-gradient(closest-side, color-mix(in srgb, var(--accent) 16%, transparent), transparent);
  animation: wl-drift-a 28s ease-in-out infinite alternate;
}
.wl-blob-b {
  right: -20%;
  bottom: -35%;
  background: radial-gradient(closest-side, color-mix(in srgb, var(--accent-light) 11%, transparent), transparent);
  animation: wl-drift-b 34s ease-in-out infinite alternate;
}

.wl-grid {
  position: absolute;
  inset: 0;
  background-image: radial-gradient(var(--border-strong) 1px, transparent 1.2px);
  background-size: 22px 22px;
  mask-image: radial-gradient(ellipse 70% 60% at 50% 45%, black, transparent 75%);
  opacity: 0.6;
}

.wl-wave {
  position: absolute;
  left: 0;
  bottom: 6%;
  width: 200%;
  height: 120px;
  animation: wl-scroll 48s linear infinite;
  will-change: transform;
}
.wl-wave path {
  fill: none;
  stroke-width: 1.5;
  vector-effect: non-scaling-stroke;
}
.wl-wave-a {
  stroke: color-mix(in srgb, var(--accent) 28%, transparent);
}
.wl-wave-b {
  stroke: color-mix(in srgb, var(--accent-light) 14%, transparent);
}

@keyframes wl-drift-a {
  to {
    transform: translate(18%, 22%) scale(1.15);
  }
}
@keyframes wl-drift-b {
  to {
    transform: translate(-16%, -18%) scale(1.1);
  }
}
@keyframes wl-scroll {
  to {
    transform: translateX(-50%);
  }
}
@keyframes wl-float {
  0%,
  100% {
    transform: translateY(0);
  }
  50% {
    transform: translateY(-4px);
  }
}
</style>
