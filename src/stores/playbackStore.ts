import type { ScriptMatch, VideoEntry } from './libraryStore'
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
import { defineStore } from 'pinia'
import { nextTick, ref, shallowRef, watch } from 'vue'
import { useAutoDirector } from '~/composables/useAutoDirector'
import { useFunscript } from '~/composables/useFunscript'
import { toast } from '~/composables/useToast'
import { useDeviceStore } from './deviceStore'
import { useLibraryStore } from './libraryStore'
import { usePlayerStore } from './playerStore'
import { loadSavedQueue, useQueueStore } from './queueStore'
import { useScriptStore } from './scriptStore'

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
}

/** "Previous" restarts the current video when you are this far into it. */
const PREV_RESTART_AFTER = 3

export const usePlaybackStore = defineStore('playback', () => {
  const player = usePlayerStore()
  const queue = useQueueStore()
  const library = useLibraryStore()
  const scripts = useScriptStore()
  const device = useDeviceStore()
  const director = useAutoDirector()
  const { autoDetectFromFiles, lastRawMetadata } = useFunscript()

  const controls = shallowRef<PlayerControls | null>(null)
  /** The library entry for what is loaded, when it came from the library. */
  const currentEntry = shallowRef<VideoEntry | null>(null)
  /** True while a file is being opened and its scripts parsed. */
  const loading = ref(false)
  /** Bumped on every track change, for transitions and now-playing cards. */
  const trackSeq = ref(0)

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
    try {
      if (player.videoUrl?.startsWith('blob:'))
        URL.revokeObjectURL(player.videoUrl)

      const url = URL.createObjectURL(file)
      player.setVideo(file.name, url)
      player.clearLoop()
      const libEntry = library.videos.find(v => v.file === file) ?? null
      currentEntry.value = libEntry
      trackSeq.value++

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
    if (!controls.value || player.videoDuration <= 0)
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
    return loadFile(entry.file, entry.scriptMatches, opts)
  }

  // ── What to play ──────────────────────────────────────────────────────────
  /**
   * Play an entry. With `context`, the queue is rebuilt from that list (the
   * library as currently sorted, or a playlist); without it the entry is
   * slotted in after the current one and everything else is kept.
   */
  function play(entry: VideoEntry, context?: VideoEntry[], label?: string) {
    if (context?.length)
      queue.setQueue(context, entry, label)
    else
      queue.playNow(entry)
    return loadEntry(entry)
  }

  /** A loose file (Open, drag and drop) that may or may not be in the library. */
  async function playFile(file: File) {
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
  async function playStream(name: string, url: string) {
    ++loadToken
    loading.value = false
    if (player.videoUrl?.startsWith('blob:'))
      URL.revokeObjectURL(player.videoUrl)
    // Clearing first makes the same URL count as a change, so the <video> reloads.
    player.setVideo('', '')
    await nextTick()
    player.setVideo(name, url)
    player.clearLoop()
    currentEntry.value = null
    trackSeq.value++
    for (const s of scripts.scripts) {
      if (s.enabled && device.axisConfigs[s.channel])
        device.axisConfigs[s.channel].enabled = true
    }
    pendingPlay = true
    flushPending()
  }

  /** Jump to an item already queued (queue panel, up-next strip). */
  function jumpTo(target: VideoEntry | number) {
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

  async function next(): Promise<boolean> {
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
      controls.value?.seek(0)
      return !!player.videoUrl
    }
    const entry = queue.prev()
    if (entry) {
      await loadEntry(entry)
      return true
    }
    return false
  }

  async function random() {
    const pool = library.videos.filter(v => v.hasScript)
    const from = pool.length ? pool : library.videos
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
    await next()
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
  async function restoreSession() {
    if (restored.value || player.videoUrl)
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
  const togglePlay = () => controls.value?.togglePlay()
  const pause = () => controls.value?.pause()
  const resume = () => controls.value?.play()
  const seek = (t: number) => controls.value?.seek(t)
  const seekRelative = (d: number) => controls.value?.seekRelative(d)
  const setSpeed = (s: number) => controls.value?.setSpeed(s)
  const setVolume = (v: number) => controls.value?.setVolume(v)
  const toggleMute = () => controls.value?.toggleMute()
  const toggleFullscreen = () => controls.value?.toggleFullscreen()

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
    loading,
    trackSeq,
    bindPlayer,
    loadFile,
    loadEntry,
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
    resume,
    seek,
    seekRelative,
    setSpeed,
    setVolume,
    toggleMute,
    toggleFullscreen,
    toggleShuffle,
    cycleRepeat,
  }
})
