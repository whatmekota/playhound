import type { AchievementFacts } from '~/lib/achievements'
import { watchDebounced } from '@vueuse/core'
import { computed, effectScope, watch } from 'vue'
import { dayFacts, newlyEarned, sessionFacts } from '~/lib/achievements'
import { isNativeMediaUrl } from '~/lib/android/nativeFile'
import { useAchievementStore } from '~/stores/achievementStore'
import { useAudioStore } from '~/stores/audio'
import { useBookmarkStore } from '~/stores/bookmarkStore'
import { useDeviceStore } from '~/stores/deviceStore'
import { useHypnoStore } from '~/stores/hypnoStore'
import { useLibraryStore } from '~/stores/libraryStore'
import { useMotionStore } from '~/stores/motionStore'
import { usePlaybackStore } from '~/stores/playbackStore'
import { usePlayerStore } from '~/stores/playerStore'
import { usePlaylistStore } from '~/stores/playlistStore'
import { usePluginStore } from '~/stores/pluginStore'
import { useProgrammeStore } from '~/stores/programmeStore'
import { useSafetyStore } from '~/stores/safetyStore'
import { useScriptPatternStore } from '~/stores/scriptPatternStore'
import { useStatsStore } from '~/stores/statsStore'
import { useThemeStore } from '~/stores/themeStore'
import { useUiStore } from '~/stores/uiStore'
import { achievementCounts, bestMoment, countMoment, markMoment } from './achievementEvents'
import { useButtplug } from './useButtplug'
import { useEstim } from './useEstim'
import { useGamepadStatus } from './useGamepadStatus'
import { useHandy } from './useHandy'
import { heartRate } from './useHeartRate'
import { usePopout } from './usePopout'
import { useRemoteStatus } from './useRemoteStatus'
import { useRules } from './useRules'

/**
 * Checks the achievements (lib/achievements) against what playhound knows,
 * a few seconds after anything changes, and notes the moments the stats
 * don't keep (a device connected, panic pressed, the VR view used) as they
 * happen. Started once by the shell.
 */

let started = false
let factsNow: (() => Omit<AchievementFacts, 'earned'>) | null = null

/** The facts as they stand, for the gallery's progress bars; null before the start. */
export function currentAchievementFacts(): AchievementFacts | null {
  if (!factsNow)
    return null
  const store = useAchievementStore()
  return { ...factsNow(), earned: store.earnedCount }
}

export function startAchievements() {
  if (started)
    return
  started = true
  effectScope(true).run(setup)
}

function setup() {
  const store = useAchievementStore()
  const stats = useStatsStore()
  const library = useLibraryStore()
  const playlists = usePlaylistStore()
  const bookmarks = useBookmarkStore()
  const patterns = useScriptPatternStore()
  const programmes = useProgrammeStore()
  const plugins = usePluginStore()
  const player = usePlayerStore()
  const playback = usePlaybackStore()
  const device = useDeviceStore()
  const motion = useMotionStore()
  const safety = useSafetyStore()
  const theme = useThemeStore()
  const hypno = useHypnoStore()
  const ui = useUiStore()
  const audio = useAudioStore()
  const rules = useRules()
  const bp = useButtplug()
  const handy = useHandy()
  const estim = useEstim()
  const gamepad = useGamepadStatus()
  const remote = useRemoteStatus()
  const popout = usePopout()

  function facts(): Omit<AchievementFacts, 'earned'> {
    const per = Object.values(stats.stats)
    const sessions = stats.history.sessions
    const finishedVideos = per.filter(s => s.finishEvents.length > 0).length
    const days = Object.entries(stats.daily).filter(([, d]) => d.plays > 0 || d.ms > 60_000).map(([k]) => k)
    const videos = library.videos
    return {
      watchMs: per.reduce((n, s) => n + (s.totalWatchedMs || 0), 0),
      plays: per.reduce((n, s) => n + (s.totalPlays || 0), 0),
      videosPlayed: per.filter(s => s.totalPlays > 0).length,
      mostPlays: per.reduce((n, s) => Math.max(n, s.totalPlays || 0), 0),
      finishes: per.reduce((n, s) => n + s.finishEvents.length, 0),
      videosFinished: finishedVideos,
      edges: per.reduce((n, s) => n + (s.edgeEvents?.length ?? 0), 0),
      ...sessionFacts(sessions),
      ...dayFacts(days),
      library: {
        videos: videos.length,
        scripted: videos.filter(v => v.hasScript).length,
        multiAxis: videos.filter(v => v.scriptType === 'multi' || v.scriptType === 'merged').length,
        starred: videos.filter(v => v.starred).length,
        tagged: videos.filter(v => (v.userMeta?.tags?.length ?? 0) > 0).length,
      },
      // Favorites is always there; only the user's own count.
      playlists: playlists.playlists.filter(p => p.id !== 'favorites').length,
      biggestPlaylist: playlists.playlists.reduce((n, p) => Math.max(n, p.entries.length), 0),
      bookmarks: bookmarks.bookmarks.length,
      patterns: patterns.saved.length,
      rules: rules.config.value.rules.filter(r => !r.id.startsWith('tpl-')).length,
      programmes: programmes.userProgrammes.length,
      plugins: plugins.plugins.length,
      counters: { ...achievementCounts },
    }
  }

  factsNow = facts

  function check() {
    const earned = new Set(Object.keys(store.saved.unlocked))
    store.earn(newlyEarned(facts(), earned))
  }

  // Whatever the facts are made of; a few seconds after it settles, check.
  const signature = computed(() => [
    stats.history.sessions.length,
    stats.history.sessions.at(-1)?.end,
    Object.keys(stats.stats).length,
    Object.keys(stats.daily).length,
    library.videos.length,
    playlists.playlists.length,
    bookmarks.bookmarks.length,
    patterns.saved.length,
    rules.config.value.rules.length,
    programmes.userProgrammes.length,
    plugins.plugins.length,
    JSON.stringify(achievementCounts),
  ].join('|'))
  watchDebounced(signature, check, { debounce: 3000, maxWait: 15_000 })
  // Once at the start, after the library and the stats have had a moment.
  setTimeout(check, 5000)
  // Library counts (stars, tags) change in place; a slow look now and then catches them.
  setInterval(check, 5 * 60_000)

  // ─── Moments ───────────────────────────────────────────────────────────
  const playing = computed(() => player.isPlaying && !!player.videoUrl)

  // The VR view, once per video looked around.
  const vrSeen = new Set<string>()
  watch(() => playing.value && player.sbs180 && !player.audioOnly ? player.videoPath : null, (v) => {
    if (v && !vrSeen.has(v)) {
      vrSeen.add(v)
      countMoment('vr-view')
    }
  })
  watch(() => playing.value && player.playbackSpeed >= 1.5, on => on && markMoment('speed-fast'))
  watch(() => playing.value && player.playbackSpeed <= 0.5, on => on && markMoment('speed-slow'))
  watch(() => playing.value && player.loopActive, on => on && markMoment('loop'))
  watch(() => playing.value && player.audioOnly, on => on && markMoment('audio'))
  watch(() => {
    const url = player.videoUrl ?? ''
    return playing.value && (!!playback.currentEntry?.remote || (/^https?:/.test(url) && !isNativeMediaUrl(url)))
  }, on => on && markMoment('stream'))
  watch(() => player.isFullscreen, on => on && markMoment('fullscreen'))
  watch(() => popout.active.value, on => on && markMoment('popout'))
  watch(() => playing.value && motion.axisLinks.some(l => l.on), on => on && markMoment('linked'))
  watch(() => playing.value && motion.source === 'music', on => on && markMoment('music-source'))
  watch(() => safety.panicked, on => on && safety.cause === 'hand' && countMoment('panic'))
  watch(() => theme.current, () => markMoment('theme'))
  watch(() => hypno.enabled, on => on && markMoment('hypno'))
  watch(() => audio.isPlaying.value, on => on && markMoment('binaural'))
  watch(() => ui.view, (v) => {
    if (v === 'slideshow')
      markMoment('slideshow')
    if (v === 'wall')
      markMoment('wall')
  })
  watch(() => programmes.status !== 'idle', on => on && countMoment('programme'))
  watch(() => motion.gamepadEnabled && gamepad.connected.value, on => on && markMoment('gamepad'))
  watch(() => remote.peers.value.remotes > 0, on => on && markMoment('remote'))

  // Devices, and how many at once.
  const tcode = computed(() => device.serialUp || device.netUp)
  watch(() => device.serialUp, on => on && markMoment('device:tcode'))
  watch(() => device.netUp, (on) => {
    if (on) {
      markMoment('device:tcode')
      markMoment('device:tcode-net')
    }
  })
  watch(() => handy.connected.value, on => on && markMoment('device:handy'))
  watch(() => bp.connected.value, on => on && markMoment('device:intiface'))
  watch(() => playing.value && bp.strengthToys.value.length > 0 && bp.enabled.value, on => on && markMoment('device:toy'))
  watch(() => estim.running.value, on => on && markMoment('device:estim'))
  watch(() => heartRate.status === 'connected', on => on && markMoment('device:heart'))
  watch(() => (tcode.value ? 1 : 0) + (handy.connected.value ? 1 : 0) + bp.devices.value.length + (heartRate.status === 'connected' ? 1 : 0), n => bestMoment('devices-max', n))
}
