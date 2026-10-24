/**
 * Everything the app keeps in localStorage, and how old layouts are upgraded.
 *
 * Keys grew up in four dialects — `mwhoplayer:*` from the player half,
 * `ph-*` from the session half, `bp:`/`es:` from integrations and a few bare
 * names (`theme`, `deviceConfig`, `uiState`) — and each loader carried its own
 * guesses about older shapes. Now:
 *
 * - every key is `ph:<area>.<name>` and is listed in KEYS below, so backup,
 *   reset and the settings screen can enumerate them, and a test fails if code
 *   uses a key that is not listed
 * - `ph:schema` records the layout version, and `runMigrations()` walks it
 *   forward one step at a time before any store reads anything
 *
 * IndexedDB (thumbnails, metadata, folder handles…) is not covered here; its
 * stores are versioned by the database itself, see ./idb.ts.
 */

export type KeyKind
  /** Things you made: playlists, bookmarks, stars, stats. Precious. */
  = | 'data'
  /** How the app behaves: audio, device, safety, appearance. */
    | 'setting'
  /** Where things were left: open panels, collapsed sections, sort order. */
    | 'ui'

export interface KeyDef {
  key: string
  kind: KeyKind
  label: string
}

function def(key: string, kind: KeyKind, label: string): KeyDef {
  return { key, kind, label }
}

/** Every persisted key. Code should take names from here rather than retyping them. */
export const KEYS = {
  schema: def('ph:schema', 'setting', 'Storage layout version'),

  // ── Your data ──────────────────────────────────────────────────────────
  playlists: def('ph:playlists', 'data', 'Playlists'),
  smartPlaylists: def('ph:playlists.smart', 'data', 'Smart playlists'),
  bookmarks: def('ph:bookmarks', 'data', 'Bookmarks'),
  starred: def('ph:library.starred', 'data', 'Starred videos'),
  stats: def('ph:stats', 'data', 'Watch stats'),
  statsDaily: def('ph:stats.daily', 'data', 'Watch time per day'),
  wallItems: def('ph:wall.items', 'data', 'Media wall YouTube tiles'),
  programmes: def('ph:programmes', 'data', 'Session programmes'),

  // ── Settings ───────────────────────────────────────────────────────────
  theme: def('ph:theme', 'setting', 'Theme'),
  logo: def('ph:ui.logo', 'setting', 'Logo'),
  playerPrefs: def('ph:player.prefs', 'setting', 'Volume, mute and speed'),
  queuePrefs: def('ph:queue.prefs', 'setting', 'Shuffle and repeat'),
  deviceConfig: def('ph:device.config', 'setting', 'Device axes and presets'),
  deviceTransport: def('ph:device.transport', 'setting', 'Device connection type'),
  deviceLatency: def('ph:device.latency', 'setting', 'Device latency compensation'),
  motionConfig: def('ph:motion.config', 'setting', 'Motion source and limits'),
  buttplugUrl: def('ph:buttplug.url', 'setting', 'Intiface address'),
  buttplugEnabled: def('ph:buttplug.enabled', 'setting', 'Intiface on/off'),
  eroscriptsCookie: def('ph:eroscripts.cookie', 'setting', 'EroScripts session'),
  remoteRoom: def('ph:remote.room', 'setting', 'Phone remote pairing'),
  remoteEnabled: def('ph:remote.enabled', 'setting', 'Phone remote on/off'),
  faceLink: def('ph:face.link', 'setting', 'CYD face link'),
  directorEnabled: def('ph:director.enabled', 'setting', 'Director on/off'),
  panicOnBlur: def('ph:safety.panicOnBlur', 'setting', 'Panic when the window loses focus'),
  idleStopMinutes: def('ph:safety.idleStopMinutes', 'setting', 'Idle device stop'),
  splash: def('ph:ui.splash', 'setting', 'Splash screen'),
  slideshow: def('ph:slideshow.settings', 'setting', 'Slideshow'),
  wallSnap: def('ph:wall.snap', 'setting', 'Media wall snapping'),
  wallGrid: def('ph:wall.grid', 'setting', 'Media wall grid'),
  emulator: def('ph:emulator', 'setting', 'Emulator window'),

  audioBaseFreq: def('ph:audio.baseFreq', 'setting', 'Carrier frequency'),
  audioBeatDelta: def('ph:audio.beatDelta', 'setting', 'Beat frequency'),
  audioBeatMode: def('ph:audio.beatMode', 'setting', 'Beat mode'),
  audioVolume: def('ph:audio.volume', 'setting', 'Tone volume'),
  audioWaveType: def('ph:audio.waveType', 'setting', 'Wave shape'),
  audioPulseEnabled: def('ph:audio.pulseEnabled', 'setting', 'Pulse on/off'),
  audioPulseCpm: def('ph:audio.pulseCpm', 'setting', 'Pulse rate'),
  audioPulseDepth: def('ph:audio.pulseDepth', 'setting', 'Pulse depth'),
  audioPulseFollow: def('ph:audio.pulseFollow', 'setting', 'Pulse follows session'),
  audioBreathEnabled: def('ph:audio.breathEnabled', 'setting', 'Breath pacing on/off'),
  audioBreathPeriod: def('ph:audio.breathPeriod', 'setting', 'Breath period'),
  audioBreathInhale: def('ph:audio.breathInhale', 'setting', 'Breath inhale ratio'),
  audioSessionArc: def('ph:audio.sessionArc', 'setting', 'Session shape'),
  audioEdgeCycles: def('ph:audio.edgeCycles', 'setting', 'Edge cycles'),
  audioScriptDrive: def('ph:audio.scriptDrive', 'setting', 'Audio follows script'),
  audioScriptDriveIntensity: def('ph:audio.scriptDriveIntensity', 'setting', 'Script drive amount'),
  audioMusicDrive: def('ph:audio.musicDrive', 'setting', 'Audio follows music'),

  hypnoEnabled: def('ph:hypno.enabled', 'setting', 'Hypno overlay on/off'),
  hypnoSpiral: def('ph:hypno.spiral', 'setting', 'Spiral on/off'),
  hypnoSpiralArms: def('ph:hypno.spiralArms', 'setting', 'Spiral arms'),
  hypnoSpiralColor: def('ph:hypno.spiralColor', 'setting', 'Spiral colour'),
  hypnoSpiralColor2: def('ph:hypno.spiralColor2', 'setting', 'Spiral second colour'),
  hypnoSpiralOpacity: def('ph:hypno.spiralOpacity', 'setting', 'Spiral opacity'),
  hypnoSpiralRate: def('ph:hypno.spiralRate', 'setting', 'Spiral speed'),
  hypnoSpiralReverse: def('ph:hypno.spiralReverse', 'setting', 'Spiral direction'),
  hypnoSpiralTwoTone: def('ph:hypno.spiralTwoTone', 'setting', 'Two-tone spiral'),
  hypnoText: def('ph:hypno.text', 'setting', 'Words on/off'),
  hypnoTextColor: def('ph:hypno.textColor', 'setting', 'Word colour'),
  hypnoTextOpacity: def('ph:hypno.textOpacity', 'setting', 'Word opacity'),
  hypnoTextSize: def('ph:hypno.textSize', 'setting', 'Word size'),
  hypnoWords: def('ph:hypno.words', 'setting', 'Word list'),
  hypnoWordEvery: def('ph:hypno.wordEvery', 'setting', 'Word interval'),
  hypnoRing: def('ph:hypno.ring', 'setting', 'Breathing ring on/off'),
  hypnoRingColor: def('ph:hypno.ringColor', 'setting', 'Ring colour'),
  hypnoRingOpacity: def('ph:hypno.ringOpacity', 'setting', 'Ring opacity'),
  hypnoVignette: def('ph:hypno.vignette', 'setting', 'Vignette'),

  // ── Layout and leftovers ───────────────────────────────────────────────
  shell: def('ph:ui.shell', 'ui', 'Open views and panels'),
  queueSession: def('ph:queue.session', 'ui', 'Queue to resume'),
  librarySort: def('ph:library.sort', 'ui', 'Library sort'),
  libraryView: def('ph:library.view', 'ui', 'Library grid or list'),
  libraryCard: def('ph:library.cardSize', 'ui', 'Library card size'),
  playlistsSelected: def('ph:ui.playlists.selected', 'ui', 'Selected playlist'),
  paletteRecent: def('ph:ui.palette.recent', 'ui', 'Recent commands'),
  timelineHeatmap: def('ph:ui.timeline.heatmap', 'ui', 'Timeline heatmap'),
  fsUpNext: def('ph:ui.player.fsUpNext', 'ui', 'Fullscreen up-next sheet'),
  eroscriptsView: def('ph:ui.eroscripts.view', 'ui', 'EroScripts grid or list'),
  queueHistoryOpen: def('ph:ui.queue.historyOpen', 'ui', 'Queue history section'),
  binOpenTone: def('ph:ui.binaural.toneOpen', 'ui', 'Binaural sections'),
  binOpenScript: def('ph:ui.binaural.scriptOpen', 'ui', 'Binaural sections'),
  binOpenLayers: def('ph:ui.binaural.layersOpen', 'ui', 'Binaural sections'),
  binOpenPulse: def('ph:ui.binaural.pulseOpen', 'ui', 'Binaural sections'),
  binOpenSession: def('ph:ui.binaural.sessionOpen', 'ui', 'Binaural sections'),
  binOpenBreath: def('ph:ui.binaural.breathOpen', 'ui', 'Binaural sections'),
  hypnoOpenSpiral: def('ph:ui.hypno.spiralOpen', 'ui', 'Hypno sections'),
  hypnoOpenWords: def('ph:ui.hypno.wordsOpen', 'ui', 'Hypno sections'),
  hypnoOpenRing: def('ph:ui.hypno.ringOpen', 'ui', 'Hypno sections'),
  hypnoOpenFrame: def('ph:ui.hypno.frameOpen', 'ui', 'Hypno sections'),
  directorOpenHow: def('ph:ui.director.howOpen', 'ui', 'Director sections'),
  directorOpenCoverage: def('ph:ui.director.coverageOpen', 'ui', 'Director sections'),
} as const satisfies Record<string, KeyDef>

export const ALL_KEYS: KeyDef[] = Object.values(KEYS)

const KNOWN = new Set(ALL_KEYS.map(k => k.key))

/** True for keys this app owns, including the legacy names old backups carry. */
export function isOwnKey(key: string): boolean {
  return KNOWN.has(key) || key.startsWith('ph:') || isLegacyKey(key)
}

// ─── Migrations ───────────────────────────────────────────────────────────────

export const SCHEMA_VERSION = 3

/** Old name → new name, for the move to the `ph:` namespace (schema 1 → 2). */
export const LEGACY_RENAMES: Record<string, string> = {
  'theme': KEYS.theme.key,
  'deviceConfig': KEYS.deviceConfig.key,
  'motion': KEYS.motionConfig.key,
  'bp:url': KEYS.buttplugUrl.key,
  'bp:enabled': KEYS.buttplugEnabled.key,
  'es:cookie': KEYS.eroscriptsCookie.key,
  'es:view': KEYS.eroscriptsView.key,
  'mwhoplayer:playlists': KEYS.playlists.key,
  'mwhoplayer:smartplaylists': KEYS.smartPlaylists.key,
  'mwhoplayer:bookmarks': KEYS.bookmarks.key,
  'mwhoplayer:starred': KEYS.starred.key,
  'mwhoplayer:stats': KEYS.stats.key,
  'mwhoplayer:stats-daily': KEYS.statsDaily.key,
  'mwhoplayer:player': KEYS.playerPrefs.key,
  'mwhoplayer:queue': KEYS.queuePrefs.key,
  'mwhoplayer:librarySort': KEYS.librarySort.key,
  'ph-ui-v2': KEYS.shell.key,
  'ph-queue-session': KEYS.queueSession.key,
  'ph-library-view': KEYS.libraryView.key,
  'ph-library-card': KEYS.libraryCard.key,
  'ph-playlists-selected': KEYS.playlistsSelected.key,
  'ph-palette-recent': KEYS.paletteRecent.key,
  'ph-timeline-heatmap': KEYS.timelineHeatmap.key,
  'ph-fs-upnext': KEYS.fsUpNext.key,
  'ph-queue-history-open': KEYS.queueHistoryOpen.key,
  'ph-splash': KEYS.splash.key,
  'ph-device-transport': KEYS.deviceTransport.key,
  'ph-director-enabled': KEYS.directorEnabled.key,
  'ph-remote-room': KEYS.remoteRoom.key,
  'ph-remote-enabled': KEYS.remoteEnabled.key,
  'ph-panic-on-blur': KEYS.panicOnBlur.key,
  'ph-idle-stop-min': KEYS.idleStopMinutes.key,
  'ph-ss-settings': KEYS.slideshow.key,
  'ph-wall-items': KEYS.wallItems.key,
  'ph-wall-snap': KEYS.wallSnap.key,
  'ph-wall-grid': KEYS.wallGrid.key,
  'ph-emulator': KEYS.emulator.key,
  'ph-base-freq': KEYS.audioBaseFreq.key,
  'ph-beat-delta': KEYS.audioBeatDelta.key,
  'ph-beat-mode': KEYS.audioBeatMode.key,
  'ph-volume': KEYS.audioVolume.key,
  'ph-wave-type': KEYS.audioWaveType.key,
  'ph-pulse-enabled': KEYS.audioPulseEnabled.key,
  'ph-pulse-cpm': KEYS.audioPulseCpm.key,
  'ph-pulse-depth': KEYS.audioPulseDepth.key,
  'ph-pulse-follow': KEYS.audioPulseFollow.key,
  'ph-breath-enabled': KEYS.audioBreathEnabled.key,
  'ph-breath-period': KEYS.audioBreathPeriod.key,
  'ph-breath-inhale': KEYS.audioBreathInhale.key,
  'ph-session-arc': KEYS.audioSessionArc.key,
  'ph-edge-cycles': KEYS.audioEdgeCycles.key,
  'ph-script-drive': KEYS.audioScriptDrive.key,
  'ph-script-drive-intensity': KEYS.audioScriptDriveIntensity.key,
  'ph-music-drive': KEYS.audioMusicDrive.key,
  'ph-hypno-enabled': KEYS.hypnoEnabled.key,
  'ph-hypno-spiral': KEYS.hypnoSpiral.key,
  'ph-hypno-spiral-arms': KEYS.hypnoSpiralArms.key,
  'ph-hypno-spiral-color': KEYS.hypnoSpiralColor.key,
  'ph-hypno-spiral-color2': KEYS.hypnoSpiralColor2.key,
  'ph-hypno-spiral-opacity': KEYS.hypnoSpiralOpacity.key,
  'ph-hypno-spiral-rate': KEYS.hypnoSpiralRate.key,
  'ph-hypno-spiral-reverse': KEYS.hypnoSpiralReverse.key,
  'ph-hypno-spiral-twotone': KEYS.hypnoSpiralTwoTone.key,
  'ph-hypno-text': KEYS.hypnoText.key,
  'ph-hypno-text-color': KEYS.hypnoTextColor.key,
  'ph-hypno-text-opacity': KEYS.hypnoTextOpacity.key,
  'ph-hypno-text-size': KEYS.hypnoTextSize.key,
  'ph-hypno-words': KEYS.hypnoWords.key,
  'ph-hypno-word-every': KEYS.hypnoWordEvery.key,
  'ph-hypno-ring': KEYS.hypnoRing.key,
  'ph-hypno-ring-color': KEYS.hypnoRingColor.key,
  'ph-hypno-ring-opacity': KEYS.hypnoRingOpacity.key,
  'ph-hypno-vignette': KEYS.hypnoVignette.key,
  'ph-bin-open-tone': KEYS.binOpenTone.key,
  'ph-bin-open-script': KEYS.binOpenScript.key,
  'ph-bin-open-layers': KEYS.binOpenLayers.key,
  'ph-bin-open-pulse': KEYS.binOpenPulse.key,
  'ph-bin-open-session': KEYS.binOpenSession.key,
  'ph-bin-open-breath': KEYS.binOpenBreath.key,
  'ph-hypno-open-spiral': KEYS.hypnoOpenSpiral.key,
  'ph-hypno-open-words': KEYS.hypnoOpenWords.key,
  'ph-hypno-open-ring': KEYS.hypnoOpenRing.key,
  'ph-hypno-open-frame': KEYS.hypnoOpenFrame.key,
  'ph-director-open-how': KEYS.directorOpenHow.key,
  'ph-director-open-coverage': KEYS.directorOpenCoverage.key,
}

/** Keys that are simply gone: replaced by something else, or never worth keeping. */
const LEGACY_DROPPED = ['uiState', 'ph-favorites-into-stars']

/**
 * Keys from features that no longer exist (an LLM helper and a VRM viewer
 * from before the merge, sections and strips of the old UI). Found in real
 * storage after the 1 → 2 step, which only knew the keys code still used.
 */
const ORPHANED = [
  'mwhoplayer:llm',
  'vrmViewer:poseId',
  'ph-sec-beat',
  'ph-sec-layers',
  'ph-sec-session',
  'ph-upnext-open',
]

function isLegacyKey(key: string): boolean {
  return key in LEGACY_RENAMES || LEGACY_DROPPED.includes(key) || ORPHANED.includes(key)
}

/** Minimal storage surface, so migrations run against a fake in tests. */
export interface KV {
  getItem: (k: string) => string | null
  setItem: (k: string, v: string) => void
  removeItem: (k: string) => void
}

function readJson<T>(kv: KV, key: string): T | null {
  try {
    const raw = kv.getItem(key)
    return raw === null ? null : JSON.parse(raw) as T
  }
  catch {
    return null
  }
}

/**
 * One step per version. `from` is the version the step upgrades *from*.
 * Steps must be safe to run on partially migrated storage: a crash between
 * two writes should not lose anything on the next attempt.
 */
const MIGRATIONS: { from: number, run: (kv: KV) => void }[] = [
  {
    // 1 → 2: one namespace for everything.
    from: 1,
    run(kv) {
      // `theme` is a bare string rather than JSON, so the pre-paint script in
      // index.html can read it without parsing; keep it that way.
      const theme = kv.getItem('theme')
      if (theme !== null && kv.getItem(KEYS.theme.key) === null)
        kv.setItem(KEYS.theme.key, theme.replace(/^"|"$/g, ''))

      // Motion lived inside the old shell's `uiState` blob before it had a key of its own.
      const ui = readJson<{ motion?: unknown }>(kv, 'uiState')
      if (ui?.motion && kv.getItem('motion') === null && kv.getItem(KEYS.motionConfig.key) === null)
        kv.setItem(KEYS.motionConfig.key, JSON.stringify(ui.motion))

      // Stars used to be split between the library's set and the Favorites
      // playlist; the star is the library's set now, so fold Favorites in.
      if (kv.getItem('ph-favorites-into-stars') === null) {
        const lists = readJson<{ id: string, entries?: { videoName: string }[] }[]>(kv, 'mwhoplayer:playlists') ?? []
        const fav = lists.find(l => l.id === 'favorites')?.entries ?? []
        if (fav.length) {
          const stars = new Set(readJson<string[]>(kv, 'mwhoplayer:starred') ?? [])
          for (const e of fav)
            stars.add(e.videoName)
          kv.setItem('mwhoplayer:starred', JSON.stringify([...stars]))
        }
      }

      for (const [from, to] of Object.entries(LEGACY_RENAMES)) {
        if (from === 'theme')
          continue
        const v = kv.getItem(from)
        if (v === null)
          continue
        // Never clobber a value already written under the new name.
        if (kv.getItem(to) === null)
          kv.setItem(to, v)
      }
      for (const from of [...Object.keys(LEGACY_RENAMES), ...LEGACY_DROPPED])
        kv.removeItem(from)
    },
  },
  {
    // 2 → 3: drop what no feature reads any more.
    from: 2,
    run(kv) {
      for (const k of ORPHANED)
        kv.removeItem(k)
    },
  },
]

/** Version of what is in storage now. Fresh storage counts as current. */
export function storedSchema(kv: KV): number {
  const v = Number(kv.getItem(KEYS.schema.key))
  if (Number.isFinite(v) && v > 0)
    return v
  // No version yet: anything of ours lying around means the original layout.
  for (const k of [...Object.keys(LEGACY_RENAMES), ...LEGACY_DROPPED]) {
    if (kv.getItem(k) !== null)
      return 1
  }
  return SCHEMA_VERSION
}

/**
 * Bring storage up to SCHEMA_VERSION. Runs before the app is imported (see
 * main.ts), because several stores read their keys at module load.
 * Returns the steps that ran, for logging.
 */
export function runMigrations(kv: KV = localStorage, from = storedSchema(kv)): number[] {
  const ran: number[] = []
  let v = from
  for (const step of MIGRATIONS) {
    if (step.from < v)
      continue
    if (step.from !== v)
      break
    try {
      step.run(kv)
    }
    catch (err) {
      // Leave the version where it was so the step is retried next start.
      console.error(`[persist] migration from v${v} failed`, err)
      return ran
    }
    ran.push(v)
    v = step.from + 1
    kv.setItem(KEYS.schema.key, String(v))
  }
  if (v === from && kv.getItem(KEYS.schema.key) === null)
    kv.setItem(KEYS.schema.key, String(SCHEMA_VERSION))
  return ran
}

/** Remove keys of one kind (e.g. reset layout without touching playlists). */
export function clearKind(kind: KeyKind, kv: KV = localStorage) {
  for (const k of ALL_KEYS) {
    if (k.kind === kind && k.key !== KEYS.schema.key)
      kv.removeItem(k.key)
  }
}
