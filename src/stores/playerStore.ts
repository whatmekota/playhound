import type { VrEye } from '~/lib/vrFormat'
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { isAudioName } from '~/lib/mediaFiles'
import { looksVr } from '~/lib/tags'
import { DEFAULT_VR_FORMAT, guessVrFormat, looksSbsBySize, VR_FORMATS } from '~/lib/vrFormat'

// Legacy storage key kept so existing data survives the rename.
const LS_KEY = 'ph:player.prefs'
function load() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) ?? '{}') }
  catch { return {} }
}
const saved = load()

/**
 * What the user set the VR view to for a video (on or off, the eye, the
 * format), by file name, so it comes back the next time it plays.
 */
interface VrChoice { on?: boolean, eye?: VrEye, format?: string }
const VR_CHOICES_KEY = 'ph:player.vrByVideo'
const VR_CHOICES_MAX = 2000
function loadVrChoices(): Map<string, VrChoice> {
  try {
    const raw = JSON.parse(localStorage.getItem(VR_CHOICES_KEY) ?? '[]')
    return new Map(Array.isArray(raw) ? raw : [])
  }
  catch { return new Map() }
}

export const usePlayerStore = defineStore('player', () => {
  // Video state
  const videoPath = ref<string | null>(null)
  const videoUrl = ref<string | null>(null)
  /**
   * 'hls' when videoUrl is an HLS playlist, which the player plays with
   * hls.js; 'external' when the video plays in another app (a VR headset)
   * and only its clock is here (playbackStore.playExternal).
   */
  const videoKind = ref<'file' | 'hls' | 'external'>('file')
  /**
   * Sound with no picture: an audio file, or a stream that turned out to have
   * no video track. The stage then shows the visual picked for audio.
   */
  const audioOnly = ref(false)
  /** The picture's own size in pixels, once the media says (0 before, and for sound alone). */
  const videoWidth = ref(0)
  const videoHeight = ref(0)
  /**
   * Where the picture is drawn inside the player, in CSS px from its top-left
   * (object-contain: letterboxed or pillarboxed), and the player's size; null
   * with no picture. Kept by VideoPlayer, for plugins (player.picture).
   */
  const pictureRect = ref<{ x: number, y: number, width: number, height: number, areaWidth: number, areaHeight: number } | null>(null)
  const videoDuration = ref(0) // seconds
  const currentTime = ref(0) // seconds
  const isPlaying = ref(false)
  const playbackSpeed = ref<number>(saved.playbackSpeed ?? 1.0)
  const volume = ref<number>(saved.volume ?? 1.0)
  const isMuted = ref<boolean>(saved.isMuted ?? false)

  // SBS VR view (named for the 180° it started with)
  const sbs180 = ref(false)
  /** Layout of the VR video, an id from VR_FORMATS. */
  const vrFormat = ref<string>(VR_FORMATS.some(f => f.id === saved.vrFormat) ? saved.vrFormat : DEFAULT_VR_FORMAT)
  /** Which eye's half the VR view shows; the last one chosen, unless a video has its own. */
  const vrEye = ref<VrEye>(saved.vrEye === 'right' ? 'right' : 'left')
  /** Open VR videos in the VR view by themselves (and flat ones out of it). */
  const vrAuto = ref<boolean>(saved.vrAuto ?? true)

  function toggleSbs() { sbs180.value = !sbs180.value }

  const vrChoices = loadVrChoices()
  // Set while playhound itself changes the VR view, so only the user's own changes are remembered.
  let applyingVr = false
  function rememberVr(change: VrChoice) {
    const name = videoPath.value
    if (applyingVr || !name || videoKind.value === 'external')
      return
    const next = { ...vrChoices.get(name), ...change }
    vrChoices.delete(name)
    vrChoices.set(name, next)
    while (vrChoices.size > VR_CHOICES_MAX)
      vrChoices.delete(vrChoices.keys().next().value!)
    try { localStorage.setItem(VR_CHOICES_KEY, JSON.stringify([...vrChoices])) }
    catch {}
  }
  watch(sbs180, on => rememberVr({ on }), { flush: 'sync' })
  watch(vrEye, eye => rememberVr({ eye }), { flush: 'sync' })
  watch(vrFormat, format => rememberVr({ format }), { flush: 'sync' })

  /**
   * A video was loaded: put the VR view back as the user left it for this
   * video, or, with vrAuto, on for a VR video and off for a flat one.
   * `isVr` is what the library knows (its name, a "vr" tag, its size).
   */
  function applyVr(isVr: boolean, title?: string) {
    const name = videoPath.value
    if (!name || videoKind.value === 'external')
      return
    const c = vrChoices.get(name)
    applyingVr = true
    try {
      // A title that says how it is laid out (a provided video's name is its id).
      if (title)
        vrFormat.value = guessVrFormat(title) ?? vrFormat.value
      if (c?.on !== undefined)
        sbs180.value = c.on
      else if (vrAuto.value)
        sbs180.value = isVr
      if (c?.eye)
        vrEye.value = c.eye
      if (c?.format && VR_FORMATS.some(f => f.id === c.format))
        vrFormat.value = c.format
    }
    finally {
      applyingVr = false
    }
  }

  // UI state
  const controlsVisible = ref(true)
  const controlsTimeout = ref<ReturnType<typeof setTimeout> | null>(null)

  // Loop section (A-B loop)
  const loopEnabled = ref(false)
  const loopStart = ref<number | null>(null) // seconds
  const loopEnd = ref<number | null>(null) // seconds

  // Fullscreen
  const isFullscreen = ref(false)

  // Computed
  const progress = computed(() =>
    videoDuration.value > 0 ? currentTime.value / videoDuration.value : 0,
  )

  const hasLoop = computed(() =>
    loopStart.value !== null && loopEnd.value !== null,
  )

  const loopActive = computed(() =>
    loopEnabled.value && hasLoop.value,
  )

  // Persist volume + speed
  watch([volume, isMuted, playbackSpeed, vrFormat, vrEye, vrAuto], () => {
    localStorage.setItem(LS_KEY, JSON.stringify({
      volume: volume.value,
      isMuted: isMuted.value,
      playbackSpeed: playbackSpeed.value,
      vrFormat: vrFormat.value,
      vrEye: vrEye.value,
      vrAuto: vrAuto.value,
    }))
  })

  // A video whose name says nothing but whose picture is big and 2:1 is VR.
  watch([videoWidth, videoHeight], ([w, h]) => {
    const name = videoPath.value
    if (!name || !vrAuto.value || sbs180.value || audioOnly.value || vrChoices.get(name)?.on !== undefined)
      return
    if (w && h && looksSbsBySize(w, h)) {
      applyingVr = true
      sbs180.value = true
      applyingVr = false
    }
  })

  // Actions
  function setVideo(path: string, url: string, kind: 'file' | 'hls' | 'external' = 'file') {
    videoPath.value = path
    // A file name that says how it is laid out (_MKX200, _180_LR) wins over
    // the last choice; one that says nothing keeps it.
    applyingVr = true
    vrFormat.value = guessVrFormat(path) ?? vrFormat.value
    applyingVr = false
    videoUrl.value = url
    videoKind.value = kind
    // By name until the media says (VideoPlayer, on loadedmetadata).
    audioOnly.value = isAudioName(path)
    videoWidth.value = 0
    videoHeight.value = 0
    currentTime.value = 0
    videoDuration.value = 0
    isPlaying.value = false
    if (path && !audioOnly.value)
      applyVr(looksVr({ name: path, path }))
  }

  function setLoopStart(t: number | null) {
    loopStart.value = t
  }

  function setLoopEnd(t: number | null) {
    loopEnd.value = t
  }

  function clearLoop() {
    loopStart.value = null
    loopEnd.value = null
    loopEnabled.value = false
  }

  function showControls() {
    controlsVisible.value = true
    if (controlsTimeout.value)
      clearTimeout(controlsTimeout.value)
    controlsTimeout.value = setTimeout(() => {
      if (isPlaying.value)
        controlsVisible.value = false
    }, 3000)
  }

  return {
    videoKind,
    audioOnly,
    videoWidth,
    videoHeight,
    pictureRect,
    videoPath,
    videoUrl,
    videoDuration,
    currentTime,
    isPlaying,
    playbackSpeed,
    volume,
    isMuted,
    sbs180,
    vrFormat,
    vrEye,
    vrAuto,
    applyVr,
    controlsVisible,
    controlsTimeout,
    loopEnabled,
    loopStart,
    loopEnd,
    isFullscreen,
    progress,
    hasLoop,
    loopActive,
    setVideo,
    setLoopStart,
    setLoopEnd,
    clearLoop,
    toggleSbs,
    showControls,
  }
})
