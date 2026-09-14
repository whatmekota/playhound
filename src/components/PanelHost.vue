<script setup lang="ts">
import type { PanelId } from '~/lib/panels'
import type { VideoEntry } from '~/stores/libraryStore'
import { findPanel, isMainSurface } from '~/lib/panels'
import BinauralBeats from './BinauralBeats.vue'
import BookmarkPanel from './BookmarkPanel.vue'
import DevicePanel from './DevicePanel.vue'
import EroScriptsPanel from './EroScriptsPanel.vue'
import MediaWall from './MediaWall.vue'
import MotionPanel from './MotionPanel.vue'
import OrganizerPanel from './OrganizerPanel.vue'
import PlaylistPanel from './PlaylistPanel.vue'
import ScriptPanel from './ScriptPanel.vue'
import SlideshowView from './SlideshowView.vue'
import StatsDashboard from './StatsDashboard.vue'
import VideoLibrary from './VideoLibrary.vue'

const props = defineProps<{
  id: PanelId
  pinned?: boolean
}>()

const emit = defineEmits<{
  select: [entry: VideoEntry]
  queue: [entries: VideoEntry[], selected: VideoEntry]
  seek: [time: number]
  pin: [id: PanelId]
  close: [id: PanelId]
}>()

const def = computed(() => findPanel(props.id))
// Canvas panels own the main area, so there is nothing to pin them into.
const canPin = computed(() => !isMainSurface(props.id))
</script>

<template>
  <section class="flex flex-col min-h-0 overflow-hidden">
    <!-- Slim title strip so a pinned panel is identifiable at a glance -->
    <header class="panel-header">
      <div v-if="def" :class="[def.icon, def.accent]" class="text-sm shrink-0" />
      <span class="panel-title truncate">{{ def?.label }}</span>
      <div class="ml-auto flex shrink-0 gap-0.5 items-center">
        <button
          v-if="canPin"
          class="btn-icon h-6 w-6"
          :class="pinned ? 'text-accent-400 bg-accent-500/15' : ''"
          :title="pinned ? 'Unpin' : 'Pin above the active panel'"
          @click="emit('pin', id)"
        >
          <div :class="pinned ? 'i-carbon-pin-filled' : 'i-carbon-pin'" class="text-xs" />
        </button>
        <button class="btn-icon h-6 w-6" title="Close panel" @click="emit('close', id)">
          <div class="i-carbon-close text-xs" />
        </button>
      </div>
    </header>

    <div class="panel-body">
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
      <StatsDashboard v-else-if="id === 'stats'" />
    </div>
  </section>
</template>
