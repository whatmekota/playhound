<script setup lang="ts">
import type { FloatingId, InspectorId, ViewId } from '~/lib/views'
import { computed, ref, watch } from 'vue'
import { offeredHere } from '~/lib/android/features'
import { INSPECTOR_GROUPS, VIEW_GROUPS } from '~/lib/views'
import { usePlaybackStore } from '~/stores/playbackStore'
import { usePlayerStore } from '~/stores/playerStore'
import { usePluginStore } from '~/stores/pluginStore'
import { useUiStore } from '~/stores/uiStore'

/**
 * The phone layout's nav (useCompactLayout): a bar along the bottom with the
 * views used most, the device panel, and two sheets for everything else, in
 * place of the nav on the left and the tool rail on the right.
 */

const emit = defineEmits<{ open: [] }>()
const ui = useUiStore()
const player = usePlayerStore()
const playback = usePlaybackStore()
const pluginStore = usePluginStore()

const sheet = ref<'tools' | 'more' | null>(null)
watch(() => ui.settingsOpen || ui.paletteOpen, open => open && (sheet.value = null))

/** A tool panel covers the stage on a phone: a view's tab closes it. */
function closePanels() {
  if (ui.pinned)
    ui.closeInspector(ui.pinned)
  ui.closeInspector()
}

function go(id: ViewId) {
  closePanels()
  sheet.value = null
  ui.openView(id)
}

function tool(id: InspectorId | FloatingId) {
  sheet.value = null
  if (id === 'emulator') {
    ui.toggleFloating('emulator')
    return
  }
  if (ui.pinned && ui.pinned !== id)
    ui.closeInspector(ui.pinned)
  ui.toggleInspector(id)
}

function openPluginPanel(id: string) {
  sheet.value = null
  pluginStore.activePanel = id
  ui.openInspector('plugins')
}

function openPluginPage(id: string) {
  closePanels()
  sheet.value = null
  ui.openPluginView(id)
}

const panelOpen = computed(() => ui.drawerOpen)
const viewOn = (id: ViewId) => !panelOpen.value && ui.view === id

const TABS: { id: ViewId, label: string, icon: string }[] = [
  { id: 'player', label: 'Player', icon: 'i-carbon-play-filled-alt' },
  { id: 'library', label: 'Library', icon: 'i-carbon-video-chat' },
]

const tools = computed(() => INSPECTOR_GROUPS
  .flatMap(g => g.items)
  .filter(i => i.id !== 'plugins' && i.id !== 'library-panel' && i.id !== 'playlists-panel' && offeredHere(i.id)))

const moreViews = computed(() => VIEW_GROUPS
  .flatMap(g => g.items)
  .filter(i => !TABS.some(t => t.id === i.id) && offeredHere(i.id)))

const actions = [
  { icon: 'i-carbon-search', label: 'Search', run: () => (ui.paletteOpen = true) },
  { icon: 'i-carbon-document-add', label: 'Open a file', run: () => emit('open') },
  { icon: 'i-carbon-shuffle', label: 'Random', run: () => playback.random() },
  { icon: 'i-carbon-settings', label: 'Settings', run: () => (ui.settingsOpen = true) },
]

function toggleSheet(which: 'tools' | 'more') {
  sheet.value = sheet.value === which ? null : which
}
</script>

<template>
  <!-- The sheet over the stage, above the bar -->
  <Transition name="t-fade">
    <div v-if="sheet" class="bg-black/40 inset-0 fixed z-[640]" @pointerdown.self="sheet = null">
      <div class="mobile-sheet px-3 pb-3 pt-2 scroll-y border-t border-edge bg-surface-900 max-h-[70vh] shadow-[var(--shadow-pop)] inset-x-0 absolute">
        <div class="mx-auto mb-2 rounded-full bg-fg/20 h-1 w-10" />
        <template v-if="sheet === 'tools'">
          <div class="mobile-grid">
            <button
              v-for="t in tools"
              :key="t.id"
              type="button"
              class="mobile-tile"
              :class="(t.id === 'emulator' ? ui.isFloatingOpen('emulator') : ui.inspector === t.id) ? 'text-accent-300 bg-accent-soft' : ''"
              @click="tool(t.id)"
            >
              <span :class="t.icon" class="text-[22px]" />
              <span class="text-[11.5px] leading-tight">{{ t.label }}</span>
            </button>
            <button
              v-for="p in pluginStore.panels"
              :key="p.manifest.id"
              type="button"
              class="mobile-tile"
              @click="openPluginPanel(p.manifest.id)"
            >
              <span v-if="p.panel?.icon" class="plugin-icon text-[22px]" v-html="p.panel.icon" />
              <span v-else class="i-carbon-application text-[22px]" />
              <span class="text-[11.5px] leading-tight">{{ p.panel?.title || p.manifest.name }}</span>
            </button>
          </div>
        </template>
        <template v-else>
          <div class="mobile-grid">
            <button v-for="v in moreViews" :key="v.id" type="button" class="mobile-tile" :class="viewOn(v.id) ? 'text-accent-300 bg-accent-soft' : ''" @click="go(v.id)">
              <span :class="v.icon" class="text-[22px]" />
              <span class="text-[11.5px] leading-tight">{{ v.label }}</span>
            </button>
            <button v-for="p in pluginStore.pages" :key="p.manifest.id" type="button" class="mobile-tile" @click="openPluginPage(p.manifest.id)">
              <span v-if="p.page?.icon" class="plugin-icon text-[22px]" v-html="p.page.icon" />
              <span v-else class="i-carbon-application text-[22px]" />
              <span class="text-[11.5px] leading-tight">{{ p.page?.title || p.manifest.name }}</span>
            </button>
          </div>
          <div class="my-3 divider-y" />
          <div class="mobile-grid">
            <button v-for="a in actions" :key="a.label" type="button" class="mobile-tile" @click="sheet = null; a.run()">
              <span :class="a.icon" class="text-[22px]" />
              <span class="text-[11.5px] leading-tight">{{ a.label }}</span>
            </button>
          </div>
        </template>
      </div>
    </div>
  </Transition>

  <nav class="mobile-nav border-t border-edge bg-surface-900 flex shrink-0 relative z-[650]" aria-label="Views">
    <button
      v-for="t in TABS"
      :key="t.id"
      type="button"
      class="mobile-tab"
      :class="viewOn(t.id) ? 'text-accent-300' : 'text-fg-muted'"
      :aria-current="viewOn(t.id) ? 'page' : undefined"
      @click="go(t.id)"
    >
      <span :class="t.icon" class="text-[21px]" />
      <span>{{ t.label }}</span>
      <span v-if="t.id === 'player' && player.isPlaying && !viewOn('player')" class="rounded-full bg-accent h-1.5 w-1.5 right-[calc(50%-16px)] top-2 absolute" />
    </button>
    <button
      type="button"
      class="mobile-tab"
      :class="ui.inspector === 'device' ? 'text-accent-300' : 'text-fg-muted'"
      @click="tool('device')"
    >
      <span class="i-carbon-plug text-[21px]" />
      <span>Device</span>
    </button>
    <button
      type="button"
      class="mobile-tab"
      :class="sheet === 'tools' || (panelOpen && ui.inspector !== 'device') ? 'text-accent-300' : 'text-fg-muted'"
      :aria-expanded="sheet === 'tools'"
      @click="toggleSheet('tools')"
    >
      <span class="i-carbon-tool-box text-[21px]" />
      <span>Tools</span>
    </button>
    <button
      type="button"
      class="mobile-tab"
      :class="sheet === 'more' ? 'text-accent-300' : 'text-fg-muted'"
      :aria-expanded="sheet === 'more'"
      @click="toggleSheet('more')"
    >
      <span class="i-carbon-overflow-menu-horizontal text-[21px]" />
      <span>More</span>
    </button>
  </nav>
</template>
