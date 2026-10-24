import type { Location, PhaseBounds, Programme, ProgrammePhase } from '~/lib/programme'
import { useLocalStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed, ref, shallowRef, watch } from 'vue'
import { useAutoDirector } from '~/composables/useAutoDirector'
import { useBinauralBeats } from '~/composables/useBinauralBeats'
import { useScriptPulse } from '~/composables/useScriptPulse'
import { useSessionEngine } from '~/composables/useSessionEngine'
import { toast } from '~/composables/useToast'
import { storage } from '~/lib/browserApi'
import { chaptersForScript } from '~/lib/chapters'
import { KEYS } from '~/lib/persist'
import {
  cloneProgramme,
  intensityAt,
  KIND_SESSION_PHASE,
  locate,
  normaliseProgramme,
  phaseCeiling,
  slew,
  switchPoint,
  TEMPLATES,
  timeline,
} from '~/lib/programme'
import { useAudioStore } from './audio'
import { useLibraryStore } from './libraryStore'
import { useMotionStore } from './motionStore'
import { usePlaybackStore } from './playbackStore'
import { usePlayerStore } from './playerStore'
import { useSafetyStore } from './safetyStore'
import { useScriptStore } from './scriptStore'

export type RunStatus = 'idle' | 'running' | 'paused' | 'stopping'

/** One video that played during a run, and when. */
export interface PlanEntry {
  phase: number
  /** Programme seconds when it started. */
  at: number
  name: string
  basename: string
}

/** How often the programme clock ticks. The motion engine ramps between ticks anyway. */
const TICK_MS = 250
/**
 * How fast the written intensity may follow the curve, per second. A phase
 * boundary can step the curve (a cool-down that starts below the peak); this
 * turns the step into a glide of a few seconds.
 */
const FOLLOW_PER_SEC = 0.05
/** How fast a stop eases intensity down, per second: from the top in ~12 s. */
const STOP_PER_SEC = 0.08
/** Below this a stop counts as settled. */
const SETTLED = 0.02
const EXTEND_SECONDS = 5 * 60
/** An interval change waits this long, at most, for the script's next chapter break. */
const CHAPTER_WAIT = 90

interface Saved {
  version: 1
  user: Programme[]
  selected: string
  /**
   * The motion ceiling to put back if a run was cut off (reload, crash) while
   * a phase had it lowered — the lowered value was persisted with the rest of
   * the motion settings.
   */
  restoreCeiling: number | null
}

/**
 * Runs a programme: one clock that drives session intensity along a planned
 * arc, steers the director's video choice to the same arc, and applies
 * per-phase sound and motion limits.
 *
 * It does not run the session engine's own timers — those choose their own
 * random phase lengths — but borrows its phase application (beat, noise, LFO)
 * through `applyPhase`, and owns `sessionActive` while it runs so everything
 * that follows a session (pulse, generated motion, hypno, the director panel)
 * follows the programme.
 */
export const useProgrammeStore = defineStore('programme', () => {
  const audio = useAudioStore()
  const motion = useMotionStore()
  const player = usePlayerStore()
  const playback = usePlaybackStore()
  const library = useLibraryStore()
  const safety = useSafetyStore()
  const scripts = useScriptStore()
  const director = useAutoDirector()
  const session = useSessionEngine()
  const binaural = useBinauralBeats()
  const pulse = useScriptPulse()

  // ─── Library of programmes ──────────────────────────────────────────────────

  const saved = useLocalStorage<Saved>(
    KEYS.programmes.key,
    { version: 1, user: [], selected: TEMPLATES[1].id, restoreCeiling: null },
    { mergeDefaults: true },
  )
  saved.value.user = (Array.isArray(saved.value.user) ? saved.value.user : [])
    .map(normaliseProgramme)
    .filter((p): p is Programme => !!p)

  // A run that never got to put the ceiling back.
  if (typeof saved.value.restoreCeiling === 'number') {
    if (motion.maxSpm < saved.value.restoreCeiling)
      motion.maxSpm = saved.value.restoreCeiling
    saved.value.restoreCeiling = null
  }

  const userProgrammes = computed(() => saved.value.user)
  const all = computed(() => [...TEMPLATES, ...saved.value.user])
  const selectedId = computed({
    get: () => saved.value.selected,
    set: (id: string) => { saved.value.selected = id },
  })
  const selected = computed(() => all.value.find(p => p.id === saved.value.selected) ?? TEMPLATES[1])

  function save(p: Programme) {
    const clean = normaliseProgramme(p)
    if (!clean)
      return null
    const i = saved.value.user.findIndex(u => u.id === clean.id)
    if (i >= 0)
      saved.value.user.splice(i, 1, clean)
    else
      saved.value.user.push(clean)
    saved.value.selected = clean.id
    return clean
  }

  function duplicate(p: Programme, name?: string) {
    return save(cloneProgramme(p, name))
  }

  function remove(id: string) {
    const i = saved.value.user.findIndex(u => u.id === id)
    if (i < 0)
      return
    saved.value.user.splice(i, 1)
    if (saved.value.selected === id)
      saved.value.selected = TEMPLATES[1].id
  }

  // ─── Run state ──────────────────────────────────────────────────────────────

  const status = ref<RunStatus>('idle')
  /** A frozen copy of what is running, so editing the original cannot move the clock. */
  const plan = shallowRef<Programme | null>(null)
  /** Seconds added to each phase by "extend". */
  const extra = ref<number[]>([])
  /** Programme seconds elapsed (the clock stops while paused). */
  const elapsed = ref(0)
  /** What the curve asks for now. */
  const target = ref(0)
  /** What was last written to session intensity: the curve, followed at a limited rate. */
  const output = ref(0)
  /** Videos played during the run, in order. */
  const log = ref<PlanEntry[]>([])
  /** Set when the last run reached its end rather than being stopped. */
  const finished = ref(false)

  const active = computed(() => status.value !== 'idle')
  const bounds = computed<PhaseBounds[]>(() => plan.value ? timeline(plan.value.phases, extra.value) : [])
  const total = computed(() => bounds.value.length ? bounds.value[bounds.value.length - 1].end : 0)
  const where = computed<Location | null>(() => bounds.value.length ? locate(bounds.value, elapsed.value) : null)
  const phaseIndex = computed(() => where.value?.index ?? -1)
  const currentPhase = computed<ProgrammePhase | null>(() => plan.value?.phases[phaseIndex.value] ?? null)

  /**
   * While Follow script is actually writing intensity, writing it as well
   * would just fight; the plan then steers the director only.
   */
  const scriptOwnsIntensity = computed(() => pulse.canDrive.value && audio.scriptDriveIntensity.value)

  let timer: ReturnType<typeof setInterval> | null = null
  let lastTs = 0
  let enteredPhase = -1
  /** Programme time of the last video change, for the interval mode. */
  let lastSwitchAt = 0
  /** Video time of the chapter break an interval change is waiting for. */
  let switchAtVideoTime: number | null = null
  /** The user's own motion ceiling, before any phase lowered it. */
  let userCeiling = 0
  /** The last ceiling written, so a change made by hand in the Motion panel is noticed. */
  let writtenCeiling: number | null = null
  let startedTone = false
  let pausedVideo = false
  /** Our own call to stopSession must not read as the user ending the run. */
  let selfStoppingSession = false

  function writeIntensity(v: number) {
    output.value = v
    if (!scriptOwnsIntensity.value)
      audio.intensity.value = v
  }

  function applyCeiling(cap: number | null) {
    const want = phaseCeiling(userCeiling, cap)
    if (want === motion.maxSpm)
      return
    motion.maxSpm = want
    writtenCeiling = want
    saved.value.restoreCeiling = want < userCeiling ? userCeiling : null
  }

  function restoreCeiling() {
    // Only undo our own write; a ceiling changed by hand mid-run stands.
    if (writtenCeiling !== null && motion.maxSpm === writtenCeiling)
      motion.maxSpm = userCeiling
    writtenCeiling = null
    saved.value.restoreCeiling = null
  }

  // A ceiling set by hand while a phase holds it becomes the new ceiling.
  watch(() => motion.maxSpm, (v) => {
    if (!active.value || v === writtenCeiling)
      return
    userCeiling = v
    writtenCeiling = null
    saved.value.restoreCeiling = null
  })

  function switchVideo() {
    // Only move on from something that is playing; never start a video the
    // user has paused or closed. The interval restarts either way, so
    // un-pausing does not immediately cut to something else.
    lastSwitchAt = elapsed.value
    switchAtVideoTime = null
    if (!library.hasVideos || !player.videoUrl || !player.isPlaying)
      return
    void playback.next()
  }

  function enterPhase(i: number, announce: boolean) {
    const p = plan.value?.phases[i]
    if (!p)
      return
    enteredPhase = i
    session.applyPhase(KIND_SESSION_PHASE[p.kind], { beatRange: p.beat ?? undefined })
    applyCeiling(p.capSpm)
    if (!announce)
      return
    toast(p.name, {
      detail: `Phase ${i + 1} of ${plan.value!.phases.length} · ${Math.round(bounds.value[i].dur / 60)} min`,
      icon: 'i-carbon-roadmap',
      key: 'programme-phase',
    })
    if (plan.value!.video === 'phase')
      switchVideo()
  }

  function tick() {
    const now = performance.now()
    const dt = Math.max(0, (now - lastTs) / 1000)
    lastTs = now

    if (status.value === 'stopping') {
      writeIntensity(slew(output.value, 0, STOP_PER_SEC, dt))
      if (output.value <= SETTLED)
        finish()
      return
    }
    if (status.value !== 'running' || !plan.value)
      return

    elapsed.value += dt
    const loc = where.value!
    if (loc.done) {
      finished.value = true
      beginStop()
      return
    }
    // Steer first: entering a phase may change video, and the pick should
    // suit the phase being entered, not the end of the last one.
    target.value = intensityAt(plan.value.phases, elapsed.value, extra.value)
    director.steer.value = target.value
    if (loc.index !== enteredPhase)
      enterPhase(loc.index, true)
    writeIntensity(slew(output.value, target.value, FOLLOW_PER_SEC, dt))

    if (plan.value.video === 'interval')
      intervalTick(plan.value.everyMin * 60)
  }

  /**
   * Due for a change: at the script's next chapter break if one is close,
   * otherwise now. Never later than CHAPTER_WAIT past due, whatever the
   * video does meanwhile (a seek back would otherwise postpone it forever).
   */
  function intervalTick(every: number) {
    const since = elapsed.value - lastSwitchAt
    if (since < every)
      return
    if (switchAtVideoTime === null) {
      const chapters = chaptersForScript(scripts.primaryScript, player.videoDuration)
      const breaks = chapters.slice(1).map(c => c.start / 1000)
      const at = switchPoint(player.currentTime, breaks, CHAPTER_WAIT)
      if (at > player.currentTime) {
        switchAtVideoTime = at
        return
      }
      switchVideo()
      return
    }
    if (player.currentTime >= switchAtVideoTime || since >= every + CHAPTER_WAIT)
      switchVideo()
  }

  function startClock() {
    stopClock()
    lastTs = performance.now()
    timer = setInterval(tick, TICK_MS)
  }

  function stopClock() {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  // ─── Controls ───────────────────────────────────────────────────────────────

  function start(p: Programme = selected.value) {
    if (active.value)
      return
    if (safety.panicked) {
      toast.warn('Panic is on', { detail: 'Resume first, then start the programme.', key: 'programme' })
      return
    }
    const clean = normaliseProgramme(p)
    if (!clean)
      return

    // The engine's own session runs on its own clock; this one replaces it.
    if (session.isRunning()) {
      selfStoppingSession = true
      session.stopSession()
      selfStoppingSession = false
    }

    plan.value = { ...clean, id: p.id, builtin: p.builtin }
    extra.value = clean.phases.map(() => 0)
    elapsed.value = 0
    log.value = []
    finished.value = false
    lastSwitchAt = 0
    switchAtVideoTime = null
    enteredPhase = -1
    userCeiling = motion.maxSpm
    writtenCeiling = null
    pausedVideo = false

    target.value = intensityAt(clean.phases, 0)
    director.steer.value = target.value
    writeIntensity(target.value)

    if (clean.tone && !audio.isPlaying.value) {
      binaural.start(audio.baseFrequency.value, audio.beatDelta.value, audio.volume.value, audio.waveType.value)
      audio.isPlaying.value = true
      startedTone = true
    }
    else {
      startedTone = false
    }

    audio.sessionActive.value = true
    status.value = 'running'
    enterPhase(0, false)
    startClock()

    if (player.videoUrl) {
      logCurrent()
    }
    else {
      // Open on something that suits the first phase, when there is something analysed.
      const pick = director.pickNext()
      if (pick)
        void playback.play(pick)
    }

    toast(`${clean.name} started`, {
      detail: `${clean.phases.length} phases · ${Math.round(total.value / 60)} min`,
      icon: 'i-carbon-roadmap',
      key: 'programme',
    })
  }

  function pause() {
    if (status.value !== 'running')
      return
    status.value = 'paused'
    if (player.isPlaying) {
      playback.pause()
      pausedVideo = true
    }
  }

  function resume() {
    if (status.value !== 'paused')
      return
    if (safety.panicked)
      return
    status.value = 'running'
    lastTs = performance.now()
    if (pausedVideo)
      playback.resume()
    pausedVideo = false
  }

  /** Jump to the start of the next phase; from the last one, wind down. */
  function skipPhase() {
    if (!plan.value || (status.value !== 'running' && status.value !== 'paused'))
      return
    const next = bounds.value[phaseIndex.value + 1]
    if (!next) {
      stop()
      return
    }
    elapsed.value = next.start
    if (status.value === 'running')
      tick()
  }

  function extendPhase(seconds = EXTEND_SECONDS) {
    const i = phaseIndex.value
    if (i < 0 || (status.value !== 'running' && status.value !== 'paused'))
      return
    const next = [...extra.value]
    next[i] = (next[i] ?? 0) + seconds
    extra.value = next
  }

  /** Ease down rather than drop: the device and the tone follow intensity on their ramps. */
  function stop() {
    if (status.value === 'running' || status.value === 'paused')
      beginStop()
  }

  function beginStop() {
    // A video paused by the programme stays paused; stopping is not a cue to play.
    pausedVideo = false
    status.value = 'stopping'
    director.steer.value = null
    target.value = 0
    // Nothing of ours to ease while the script holds intensity.
    if (scriptOwnsIntensity.value) {
      finish()
      return
    }
    if (timer === null)
      startClock()
  }

  /** Immediate end, for panic and for a session started or ended elsewhere. */
  function halt(reason?: string) {
    if (!active.value)
      return
    finish()
    if (reason)
      toast(reason, { icon: 'i-carbon-roadmap', key: 'programme' })
  }

  function finish() {
    stopClock()
    status.value = 'idle'
    director.steer.value = null
    restoreCeiling()
    output.value = 0
    target.value = 0
    enteredPhase = -1
    if (audio.sessionActive.value) {
      audio.sessionActive.value = false
      audio.phase.value = 'idle'
      // Same as the engine's own end: nothing downstream should run off a stale value.
      audio.intensity.value = 0
    }
    if (startedTone && audio.isPlaying.value && !safety.panicked) {
      audio.isPlaying.value = false
      binaural.fadeOut(3)
    }
    startedTone = false
    if (finished.value)
      toast.success('Programme complete', { detail: plan.value?.name, icon: 'i-carbon-roadmap', key: 'programme' })
  }

  // ─── Video plan ─────────────────────────────────────────────────────────────

  function logCurrent() {
    const path = player.videoPath
    if (!path)
      return
    const entry = playback.currentEntry
    log.value.push({
      phase: Math.max(0, phaseIndex.value),
      at: elapsed.value,
      name: entry?.name ?? path,
      basename: entry?.basename ?? path.replace(/\.[^.]+$/, ''),
    })
  }

  watch(() => playback.trackSeq, () => {
    if (status.value !== 'running' && status.value !== 'paused')
      return
    // Any change — the director at the end of a video, or a hand on Next —
    // restarts the interval, so it never cuts a video that just began.
    lastSwitchAt = elapsed.value
    switchAtVideoTime = null
    logCurrent()
  })

  // ─── Things that end a run from outside ─────────────────────────────────────

  watch(() => safety.panicked, (p) => {
    if (p)
      halt('Programme stopped by panic')
  })

  session.on('sessionStart', () => halt('Programme ended — a session was started in Binaural'))
  session.on('sessionStop', () => {
    if (!selfStoppingSession)
      halt('Programme ended')
  })

  // A reload ends the run; put the ceiling back on the way out so a lowered
  // one is not left persisted with the motion settings.
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => {
      if (!active.value || writtenCeiling === null || motion.maxSpm !== writtenCeiling)
        return
      motion.maxSpm = userCeiling
      storage.set(KEYS.motionConfig.key, motion.serialize())
      saved.value.restoreCeiling = null
      storage.set(KEYS.programmes.key, saved.value)
    })
  }

  return {
    // library
    all,
    userProgrammes,
    selectedId,
    selected,
    save,
    duplicate,
    remove,
    // run
    status,
    active,
    plan,
    extra,
    elapsed,
    target,
    output,
    log,
    finished,
    bounds,
    total,
    where,
    phaseIndex,
    currentPhase,
    scriptOwnsIntensity,
    scriptIntensity: pulse.scriptIntensity,
    scriptLive: pulse.canDrive,
    start,
    pause,
    resume,
    skipPhase,
    extendPhase,
    stop,
    halt,
  }
})
