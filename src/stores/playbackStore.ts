import type { ScriptMatch, VideoEntry } from './libraryStore'
import type { ScriptFile } from './scriptStore'
import type { ExternalClock, ExternalSample, MediaClock } from '~/lib/externalClock'
/**
 * Playback controller — the one place that decides what plays.
 *
 * Everything that changes the video goes through here: the library, playlists,
 * the queue panel, the up-next strip, fullscreen controls, hotkeys, gamepad
 * and phone remote. Before this existed each of those carried its own copy of
 * "load the file, parse scripts, enable axes, autoplay", and they drifted (the
 * fullscreen previous button played the *next* video).
 *
 * The <video> element itself belongs to VideoPlayer, which registers its
 * controls with `bindPlayer` on mount.
 */
import { useLocalStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed, nextTick, ref, shallowRef, watch } from 'vue'
import { useAutoDirector } from '~/composables/useAutoDirector'
import { useFunscript } from '~/composables/useFunscript'
import { proxiedStream } from '~/composables/useStreams'
import { toast } from '~/composables/useToast'
import { createExternalClock } from '~/lib/externalClock'
import { mayLeave } from '~/lib/leaveGuard'
import { sameKindAs } from '~/lib/mediaFiles'
import { KEYS } from '~/lib/persist'
import { isVrVideo } from '~/lib/tags'
import { remoteScriptMatches } from '~/plugins/remoteScripts'
import { useDeviceStore } from './deviceStore'
import { useLibraryStore } from './libraryStore'
import { usePlayerStore } from './playerStore'
import { loadSavedQueue, useQueueStore } from './queueStore'
import { useSafetyStore } from './safetyStore'
import { useScriptStore } from './scriptStore'
import { useSubtitleStore } from './subtitleStore'

export interface PlayerControls {
  play: () => void
  pause: () => void
  togglePlay: () => void
  seek: (seconds: number) => void
  seekRelative: (delta: number) => void
  setSpeed: (speed: number) => void
  setVolume: (volume: number) => void
  toggleMute: () => void
  toggleFullscreen: () => void
  /** Into the pop-out window and back. Needs a click or key press to open. */
  togglePopout: () => void
  /** The picture showing now as a JPEG data URL, at most `maxWidth` wide; null without one. */
  frame?: (maxWidth: number, quality: number) => string | null
  /** The <video> element itself, for plugins that draw from it. */
  video?: () => HTMLVideoElement | null
}

/** "Previous" restarts the current video when you are this far into it. */
const PREV_RESTART_AFTER = 3

/**
 * Something that, for a while, decides what "next" means instead of the
 * queue: a programme's highlight reel moves on to its next clip when the
 * user presses Next or a video ends, rather than to the next queued video.
 */
export interface PlaybackTakeover {
  /** Shown where it helps to say who is choosing ("Programme"). */
  label: string
  next: () => Promise<boolean> | boolean
}

/** What playhound's own controls ask of a video playing in another app. */
export type ExternalCommand = { type: 'play' } | { type: 'pause' } | { type: 'seek', time: number } | { type: 'rate', rate: number }

/** Why external playback ended: the user stopped it, another video took over, or its plugin ended it. */
export type ExternalEndReason = 'stopped' | 'replaced' | 'restarted' | 'ended'

/**
 * A video playing in another app (a VR headset) that playhound follows: the
 * other app reports where it is (a plugin passes the reports on), and the
 * device plays this video's scripts to that clock exactly as it would to the
 * <video>'s. See playExternal.
 */
export interface ExternalSession {
  /** The plugin that started it. */
  readonly owner: string
  /** Where it plays, as the player says it: "Playing in <label>". */
  readonly label: string
  readonly title: string
  /** The library video, when it is one. */
  readonly entry: VideoEntry | null
  /** The clock the device follows, read like a <video>. */
  readonly media: MediaClock
  readonly clock: ExternalClock
  /** A report from the other app. */
  update: (s: ExternalSample & { duration?: number }) => void
  /** Hear 'play', 'pause' (including panic and a quiet other app) and 'seek'; returns an unsubscribe. */
  onEvent: (fn: (e: 'play' | 'pause' | 'seek') => void) => () => void
  onEnd: (fn: (reason: ExternalEndReason) => void) => () => void
  readonly ended: boolean
  /** Whether play/pause/seek from playhound reach the other app. */
  readonly controllable: boolean
}

/** The store's own handle on a session. */
interface LiveExternal extends ExternalSession {
  ended: boolean
  /** Bring the player's state up to the clock, and start or stop the device with it. */
  tick: () => void
  end: (reason: ExternalEndReason) => void
  /** playhound's controls, passed on to the other app. */
  controls: PlayerControls
}

export interface ExternalOptions {
  owner: string
  label: string
  /** The library video it is, or null for one only the plugin knows. */
  entry: VideoEntry | null
  /** Its name, when it isn't a library video. */
  title?: string
  /** Scripts to play, for a video that isn't in the library (or to use instead of its own). */
  scripts?: ScriptFile[]
  /** Seconds, when known. */
  duration?: number
  onCommand?: (c: ExternalCommand) => void
}

export const usePlaybackStore = defineStore('playback', () => {
  const player = usePlayerStore()
  const queue = useQueueStore()
  const library = useLibraryStore()
  const scripts = useScriptStore()
  const device = useDeviceStore()
  const subtitles = useSubtitleStore()
  const safety = useSafetyStore()
  const director = useAutoDirector()
  const { autoDetectFromFiles, lastRawMetadata } = useFunscript()

  const controls = shallowRef<PlayerControls | null>(null)
  /** The library entry for what is loaded, when it came from the library. */
  const currentEntry = shallowRef<VideoEntry | null>(null)
  /** The file that is playing, library or not; null for a stream. */
  const currentFile = shallowRef<File | null>(null)
  /** True while a file is being opened and its scripts parsed. */
  const loading = ref(false)
  /** Bumped on every track change, for transitions and now-playing cards. */
  const trackSeq = ref(0)
  /** Set while something else owns "next" (see PlaybackTakeover). */
  const takeover = shallowRef<PlaybackTakeover | null>(null)
  /** The video playing in another app that playhound follows, if one is (playExternal). */
  const external = shallowRef<LiveExternal | null>(null)
  let externalTimer: ReturnType<typeof setInterval> | null = null
  /**
   * The loaded main script's `metadata` block, as written (chapters, bookmarks,
   * tags…). Null with no script, so a script-less video never shows the last one's.
   */
  const scriptMetadata = computed(() => (scripts.scripts.length ? lastRawMetadata.value : null))

  function bindPlayer(c: PlayerControls | null) {
    controls.value = c
  }

  // ── Loading ───────────────────────────────────────────────────────────────
  let loadToken = 0
  // The <video> element is recreated on every load, so play/seek requests made
  // before it reports metadata are parked and applied once it does.
  let pendingPlay = false
  let pendingSeek = 0

  async function loadFile(file: File, scriptMatches: ScriptMatch[] = [], opts: { autoplay?: boolean, startAt?: number } = {}) {
    const token = ++loadToken
    loading.value = true
    endExternal('replaced')
    try {
      if (player.videoUrl?.startsWith('blob:'))
        URL.revokeObjectURL(player.videoUrl)

      const url = URL.createObjectURL(file)
      player.setVideo(file.name, url)
      player.clearLoop()
      currentFile.value = file
      const libEntry = library.videos.find(v => v.file === file) ?? null
      if (libEntry)
        player.applyVr(isVrVideo(libEntry))
      currentEntry.value = libEntry
      trackSeq.value++
      // Alongside the scripts, not after: a slow script parse should not hold them up.
      void subtitles.load(libEntry?.subtitles)

      // This video's script tweaks first, so its scripts play tweaked from
      // the start (and the Handy uploads once).
      await scripts.useTweaksFor(file.name, false)
      if (token !== loadToken)
        return
      await autoDetectFromFiles(file, scriptMatches)
      // A newer load started while scripts were parsing; let it win.
      if (token !== loadToken)
        return

      // A single .funscript yielding several axes means a merged script — flag
      // the library entry so the badge and glow render correctly.
      const uniqueFiles = new Set(scripts.scripts.map(s => s.filename))
      const isMerged = uniqueFiles.size === 1 && scripts.scripts.length > 1
      if (libEntry) {
        // A full parse is the most reliable answer there is, so let it correct
        // whatever the library's cheaper scan concluded.
        libEntry.channels = [...new Set(scripts.scripts.map(s => s.channel))]
        if (isMerged) {
          libEntry.scriptType = 'merged'
          libEntry.scriptCount = libEntry.channels.length
        }
        if (!libEntry.scriptMeta && lastRawMetadata.value) {
          const fm = lastRawMetadata.value
          libEntry.scriptMeta = {
            tags: Array.isArray(fm.topic_tags) ? (fm.topic_tags as string[]) : undefined,
            creator: typeof fm.topic_creator === 'string' ? fm.topic_creator : undefined,
            date: typeof fm.topic_date === 'string' ? fm.topic_date : undefined,
            url: typeof fm.topic_url === 'string' ? fm.topic_url : undefined,
          }
        }
      }

      // Enable a device axis for every loaded script so emulator and hardware agree.
      for (const s of scripts.scripts) {
        if (s.enabled && device.axisConfigs[s.channel])
          device.axisConfigs[s.channel].enabled = true
      }

      // Learn this video's shape as a side effect of playing it, so the
      // director gets smarter without anyone running a sweep.
      if (libEntry)
        void director.summarise(libEntry)

      if (opts.startAt)
        pendingSeek = opts.startAt
      if (opts.autoplay)
        pendingPlay = true
      flushPending()
    }
    catch (err) {
      console.error('Failed to load video:', err)
      toast.error('Could not open that video', { detail: file.name })
    }
    finally {
      if (token === loadToken)
        loading.value = false
    }
  }

  function flushPending() {
    if (!controls.value || player.videoDuration <= 0 || external.value)
      return
    if (pendingSeek) {
      controls.value.seek(pendingSeek)
      pendingSeek = 0
    }
    if (pendingPlay) {
      pendingPlay = false
      controls.value.play()
    }
  }
  watch(() => player.videoDuration, flushPending)

  function loadEntry(entry: VideoEntry, opts: { autoplay?: boolean, startAt?: number } = { autoplay: true }) {
    if (entry.remote)
      return loadRemote(entry, opts)
    return loadFile(entry.file, entry.scriptMatches, opts)
  }

  /**
   * A video a plugin added from another app (src/plugins/provider.ts): it
   * streams, through the local proxy when it needs headers, and its scripts
   * are fetched the first time it plays.
   */
  async function loadRemote(entry: VideoEntry, opts: { autoplay?: boolean, startAt?: number }) {
    const r = entry.remote!
    const token = ++loadToken
    loading.value = true
    endExternal('replaced')
    try {
      if (player.videoUrl?.startsWith('blob:'))
        URL.revokeObjectURL(player.videoUrl)
      const url = r.headers ? await proxiedStream(r.url, r.headers, r.kind) : r.url
      if (token !== loadToken)
        return
      player.setVideo('', '')
      await nextTick()
      player.setVideo(entry.name, url, r.kind)
      player.applyVr(isVrVideo(entry), entry.basename)
      player.clearLoop()
      currentEntry.value = entry
      currentFile.value = null
      trackSeq.value++
      subtitles.clear()
      await scripts.useTweaksFor(entry.name, false)
      if (token !== loadToken)
        return
      await autoDetectFromFiles(entry.file, await remoteScriptMatches(entry))
      if (token !== loadToken)
        return
      entry.channels = [...new Set(scripts.scripts.map(s => s.channel))]
      for (const s of scripts.scripts) {
        if (s.enabled && device.axisConfigs[s.channel])
          device.axisConfigs[s.channel].enabled = true
      }
      if (entry.hasScript)
        void director.summarise(entry)
      if (opts.startAt)
        pendingSeek = opts.startAt
      if (opts.autoplay)
        pendingPlay = true
      flushPending()
    }
    catch (err) {
      console.error('Failed to load video:', err)
      toast.error('Could not play that video', { detail: `${entry.basename}: ${err instanceof Error ? err.message : String(err)}` })
    }
    finally {
      if (token === loadToken)
        loading.value = false
    }
  }

  // ── Playing in another app ────────────────────────────────────────────────

  /**
   * Follow a video that plays in another app (a VR headset): this video's
   * scripts play on every device to the other app's clock, with latency,
   * offset, tweaks, the knob, edges and panic as for a video here. The
   * player shows it as playing elsewhere, with its timeline following.
   * Null if the user kept unsaved script edits.
   */
  async function playExternal(o: ExternalOptions): Promise<ExternalSession | null> {
    if (!await mayLeave('Play another video'))
      return null
    // A new external session ends the one before: 'restarted', not the user playing something else.
    endExternal('restarted')
    const token = ++loadToken
    loading.value = false
    pendingPlay = false
    pendingSeek = 0
    controls.value?.pause()
    if (player.videoUrl?.startsWith('blob:'))
      URL.revokeObjectURL(player.videoUrl)
    const entry = o.entry
    const name = entry?.name ?? (o.title?.trim() || o.label)
    player.setVideo('', '')
    await nextTick()
    player.setVideo(name, `external:${o.owner}`, 'external')
    player.clearLoop()
    currentEntry.value = entry
    currentFile.value = null
    subtitles.clear()
    trackSeq.value++

    const clock = createExternalClock()
    const events = new Set<(e: 'play' | 'pause' | 'seek') => void>()
    const ends = new Set<(r: ExternalEndReason) => void>()
    /** Whether the device follows: the other app plays, it's been heard from, and no panic. */
    let following = false
    const emit = (e: 'play' | 'pause' | 'seek') => {
      for (const fn of events) {
        try {
          fn(e)
        }
        catch (err) {
          console.error('[playback] external listener failed', err)
        }
      }
    }
    const read = () => clock.read(performance.now())
    const media: MediaClock = {
      get currentTime() {
        return read().timeMs / 1000
      },
      get playbackRate() {
        return read().rate
      },
      get paused() {
        return !following
      },
      seeking: false,
      ended: false,
      // As much as a <video> that can play on.
      readyState: 4,
    }
    const session: LiveExternal = {
      owner: o.owner,
      label: o.label,
      title: entry?.basename ?? name,
      entry,
      media,
      clock,
      ended: false,
      controllable: typeof o.onCommand === 'function',
      update(s) {
        if (session.ended)
          return
        if (typeof s.duration === 'number' && Number.isFinite(s.duration) && s.duration > 0)
          player.videoDuration = s.duration
        const changed = clock.update(s, performance.now())
        if (changed.includes('seek'))
          emit('seek')
        session.tick()
      },
      onEvent(fn) {
        events.add(fn)
        return () => void events.delete(fn)
      },
      onEnd(fn) {
        ends.add(fn)
        return () => void ends.delete(fn)
      },
      /** Bring the player's state up to the clock, and start or stop the device with it. */
      tick() {
        if (session.ended)
          return
        const r = read()
        player.currentTime = r.timeMs / 1000
        player.isPlaying = r.playing
        const want = r.playing && !safety.panicked
        if (want !== following) {
          following = want
          emit(want ? 'play' : 'pause')
        }
      },
      end(reason) {
        if (session.ended)
          return
        session.ended = true
        following = false
        emit('pause')
        for (const fn of ends) {
          try {
            fn(reason)
          }
          catch (err) {
            console.error('[playback] external end listener failed', err)
          }
        }
      },
      controls: {
        play: () => o.onCommand?.({ type: 'play' }),
        pause: () => o.onCommand?.({ type: 'pause' }),
        togglePlay: () => o.onCommand?.({ type: read().playing ? 'pause' : 'play' }),
        seek: t => o.onCommand?.({ type: 'seek', time: Math.max(0, t) }),
        seekRelative: d => o.onCommand?.({ type: 'seek', time: Math.max(0, read().timeMs / 1000 + d) }),
        setSpeed: rate => o.onCommand?.({ type: 'rate', rate: Math.max(0.1, Math.min(10, rate)) }),
        // The rest are this window's: there's no picture here to show.
        setVolume: v => controls.value?.setVolume(v),
        toggleMute: () => controls.value?.toggleMute(),
        toggleFullscreen: () => {},
        togglePopout: () => {},
        frame: () => null,
      },
    }

    // Its scripts: the library video's own, or the plugin's.
    await scripts.useTweaksFor(name, false)
    if (token !== loadToken)
      return null
    if (o.scripts?.length)
      scripts.setAutoDetected(o.scripts)
    else if (entry)
      await autoDetectFromFiles(entry.file, entry.remote ? await remoteScriptMatches(entry) : entry.scriptMatches)
    else
      scripts.clearScripts()
    if (token !== loadToken)
      return null
    for (const s of scripts.scripts) {
      if (s.enabled && device.axisConfigs[s.channel])
        device.axisConfigs[s.channel].enabled = true
    }
    player.videoDuration = o.duration && o.duration > 0 ? o.duration : entry?.duration ?? 0
    external.value = session
    // The player's time a few times a second, as a <video> reports it; the
    // device reads the clock itself, every frame.
    externalTimer = setInterval(() => session.tick(), 250)
    return session
  }

  /** Stop following the other app. The device stops; the other app plays on. */
  function endExternal(reason: ExternalEndReason = 'stopped') {
    const s = external.value
    if (!s)
      return
    if (externalTimer)
      clearInterval(externalTimer)
    externalTimer = null
    external.value = null
    s.end(reason)
    if (reason !== 'replaced' && reason !== 'restarted') {
      player.setVideo('', '')
      currentEntry.value = null
      trackSeq.value++
    }
  }

  // Panic stops the device at once, whatever the other app does.
  watch(() => safety.panicked, () => external.value?.tick(), { flush: 'sync' })

  /** Whose controls play, pause and seek: the other app's while following it. */
  const ctl = (): PlayerControls | null => (external.value ? external.value.controls : controls.value)

  /**
   * Play an entry from `startAt` seconds, slotted in after the current one
   * like `play` without context. For a clip of a video: the seek is applied
   * as soon as the new video can take it, before it starts playing. The same
   * video already loaded just seeks.
   */
  async function playAt(entry: VideoEntry, startAt: number) {
    if (currentEntry.value?.name === entry.name && player.videoUrl && !loading.value) {
      controls.value?.seek(startAt)
      controls.value?.play()
      return
    }
    if (!await mayLeave('Play another video'))
      return
    queue.playNow(entry)
    await loadEntry(entry, { autoplay: true, startAt })
  }

  function setTakeover(t: PlaybackTakeover | null) {
    takeover.value = t
  }

  // ── What to play ──────────────────────────────────────────────────────────
  /**
   * Play an entry. With `context`, the queue is rebuilt from that list (the
   * library as currently sorted, or a playlist); without it the entry is
   * slotted in after the current one and everything else is kept.
   */
  async function play(entry: VideoEntry, context?: VideoEntry[], label?: string) {
    if (!await mayLeave('Play another video'))
      return
    if (context?.length)
      queue.setQueue(context, entry, label)
    else
      queue.playNow(entry)
    return loadEntry(entry)
  }

  /** A loose file (Open, drag and drop) that may or may not be in the library. */
  async function playFile(file: File) {
    if (!await mayLeave('Play another video'))
      return
    const entry = library.videos.find(v => v.name === file.name && v.file.size === file.size)
    if (entry)
      return play(entry)
    currentEntry.value = null
    return loadFile(file, [], { autoplay: true })
  }

  /**
   * A remote stream (EroScripts sources). Scripts are whatever is already in
   * the script store — the caller loads them first, since there is no folder to
   * auto-detect from. The queue is left alone: a stream is not a library entry.
   */
  async function playStream(name: string, url: string, kind: 'file' | 'hls' = 'file') {
    if (!await mayLeave('Play another video'))
      return
    ++loadToken
    loading.value = false
    endExternal('replaced')
    if (player.videoUrl?.startsWith('blob:'))
      URL.revokeObjectURL(player.videoUrl)
    // Clearing first makes the same URL count as a change, so the <video> reloads.
    player.setVideo('', '')
    await nextTick()
    player.setVideo(name, url, kind)
    player.clearLoop()
    currentEntry.value = null
    currentFile.value = null
    // A stream has no folder to find subtitles in.
    subtitles.clear()
    trackSeq.value++
    // The scripts were loaded first, by the caller; give them this stream's tweaks.
    void scripts.useTweaksFor(name)
    for (const s of scripts.scripts) {
      if (s.enabled && device.axisConfigs[s.channel])
        device.axisConfigs[s.channel].enabled = true
    }
    pendingPlay = true
    flushPending()
  }

  /** Jump to an item already queued (queue panel, up-next strip). */
  async function jumpTo(target: VideoEntry | number) {
    if (!await mayLeave('Play another video'))
      return
    const entry = queue.jumpTo(target)
    if (entry)
      return loadEntry(entry)
  }

  function playNextInQueue(entries: VideoEntry | VideoEntry[]) {
    const list = Array.isArray(entries) ? entries : [entries]
    queue.playNext(list)
    toast(list.length === 1 ? 'Playing next' : `${list.length} videos playing next`, {
      detail: list.length === 1 ? list[0].basename : undefined,
      icon: 'i-carbon-play-filled-alt',
      key: 'queue-add',
    })
  }

  function addToQueue(entries: VideoEntry | VideoEntry[]) {
    const list = Array.isArray(entries) ? entries : [entries]
    queue.enqueue(list)
    toast(list.length === 1 ? 'Added to queue' : `${list.length} videos added to queue`, {
      detail: list.length === 1 ? list[0].basename : undefined,
      icon: 'i-carbon-list-boxes',
      key: 'queue-add',
    })
  }

  /** The director's pick, when it is on and has something analysed to offer. */
  function directed(): VideoEntry | null {
    if (!director.enabled.value)
      return null
    return director.pickNext(player.videoPath ?? undefined)
  }

  async function next(auto = false): Promise<boolean> {
    if (!await mayLeave('Play the next video', auto === true))
      return false
    if (takeover.value)
      return takeover.value.next()
    const picked = directed()
    if (picked) {
      queue.playNow(picked)
      await loadEntry(picked)
      return true
    }
    const entry = queue.next()
    if (entry) {
      await loadEntry(entry)
      return true
    }
    toast('End of queue', { icon: 'i-carbon-list', key: 'queue-end' })
    return false
  }

  /**
   * Previous behaves like every music player: a few seconds in, it restarts
   * the current video; at the start, it goes back one.
   */
  async function prev(): Promise<boolean> {
    if (player.currentTime > PREV_RESTART_AFTER || !queue.hasPrev) {
      ctl()?.seek(0)
      return !!player.videoUrl
    }
    if (!await mayLeave('Play the previous video'))
      return false
    const entry = queue.prev()
    if (entry) {
      await loadEntry(entry)
      return true
    }
    return false
  }

  async function random() {
    if (!await mayLeave('Play another video'))
      return
    // Scripted first, and the same kind as what is playing (video or audio).
    const scripted = library.videos.filter(v => v.hasScript)
    const from = sameKindAs(scripted.length ? scripted : library.videos, currentEntry.value?.name)
    if (!from.length) {
      toast('Open a folder first', { icon: 'i-carbon-folder', key: 'random' })
      return
    }
    const others = from.filter(v => v.name !== currentEntry.value?.name)
    const pick = (others.length ? others : from)[Math.floor(Math.random() * (others.length || from.length))]
    // With no queue yet, the scripted pool becomes one, so next keeps going.
    if (!queue.length)
      return play(pick, from, 'Random')
    return play(pick)
  }

  async function onEnded() {
    if (queue.repeatMode === 'one') {
      controls.value?.seek(0)
      controls.value?.play()
      return
    }
    await next(true)
  }

  // ── Session restore ───────────────────────────────────────────────────────
  // Remember where we were so a reload comes back to the same video, paused,
  // at the same moment.
  let lastSnap = 0
  watch(() => player.currentTime, (t) => {
    const now = Date.now()
    if (now - lastSnap < 4000)
      return
    lastSnap = now
    queue.snapshot(t)
  })

  const restored = ref(false)
  /** Settings → Startup. Off, startup lands on the welcome screen with the library open. */
  const resumeOnStart = useLocalStorage(KEYS.resumeOnStart.key, true)
  async function restoreSession() {
    if (restored.value || player.videoUrl || !resumeOnStart.value)
      return
    const saved = loadSavedQueue()
    if (!saved || !library.videos.length)
      return
    restored.value = true
    const entry = queue.restore(saved, library.videos)
    if (!entry)
      return
    // Back off a few seconds so there is context, and never resume in the last moments.
    const at = Math.max(0, saved.time - 3)
    await loadEntry(entry, { autoplay: false, startAt: at > 5 ? at : 0 })
    toast('Picked up where you left off', {
      detail: entry.basename,
      icon: 'i-carbon-restart',
      image: entry.thumbnailUrl,
      key: 'resume',
    })
  }
  watch(() => library.loadedAt, () => void restoreSession())

  // ── Passthrough controls ──────────────────────────────────────────────────
  const togglePlay = () => ctl()?.togglePlay()
  const pause = () => ctl()?.pause()
  /** The current picture of the video, small, for whoever wants a look (plugins). */
  const grabFrame = (maxWidth = 512, quality = 0.72) => ctl()?.frame?.(maxWidth, quality) ?? null
  /** The player's own <video>, for plugins to draw from; null without one. */
  const videoElement = () => ctl()?.video?.() ?? null
  const resume = () => ctl()?.play()
  const seek = (t: number) => ctl()?.seek(t)
  const seekRelative = (d: number) => ctl()?.seekRelative(d)
  const setSpeed = (s: number) => ctl()?.setSpeed(s)
  const setVolume = (v: number) => ctl()?.setVolume(v)
  const toggleMute = () => ctl()?.toggleMute()
  const toggleFullscreen = () => ctl()?.toggleFullscreen()
  const togglePopout = () => ctl()?.togglePopout()

  function toggleShuffle() {
    queue.toggleShuffle()
    toast(queue.shuffle ? 'Shuffle on' : 'Shuffle off', { icon: 'i-carbon-shuffle', key: 'mode' })
  }

  function cycleRepeat() {
    queue.cycleRepeat()
    const label = { off: 'Repeat off', all: 'Repeat all', one: 'Repeat one' }[queue.repeatMode]
    toast(label, { icon: queue.repeatMode === 'one' ? 'i-carbon-repeat-one' : 'i-carbon-repeat', key: 'mode' })
  }

  return {
    controls,
    currentEntry,
    currentFile,
    loading,
    trackSeq,
    takeover,
    scriptMetadata,
    bindPlayer,
    loadFile,
    loadEntry,
    external,
    playExternal,
    endExternal,
    playAt,
    setTakeover,
    play,
    playFile,
    playStream,
    jumpTo,
    playNextInQueue,
    addToQueue,
    next,
    prev,
    random,
    onEnded,
    restoreSession,
    togglePlay,
    pause,
    grabFrame,
    videoElement,
    resume,
    seek,
    seekRelative,
    setSpeed,
    setVolume,
    toggleMute,
    toggleFullscreen,
    togglePopout,
    toggleShuffle,
    cycleRepeat,
  }
})
