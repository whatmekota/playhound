/**
 * Registry of every sidebar panel, grouped for the navigation rail.
 *
 * After the merge there are thirteen of these, which is what the old flat row
 * of header icons could no longer carry.
 */

export type PanelId
  = | 'library' | 'playlists' | 'organizer'
    | 'scripts' | 'bookmarks' | 'eroscripts'
    | 'binaural' | 'wall' | 'slideshow'
    | 'device' | 'motion' | 'emulator'
    | 'stats'

export type PanelGroupId = 'media' | 'script' | 'session' | 'device' | 'data'

export interface PanelDef {
  id: PanelId
  label: string
  /** UnoCSS preset-icons class from @iconify-json/carbon */
  icon: string
  /** Tailwind-ish accent class used when the panel is active */
  accent: string
  hint: string
}

export interface PanelGroup {
  id: PanelGroupId
  label: string
  panels: PanelDef[]
}

export const PANEL_GROUPS: PanelGroup[] = [
  {
    id: 'media',
    label: 'Media',
    panels: [
      { id: 'library', label: 'Library', icon: 'i-carbon-video', accent: 'text-accent-400', hint: 'Browse videos and matched scripts' },
      { id: 'playlists', label: 'Playlists', icon: 'i-carbon-list', accent: 'text-accent-400', hint: 'Saved and smart playlists' },
      { id: 'organizer', label: 'Organizer', icon: 'i-carbon-folder-move-to', accent: 'text-accent-400', hint: 'Rename videos and scripts together' },
    ],
  },
  {
    id: 'script',
    label: 'Script',
    panels: [
      { id: 'scripts', label: 'Scripts', icon: 'i-carbon-chart-line-data', accent: 'text-accent-400', hint: 'Loaded funscript axes' },
      { id: 'bookmarks', label: 'Bookmarks', icon: 'i-carbon-bookmark', accent: 'text-amber-400', hint: 'Marked positions (B to add)' },
      { id: 'eroscripts', label: 'EroScripts', icon: 'i-carbon-cloud-download', accent: 'text-rose-400', hint: 'Browse and fetch from EroScripts' },
    ],
  },
  {
    id: 'session',
    label: 'Session',
    panels: [
      { id: 'binaural', label: 'Binaural', icon: 'i-carbon-headphones', accent: 'text-teal-400', hint: 'Binaural tone, noise and session phases' },
      { id: 'wall', label: 'Media Wall', icon: 'i-carbon-grid', accent: 'text-teal-400', hint: 'Free-placed images, video and YouTube' },
      { id: 'slideshow', label: 'Slideshow', icon: 'i-carbon-play-outline', accent: 'text-teal-400', hint: 'Beat-synced slideshow' },
    ],
  },
  {
    id: 'device',
    label: 'Device',
    panels: [
      { id: 'device', label: 'Device', icon: 'i-carbon-plug', accent: 'text-accent-400', hint: 'Serial / Buttplug connection and axes' },
      { id: 'motion', label: 'Motion', icon: 'i-carbon-wave-height', accent: 'text-emerald-400', hint: 'What drives the device: script, session, beat or manual' },
      { id: 'emulator', label: 'Emulator', icon: 'i-carbon-cube', accent: 'text-accent-400', hint: 'On-screen OSR preview' },
    ],
  },
  {
    id: 'data',
    label: 'Data',
    panels: [
      { id: 'stats', label: 'Stats', icon: 'i-carbon-chart-bar', accent: 'text-pink-400', hint: 'Session history' },
    ],
  },
]

export const ALL_PANELS: PanelDef[] = PANEL_GROUPS.flatMap(g => g.panels)

export function findPanel(id: PanelId | null): PanelDef | undefined {
  return id ? ALL_PANELS.find(p => p.id === id) : undefined
}
