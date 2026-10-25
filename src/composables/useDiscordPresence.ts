import type { PresenceContext, PresenceSettings } from '~/lib/presence'
import { useLocalStorage } from '@vueuse/core'
import { computed, ref, watch } from 'vue'
import { desktop } from '~/lib/browserApi'
import { KEYS } from '~/lib/persist'
import { buildActivity, DEFAULT_CLIENT_ID, DEFAULT_PRESENCE, isClientId } from '~/lib/presence'
import { formatTime } from '~/lib/time'
import { useDeviceStore } from '~/stores/deviceStore'
import { MOTION_SOURCES, useMotionStore } from '~/stores/motionStore'
import { usePlayerStore } from '~/stores/playerStore'
import { useProgrammeStore } from '~/stores/programmeStore'
import { useQueueStore } from '~/stores/queueStore'
import { useSafetyStore } from '~/stores/safetyStore'
import { useScriptStore } from '~/stores/scriptStore'
import { useSessionControlStore } from '~/stores/sessionControlStore'
import { heartRate } from './useHeartRate'
import { useSessionActions } from './useSessionActions'
import { getBeatGrid } from './useVideoBeat'

/** Rich Presence changes at most this often; Discord itself caps updates hard. */
const MIN_GAP_MS = 15_000

let settings: ReturnType<typeof useLocalStorage<PresenceSettings>> | null = null

/** Shared settings, for the Settings screen and the presence loop alike. */
export function usePresenceSettings() {
  settings ??= useLocalStorage<PresenceSettings>(KEYS.discord.key, { ...DEFAULT_PRESENCE }, { mergeDefaults: true })
  return settings
}

/** Live status from the desktop side, for the Settings screen. */
export const presenceStatus = ref(desktop?.presence?.status() ?? { status: 'off' as const })
desktop?.presence?.onStatus((s) => {
  presenceStatus.value = s
})

/** The values templates can use, from the live session. */
export function usePresenceContext() {
  const player = usePlayerStore()
  const queue = useQueueStore()
  const motion = useMotionStore()
  const scripts = useScriptStore()
  const device = useDeviceStore()
  const control = useSessionControlStore()
  const programme = useProgrammeStore()
  const { chapters } = useSessionActions()

  return computed<PresenceContext>(() => {
    const title = player.videoPath?.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '')
    const t = player.currentTime
    const chapter = chapters.value.find(c => t * 1000 >= c.start && t * 1000 < c.end)
    const source = motion.enabled && motion.isGenerated
      ? MOTION_SOURCES.find(s => s.id === motion.source)?.label
      : scripts.activeScripts.length ? 'Script' : undefined
    return {
      title,
      playlist: queue.sourceLabel || undefined,
      state: !player.videoUrl ? 'Idle' : player.isPlaying ? 'Playing' : 'Paused',
      position: player.videoUrl ? formatTime(t) : undefined,
      duration: player.videoDuration ? formatTime(player.videoDuration) : undefined,
      spm: motion.currentSpm || undefined,
      bpm: getBeatGrid()?.bpm,
      source,
      intensity: Math.round(control.intensityScale * 100),
      edges: control.edges.length,
      chapter: chapter?.name,
      heart: heartRate.bpm ?? undefined,
      device: device.connected ? 'Connected' : undefined,
      axes: scripts.activeScripts.length || undefined,
      programme: programme.status !== 'idle' ? programme.plan?.name : undefined,
      phase: programme.status !== 'idle' ? programme.currentPhase?.name : undefined,
    }
  })
}

/**
 * Keep Discord Rich Presence in step with the session — desktop app only, and
 * only when switched on in Settings. Mounted once by the shell.
 */
export function useDiscordPresence() {
  const api = desktop?.presence
  if (!api)
    return

  const s = usePresenceSettings()
  const player = usePlayerStore()
  const safety = useSafetyStore()
  const ctx = usePresenceContext()
  const sessionStart = Date.now()

  let lastSentAt = 0
  let lastJson = ''
  let timer: ReturnType<typeof setTimeout> | null = null

  function compute() {
    // Empty means the built-in application (also covers settings saved before it existed).
    const settings = { ...s.value, clientId: s.value.clientId.trim() || DEFAULT_CLIENT_ID }
    if (!isClientId(settings.clientId))
      return { id: '', activity: null }
    const videoStart = player.videoUrl && player.isPlaying ? Date.now() - player.currentTime * 1000 : null
    return { id: settings.clientId, activity: buildActivity(settings, ctx.value, { sessionStart, videoStart }) }
  }

  function send(force = false) {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    // Panic hides the presence at once, whatever else is going on.
    const { id, activity } = safety.panicked ? { id: '', activity: null } : compute()
    // Compare without timestamps, which move on their own.
    const json = JSON.stringify({ id, activity: activity ? { ...activity, startTimestamp: undefined } : null })
    if (json === lastJson && !force)
      return
    const wait = MIN_GAP_MS - (Date.now() - lastSentAt)
    if (wait > 0 && !force) {
      timer = setTimeout(() => send(), wait)
      return
    }
    lastJson = json
    lastSentAt = Date.now()
    api!.set(id, activity)
  }

  // Immediate: on/off, mode and identity changes, a new video, play/pause, panic.
  watch(
    () => [s.value.enabled, s.value.clientId, s.value.mode, s.value.timer, player.videoPath, player.isPlaying, safety.panicked],
    () => send(true),
    { immediate: true },
  )
  // Everything else (rate, tempo, templates) at the throttled pace.
  // The context changes every frame while motion runs; skip all of it while off.
  watch([ctx, () => JSON.stringify(s.value)], () => {
    if (s.value.enabled)
      send()
  })
}
