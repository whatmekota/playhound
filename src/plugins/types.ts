/**
 * The plugin API, as a plugin sees it.
 *
 * A plugin is a zip with a `manifest.json` and one ES module (`main`, default
 * `index.js`) whose default export is `activate(ctx)`. It may return a
 * function (or `{ deactivate }`) that undoes what it set up; it runs when the
 * plugin is switched off or removed.
 *
 * Plugins run inside playhound with the same access as playhound itself.
 * There is no sandbox: install only plugins you trust.
 */

export interface PluginManifest {
  /** Lower-case letters, digits and dashes; the plugin's identity. */
  id: string
  name: string
  version: string
  description?: string
  author?: string
  /** The module to load, relative to the zip root. Default `index.js`. */
  main?: string
}

export type SettingField
  = | (FieldBase & { type: 'text' | 'password', placeholder?: string, default?: string })
    | (FieldBase & { type: 'textarea', placeholder?: string, rows?: number, default?: string })
    | (FieldBase & { type: 'number', min?: number, max?: number, step?: number, default?: number })
    | (FieldBase & { type: 'slider', min: number, max: number, step?: number, unit?: string, default?: number })
    | (FieldBase & { type: 'switch', default?: boolean })
    | (FieldBase & {
      type: 'select'
      /** A fixed list, or a function that fetches one (refreshed on demand). */
      options: SelectOption[] | (() => Promise<SelectOption[]>)
      default?: string
      /** Also accept a value that is not in the list (typed in). */
      free?: boolean
    })
    | { type: 'heading', label: string, hint?: string, key?: undefined, when?: FieldBase['when'] }

interface FieldBase {
  key: string
  label: string
  hint?: string
  /** Show the field only when this returns true (given the current values). */
  when?: (values: Record<string, unknown>) => boolean
}

export interface SelectOption { value: string, label: string }

export interface PanelDef {
  /** Shown as the drawer's title and the rail button's tooltip; the plugin's name if absent. */
  title?: string
  /**
   * The rail button's icon: an inline SVG drawn in currentColor, about 16×16
   * (stroke or fill). A generic icon stands in without one.
   */
  icon?: string
  /** Build the panel's DOM into `el`; return a cleanup. Called each time the panel opens. */
  mount: (el: HTMLElement) => void | (() => void)
}

export interface PlayerSnapshot {
  playing: boolean
  /** File name of what's loaded, or null. */
  title: string | null
  time: number
  duration: number
  hasScript: boolean
}

/** A video in the library, with what playhound knows about it. */
export interface LibraryVideo {
  /** Its file name: the key to pass back to playback.play(). */
  id: string
  /** The name without the extension. */
  title: string
  /** From its library folder down, e.g. "Videos/sub/clip.mp4". */
  path: string
  durationS: number | null
  hasScript: boolean
  starred: boolean
  /** How hard its script goes, once analysed; null before (see library.analyse). */
  intensity: { band: 'gentle' | 'medium' | 'intense', meanSpm: number, meanSpeed: number, peakSpeed: number } | null
  /** Names of the (hand-made) playlists it is in. */
  playlists: string[]
  plays: number
  /** Times the user marked "I came" during it. */
  finishes: number
  watchedMin: number
  /** ms since epoch, or null if never played. */
  lastPlayedAt: number | null
}

/** What the loaded script is doing around the playhead, and what comes next. */
export interface ScriptNow {
  /** Strokes per minute right now. */
  spm: number
  /** 0-1: how hard this part goes against the rest of this script. */
  level: number
  /** The next stretch that goes clearly harder (or, if already hard, eases off), within a minute. */
  next: { inS: number, kind: 'harder' | 'easier', spm: number, level: number } | null
  /** Seconds to the end of the script. */
  endsInS: number
}

export interface MotionTarget {
  /** Strokes per minute; capped by the app's own speed ceiling. 0 stops the stroke. */
  spm?: number
  /** Stroke length, 0–1 of the axis range. */
  depth?: number
  /** Middle of the stroke, 0 (bottom) – 1 (top). */
  center?: number
  shape?: 'sine' | 'ease' | 'pulse' | 'saw' | 'sharp'
}

export interface MotionReadout {
  spm: number
  depth: number
  /** Where the stroke axis is now, 0-1: the generator's output, or a script's while one plays. */
  pos: number
  /** The app's speed ceiling, strokes per minute. */
  maxSpm: number
  /** Something is connected that takes the motion. */
  device: boolean
}

/** The stroke generator, while a plugin holds it. */
export interface MotionControl {
  set: (target: MotionTarget) => void
  /** Stop stroking but keep control. */
  hold: () => void
  /** Hand the generator back: its settings as they were before `take()`, and stopped. */
  release: () => void
  readonly active: boolean
}

export interface PluginContext {
  readonly manifest: PluginManifest
  settings: {
    get: <T = unknown>(key: string) => T
    all: () => Record<string, unknown>
    set: (key: string, value: unknown) => void
    /** Called after any setting changes; returns an unsubscribe. */
    onChange: (fn: (values: Record<string, unknown>) => void) => () => void
  }
  /** Small persistent key/value store for the plugin's own data. */
  storage: {
    get: <T = unknown>(key: string) => Promise<T | undefined>
    set: (key: string, value: unknown) => Promise<void>
    del: (key: string) => Promise<void>
  }
  ui: {
    /** The form shown for this plugin in Settings → Plugins. */
    settings: (fields: SettingField[]) => void
    /** The plugin's panel in the Plugins drawer. */
    panel: (def: PanelDef) => void
    openPanel: () => void
    openSettings: () => void
    /** CSS for the plugin's own DOM; removed when it is switched off. */
    style: (css: string) => void
    toast: (text: string, opts?: { tone?: 'info' | 'success' | 'error', detail?: string }) => void
  }
  player: {
    state: () => PlayerSnapshot
    /** The loaded script around the playhead; null without a script. */
    script: () => ScriptNow | null
    /** The video's current picture as a JPEG data URL (default 512 px wide); null without one. */
    frame: (opts?: { maxWidth?: number, quality?: number }) => string | null
    /** When what plays, or whether it plays, changes (not on every clock tick). */
    onChange: (fn: (s: PlayerSnapshot) => void) => () => void
  }
  /** The user's library. Read-only; empty until a folder is open. */
  library: {
    list: () => Promise<LibraryVideo[]>
    /** Analyse the scripts of these videos (those not done yet), so their intensity is known. */
    analyse: (ids: string[]) => Promise<void>
    /** When the library is (re)loaded. */
    onChange: (fn: () => void) => () => void
  }
  /** What plays. */
  playback: {
    /** Play a library video on its own (nothing queued after it). False if it isn't in the library. */
    play: (id: string) => Promise<boolean>
    pause: () => void
    resume: () => void
    /** When the video playing reaches its end. */
    onEnded: (fn: (id: string | null) => void) => () => void
  }
  motion: {
    /** Take the stroke generator (the Manual source). Null while panic is on. */
    take: () => MotionControl | null
    readout: () => MotionReadout
  }
  safety: {
    panicked: () => boolean
    /** Panic (Esc) fired: stop talking, stop moving. Control was already released. */
    onPanic: (fn: () => void) => () => void
  }
  net: {
    /**
     * fetch(), but in the desktop app it goes out from the app itself, so a
     * local server without CORS headers answers. Streams like fetch does.
     */
    fetch: (url: string, init?: RequestInit) => Promise<Response>
  }
  /** A blob: URL for a file from the plugin's zip, or null. */
  asset: (path: string) => string | null
  log: (...args: unknown[]) => void
}

export type Activate = (ctx: PluginContext) => void | (() => void) | { deactivate: () => void } | Promise<void | (() => void) | { deactivate: () => void }>
