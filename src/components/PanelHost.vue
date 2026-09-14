<script setup lang="ts">
import type { PanelId } from '~/lib/panels'
import type { VideoEntry } from '~/stores/libraryStore'
import { findPanel } from '~/lib/panels'
import BinauralBeats from './BinauralBeats.vue'
import BookmarkPanel from './BookmarkPanel.vue'
import DevicePanel from './DevicePanel.vue'
import EroScriptsPanel from './EroScriptsPanel.vue'
import MediaWall from './MediaWall.vue'
import MotionPanel from './MotionPanel.vue'
import OrganizerPanel from './OrganizerPanel.vue'
import OsrEmulator from './OsrEmulator.vue'
import PlaylistPanel from './PlaylistPanel.vue'
import ScriptPanel from './ScriptPanel.vue'
import SlideshowView from './SlideshowView.vue'
import StatsDashboard from './StatsDashboard.vue'
import VideoLibrary from './VideoLibrary.vue'

const props = defineProps<{
  id: PanelId
  pinned?: boolean
  pinnable?: boolean
}>()

const emit = defineEmits<{
  select: [entry: VideoEntry]
  queue: [entries: VideoEntry[], selected: VideoEntry]
  seek: [time: number]
  pin: [id: PanelId]
  close: [id: PanelId]
}>()

const def = computed(() => findPanel(props.id))
</script>

<template>
  <section class="flex flex-col min-h-0 overflow-hidden">
    <!-- Slim title strip so a pinned panel is identifiable at a glance -->
    <header
      v-if="pinnable"
      class="px-2 border-b border-white/5 bg-surface-850 flex shrink-0 gap-1.5 h-7 items-center"
    >
      <div v-if="def" :class="[def.icon, def.accent]" class="text-xs" />
      <span class="text-[10px] text-white/50 tracking-wider font-medium uppercase">
        {{ def?.label }}
      </span>
      <div class="ml-auto flex gap-0.5 items-center">
        <button
          class="rounded flex h-5 w-5 transition-colors items-center justify-center"
          :class="pinned ? 'text-accent-400 bg-accent-600/20' : 'text-white/25 hover:text-white/60 hover:bg-white/10'"
          :title="pinned ? 'Unpin' : 'Pin above the active panel'"
          @click="emit('pin', id)"
        >
          <div :class="pinned ? 'i-carbon-pin-filled' : 'i-carbon-pin'" class="text-[11px]" />
        </button>
        <button
          class="text-white/25 rounded flex h-5 w-5 transition-colors items-center justify-center hover:text-white/60 hover:bg-white/10"
          title="Close"
          @click="emit('close', id)"
        >
          <div class="i-carbon-close text-[11px]" />
        </button>
      </div>
    </header>

    <div class="flex-1 min-h-0 overflow-hidden">
      <VideoLibrary
        v-if="id === 'library'"
        @select="e => emit('select', e)"
        @queue="(l, s) => emit('queue', l, s)"
      />
      <PlaylistPanel
        v-else-if="id === 'playlists'"
        @select="e => emit('select', e)"
        @queue="(l, s) => emit('queue', l, s)"
      />
      <OrganizerPanel v-else-if="id === 'organizer'" />
      <ScriptPanel v-else-if="id === 'scripts'" />
      <BookmarkPanel v-else-if="id === 'bookmarks'" @seek="t => emit('seek', t)" />
      <EroScriptsPanel v-else-if="id === 'eroscripts'" />
      <BinauralBeats v-else-if="id === 'binaural'" />
      <MediaWall v-else-if="id === 'wall'" />
      <SlideshowView v-else-if="id === 'slideshow'" />
      <DevicePanel v-else-if="id === 'device'" />
      <MotionPanel v-else-if="id === 'motion'" />
      <OsrEmulator v-else-if="id === 'emulator'" visible />
      <StatsDashboard v-else-if="id === 'stats'" />
    </div>
  </section>
</template>
