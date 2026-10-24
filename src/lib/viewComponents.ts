import type { Component } from 'vue'
import type { InspectorId, ViewId } from './views'
import BackupInspector from '~/components/inspectors/BackupInspector.vue'
import BinauralInspector from '~/components/inspectors/BinauralInspector.vue'
import BookmarksInspector from '~/components/inspectors/BookmarksInspector.vue'
import DeviceInspector from '~/components/inspectors/DeviceInspector.vue'
import DirectorInspector from '~/components/inspectors/DirectorInspector.vue'
import FaceInspector from '~/components/inspectors/FaceInspector.vue'
import HypnoInspector from '~/components/inspectors/HypnoInspector.vue'
import LibraryInspector from '~/components/inspectors/LibraryInspector.vue'
import MotionInspector from '~/components/inspectors/MotionInspector.vue'
import PlaylistsInspector from '~/components/inspectors/PlaylistsInspector.vue'
import ProgrammeInspector from '~/components/inspectors/ProgrammeInspector.vue'
import QueueInspector from '~/components/inspectors/QueueInspector.vue'
import RemoteInspector from '~/components/inspectors/RemoteInspector.vue'
import ScriptsInspector from '~/components/inspectors/ScriptsInspector.vue'
import EroScriptsView from '~/components/views/EroScriptsView.vue'
import LibraryView from '~/components/views/LibraryView.vue'
import MediaWallView from '~/components/views/MediaWallView.vue'
import OrganizerView from '~/components/views/OrganizerView.vue'
import PlaylistsView from '~/components/views/PlaylistsView.vue'
import SlideshowView from '~/components/views/SlideshowView.vue'
import StatsView from '~/components/views/StatsView.vue'

/**
 * Component for each registry id. Every one of these takes no props and emits
 * nothing: they read and drive the stores directly, so the shell can mount any
 * of them anywhere. The player view is special-cased by the shell (the video
 * element has to survive view switches), so it is not listed here.
 */
export const VIEW_COMPONENTS: Record<Exclude<ViewId, 'player'>, Component> = {
  library: LibraryView,
  playlists: PlaylistsView,
  wall: MediaWallView,
  slideshow: SlideshowView,
  eroscripts: EroScriptsView,
  organizer: OrganizerView,
  stats: StatsView,
}

export const INSPECTOR_COMPONENTS: Record<InspectorId, Component> = {
  'library-panel': LibraryInspector,
  'playlists-panel': PlaylistsInspector,
  'programme': ProgrammeInspector,
  'face': FaceInspector,
  'queue': QueueInspector,
  'scripts': ScriptsInspector,
  'bookmarks': BookmarksInspector,
  'device': DeviceInspector,
  'motion': MotionInspector,
  'remote': RemoteInspector,
  'binaural': BinauralInspector,
  'hypno': HypnoInspector,
  'director': DirectorInspector,
  'backup': BackupInspector,
}
