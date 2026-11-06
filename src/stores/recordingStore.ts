import type { VideoEntry } from './libraryStore'
import type { SaveTarget } from '~/lib/funscriptSave'
import type { AxisModel, RecordedAxis, Take } from '~/lib/recording'
import { defineStore } from 'pinia'
import { computed, ref, shallowRef, watch } from 'vue'
import { useAnyDevice } from '~/composables/useAnyDevice'
import { setAxisTap } from '~/composables/useTCode'
import { toast } from '~/composables/useToast'
import { syncedVideo, useDeviceLatency } from '~/composables/useVideoSync'
import { cancelFrame, requestFrame } from '~/lib/frames'
import { namesIn, saveScripts } from '~/lib/funscriptSave'
import { clampLatency } from '~/lib/latency'
import { cleanBase, createAxisModel, createTake, defaultBase, fileNameFor, funscriptText } from '~/lib/recording'
import { createSteadyClock } from '~/lib/steadyClock'
import { motionFilters } from '~/plugins/filters'
import { useAudioStore } from './audio'
import { useDeviceStore } from './deviceStore'
import { useLibraryStore } from './libraryStore'
import { useMotionStore } from './motionStore'
import { usePlaybackStore } from './playbackStore'
import { usePlayerStore } from './playerStore'
import { useProgrammeStore } from './programmeStore'
import { useSafetyStore } from './safetyStore'
import { useScriptStore } from './scriptStore'
import { useSessionControlStore } from './sessionControlStore'

/**
 * Session recording: what the device did, saved as funscripts.
 *
 * Positions come from useTCode's tap (see lib/recording), sampled every frame
 * at most every SAMPLE_MS, so whatever drives the device is caught: the
 * generators, plugins through them, the knob and edges on a script, derived
 * axes, panic's homing.
 *
 * Timing:
 * - With a video loaded (and no programme switching videos), times are the
 *   video's, so the file plays back in step with it. Only playing time is
 *   recorded: while paused or seeking nothing is, so a pause leaves no gap.
 *   A seek starts a new stretch; recording over a part again replaces it.
 *   Times are shifted by the device latency, to when the device got there,
 *   which is what playback with the same latency then reproduces.
 * - Otherwise, times run from the start of the recording.
 */

/** About 60 Hz on a 60 Hz screen, about 50 on a faster one. */
const SAMPLE_MS = 15
/** Video time jumping forward further than this between samples is a seek. */
const SEEK_GAP_MS = 1000

export type StopReason = 'user' | 'panic' | 'device' | 'session' | 'video'

const REASON_NOTE: Record<StopReason, string | null> = {
  user: null,
  panic: 'Stopped by panic',
  device: 'Stopped: the device disconnected',
  session: 'Stopped: the session ended',
  video: 'Stopped: the video changed',
}

export interface PendingTake {
  axes: RecordedAxis[]
  /** Time recorded, ms (playing time only, for a video). */
  lengthMs: number
  points: number
  mode: 'video' | 'free'
  /** The video's file name, in video mode. */
  video: string | null
  note: string | null
  /** Nothing but the loaded script playing as written. */
  plainReplay: boolean
  /** Where it goes; null while that is being looked up. */
  target: SaveTarget | null
  /** Names already there, lower-cased. */
  existing: Set<string>
  /** The suggested name, without .funscript. */
  base: string
  /** For the funscript's metadata: the video's length, or the take's. */
  durationMs: number
}

export const useRecordingStore = defineStore('recording', () => {
  const player = usePlayerStore()
  const playback = usePlaybackStore()
  const library = useLibraryStore()
  const scripts = useScriptStore()
  const motion = useMotionStore()
  const control = useSessionControlStore()
  const device = useDeviceStore()
  const safety = useSafetyStore()
  const audio = useAudioStore()
  const programme = useProgrammeStore()
  const anyDevice = useAnyDevice()
  const latency = useDeviceLatency()

  const recording = ref(false)
  const mode = ref<'video' | 'free'>('free')
  /** Whole seconds since it started, for the indicator. */
  const elapsed = ref(0)
  const pending = shallowRef<PendingTake | null>(null)
  const saving = ref(false)
  /** The save sheet: up once stopped, but never over the panic cover. */
  const sheetOpen = computed(() => !!pending.value && !safety.panicked)

  let take: Take | null = null
  const models = new Map<string, AxisModel>()
  const clock = createSteadyClock()
  let raf = 0
  let startedAt = 0
  let lastSample = 0
  let novel = 0
  let entry: VideoEntry | null = null
  let videoName: string | null = null
  let sessionAtStart = false

  function onCommand(channel: string, pos: number, intervalMs: number) {
    let m = models.get(channel)
    if (!m)
      models.set(channel, m = createAxisModel())
    m.command(pos, intervalMs, performance.now())
  }

  /** The loaded script playing as written: recording it adds nothing. */
  function plainReplay() {
    return scripts.activeScripts.length > 0 && player.isPlaying && !motionFilters.active()
      && control.intensityScale >= 0.999 && control.holdBack < 0.001 && !motion.synthEnabled
  }

  function frame(now: number) {
    raf = requestFrame(frame)
    elapsed.value = Math.floor((now - startedAt) / 1000)
    if (now - lastSample < SAMPLE_MS || !take)
      return
    lastSample = now
    // Only axes switched on in the Device panel: the others did not move anything.
    const values: [string, number][] = []
    for (const [ch, m] of models) {
      if (device.axisConfigs[ch]?.enabled)
        values.push([ch, m.at(now)])
    }
    if (!values.length)
      return
    let t: number
    if (mode.value === 'video') {
      const el = syncedVideo()
      if (!el || el.paused || el.seeking || el.ended || el.readyState < 3) {
        clock.reset()
        return
      }
      const rate = el.playbackRate || 1
      t = clock.read(el.currentTime * 1000, now, rate, true) + clampLatency(latency.value) * rate
    }
    else {
      t = now - startedAt
    }
    take.add(t, values)
    if (!plainReplay())
      novel++
  }

  function start() {
    if (recording.value)
      return
    // A take not yet saved or discarded is still waiting on the sheet.
    if (pending.value) {
      toast('Save or discard the last recording first', { icon: 'i-carbon-recording', key: 'rec' })
      return
    }
    // A programme changes videos as it goes, so its recording is on its own clock.
    mode.value = player.videoPath && programme.status === 'idle' ? 'video' : 'free'
    entry = mode.value === 'video' ? playback.currentEntry : null
    videoName = mode.value === 'video' ? (player.videoPath?.split(/[\\/]/).pop() ?? null) : null
    sessionAtStart = audio.sessionActive.value || programme.status !== 'idle'
    take = createTake({ gapMs: mode.value === 'video' ? SEEK_GAP_MS : Infinity })
    models.clear()
    clock.reset()
    novel = 0
    startedAt = performance.now()
    lastSample = 0
    elapsed.value = 0
    setAxisTap(onCommand)
    raf = requestFrame(frame)
    recording.value = true
    toast('Recording', {
      detail: mode.value === 'video' ? 'In time with the video · Shift + C stops' : 'Shift + C stops',
      icon: 'i-carbon-recording-filled',
      key: 'rec',
    })
  }

  function stop(reason: StopReason = 'user') {
    if (!recording.value || !take)
      return
    recording.value = false
    setAxisTap(null)
    cancelFrame(raf)
    raf = 0
    const axes = take.finish()
    const lengthMs = take.recordedMs
    const sampled = take.samples > 0
    take = null
    models.clear()
    if (!axes.length) {
      const why = !sampled && mode.value === 'video' ? 'The video did not play' : 'The device did not move'
      toast('Nothing recorded', { detail: why, icon: 'i-carbon-recording', key: 'rec' })
      return
    }
    const lastAt = Math.max(...axes.map(a => a.actions.at(-1)?.at ?? 0))
    const p: PendingTake = {
      axes,
      lengthMs,
      points: axes.reduce((n, a) => n + a.actions.length, 0),
      mode: mode.value,
      video: videoName,
      note: REASON_NOTE[reason],
      plainReplay: novel === 0,
      target: null,
      existing: new Set(),
      base: '',
      durationMs: mode.value === 'video' ? Math.max(lastAt, player.videoDuration * 1000) : lastAt,
    }
    pending.value = p
    void findTarget(p)
  }

  /** Where the file goes, and what is there already, to suggest a name that replaces nothing. */
  async function findTarget(p: PendingTake) {
    const channels = p.axes.map(a => a.channel)
    const path = p.mode === 'video' ? entry?.path : null
    // A video from outside the library has no folder to save beside.
    const dir = p.mode === 'video' && !path ? null : await library.folderHandleFor(path ?? null)
    let target: SaveTarget
    let existing: Set<string>
    if (dir) {
      target = { kind: 'folder', dir, label: path ? path.split('/').slice(0, -1).join('/') : dir.name }
      existing = await namesIn(dir)
    }
    else {
      target = { kind: 'download', label: 'Downloads' }
      // Not the downloads folder's contents, but what is known to sit beside the video.
      existing = new Set([
        ...(entry?.scriptFiles.map(f => f.name.toLowerCase()) ?? []),
        ...(p.video ? scripts.scripts.map(s => s.filename.toLowerCase()) : []),
      ])
    }
    if (pending.value !== p)
      return
    pending.value = {
      ...p,
      target,
      existing,
      base: defaultBase({ video: p.video, channels, existing, now: new Date() }),
    }
  }

  function toggle() {
    if (recording.value)
      stop()
    else
      start()
  }

  function discard() {
    pending.value = null
  }

  /** The files `name` would write. */
  function filesFor(name: string) {
    const p = pending.value
    if (!p)
      return []
    const base = cleanBase(name) || p.base
    return p.axes.map(a => ({
      name: fileNameFor(base, a.channel),
      text: funscriptText(a.actions, { title: base, durationMs: p.durationMs }),
    }))
  }

  /** Call from a click: writing to a folder may need the browser's permission. */
  async function save(name: string) {
    const p = pending.value
    if (!p?.target || saving.value)
      return
    saving.value = true
    try {
      const files = filesFor(name)
      let target = p.target
      if (target.kind === 'folder') {
        const dir = await library.folderHandleFor(p.mode === 'video' ? entry?.path ?? null : null, true)
        if (dir)
          target = { ...target, dir }
        else
          target = { kind: 'download', label: 'Downloads' }
      }
      await saveScripts(target, files)
      pending.value = null
      toast.success(target.kind === 'folder' ? 'Recording saved' : 'Recording downloaded', {
        detail: files.map(f => f.name).join(', '),
        icon: 'i-carbon-recording',
        key: 'rec',
      })
      // So the library pairs the new script with its video.
      if (target.kind === 'folder')
        void library.rescan()
    }
    catch (err) {
      console.error('Saving the recording failed:', err)
      toast.error('Could not save the recording', { detail: err instanceof Error ? err.message : String(err) })
    }
    finally {
      saving.value = false
    }
  }

  // ─── Stopping by itself ──────────────────────────────────────────────────
  // Panic keeps what was recorded; the sheet waits until the cover is gone.
  watch(() => safety.panicked, p => p && stop('panic'), { flush: 'sync' })
  watch(anyDevice, (on, was) => {
    if (was && !on)
      stop('device')
  })
  watch(() => audio.sessionActive.value || programme.status !== 'idle', (on) => {
    if (!on && sessionAtStart)
      stop('session')
  })
  watch(() => player.videoPath, () => {
    if (mode.value === 'video')
      stop('video')
  })

  return { recording, mode, elapsed, pending, saving, sheetOpen, start, stop, toggle, discard, save, filesFor }
})
