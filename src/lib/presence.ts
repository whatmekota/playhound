import type { PresenceActivity } from './browserApi'

/**
 * What goes into Discord Rich Presence, worked out from the session.
 *
 * Off by default. "Minimal" shows the app (Discord names it after the
 * application) with the logo and a timer, and nothing about what is playing.
 * "Custom" fills two lines from templates with {{placeholders}}, so showing a
 * title is always a deliberate choice. Vue-free so it can be tested.
 */

export type PresenceMode = 'minimal' | 'custom'
export type PresenceTimer = 'session' | 'video' | 'none'

export interface PresenceSettings {
  enabled: boolean
  /** The Discord application's ID (a long number). Never a bot token. */
  clientId: string
  mode: PresenceMode
  /** 0 Playing, 2 Listening to, 3 Watching. */
  activityType: 0 | 2 | 3
  /** Custom mode: first line. */
  details: string
  /** Custom mode: second line. */
  state: string
  timer: PresenceTimer
  /** Name of an image uploaded to the application's Rich Presence art assets. */
  largeImageKey: string
  largeImageText: string
  /** Clear the presence while nothing is playing. */
  hideWhenIdle: boolean
}

/**
 * The owner's own Discord application. An Application ID is public (it is in
 * every presence it shows), so it can live in the source; presence still
 * stays off until switched on in Settings.
 */
export const DEFAULT_CLIENT_ID = '1563782113008943176'

export const DEFAULT_PRESENCE: PresenceSettings = {
  enabled: false,
  clientId: DEFAULT_CLIENT_ID,
  mode: 'minimal',
  activityType: 0,
  details: '{{state}} · {{source}}',
  state: '{{spm}} spm · {{bpm}} bpm',
  timer: 'session',
  largeImageKey: 'logo',
  largeImageText: 'playhound',
  hideWhenIdle: false,
}

/** Everything a template can mention. Missing values render as nothing. */
export interface PresenceContext {
  /** Video title (file name without extension). */
  title?: string
  /** Where the queue came from: "Library", a playlist name, "Programme"… */
  playlist?: string
  /** Playing / Paused / Idle. */
  state?: string
  position?: string
  duration?: string
  /** Strokes per minute right now, rounded. */
  spm?: number
  /** Music tempo, when the music source knows it. */
  bpm?: number
  /** What drives the device: Script, Music, Session, Manual… */
  source?: string
  /** The intensity knob, as a percentage. */
  intensity?: number
  /** Edges this session. */
  edges?: number
  chapter?: string
  /** Programme name and phase, when one runs. */
  programme?: string
  phase?: string
  /** Heart rate, when a monitor is connected. */
  heart?: number
  /** Device name, or empty when none is connected. */
  device?: string
  /** Number of script axes loaded. */
  axes?: number
}

/** The placeholders, for the settings UI. */
export const PRESENCE_PLACEHOLDERS: { key: keyof PresenceContext, label: string, example: string }[] = [
  { key: 'title', label: 'Video title', example: 'My favourite PMV' },
  { key: 'playlist', label: 'Playlist or source', example: 'Library' },
  { key: 'state', label: 'Playing / Paused', example: 'Playing' },
  { key: 'position', label: 'Position', example: '1:24' },
  { key: 'duration', label: 'Length', example: '3:43' },
  { key: 'spm', label: 'Strokes per minute', example: '71' },
  { key: 'bpm', label: 'Music tempo', example: '141' },
  { key: 'source', label: 'Motion source', example: 'Script' },
  { key: 'intensity', label: 'Intensity knob %', example: '80' },
  { key: 'edges', label: 'Edges this session', example: '3' },
  { key: 'chapter', label: 'Chapter', example: 'Peak' },
  { key: 'programme', label: 'Programme', example: 'Classic' },
  { key: 'phase', label: 'Programme phase', example: 'Build' },
  { key: 'heart', label: 'Heart rate', example: '96' },
  { key: 'device', label: 'Device', example: 'OSR2' },
  { key: 'axes', label: 'Script axes', example: '4' },
]

const SEPARATORS = /^[\s·•|\-–—:,/]+|[\s·•|\-–—:,/]+$/g

function value(v: unknown): string {
  if (v === undefined || v === null)
    return ''
  if (typeof v === 'number')
    return Number.isFinite(v) && v > 0 ? String(Math.round(v)) : ''
  return String(v).trim()
}

/**
 * Fill a template. A placeholder with nothing to say takes the words glued to
 * it with it ("{{bpm}} bpm" vanishes whole when there is no tempo), and the
 * separators left dangling are tidied, so a half-empty line still reads.
 */
export function renderTemplate(template: string, ctx: PresenceContext): string {
  // Split on separators so each chunk can vanish on its own.
  const parts = template.split(/(\s[·•|\-–—]\s|\s\/\s)/)
  const kept: string[] = []
  for (let i = 0; i < parts.length; i += 2) {
    const chunk = parts[i]
    let empty = false
    let hadPlaceholder = false
    const filled = chunk.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => {
      hadPlaceholder = true
      const v = value((ctx as Record<string, unknown>)[k])
      if (!v)
        empty = true
      return v
    })
    if (hadPlaceholder && empty)
      continue
    const t = filled.trim()
    if (!t)
      continue
    if (kept.length)
      kept.push(parts[i - 1] ?? ' ')
    kept.push(t)
  }
  return kept.join('').replace(/\s+/g, ' ').replace(SEPARATORS, '').trim().slice(0, 128)
}

/**
 * The activity to send, or null to clear. `sessionStart` and `videoStart`
 * are epoch ms for the elapsed timers.
 */
export function buildActivity(
  s: PresenceSettings,
  ctx: PresenceContext,
  times: { sessionStart: number, videoStart: number | null },
): PresenceActivity | null {
  if (!s.enabled || !s.clientId)
    return null
  if (s.hideWhenIdle && (!ctx.state || ctx.state === 'Idle'))
    return null

  const a: PresenceActivity = { type: s.activityType }
  if (s.mode === 'custom') {
    const details = renderTemplate(s.details, ctx)
    const state = renderTemplate(s.state, ctx)
    // Discord refuses one-character lines.
    if (details.length >= 2)
      a.details = details
    if (state.length >= 2)
      a.state = state
  }
  if (s.timer === 'session')
    a.startTimestamp = times.sessionStart
  else if (s.timer === 'video' && times.videoStart !== null)
    a.startTimestamp = times.videoStart
  if (s.largeImageKey.trim()) {
    a.largeImageKey = s.largeImageKey.trim()
    if (s.largeImageText.trim().length >= 2)
      a.largeImageText = s.largeImageText.trim()
  }
  return a
}

/** Application IDs are Discord snowflakes: 15–22 digits. */
export function isClientId(v: string): boolean {
  return /^\d{15,22}$/.test(v.trim())
}
