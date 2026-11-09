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
 * src/plugins/manifest.ts). API 3 added playback.external, net.socket,
 * http, library.provide / mediaUrl / scriptUrl and session; docs/plugins.md
 * has the guide.
 */

/** What a plugin can ask to do; see PERMISSIONS in src/plugins/manifest.ts. */
export type PluginPermission
  = | 'device' | 'scripts' | 'player' | 'playback' | 'library' | 'library-edit' | 'network' | 'stage' | 'web'
  // API 3
    | 'external' | 'session' | 'library-source' | 'socket' | 'serve'

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
  // What the plugin store shows; see src/plugins/storeMeta.ts.
  /** Square PNG (256 px) or SVG, in the zip and/or attached to the release. */
  icon?: string
  /** Markdown, for the store's detail view. Without it the repository's README shows. */
  longDescription?: string
  /** Images attached to the release (PNG, JPEG, WebP), up to 6. */
  screenshots?: { file: string, caption?: string }[]
  homepage?: string
  category?: 'partner' | 'sync' | 'library' | 'visuals' | 'devices' | 'tools'
  keywords?: string[]
  /** The oldest playhound it runs on, like "2.2.0". An older one won't install it. */
  minPlayhound?: string
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
  /**
   * File name of what's loaded, or null. For a video a plugin provides
   * (library.provide) it is `<plugin id>:<its id>`, the same as that video's
   * id in library.list().
   */
  title: string | null
  time: number
  duration: number
  hasScript: boolean
  /** The playback speed, 1 is normal (the one player.setRate sets). */
  rate: number
  /** The picture's own size in pixels (API 3): 0 until the video has loaded, and for sound alone or a video playing elsewhere. Portrait when height > width. */
  width: number
  height: number
}

/** Where the picture is drawn in the player (player.picture), in CSS px from the player's top-left. */
export interface PictureRect {
  x: number
  y: number
  width: number
  height: number
  /** The player's own size: the picture is centred in it, letterboxed or pillarboxed. */
  areaWidth: number
  areaHeight: number
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
  /** The picture's size in pixels (API 3), once playhound has read it from the file; null before (see library.media) and for sound alone. */
  width: number | null
  height: number | null
  /** The file's size in bytes (API 3); null for a video another app provides. */
  sizeBytes: number | null
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
  /** The tags given to it (by hand, a download, or a plugin), lower case. */
  tags: string[]
  /** Where it came from, when known: its saved source link, or its script's (a forum thread). */
  sourceUrl: string | null
}

/** What a video's saved info and its script's own metadata say (library.info). */
export interface LibraryVideoInfo {
  tags: string[]
  sourceUrl: string | null
  /** From the script's metadata, when it has some. */
  creator: string | null
  /** The script files paired with it, by name. */
  scriptFiles: string[]
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
  /** The generator's stroke phase, 0–1 with 0 at the bottom; null while it isn't stroking (a script plays, or it is off). */
  phase: number | null
  /** Milliseconds until the generator's stroke is next at the bottom (where a beat lands); null while it isn't stroking. */
  nextStrokeInMs: number | null
  /**
   * A script is playing and drives the stroke: the generator (motion.take)
   * waits until it stops, since the two never fight over the same axis.
   * What a plugin sets meanwhile applies when the script stops.
   */
  scriptDriving: boolean
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
   * A list (API 3) is tried in order and the first free one is taken; only
   * when none is free is that logged.
   */
  kbd?: string | string[]
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

/** What a web view shows, as of its last change. */
export interface WebViewState {
  /** The page's address; '' before anything has loaded. */
  url: string
  title: string
  /** Something is loading (the page, or a navigation inside it). */
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** Why the last page didn't load (no network, a bad address, a crash), or null. */
  error: { code: number, description: string, url: string } | null
  /** Video or audio is playing in it. */
  media: boolean
  /** It makes sound right now. */
  audible: boolean
  /** A video in it has taken the whole window. */
  fullscreen: boolean
  /** The keyboard is in the page. */
  focused: boolean
  /** It is on screen: attached to an element that shows, and nothing of playhound's is over it. */
  shown: boolean
}

export interface WebViewOptions {
  /** Load this page at once (http or https). */
  url?: string
  /** The page's zoom, 1 = 100% (0.25–5). */
  zoom?: number
}

/**
 * A real web page inside playhound (desktop app only). It is drawn by the
 * desktop app on top of playhound's own page, so it can't sit under your DOM:
 * it goes where the element you attach it to is, and playhound hides it
 * while one of its dialogs, menus or toasts would be under it, and on panic.
 */
export interface WebViewHandle {
  /**
   * Keep the view on `el`'s box, following it as it moves and resizes (and
   * when the interface size changes). It shows only while `el` is in the
   * document and visible. Attaching elsewhere moves it; null hides it.
   */
  attach: (el: HTMLElement | null) => void
  /** Load a page: http or https. Anything else throws. */
  navigate: (url: string) => void
  back: () => void
  forward: () => void
  reload: () => void
  stop: () => void
  /** The page's zoom, 1 = 100% (0.25–5). */
  setZoom: (factor: number) => void
  state: () => WebViewState
  /** Called with the whole state whenever any of it changes; returns an unsubscribe. */
  onState: (fn: (s: WebViewState) => void) => () => void
  /** Close the page. Done for you when the plugin is switched off. */
  destroy: () => void
  readonly destroyed: boolean
}

// ─── API 3 ───────────────────────────────────────────────────────────────────

/** What playhound's own controls ask of a video playing in another app. */
export type ExternalCommand = { type: 'play' } | { type: 'pause' } | { type: 'seek', time: number } | { type: 'rate', rate: number }

export interface ExternalPlaybackOptions {
  /** Where it plays, as the player says it: "Playing in HereSphere". */
  label: string
  /** The library video it is (an id from library.list). */
  video?: string
  /** Or the library video with this fingerprint (library.fingerprint). */
  fingerprint?: string
  /** Its name, for a video that isn't in the library. */
  title?: string
  /**
   * Scripts to play: for a video that isn't in the library, or in place of a
   * library video's own. As in scripts.load: `axis` a TCode channel or a
   * funscript suffix, `actions` with `at` ms and `pos` 0–100.
   */
  scripts?: { actions: { at: number, pos: number }[], axis?: string, name?: string }[]
  /** Its length, seconds, when known (update() can say it later). */
  duration?: number
  /**
   * playhound's play, pause, seek and speed controls, passed on, while it
   * follows this video. Without it they do nothing (the user uses the
   * other app's).
   */
  onCommand?: (cmd: ExternalCommand) => void
}

/** A video playing in another app that playhound follows. */
export interface ExternalPlayback {
  /**
   * Where the other app is: `time` in seconds, whether it plays, its speed.
   * Send it whenever the other app says, a few times a second; late and
   * uneven is fine, playhound steadies it. If nothing comes for a few
   * seconds while playing, the device stops until something does.
   */
  update: (s: { time: number, playing: boolean, rate?: number, duration?: number }) => void
  /** Stop following it. The device stops; the other app plays on. */
  end: () => void
  /**
   * It ended: 'stopped' by the user, 'replaced' by the user (or anything)
   * playing another video here, 'restarted' by a new playback.external()
   * call (yours or another plugin's), or 'ended' by end(). Returns an unsubscribe.
   */
  onEnd: (fn: (reason: 'stopped' | 'replaced' | 'restarted' | 'ended') => void) => () => void
  readonly active: boolean
}

/** A TCP connection to an app or device on the local network (desktop app only). */
export interface NetSocket {
  /** Send bytes, or a string as UTF-8. Throws once closed. */
  send: (data: string | Uint8Array) => void
  /** Bytes as they arrive (not split into messages: that's the protocol's job). Returns an unsubscribe. */
  onData: (fn: (data: Uint8Array) => void) => () => void
  /** It closed: `error` says why, or null when it simply ended. Returns an unsubscribe. */
  onClose: (fn: (error: string | null) => void) => () => void
  close: () => void
  readonly closed: boolean
  /** Where it is connected to: the address the name led to, and the port. */
  readonly remote: { address: string, port: number }
}

/** A request to the plugin's address on the LAN server. */
export interface HttpRequest {
  method: string
  /**
   * After the plugin's own prefix: "/" for /plugins/<id>/, "/library.json" for
   * /plugins/<id>/library.json. As sent, still percent-encoded ("/My%20Video.mp4"):
   * decodeURIComponent each part you match against names.
   */
  path: string
  query: Record<string, string>
  /** Lower-case names. */
  headers: Record<string, string>
  body: Uint8Array | null
  /** The address it came from. */
  remote: string
  text: () => string
  json: () => unknown
}

/** An answer: `json` (sent as JSON), or a `body`. Returning nothing answers 404. */
export interface HttpResponse {
  status?: number
  headers?: Record<string, string>
  body?: string | Uint8Array | Blob
  json?: unknown
}

export type HttpHandler = (req: HttpRequest) => HttpResponse | null | undefined | Promise<HttpResponse | null | undefined>

/** A video a plugin adds to the library from another app. */
export interface ProvidedVideo {
  /** Its id at the source; stable, so stars and stats stay with it. */
  id: string | number
  title: string
  /** Where to stream it from (http or https): a file a <video> plays, or an HLS playlist. */
  url: string
  /** 'hls' for a playlist; guessed from the URL (.m3u8) when absent. */
  kind?: 'file' | 'hls'
  /** Headers the source wants (an API key): the stream then goes through playhound's local proxy, and script requests carry them. */
  headers?: Record<string, string>
  /** Its scripts, one per axis: `axis` a TCode channel or funscript suffix (stroke when absent), `url` a funscript. */
  scripts?: { axis?: string, url: string }[]
  /** It has scripts that the source's scripts() loader gives (instead of URLs). */
  hasScript?: boolean
  tags?: string[]
  /** Chapters or markers, seconds. They show as the script's chapters. */
  chapters?: { name: string, start: number, end?: number }[]
  /** A picture for its card: http(s), or a data: image. */
  thumbnail?: string
  /** Length, seconds. */
  duration?: number
  /** Its page at the source, shown in its info. */
  sourceUrl?: string
}

export interface LibrarySourceDef {
  /** The source's name, as its badge and the library's folder picker show it ("Stash"). */
  label: string
  /** Everything it has. Called at once, and again on refresh(). */
  videos: () => ProvidedVideo[] | Promise<ProvidedVideo[]>
  /**
   * A video's scripts, for videos with `hasScript` and no script URLs: per
   * axis, actions as in a .funscript. Called when the video first plays.
   */
  scripts?: (id: string) => Promise<{ axis?: string, actions: { at: number, pos: number }[] }[]>
}

export interface LibrarySourceHandle {
  /** Ask videos() again and put what it returns in place of the last list. Resolves the number added; rejects saying why not. */
  refresh: () => Promise<number>
  /** Take its videos out of the library. Done for you when the plugin is switched off. */
  remove: () => void
  /** Why videos in the last list were left out (a missing title, a bad URL…), for the plugin's own log. */
  readonly problems: string[]
}

/** Where an edge is now. */
export interface EdgeState {
  phase: 'idle' | 'falling' | 'holding' | 'rebuilding'
  /** Seconds left of the hold and the rebuild. */
  remainingSec: number
  /** How far everything is backed off, 0–1. */
  holdBack: number
  /** What actually reaches the device and the senses: the knob × (1 − holdBack), 0–1. */
  effective: number
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
    /**
     * The theme ('dark', 'light', 'catppuccin', 'dracula'…), also on <html>
     * as `data-theme`. Its colours are the CSS variables (`--text`,
     * `--accent`…); read them with getComputedStyle to draw on a canvas.
     */
    theme: () => string
    /** The theme changed (its CSS variables already have the new colours): repaint. Returns an unsubscribe. */
    onThemeChange: (fn: (theme: string) => void) => () => void
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
    /**
     * Where the picture is drawn in the player right now (API 3), in CSS px
     * from the player's top-left, with the player's size: a portrait video is
     * pillarboxed, a wide one letterboxed. Null with no picture (sound alone,
     * a video playing elsewhere, nothing loaded). An overlay can also use the
     * CSS variables --ph-picture-left / -top / -width / -height.
     */
    picture: () => PictureRect | null
    /** The picture moved or changed size (a new video, a resize, fullscreen, the pop-out). Returns an unsubscribe. */
    onPicture: (fn: (r: PictureRect | null) => void) => () => void
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
    /**
     * Its saved info and what its script's own metadata says (the thread a
     * script came from, its creator), read from the file when asked. Null if
     * the video isn't in the library.
     */
    info: (videoId: string) => Promise<LibraryVideoInfo | null>
    /**
     * Its length, picture size and file size, reading the file for what
     * isn't known yet (kept, so asking again is free) (API 3). Null if the
     * video isn't in the library.
     */
    media: (videoId: string) => Promise<{ durationS: number | null, width: number | null, height: number | null, sizeBytes: number | null } | null>
    /**
     * Its library thumbnail as a JPEG data URL (320×180, the one the library
     * shows), made from a frame of the video if there isn't one yet. For a
     * provided video it is the picture its source gave, which may be an
     * http(s) link instead (API 3). Null if there is none.
     */
    thumbnail: (videoId: string) => Promise<string | null>
    /** Add and remove tags on a video (permission `library-edit`). Returns its tags after, or null if it isn't in the library. */
    tag: (videoId: string, change: { add?: string[], remove?: string[] }) => Promise<string[] | null>
    /** Set (or clear, with null) the link a video came from, an http(s) URL (permission `library-edit`). False if it isn't in the library. */
    setSource: (videoId: string, url: string | null) => Promise<boolean>
    /**
     * Add videos from another app (permission `library-source`). They show
     * in the library with the source's name, play like any video (streamed),
     * work in the queue and playlists, and go when the plugin is switched
     * off. One source per plugin: calling it again replaces it. Resolves
     * once the first list is in.
     */
    provide: (def: LibrarySourceDef) => Promise<LibrarySourceHandle>
    /**
     * A link that streams this library video to devices on the network
     * (with seeking), for as long as the plugin is on; null if there is no
     * such video or nothing to reach it on. Desktop app only (permissions
     * `serve` and `library`).
     */
    mediaUrl: (videoId: string) => Promise<string | null>
    /** The same for one of its scripts: the .funscript for `axis` (stroke when absent); null if it has none for that axis. */
    scriptUrl: (videoId: string, axis?: string) => Promise<string | null>
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
    /** What the Next key does: the next in the queue (or the auto-director's pick). False if there is nothing next. */
    next: () => Promise<boolean>
    /** What the Previous key does. False if there is nothing before. */
    previous: () => Promise<boolean>
    /**
     * Follow a video that plays in another app, a VR headset (permission
     * `external`): its scripts play on every device to the clock you feed
     * with update(), with the user's latency, offset, tweaks, intensity,
     * edges and panic, as for a video playing here. Null if there is no such
     * library video (and no scripts were given), or the user kept unsaved
     * script edits.
     */
    external: (opts: ExternalPlaybackOptions) => Promise<ExternalPlayback | null>
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
    /** Panic was lifted (the user pressed it again). Nothing restarts by itself: take control again if you need it. */
    onResume: (fn: () => void) => () => void
  }
  net: {
    /**
     * fetch(), but in the desktop app it goes out from the app itself, so a
     * local server without CORS headers answers. Streams like fetch does.
     */
    fetch: (url: string, init?: RequestInit) => Promise<Response>
    /** Whether socket() works: the desktop app. */
    readonly socketAvailable: boolean
    /**
     * A TCP connection to an app or device on your network (permission
     * `socket`, desktop app only): `host` is localhost, a private address
     * (192.168.x.x, 10.x.x.x, 172.16–31.x.x, link-local) or a `.local` name
     * that leads to one. Resolves once connected; rejects saying why not.
     * Closed for you when the plugin is switched off.
     */
    socket: (opts: { host: string, port: number }) => Promise<NetSocket>
  }
  /** Answering devices on the network from the desktop app's LAN server (permission `serve`). */
  http: {
    /** False outside the desktop app: there, serve() throws. */
    readonly available: boolean
    /**
     * Answer requests to `http://<this computer>:<port>/plugins/<id>/…` with
     * `handler`, until stop() or the plugin is switched off. Calling it again
     * replaces the handler. Resolves that address (null when the LAN server
     * isn't running).
     */
    serve: (handler: HttpHandler, opts?: {
      /**
       * Also answer the short root paths headsets ask for on their own,
       * `deovr` and/or `heresphere`: a request to `/deovr…` reaches your
       * handler as `/deovr…` under your own path. The first plugin to claim
       * one keeps it while it serves; see rootAliases() for what you got.
       */
      rootAliases?: ('deovr' | 'heresphere')[]
    }) => Promise<string | null>
    /** The address serve() answers on, or null when it isn't serving. */
    url: () => string | null
    /**
     * The same on every address this computer has, one per network adapter
     * (Wi-Fi, Ethernet, a VPN, a virtual machine's): url() is only the
     * first. Show them all, or build links from a request's Host header.
     */
    urls: () => string[]
    /** The root paths this plugin holds (see serve's rootAliases). */
    rootAliases: () => ('deovr' | 'heresphere')[]
    stop: () => void
  }
  /**
   * The session: edges, the intensity knob, finishes. Calling an edge,
   * setting the intensity and hearing finishes need `session`; reading the
   * edge and the knob (edgeState, onEdge, intensity.get / max / onChange)
   * need `player` or `session`.
   */
  session: {
    /** Call an edge: everything backs off for the user's hold time and eases back. */
    edge: () => void
    /** End the hold early ("I'm OK"): it starts easing back now. Not while panic is on. */
    endEdge: () => void
    edgeState: () => EdgeState
    /** An edge was called, by anyone (`byPlugin` when by a plugin). Returns an unsubscribe. */
    onEdge: (fn: (e: { at: number, videoTime: number | null, byPlugin: boolean }) => void) => () => void
    /** The user marked "I came". Returns an unsubscribe. */
    onFinish: (fn: (e: { at: number, videoTime: number | null }) => void) => () => void
    intensity: {
      /** The knob, 0.1–1. */
      get: () => number
      /**
       * Move the knob toward `level` (0.1–1), a little at a time (about 10%
       * a second up), never past the limit the user set for plugins.
       * Returns where it will stop. The user turning the knob, or panic,
       * stops the move. The user sees a notice saying which plugin did it.
       * During a panic it may only lower the knob (at once, nothing moves
       * then anyway).
       */
      set: (level: number) => number
      /**
       * Put the knob back where it was before this plugin first moved it
       * (since its last restore), even above the plugin limit, since that
       * was the user's own level. Ramps like set(); after a panic it only
       * goes down. Returns where it will stop, or null when this plugin
       * hasn't moved it (or the user has turned it since).
       */
      restore: () => number | null
      /** The most a plugin may set, as the user chose in Settings → Plugins. */
      max: () => number
      /** The knob moved, by anyone. Returns an unsubscribe. */
      onChange: (fn: (level: number) => void) => () => void
    }
  }
  /** Commands in the palette, with optional shortcuts. */
  commands: {
    /** Add (or replace, by id) a command. False if its shortcut is taken: the command is then added without one. */
    register: (def: CommandDef) => boolean
    unregister: (id: string) => void
    /**
     * Whether a shortcut could be had: a key a plugin may use that neither
     * playhound nor another plugin has. One of this plugin's own commands
     * holding it counts as free.
     */
    keyFree: (kbd: string) => boolean
  }
  /** Real web pages inside playhound. */
  webview: {
    /** False outside the desktop app: there, create() throws. */
    readonly available: boolean
    /**
     * A new web view, hidden until attached. Pages run in a browsing session
     * of their own (cookies and logins kept, apart from playhound's) and can't
     * reach playhound. At most 4 are open at once, across all plugins; past
     * that, and outside the desktop app, this throws.
     */
    create: (opts?: WebViewOptions) => WebViewHandle
  }
  /** A blob: URL for a file from the plugin's zip, or null. */
  asset: (path: string) => string | null
  log: (...args: unknown[]) => void
}

export type Activate = (ctx: PluginContext) => void | (() => void) | { deactivate: () => void } | Promise<void | (() => void) | { deactivate: () => void }>
