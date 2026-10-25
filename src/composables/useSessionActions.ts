import type { EdgeSource } from '~/stores/sessionControlStore'
import { computed, ref } from 'vue'
import { chaptersForScript } from '~/lib/chapters'
import { nextPeak as findNextPeak, finishChapter } from '~/lib/peakJump'
import { formatTime } from '~/lib/time'
import { usePlaybackStore } from '~/stores/playbackStore'
import { usePlayerStore } from '~/stores/playerStore'
import { useSessionControlStore } from '~/stores/sessionControlStore'
import { useUiStore } from '~/stores/uiStore'
import { useScriptAnalysis } from './useScriptAnalysis'
import { toast } from './useToast'

/** One knob step from a key, a d-pad press or the phone. */
export const KNOB_STEP = 0.05

export interface SessionNotice {
  icon: string
  text: string
  sub?: string
  /** 0–1, drawn as a bar. */
  level?: number
  key: number
}

/**
 * The latest thing worth telling the viewer about. The player shows it as its
 * OSD (it is the only thing visible in fullscreen); everywhere else it is a
 * toast. Shared so whichever surface is showing can pick it up.
 */
export const sessionNotice = ref<SessionNotice | null>(null)
let noticeSeq = 0

/**
 * The in-the-moment session controls, in one place for every input — keys,
 * gamepad, phone, dock buttons — so they all behave and report the same way.
 */
export function useSessionActions() {
  const ctl = useSessionControlStore()
  const player = usePlayerStore()
  const playback = usePlaybackStore()
  const ui = useUiStore()
  const { analysis, source } = useScriptAnalysis()

  const chapters = computed(() => chaptersForScript(source.value, player.videoDuration, analysis.value?.peaks, playback.scriptMetadata))
  const videoName = computed(() => player.videoPath?.split(/[\\/]/).pop() ?? null)

  function notify(n: Omit<SessionNotice, 'key'>, toastKey: string) {
    sessionNotice.value = { ...n, key: ++noticeSeq }
    // The player draws it over the video; off the player, say it as a toast.
    if (!(ui.onPlayer || player.isFullscreen) || !player.videoUrl)
      toast(n.text, { detail: n.sub, icon: n.icon, key: toastKey })
  }

  function edge(source: EdgeSource) {
    ctl.edge(source, {
      videoTime: player.videoUrl ? player.currentTime : null,
      videoName: videoName.value,
    })
  }

  function release() {
    ctl.release()
  }

  function nudgeIntensity(delta: number) {
    ctl.nudgeIntensity(delta)
    notify({
      icon: 'i-carbon-meter-alt',
      text: `${Math.round(ctl.intensityScale * 100)}%`,
      sub: 'Intensity',
      level: ctl.intensityScale,
    }, 'intensity')
  }

  function seekTo(ms: number) {
    playback.seek(ms / 1000)
  }

  function nextPeak() {
    if (!player.videoUrl)
      return
    if (chapters.value.length < 2) {
      notify({ icon: 'i-carbon-fire', text: 'No peaks', sub: source.value ? 'The script has no chapters' : 'No script' }, 'peak')
      return
    }
    const jump = findNextPeak(chapters.value, player.currentTime * 1000)
    if (!jump) {
      notify({ icon: 'i-carbon-fire', text: 'No more peaks' }, 'peak')
      return
    }
    seekTo(jump.chapter.start)
    notify({
      icon: 'i-carbon-fire',
      text: jump.chapter.name,
      sub: `${jump.wrapped ? 'From the top · ' : ''}${formatTime(jump.chapter.start / 1000, '0:00')}`,
    }, 'peak')
  }

  function finish() {
    if (!player.videoUrl)
      return
    const c = finishChapter(chapters.value)
    if (!c) {
      notify({ icon: 'i-carbon-flag-filled', text: 'Nothing to finish on', sub: source.value ? 'The script has no chapters' : 'No script' }, 'peak')
      return
    }
    seekTo(c.start)
    notify({ icon: 'i-carbon-flag-filled', text: 'Finish', sub: `${c.name} · ${formatTime(c.start / 1000, '0:00')}` }, 'peak')
  }

  return { edge, release, nudgeIntensity, nextPeak, finish, chapters }
}
