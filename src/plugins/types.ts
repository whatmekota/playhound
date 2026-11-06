/**
 * The plugin API, as a plugin sees it.
 *
 * A plugin is a zip with a `manifest.json` and one ES module (`main`, default
 * `index.js`) whose default export is `activate(ctx)`. It may return a
 * function (or `{ deactivate }`) that undoes what it set up; it runs when the
 * plugin is switched off or removed.
 *
 * Plugins run inside playhound with the same access as playhound itself.
 * There is no sandbox: install only plugins you trust. From API 2 a plugin
 * lists the permissions it needs, and ctx refuses the rest (see
 * src/plugins/manifest.ts).
 */

/** What a plugin can ask to do; see PERMISSIONS in src/plugins/manifest.ts. */
export type PluginPermission = 'device' | 'scripts' | 'player' | 'playback' | 'library' | 'network' | 'stage'

export interface PluginManifest {
  /** Lower-case letters, digits and dashes; the plugin's identity. */
  id: string
  name: string
  version: string
  description?: string
  author?: string
  /** The module to load, relative to the zip root. Default `index.js`. */
  main?: string
  /** The plugin API it is written for. 1 when absent; newer than playhound's refuses to install. */
  api?: number
  /**
   * What it needs (API 2). Without this list an API 1 plugin has full access;
   * an API 2 plugin has only what needs no permission.
   */
  permissions?: PluginPermission[]
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

/**
 * A page on the main stage, where the player, the library and the media wall
 * show. Same shape as a panel: `mount` gets a plain element filling the stage.
 */
export type PageDef = PanelDef

/**
 * What the main stage shows: one of playhound's own views, or a plugin's page
 * as `plugin:<id>`.
 */
export type StageView
  = | 'player' | 'library' | 'playlists'
    | 'wall' | 'slideshow'
    | 'eroscripts' | 'organizer' | 'stats'
    | `plugin:${string}`

export interface PlayerSnapshot {
  playing: boolean
  /** File name of what's loaded, or null. */
  title: string | null
  time: number
  duration: number
  hasScript: boolean
  /** The playback speed, 1 is normal (the one player.setRate sets). */
  rate: number
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

/** A command in the palette (Ctrl K), listed under the plugin's name. */
export interface CommandDef {
  /** Unique within the plugin; registering the same id again replaces it. */
  id: string
  title: string
  /** A second line, shown while the command is highlighted. */
  hint?: string
  /** An inline SVG in currentColor, about 16×16. A generic icon stands in without one. */
  icon?: string
  /**
   * A keyboard shortcut: a letter, digit or F1–F12, with any of Ctrl, Alt
   * and Shift, e.g. "Shift+K", "Alt+2", "Ctrl+Shift+Y". Refused (logged, and
   * register() returns false) when playhound or another plugin already uses it.
   */
  kbd?: string
  run: () => void | Promise<void>
}

/** A layer over the player's video. */
export interface OverlayDef {
  /**
   * Build the layer into `el` (it fills the picture); return a cleanup.
   * Called whenever the full-size player shows a video, and its cleanup when
   * it stops (the video closes, the mini player or the pop-out takes over).
   */
  mount: (el: HTMLElement) => void | (() => void)
  /** Take clicks. By default the layer lets them through to the player. */
  interactive?: boolean
}

/** One axis of the loaded script, as a copy. */
export interface ScriptAxisSnapshot {
  /** The TCode channel it drives: L0 (stroke), R0 (twist), V0 (vibrate)… */
  axis: string
  /** Its name in playhound ("Stroke", "Twist"…). */
  label: string
  /** The file (or name) it came from. */
  name: string
  /** Funscript actions: `at` in ms, `pos` 0–100, as in a .funscript file. */
  actions: { at: number, pos: number }[]
  /** The user's offset for it, ms. */
  offsetMs: number
}

export interface ScriptSnapshot {
  /** File name of the video they are loaded for, or null with none. */
  video: string | null
  /** The axes that play (an alternate take that is switched off isn't here). */
  axes: ScriptAxisSnapshot[]
}

/**
 * Transforms a script's position on its way to the device, every frame and
 * per axis: keep it quick and free of side effects. `pos` and the result are
 * 0–1 (bottom to top, or off to full for vibration); `t` is the time in the
 * script, ms.
 */
export type MotionFilter = (pos: number, info: { axis: string, t: number }) => number

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
    /**
     * The plugin's page on the main stage, with its own button in the left
     * nav. `mount` is called each time the page is shown, and its cleanup when
     * the stage moves on.
     */
    page: (def: PageDef) => void
    /** Put the plugin's own page on the stage. */
    openPage: () => void
    /** What the stage shows now. */
    stage: () => StageView
    /** Switch the stage: one of playhound's views, or a plugin's page (`plugin:<id>`). False if there is no such view. */
    showStage: (view: StageView) => boolean
    /** When the stage switches; returns an unsubscribe. */
    onStageChange: (fn: (view: StageView) => void) => () => void
    openSettings: () => void
    /**
     * A layer over the player's video, click-through unless `interactive`.
     * One per plugin; calling it again replaces it. Returns a remover.
     */
    overlay: (def: OverlayDef) => () => void
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
    /** When what plays, whether it plays, or its speed changes (not on every clock tick). */
    onChange: (fn: (s: PlayerSnapshot) => void) => () => void
    /**
     * Where playback is now, in seconds: read off the video at the moment of
     * the call and steadied, finer than state().time (which moves a few times
     * a second). For keeping something in step with the picture.
     */
    clock: () => number
    /** Jump to `t` seconds. False with nothing loaded. */
    seek: (t: number) => boolean
    /** Set the playback speed (0.1–10, 1 is normal). It is the user's speed: the player shows it and keeps it. */
    setRate: (rate: number) => void
  }
  /** The user's library. Read-only; empty until a folder is open. */
  library: {
    list: () => Promise<LibraryVideo[]>
    /** Analyse the scripts of these videos (those not done yet), so their intensity is known. */
    analyse: (ids: string[]) => Promise<void>
    /** When the library is (re)loaded. */
    onChange: (fn: () => void) => () => void
    /**
     * A stable id for a video's file: the same file gives the same id on any
     * machine, whatever it is called. Made from its size and a hash of three
     * 64 KB pieces (start, middle, end), and kept, so asking again is free.
     * Null if the video isn't in the library or can't be read.
     */
    fingerprint: (videoId: string) => Promise<string | null>
  }
  /** What plays. */
  playback: {
    /** Play a library video on its own (nothing queued after it). False if it isn't in the library. */
    play: (id: string) => Promise<boolean>
    pause: () => void
    resume: () => void
    /** When the video playing reaches its end. */
    onEnded: (fn: (id: string | null) => void) => () => void
    /** Play the library video with this fingerprint (see library.fingerprint). False if there is none. */
    playFingerprint: (fp: string) => Promise<boolean>
  }
  /** The loaded scripts. */
  scripts: {
    /** A copy of what is loaded for the current video. */
    current: () => ScriptSnapshot
    /**
     * Load a script for the current video as if it came from a file: it
     * replaces whatever plays on that axis (the others stay) and lives in
     * memory only. `axis` is a TCode channel or a funscript suffix ("L0",
     * "twist", "vib"…), the stroke when absent. `actions` as in a .funscript:
     * `at` ms, `pos` 0–100. False with no video, or no usable actions.
     */
    load: (script: { actions: { at: number, pos: number }[], axis?: string, name?: string }) => boolean
    /** When the loaded scripts change (another video, a file loaded, an axis switched). */
    onChange: (fn: (s: ScriptSnapshot) => void) => () => void
  }
  motion: {
    /** Take the stroke generator (the Manual source). Null while panic is on. */
    take: () => MotionControl | null
    readout: () => MotionReadout
    /**
     * Reshape script playback on its way to the device. One filter per
     * plugin (setting another replaces it); several plugins' filters chain in
     * the order the plugins are listed. The intensity knob, edges and the
     * user's range still apply after it, and it can't make the device move
     * faster than the script does or the speed ceiling allows. Returns a remover.
     *
     * Streamed devices (serial, Intiface) run it every frame. The Handy plays
     * the script's points itself, so for it the filter runs over every point
     * when it is set: set it again to apply a change there.
     */
    filter: (fn: MotionFilter) => () => void
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
  /** Commands in the palette, with optional shortcuts. */
  commands: {
    /** Add (or replace, by id) a command. False if its shortcut is taken: the command is then added without one. */
    register: (def: CommandDef) => boolean
    unregister: (id: string) => void
  }
  /** A blob: URL for a file from the plugin's zip, or null. */
  asset: (path: string) => string | null
  log: (...args: unknown[]) => void
}

export type Activate = (ctx: PluginContext) => void | (() => void) | { deactivate: () => void } | Promise<void | (() => void) | { deactivate: () => void }>
