/**
 * Everything the shell can show, in one registry.
 *
 * Two kinds:
 *
 * - `view`      — owns the main stage (the player, the library grid, the media
 *                 wall…). One at a time, picked from the nav on the left.
 * - `inspector` — a tool panel in the drawer on the right (device, motion,
 *                 queue…). One active, plus optionally one pinned above it, so
 *                 a readout stays visible while you work in another.
 * - `floating`  — a draggable window over everything (the OSR emulator).
 *
 * Components are resolved in src/lib/viewComponents.ts so this file stays
 * importable from uno.config.ts (which safelists the icons).
 */

export type ViewId
  = | 'player' | 'library' | 'playlists'
    | 'wall' | 'slideshow'
    | 'eroscripts' | 'organizer' | 'stats'

export type InspectorId
  = | 'library-panel' | 'playlists-panel'
    | 'queue' | 'scripts' | 'bookmarks'
    | 'device' | 'motion' | 'remote'
    | 'binaural' | 'hypno' | 'director' | 'programme' | 'face'
    | 'backup'

export type FloatingId = 'emulator'

export type AnyViewId = ViewId | InspectorId | FloatingId

export type ViewKind = 'view' | 'inspector' | 'floating'

export interface ViewDef<Id extends AnyViewId = AnyViewId> {
  id: Id
  kind: ViewKind
  label: string
  /** UnoCSS preset-icons class from @iconify-json/carbon */
  icon: string
  /** One line, shown in tooltips and the command palette. */
  hint: string
  /** Keyboard shortcut shown next to it, if it has one. */
  kbd?: string
}

export interface ViewGroup<Id extends AnyViewId = AnyViewId> {
  id: string
  label: string
  items: ViewDef<Id>[]
}

/** Left nav: what the main stage shows. */
export const VIEW_GROUPS: ViewGroup<ViewId>[] = [
  {
    id: 'watch',
    label: 'Watch',
    items: [
      { id: 'player', kind: 'view', label: 'Player', icon: 'i-carbon-play-filled-alt', hint: 'The video and its script', kbd: '1' },
      { id: 'library', kind: 'view', label: 'Library', icon: 'i-carbon-video-chat', hint: 'Browse videos and matched scripts', kbd: '2' },
      { id: 'playlists', kind: 'view', label: 'Playlists', icon: 'i-carbon-list', hint: 'Saved and smart playlists', kbd: '3' },
    ],
  },
  {
    id: 'session',
    label: 'Session',
    items: [
      { id: 'wall', kind: 'view', label: 'Media Wall', icon: 'i-carbon-grid', hint: 'Free-placed images, video and YouTube' },
      { id: 'slideshow', kind: 'view', label: 'Slideshow', icon: 'i-carbon-image', hint: 'Beat-synced slideshow' },
    ],
  },
  {
    id: 'tools',
    label: 'Tools',
    items: [
      { id: 'eroscripts', kind: 'view', label: 'EroScripts', icon: 'i-carbon-cloud-download', hint: 'Browse and fetch scripts from EroScripts' },
      { id: 'organizer', kind: 'view', label: 'Organizer', icon: 'i-carbon-folder-move-to', hint: 'Rename videos and scripts together' },
      { id: 'stats', kind: 'view', label: 'Stats', icon: 'i-carbon-chart-bar', hint: 'Watch and session history' },
    ],
  },
]

/** Right rail: tool panels in the inspector drawer. */
export const INSPECTOR_GROUPS: ViewGroup<InspectorId | FloatingId>[] = [
  {
    // The same library and playlists as the views on the left, sized for the
    // drawer, so you can pick the next thing without leaving the video.
    id: 'browse',
    label: 'Browse',
    items: [
      { id: 'library-panel', kind: 'inspector', label: 'Library', icon: 'i-carbon-video-chat', hint: 'Browse the library beside the video', kbd: 'L' },
      { id: 'playlists-panel', kind: 'inspector', label: 'Playlists', icon: 'i-carbon-list', hint: 'Browse playlists beside the video' },
    ],
  },
  {
    id: 'playback',
    label: 'Playback',
    items: [
      { id: 'queue', kind: 'inspector', label: 'Queue', icon: 'i-carbon-list-boxes', hint: 'Now playing, up next and history', kbd: 'Q' },
      { id: 'scripts', kind: 'inspector', label: 'Scripts', icon: 'i-carbon-chart-line-data', hint: 'Loaded funscript axes' },
      { id: 'bookmarks', kind: 'inspector', label: 'Bookmarks', icon: 'i-carbon-bookmark', hint: 'Marked positions (B to add)' },
    ],
  },
  {
    id: 'device',
    label: 'Device',
    items: [
      { id: 'device', kind: 'inspector', label: 'Device', icon: 'i-carbon-plug', hint: 'Serial / Intiface connection and axes', kbd: 'D' },
      { id: 'motion', kind: 'inspector', label: 'Motion', icon: 'i-carbon-wave-height', hint: 'What drives the device: script, session, beat or manual' },
      { id: 'emulator', kind: 'floating', label: 'Emulator', icon: 'i-carbon-cube', hint: 'Floating OSR preview over any view' },
      { id: 'remote', kind: 'inspector', label: 'Remote', icon: 'i-carbon-mobile', hint: 'Control playback from your phone' },
      { id: 'face', kind: 'inspector', label: 'Face', icon: 'i-carbon-face-wink', hint: 'The CYD face: what it shows and how it reacts' },
    ],
  },
  {
    id: 'session',
    label: 'Session',
    items: [
      { id: 'binaural', kind: 'inspector', label: 'Binaural', icon: 'i-carbon-headphones', hint: 'Binaural tone, noise and session phases' },
      { id: 'hypno', kind: 'inspector', label: 'Hypno', icon: 'i-carbon-circle-dash', hint: 'Spiral, words and breathing ring over the video' },
      { id: 'director', kind: 'inspector', label: 'Director', icon: 'i-carbon-machine-learning-model', hint: 'Picks what plays next to match the session' },
      { id: 'programme', kind: 'inspector', label: 'Programme', icon: 'i-carbon-roadmap', hint: 'A planned session: phases, videos, sound and motion following one arc' },
    ],
  },
  {
    id: 'data',
    label: 'Data',
    items: [
      { id: 'backup', kind: 'inspector', label: 'Backup', icon: 'i-carbon-save', hint: 'What is stored here, and export / import it' },
    ],
  },
]

export const ALL_VIEWS: ViewDef[] = [
  ...VIEW_GROUPS.flatMap(g => g.items),
  ...INSPECTOR_GROUPS.flatMap(g => g.items),
]

export function findView(id: AnyViewId | null | undefined): ViewDef | undefined {
  return id ? ALL_VIEWS.find(v => v.id === id) : undefined
}

export function isViewId(id: string): id is ViewId {
  return findView(id as AnyViewId)?.kind === 'view'
}

export function isInspectorId(id: string): id is InspectorId {
  return findView(id as AnyViewId)?.kind === 'inspector'
}
