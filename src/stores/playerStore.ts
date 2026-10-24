import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'

// Legacy storage key kept so existing data survives the rename.
const LS_KEY = 'ph:player.prefs'
function load() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) ?? '{}') }
  catch { return {} }
}
const saved = load()

export const usePlayerStore = defineStore('player', () => {
  // Video state
  const videoPath = ref<string | null>(null)
  const videoUrl = ref<string | null>(null)
  const videoDuration = ref(0) // seconds
  const currentTime = ref(0) // seconds
  const isPlaying = ref(false)
  const playbackSpeed = ref<number>(saved.playbackSpeed ?? 1.0)
  const volume = ref<number>(saved.volume ?? 1.0)
  const isMuted = ref<boolean>(saved.isMuted ?? false)

  // SBS 180° mode
  const sbs180 = ref(false)

  function toggleSbs() { sbs180.value = !sbs180.value }

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
  watch([volume, isMuted, playbackSpeed], () => {
    localStorage.setItem(LS_KEY, JSON.stringify({
      volume: volume.value,
      isMuted: isMuted.value,
      playbackSpeed: playbackSpeed.value,
    }))
  })

  // Actions
  function setVideo(path: string, url: string) {
    videoPath.value = path
    videoUrl.value = url
    currentTime.value = 0
    videoDuration.value = 0
    isPlaying.value = false
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
    videoPath,
    videoUrl,
    videoDuration,
    currentTime,
    isPlaying,
    playbackSpeed,
    volume,
    isMuted,
    sbs180,
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
