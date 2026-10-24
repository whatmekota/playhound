<script setup lang="ts">
import type { ThemeId } from '~/stores/themeStore'
import { useLocalStorage } from '@vueuse/core'
import { computed, ref, watch } from 'vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiField from '~/components/ui/UiField.vue'
import UiKbd from '~/components/ui/UiKbd.vue'
import UiModal from '~/components/ui/UiModal.vue'
import UiSelect from '~/components/ui/UiSelect.vue'
import UiSwitch from '~/components/ui/UiSwitch.vue'
import { toast } from '~/composables/useToast'
import { useLibraryStore } from '~/stores/libraryStore'
import { useSafetyStore } from '~/stores/safetyStore'
import { THEMES, useThemeStore } from '~/stores/themeStore'
import { useUiStore } from '~/stores/uiStore'
import { version } from '../../../package.json'
import BrandMark from './BrandMark.vue'

/**
 * App-wide settings. Feature settings (device, audio, hypno…) live in their
 * own inspectors next to what they change; this is only for the things that
 * belong to the app as a whole.
 */
const ui = useUiStore()
const theme = useThemeStore()
const safety = useSafetyStore()
const library = useLibraryStore()

// Shared with SplashScreen; VueUse keeps same-key refs in sync.
const splash = useLocalStorage('ph:ui.splash', true)

type SectionId = 'appearance' | 'startup' | 'safety' | 'library' | 'keyboard' | 'about'
const SECTIONS: { id: SectionId, label: string, icon: string }[] = [
  { id: 'appearance', label: 'Appearance', icon: 'i-carbon-color-palette' },
  { id: 'startup', label: 'Startup', icon: 'i-carbon-rocket' },
  { id: 'safety', label: 'Safety', icon: 'i-carbon-security' },
  { id: 'library', label: 'Library', icon: 'i-carbon-folder' },
  { id: 'keyboard', label: 'Keyboard', icon: 'i-carbon-keyboard' },
  { id: 'about', label: 'About', icon: 'i-carbon-information' },
]
const section = ref<SectionId>('appearance')
const current = computed(() => SECTIONS.find(s => s.id === section.value)!)

const THEME_NOTE: Record<ThemeId, string> = {
  dark: 'Neutral black, magenta accent',
  light: 'For daylight',
  catppuccin: 'Mocha, soft pastels',
  dracula: 'Purple night, pink accent',
}

// ─── Safety ──────────────────────────────────────────────────────────────────
const IDLE_OPTIONS = [
  { value: 0, label: 'Never' },
  { value: 5, label: 'After 5 minutes' },
  { value: 10, label: 'After 10 minutes' },
  { value: 15, label: 'After 15 minutes' },
  { value: 30, label: 'After 30 minutes' },
  { value: 60, label: 'After 1 hour' },
]
const idleOptions = computed(() =>
  IDLE_OPTIONS.some(o => o.value === safety.idleStopMinutes)
    ? IDLE_OPTIONS
    : [...IDLE_OPTIONS, { value: safety.idleStopMinutes, label: `After ${safety.idleStopMinutes} minutes` }],
)

// ─── Library ─────────────────────────────────────────────────────────────────
const folder = computed(() => library.folderName || library.savedFolderName)
const folderState = computed<{ label: string, tone: 'ok' | 'warn' | 'neutral' | 'info' }>(() => {
  if (library.restoring)
    return { label: 'Restoring', tone: 'info' }
  if (library.needsReconnect)
    return { label: 'Needs reconnect', tone: 'warn' }
  if (library.isWatching)
    return { label: 'Watching for new files', tone: 'ok' }
  if (library.hasVideos)
    return { label: 'Loaded', tone: 'ok' }
  return { label: 'No folder', tone: 'neutral' }
})
const scripted = computed(() => library.videos.reduce((n, v) => n + (v.hasScript ? 1 : 0), 0))

const picking = ref(false)
async function pickFolder() {
  picking.value = true
  try {
    if (await library.pickFolder()) {
      ui.settingsOpen = false
      ui.openView('library')
    }
  }
  catch (err) {
    console.error('Folder pick failed:', err)
  }
  finally {
    picking.value = false
  }
}

async function reconnect() {
  const ok = await library.reconnect()
  if (ok)
    toast.success(`Reconnected ${library.folderName}`, { icon: 'i-carbon-folder' })
}

const rescanning = ref(false)
async function rescan() {
  rescanning.value = true
  try {
    await library.rescan()
    toast.success('Library rescanned', { detail: `${library.videos.length} videos`, icon: 'i-carbon-renew' })
  }
  finally {
    rescanning.value = false
  }
}

/** Forgetting is destructive (the library empties), so it takes two clicks. */
const confirmForget = ref(false)
let confirmTimer: ReturnType<typeof setTimeout> | null = null
async function forget() {
  if (!confirmForget.value) {
    confirmForget.value = true
    confirmTimer = setTimeout(() => (confirmForget.value = false), 3500)
    return
  }
  if (confirmTimer)
    clearTimeout(confirmTimer)
  confirmForget.value = false
  const name = folder.value
  await library.forgetFolder()
  toast(`Forgot ${name}`, { icon: 'i-carbon-folder' })
}

watch(() => ui.settingsOpen, (open) => {
  if (!open)
    confirmForget.value = false
})

// ─── Elsewhere ───────────────────────────────────────────────────────────────
function openShortcuts() {
  ui.settingsOpen = false
  ui.shortcutsOpen = true
}
function openPalette() {
  ui.settingsOpen = false
  ui.paletteOpen = true
}
function openBackup() {
  ui.settingsOpen = false
  ui.openInspector('backup')
}
</script>

<template>
  <UiModal v-model:open="ui.settingsOpen" title="Settings" icon="i-carbon-settings" width="780px" flush>
    <div class="border-t border-edge flex h-[min(560px,70vh)]">
      <!-- Sections -->
      <nav class="p-2 border-r border-edge bg-surface-900/40 flex shrink-0 flex-col gap-0.5 w-[184px]" aria-label="Settings sections">
        <button
          v-for="s in SECTIONS"
          :key="s.id"
          type="button"
          class="text-[13px] px-2.5 focusable rounded-[var(--radius-md)] flex gap-2.5 h-9 transition-colors items-center"
          :class="section === s.id ? 'bg-fg/8 text-fg font-medium' : 'text-fg-muted hover:text-fg hover:bg-fg/4'"
          :aria-current="section === s.id ? 'page' : undefined"
          @click="section = s.id"
        >
          <span :class="[s.icon, section === s.id ? 'text-accent-300' : '']" class="text-[16px] shrink-0" />
          {{ s.label }}
        </button>
      </nav>

      <!-- Content -->
      <div class="px-6 py-5 scroll-y flex-1 min-w-0">
        <Transition name="t-view" mode="out-in">
          <div :key="section" class="flex flex-col gap-5">
            <h3 class="text-[15px] text-fg font-semibold m-0">
              {{ current.label }}
            </h3>

            <!-- Appearance -->
            <template v-if="section === 'appearance'">
              <div class="gap-3 grid grid-cols-2" role="radiogroup" aria-label="Theme">
                <button
                  v-for="t in THEMES"
                  :key="t.id"
                  type="button"
                  role="radio"
                  :aria-checked="theme.current === t.id"
                  class="group p-1.5 text-left focusable rounded-[var(--radius-lg)] flex flex-col gap-2 transition-[box-shadow,transform] duration-200 hover:-translate-y-0.5"
                  :class="theme.current === t.id ? 'ring-2 ring-accent shadow-[var(--shadow-md)]' : 'ring-1 ring-edge-strong hover:ring-fg/25'"
                  @click="theme.apply(t.id)"
                >
                  <!-- A tiny copy of the shell, drawn in that theme's own tokens:
                       data-theme scopes the variables to this subtree. -->
                  <span :data-theme="t.id" class="rounded-[var(--radius-md)] bg-surface-950 flex h-[92px] w-full pointer-events-none overflow-hidden">
                    <span class="pt-2 border-r border-edge bg-surface-900 flex shrink-0 flex-col gap-1.5 w-6 items-center">
                      <span class="rounded-[3px] bg-accent h-2.5 w-2.5" />
                      <span class="rounded-full bg-fg/25 h-1 w-2.5" />
                      <span class="rounded-full bg-fg/15 h-1 w-2.5" />
                      <span class="rounded-full bg-fg/15 h-1 w-2.5" />
                    </span>
                    <span class="p-2 flex flex-1 flex-col gap-1.5 min-w-0">
                      <span class="rounded-[5px] bg-surface-800 flex-1 relative">
                        <span class="text-accent-contrast rounded-full bg-accent center h-4 w-4 left-1/2 top-1/2 absolute -translate-x-1/2 -translate-y-1/2">
                          <span class="i-carbon-play-filled-alt text-[8px]" />
                        </span>
                      </span>
                      <span class="flex gap-1 items-center">
                        <span class="rounded-full bg-fg/80 h-1 w-8" />
                        <span class="rounded-full bg-fg-faint h-1 w-5" />
                      </span>
                      <span class="rounded-full bg-surface-700 h-1 relative overflow-hidden">
                        <span class="rounded-full bg-accent w-2/5 inset-y-0 left-0 absolute" />
                      </span>
                    </span>
                    <span class="p-1.5 border-l border-edge bg-surface-900 flex shrink-0 flex-col gap-1 w-9">
                      <span class="rounded-[3px] bg-surface-800 h-3" />
                      <span class="rounded-[3px] bg-accent-soft h-3" />
                      <span class="rounded-[3px] bg-surface-800 h-3" />
                    </span>
                  </span>
                  <span class="px-1.5 pb-1 flex gap-2 items-center">
                    <span class="flex flex-1 flex-col min-w-0">
                      <span class="text-[13px] text-fg font-medium">{{ t.label }}</span>
                      <span class="hint truncate">{{ THEME_NOTE[t.id] }}</span>
                    </span>
                    <span
                      class="text-accent-contrast rounded-full bg-accent center shrink-0 h-5 w-5 transition-all duration-200"
                      :class="theme.current === t.id ? 'scale-100 opacity-100' : 'scale-50 opacity-0'"
                    >
                      <span class="i-carbon-checkmark text-[12px]" />
                    </span>
                  </span>
                </button>
              </div>

              <div class="px-4 py-3 card">
                <UiSwitch v-model="ui.navExpanded" label="Sidebar labels" hint="Show view names next to the icons in the left bar" />
              </div>
            </template>

            <!-- Startup -->
            <template v-else-if="section === 'startup'">
              <div class="px-4 py-3 card flex flex-col gap-3">
                <UiSwitch v-model="splash" label="Intro animation" hint="Plays once per browser session; reloads go straight in. Add ?nosplash to the address to skip it once." />
              </div>
              <div class="px-4 py-3.5 card flex gap-3">
                <span class="i-carbon-restart text-[18px] text-accent-300 mt-0.5 shrink-0" />
                <div class="flex flex-col gap-1">
                  <span class="text-[13px] text-fg">Resumes where you left off</span>
                  <span class="hint">
                    At startup playhound reopens your last folder, rebuilds the queue and loads the video you were
                    watching — paused, a few seconds before where you stopped. If the browser asks for permission
                    again, a single Reconnect click on the welcome screen brings it all back.
                  </span>
                </div>
              </div>
            </template>

            <!-- Safety -->
            <template v-else-if="section === 'safety'">
              <div class="p-4 border border-danger/25 rounded-[var(--radius-lg)] bg-danger/6 flex gap-3">
                <span class="i-carbon-warning-hex text-[20px] text-danger shrink-0" />
                <div class="flex flex-col gap-1.5">
                  <span class="text-[13px] text-fg font-medium">Panic</span>
                  <span class="hint">
                    Stops the device, pauses video and audio and covers the screen with a plain clock.
                    Press it again to put everything back exactly as it was.
                  </span>
                  <span class="text-[12px] text-fg-muted flex gap-1.5 items-center">
                    <UiKbd>Esc</UiKbd> or <UiKbd>`</UiKbd> anywhere
                  </span>
                </div>
              </div>
              <div class="px-4 py-3 card flex flex-col gap-4">
                <UiSwitch
                  v-model="safety.panicOnBlur"
                  label="Panic when the window loses focus"
                  hint="Switching to another app or tab triggers panic straight away."
                  tone="danger"
                />
                <div class="divider-y" />
                <UiField label="Stop the device when idle" hint="No mouse or keyboard input for this long homes the device. The screen is left alone.">
                  <UiSelect v-model="safety.idleStopMinutes" :options="idleOptions" />
                </UiField>
              </div>
            </template>

            <!-- Library -->
            <template v-else-if="section === 'library'">
              <div class="p-4 card flex flex-col gap-4">
                <div class="flex gap-3 items-center">
                  <span class="text-accent-300 rounded-[var(--radius-md)] bg-accent-soft center shrink-0 h-10 w-10">
                    <span class="i-carbon-folder text-[19px]" />
                  </span>
                  <div class="flex flex-1 flex-col gap-0.5 min-w-0">
                    <span class="text-[14px] text-fg font-medium truncate">{{ folder || 'No folder yet' }}</span>
                    <span class="hint">
                      <template v-if="library.hasVideos">{{ library.videos.length.toLocaleString() }} videos · {{ scripted.toLocaleString() }} with scripts</template>
                      <template v-else-if="folder">Remembered, not loaded</template>
                      <template v-else>Open a folder to build your library</template>
                    </span>
                  </div>
                  <UiBadge :tone="folderState.tone" dot :pulse="library.isWatching || library.restoring">
                    {{ folderState.label }}
                  </UiBadge>
                </div>
                <div class="flex flex-wrap gap-2">
                  <UiButton v-if="library.needsReconnect" variant="primary" icon="i-carbon-connect" @click="reconnect">
                    Reconnect
                  </UiButton>
                  <UiButton :variant="folder ? 'secondary' : 'primary'" icon="i-carbon-folder-add" :loading="picking" @click="pickFolder">
                    {{ folder ? 'Choose another folder' : 'Open a folder' }}
                  </UiButton>
                  <UiButton v-if="library.isWatching" icon="i-carbon-renew" :loading="rescanning" @click="rescan">
                    Rescan
                  </UiButton>
                  <UiButton v-if="folder" variant="danger" icon="i-carbon-trash-can" class="ml-auto" @click="forget">
                    {{ confirmForget ? 'Click again to forget' : 'Forget folder' }}
                  </UiButton>
                </div>
              </div>
              <p class="hint m-0">
                Files never leave this browser. playhound keeps a handle to the folder so it can reopen it, plus
                thumbnails, stars, stats and playlists — see the Backup panel to export them.
              </p>
              <div>
                <UiButton variant="ghost" icon="i-carbon-save" @click="openBackup">
                  Open Backup
                </UiButton>
              </div>
            </template>

            <!-- Keyboard -->
            <template v-else-if="section === 'keyboard'">
              <div class="gap-3 grid grid-cols-2">
                <button type="button" class="group p-4 text-left focusable card flex flex-col gap-2 transition-colors hover:bg-surface-800" @click="openPalette">
                  <span class="flex gap-1"><UiKbd>Ctrl</UiKbd><UiKbd>K</UiKbd></span>
                  <span class="text-[13px] text-fg font-medium">Command palette</span>
                  <span class="hint">Every view, command and video, a few letters away.</span>
                </button>
                <button type="button" class="group p-4 text-left focusable card flex flex-col gap-2 transition-colors hover:bg-surface-800" @click="openShortcuts">
                  <span class="flex gap-1"><UiKbd>?</UiKbd></span>
                  <span class="text-[13px] text-fg font-medium">All shortcuts</span>
                  <span class="hint">The full cheat sheet, grouped.</span>
                </button>
              </div>
              <div class="px-4 py-1 card">
                <div
                  v-for="row in [
                    { keys: ['Space'], label: 'Play / pause' },
                    { keys: ['N'], label: 'Next video' },
                    { keys: ['R'], label: 'Random scripted video' },
                    { keys: ['1', '2', '3'], label: 'Player, Library, Playlists' },
                    { keys: ['Q'], label: 'Queue panel' },
                    { keys: ['D'], label: 'Device panel' },
                  ]"
                  :key="row.label"
                  class="py-2 border-t border-edge flex items-center justify-between first:border-t-0"
                >
                  <span class="text-[12.5px] text-fg-muted">{{ row.label }}</span>
                  <span class="flex gap-1"><UiKbd v-for="k in row.keys" :key="k">{{ k }}</UiKbd></span>
                </div>
              </div>
            </template>

            <!-- About -->
            <template v-else>
              <div class="about p-6 text-center card flex flex-col gap-4 items-center relative overflow-hidden">
                <BrandMark :size="56" animated />
                <div class="flex flex-col gap-1 items-center">
                  <span class="text-[22px] tracking-[-0.03em] font-semibold">play<span class="text-accent-300">hound</span></span>
                  <UiBadge tone="accent" size="xs">
                    v{{ version }}
                  </UiBadge>
                </div>
                <p class="text-[12.5px] text-fg-muted leading-relaxed m-0 max-w-[380px]">
                  A funscript video player and audiovisual session engine for TCode / OSR devices.
                  Runs entirely in your browser; nothing is uploaded anywhere.
                </p>
              </div>
              <div class="text-[12px] text-fg-faint flex flex-wrap gap-x-4 gap-y-1 justify-center">
                <span>Vue 3 · Pinia · UnoCSS</span>
                <span>Web Serial · Buttplug</span>
                <span>Geist</span>
              </div>
            </template>
          </div>
        </Transition>
      </div>
    </div>
  </UiModal>
</template>

<style scoped>
.about::before {
  content: '';
  position: absolute;
  inset: -40% -10% auto;
  height: 120%;
  background: radial-gradient(closest-side, color-mix(in srgb, var(--accent) 14%, transparent), transparent);
  pointer-events: none;
}
.about > * {
  position: relative;
}
</style>
