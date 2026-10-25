import type { VideoEntry } from './libraryStore'
import type { LiveEdges, Location, PhaseBounds, Programme, ProgrammePhase, RunShape } from '~/lib/programme'
import type { ReelClip, ReelSource } from '~/lib/reel'
import { useLocalStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed, ref, shallowRef, watch } from 'vue'
import { useAutoDirector } from '~/composables/useAutoDirector'
import { useBinauralBeats } from '~/composables/useBinauralBeats'
import { useScriptPulse } from '~/composables/useScriptPulse'
import { useSessionEngine } from '~/composables/useSessionEngine'
import { toast } from '~/composables/useToast'
import { storage } from '~/lib/browserApi'
import { buildIndex, cancelIndex, indexRecord, indexRevision, indexState } from '~/lib/chapterIndex'
import { chaptersForScript } from '~/lib/chapters'
import { EDGE_FALL_SEC } from '~/lib/edging'
import { KEYS } from '~/lib/persist'
import {
  cloneProgramme,
  edgeCount,
  KIND_SESSION_PHASE,
  liveEdgeState,
  locate,
  normaliseProgramme,
  phaseCeiling,
  runShape,
  shapeAt,
  shapeBreaks,
  slew,
  switchPoint,
  TEMPLATES,
} from '~/lib/programme'
import { clipSeconds, cutSoon, guessCreator, lengthen, planReel, poolSize, retime } from '~/lib/reel'
import { useAudioStore } from './audio'
import { useLibraryStore } from './libraryStore'
import { useMotionStore } from './motionStore'
import { usePlaybackStore } from './playbackStore'
import { usePlayerStore } from './playerStore'
import { useSafetyStore } from './safetyStore'
import { useScriptStore } from './scriptStore'
import { useSessionControlStore } from './sessionControlStore'

export type RunStatus = 'idle' | 'running' | 'paused' | 'stopping'
/** How the run chooses what plays: chapter clips, or whole videos via the director. */
export type RunMode = 'reel' | 'videos'

/** One video (or clip) that played during a run, and when. */
export interface PlanEntry {
  phase: number
  /** Programme seconds when it started. */
  at: number
  name: string
  basename: string
  /** Set for reel clips: the window that played, video seconds. */
  clip?: { start: number, end: number, chapter: string }
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

/** A reel needs at least this much to choose from; with less it plays whole videos. */
export const MIN_POOL_VIDEOS = 6
export const MIN_POOL_CHAPTERS = 20
/** "Keep this one longer". */
export const KEEP_LONGER_SEC = 60
/** Start getting the next clip ready this long before the cut. */
const PREPARE_AHEAD_SEC = 20
/** Within this of the cut a timer takes over from timeupdate, so the cut lands on its stroke bottom. */
const PRECISE_SEC = 2
/** Plan and reality further apart than this at a switch: replan rather than shift. */
const DRIFT_REPLAN_SEC = 20
/** …or a next clip this far off what the arc now wants (an edge pass ran long). */
const TARGET_REPLAN = 0.12
/** A load that has not reached its clip after this long is given up on. */
const SWITCH_TIMEOUT_MS = 10_000

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

function primaryScript(v: VideoEntry): File | null {
  return (v.scriptMatches.find(m => !m.isAlt) ?? v.scriptMatches[0])?.file ?? null
}

const newSeed = () => Math.floor(Math.random() * 2 ** 31)

/**
 * Runs a programme: one clock that drives session intensity along a planned
 * arc, chooses what plays to suit the same arc, and applies per-phase sound
 * and motion limits.
 *
 * What plays is a highlight reel when the chapter index has enough to choose
 * from: chapters of many videos back to back, planned ahead (lib/reel) and
 * switched at clean cut points as each clip's end comes up. Otherwise it
 * falls back to whole videos picked by the director, as before.
 *
 * Edges (the edge button, a heart-rate guard…) feed back in: an edged phase
 * counts real edges rather than running fixed passes — an edge ends the
 * build, the reel cuts to calmer clips for the rest, then the next pass
 * climbs — and anywhere else the arc simply holds while the edge does.
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
  const control = useSessionControlStore()
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

  // ─── Chapter pool ───────────────────────────────────────────────────────────

  /** Every indexed library video, as the reel planner sees it. */
  const pool = computed<ReelSource[]>(() => {
    void indexRevision.value
    const out: ReelSource[] = []
    for (const v of library.videos) {
      if (!v.hasScript)
        continue
      const rec = indexRecord(primaryScript(v))
      if (!rec || !rec.chapters.length)
        continue
      const meta = v.userMeta ?? v.scriptMeta
      const creator = rec.creator ?? meta?.creator ?? null
      out.push({
        video: v.name,
        durationMs: Math.max(rec.durationMs, (v.duration ?? 0) * 1000),
        chapters: rec.chapters,
        cuts: rec.cuts,
        curve: rec.curve,
        tags: [...new Set([...rec.tags, ...(meta?.tags ?? []).map(t => t.toLowerCase())])],
        creator: creator ? creator.toLowerCase() : guessCreator(v.basename),
      })
    }
    return out
  })
  const poolByVideo = computed(() => new Map(pool.value.map(s => [s.video, s])))
  const poolInfo = computed(() => poolSize(pool.value, selected.value.clipSec[0]))
  const scriptedCount = computed(() => library.videos.filter(v => v.hasScript).length)
  const poolReady = computed(() => poolInfo.value.videos >= MIN_POOL_VIDEOS && poolInfo.value.chapters >= MIN_POOL_CHAPTERS)

  let indexWanted = false
  /** Index the library's chapters in the background (idle time, one script at a time). */
  function ensureIndex() {
    indexWanted = true
    const sources = library.videos
      .filter(v => v.hasScript)
      .map(v => ({ name: v.name, script: primaryScript(v), duration: v.duration }))
      .filter((s): s is { name: string, script: File, duration: number | null } => !!s.script)
    if (sources.length)
      void buildIndex(sources, () => playback.loading)
  }
  watch(() => library.loadedAt, () => {
    if (indexWanted)
      ensureIndex()
  })

  // ─── Run state ──────────────────────────────────────────────────────────────

  const status = ref<RunStatus>('idle')
  /** A frozen copy of what is running, so editing the original cannot move the clock. */
  const plan = shallowRef<Programme | null>(null)
  /** Seconds added to each phase by "extend". */
  const extra = ref<number[]>([])
  /** Real edges in each edged phase (null for the rest). */
  const liveEdges = ref<(LiveEdges | null)[]>([])
  /** Programme seconds elapsed (the clock stops while paused, and while an edge holds a plain phase). */
  const elapsed = ref(0)
  /** What the curve asks for now. */
  const target = ref(0)
  /** What was last written to session intensity: the curve, followed at a limited rate. */
  const output = ref(0)
  /** Videos played during the run, in order. */
  const log = ref<PlanEntry[]>([])
  /** Set when the last run reached its end rather than being stopped. */
  const finished = ref(false)
  const mode = ref<RunMode>('videos')

  const active = computed(() => status.value !== 'idle')
  const shape = computed<RunShape | null>(() => plan.value ? runShape(plan.value.phases, extra.value, liveEdges.value, elapsed.value) : null)
  const bounds = computed<PhaseBounds[]>(() => shape.value?.bounds ?? [])
  const total = computed(() => shape.value?.total ?? 0)
  const where = computed<Location | null>(() => bounds.value.length ? locate(bounds.value, elapsed.value) : null)
  const phaseIndex = computed(() => where.value?.index ?? -1)
  const currentPhase = computed<ProgrammePhase | null>(() => plan.value?.phases[phaseIndex.value] ?? null)
  /** Where an edged phase is: pass, of, and whether it is climbing, holding or resting. */
  const edgeState = computed(() => {
    const lp = shape.value?.live[phaseIndex.value]
    const loc = where.value
    if (!lp || !loc)
      return null
    const s = liveEdgeState(lp, loc.inPhase)
    if (!s)
      return null
    return { ...s, waiting: s.kind === 'hold' && lp.dueAt !== null, edged: liveEdges.value[phaseIndex.value]?.at.length ?? 0 }
  })

  /**
   * While Follow script is actually writing intensity, writing it as well
   * would just fight; the plan then steers the director only.
   */
  const scriptOwnsIntensity = computed(() => pulse.canDrive.value && audio.scriptDriveIntensity.value)

  // ─── Reel state ─────────────────────────────────────────────────────────────

  /** The planned clips: the run's while one is going, otherwise a preview of the selection. */
  const reel = shallowRef<ReelClip[]>([])
  /** Which programme `reel` was planned for. */
  const reelFor = ref<string | null>(null)
  const clipIndex = ref(-1)
  const seed = ref(newSeed())
  /** The pool ran short and the plan repeats itself somewhere. */
  const shortfall = ref(false)
  /** The user took the current video elsewhere (seeked away, played something else); the reel waits. */
  const offReel = ref(false)
  /** Chapters skipped by hand, not to come back this run. */
  let skipped = new Set<string>()

  const currentClip = computed(() => reel.value[clipIndex.value] ?? null)
  const clipProgress = computed(() => {
    const c = currentClip.value
    if (!c || mode.value !== 'reel')
      return 0
    return Math.min(1, Math.max(0, (player.currentTime - c.start) / Math.max(1, clipSeconds(c))))
  })
  /** The selected programme will play as a reel (or would, if started now). */
  const canReel = computed(() => selected.value.reel && poolReady.value)

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
  /** Set while we load a clip, so the track change is not taken for the user's. */
  let selfLoad = false
  /** When the current clip's load started (performance.now()), until it reaches its window. */
  let switchingSince = 0
  let advancing = false
  let cutTimer: ReturnType<typeof setTimeout> | null = null
  const prepared = new Set<string>()
  let lastTotal = 0
  /** Last video time seen, to tell a seek from playback. */
  let lastT = 0

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

  /** Calm after an edge before the next pass climbs: the edge's own fall and hold, and half its rebuild. */
  function restSec() {
    const s = control.settings
    return EDGE_FALL_SEC + s.cooldownSec + s.rebuildSec * 0.5
  }

  function freshLive(p: Programme): (LiveEdges | null)[] {
    return p.phases.map(ph => (edgeCount(ph) > 1 ? { at: [], restSec: restSec() } : null))
  }

  /** The selected programme's arc as a run would start it, for the preview. */
  const previewShape = computed(() => runShape(selected.value.phases, [], freshLive(selected.value), 0))

  // ─── Reel planning ──────────────────────────────────────────────────────────

  function planFrom(sh: RunShape, from: number, opts: { history?: ReelClip[], fixed?: ReelClip[], salt?: number, to?: number }) {
    const p = plan.value && active.value ? plan.value : selected.value
    return planReel(pool.value, {
      from,
      to: opts.to ?? sh.total,
      target: t => shapeAt(sh, t),
      breaks: shapeBreaks(sh),
    }, {
      seed: seed.value + (opts.salt ?? 0),
      minSec: p.clipSec[0],
      maxSec: p.clipSec[1],
      exclude: skipped,
      fixed: opts.fixed,
      history: opts.history,
    })
  }

  /** Replace everything from clip `k` on, starting at programme time `at`. Locked clips stay. */
  function replanFrom(k: number, at: number) {
    const sh = shape.value
    if (!sh)
      return
    const keep = reel.value.slice(0, k)
    const fixed = reel.value.slice(k).filter(c => c.locked)
    const res = planFrom(sh, at, { history: keep, fixed, salt: k })
    reel.value = [...keep, ...res.clips]
    shortfall.value = res.shortfall
    lastTotal = sh.total
  }

  /** The preview for the selected programme, when nothing is running. */
  function planPreview() {
    // A finished run stays on show (what played) until another programme is picked.
    if (active.value || (finished.value && plan.value?.id === selected.value.id && reelFor.value === null))
      return
    const p = selected.value
    if (!p.reel || !poolReady.value) {
      reel.value = []
      reelFor.value = null
      shortfall.value = false
      return
    }
    // Locks survive a reshuffle of the same programme, not a change of programme.
    const fixed = reelFor.value === p.id ? reel.value.filter(c => c.locked) : []
    if (reelFor.value !== p.id)
      skipped = new Set()
    const res = planFrom(previewShape.value, 0, { fixed })
    reel.value = res.clips
    reelFor.value = p.id
    clipIndex.value = -1
    shortfall.value = res.shortfall
  }

  let previewTimer: ReturnType<typeof setTimeout> | null = null
  function schedulePreview() {
    if (previewTimer)
      clearTimeout(previewTimer)
    previewTimer = setTimeout(() => {
      previewTimer = null
      planPreview()
    }, 250)
  }
  watch([() => JSON.stringify(selected.value), pool, () => control.settings.cooldownSec, () => control.settings.rebuildSec], () => {
    if (!active.value)
      schedulePreview()
  })

  /** New seed: reshuffle what has not played yet (locked clips stay). */
  function regenerate() {
    seed.value = newSeed()
    if (active.value && mode.value === 'reel') {
      const cur = currentClip.value
      const from = cur ? cur.at + clipSeconds(cur) : elapsed.value
      replanFrom(clipIndex.value + 1, from)
    }
    else {
      planPreview()
    }
  }

  function toggleLock(id: string) {
    reel.value = reel.value.map(c => (c.id === id ? { ...c, locked: !c.locked } : c))
  }

  /** Drop a clip that has not played and fill its slot with something else. */
  function skipClip(id: string) {
    const k = reel.value.findIndex(c => c.id === id)
    if (k < 0)
      return
    const clip = reel.value[k]
    skipped.add(clip.key)
    if (k === clipIndex.value && mode.value === 'reel' && active.value) {
      void advance()
      return
    }
    if (k < clipIndex.value)
      return
    const sh = active.value ? shape.value : previewShape.value
    if (!sh)
      return
    const before = reel.value.slice(0, k)
    const after = reel.value.slice(k + 1)
    const fill = planFrom(sh, clip.at, {
      history: before,
      to: clip.at + clipSeconds(clip),
      salt: k + 1000,
    })
    // Keep later clips out of the fill, so the slot does not borrow from further on.
    const later = new Set(after.map(c => c.key))
    const clips = fill.clips.filter(c => !later.has(c.key))
    const next = [...before, ...clips, ...after]
    reel.value = retime(next, k + clips.length, clips.length ? clips[clips.length - 1].at + clipSeconds(clips[clips.length - 1]) : clip.at)
  }

  // ─── Reel playback ──────────────────────────────────────────────────────────

  function clearCutTimer() {
    if (cutTimer !== null) {
      clearTimeout(cutTimer)
      cutTimer = null
    }
  }

  function entryFor(clip: ReelClip): VideoEntry | null {
    return library.videos.find(v => v.name === clip.video) ?? null
  }

  async function playClip(k: number, attempts = 0): Promise<boolean> {
    clearCutTimer()
    let clip = reel.value[k]
    if (!clip || attempts > 3)
      return false
    // Keep the plan honest about when this one actually starts: a little
    // drift shifts what follows, a lot (an edge pass that ran long, a hold)
    // means the arc wants something else by now.
    const want = shape.value ? shapeAt(shape.value, elapsed.value + clipSeconds(clip) / 2) : clip.target
    if (Math.abs(clip.at - elapsed.value) > DRIFT_REPLAN_SEC || Math.abs(want - clip.target) > TARGET_REPLAN) {
      replanFrom(k, elapsed.value)
      clip = reel.value[k]
      if (!clip)
        return false
    }
    else {
      reel.value = retime(reel.value, k, elapsed.value)
      clip = reel.value[k]
    }
    const entry = entryFor(clip)
    if (!entry) {
      // Gone from the library since it was planned.
      skipped.add(clip.key)
      reel.value = reel.value.filter((_, i) => i !== k)
      return playClip(k, attempts + 1)
    }
    clipIndex.value = k
    offReel.value = false
    switchingSince = performance.now()
    selfLoad = true
    const loading = playback.playAt(entry, clip.start)
    selfLoad = false
    log.value.push({
      phase: Math.max(0, phaseIndex.value),
      at: elapsed.value,
      name: entry.name,
      basename: entry.basename,
      clip: { start: clip.start, end: clip.end, chapter: clip.name },
    })
    await loading
    return true
  }

  /** On to the next clip, now. Null when a switch is already under way. */
  async function advance(): Promise<boolean | null> {
    if (advancing)
      return null
    if (mode.value !== 'reel' || !active.value)
      return false
    advancing = true
    try {
      if (clipIndex.value + 1 >= reel.value.length)
        replanFrom(reel.value.length, elapsed.value)
      return await playClip(clipIndex.value + 1)
    }
    finally {
      advancing = false
    }
  }

  /** Next clip, from the transport's Next or a video that ended. Back on the reel if the user had wandered off. */
  async function nextClip(): Promise<boolean> {
    return (await advance()) !== false
  }

  /** Get the next clip's video ready while this one plays: resolve it, warm its scripts. */
  function prepareNext() {
    const next = reel.value[clipIndex.value + 1]
    if (!next || prepared.has(next.id))
      return
    prepared.add(next.id)
    const entry = entryFor(next)
    if (!entry) {
      skipped.add(next.key)
      replanFrom(clipIndex.value + 1, next.at)
      return
    }
    // Reading the scripts now puts them in the OS cache, so parsing at the switch is quick.
    for (const m of entry.scriptMatches)
      void m.file.text().catch(() => {})
  }

  /** End the current clip at the next clean cut (an edge, a skipped phase) and replan what follows. */
  function cutAndReplan(withinSec = 4) {
    const clip = currentClip.value
    if (mode.value !== 'reel' || !clip)
      return
    const src = poolByVideo.value.get(clip.video)
    const now = player.currentTime
    const end = src ? cutSoon(src, now, withinSec) : now
    if (end < clip.end) {
      const list = [...reel.value]
      list[clipIndex.value] = { ...clip, end: Math.max(clip.start + 1, end) }
      reel.value = list
    }
    replanFrom(clipIndex.value + 1, elapsed.value + Math.max(0, end - now))
  }

  /** "Keep this one longer": stretch the current clip and move the rest along. */
  function keepLonger(seconds = KEEP_LONGER_SEC) {
    const clip = currentClip.value
    if (mode.value !== 'reel' || !clip)
      return
    const src = poolByVideo.value.get(clip.video)
    const longer = src ? lengthen(clip, src, seconds) : clip
    if (longer === clip) {
      toast('Nothing more in this video', { icon: 'i-carbon-time', key: 'programme-longer' })
      return
    }
    const list = [...reel.value]
    list[clipIndex.value] = longer
    reel.value = list
    replanFrom(clipIndex.value + 1, elapsed.value + Math.max(0, longer.end - player.currentTime))
    toast(`Staying ${Math.round(longer.end - clip.end)} s longer`, { icon: 'i-carbon-time', key: 'programme-longer' })
  }

  // Follow the clip as it plays: get the next one ready, and cut on time.
  watch(() => player.currentTime, (t) => {
    if (mode.value !== 'reel' || status.value !== 'running' || offReel.value)
      return
    const clip = currentClip.value
    if (!clip)
      return
    const prev = lastT
    lastT = t
    if (switchingSince) {
      // Loading: currentTime reads 0 until the seek to the clip lands.
      if (t >= clip.start - 1 && t <= clip.end)
        switchingSince = 0
      else if (performance.now() - switchingSince > SWITCH_TIMEOUT_MS)
        switchingSince = 0
      return
    }
    if (Math.abs(t - prev) > 3 && (t < clip.start - 1 || t > clip.end)) {
      // Sought away from the clip: the video is the user's until it ends or they press Next.
      offReel.value = true
      clearCutTimer()
      return
    }
    const left = clip.end - t
    if (left <= 0.05) {
      void advance().then((ok) => {
        // Nothing left to cut to (the very end): stop following this video.
        if (ok === false && status.value === 'running')
          offReel.value = true
      })
      return
    }
    if (left < PREPARE_AHEAD_SEC)
      prepareNext()
    if (left < PRECISE_SEC && player.isPlaying) {
      clearCutTimer()
      const at = clip.id
      cutTimer = setTimeout(() => {
        cutTimer = null
        if (currentClip.value?.id === at && status.value === 'running' && player.isPlaying && !offReel.value)
          void advance()
      }, Math.max(0, (left / Math.max(0.1, player.playbackSpeed)) * 1000))
    }
  })

  // ─── Edges ──────────────────────────────────────────────────────────────────

  watch(() => control.edges.length, (n, old) => {
    if (n <= (old ?? 0) || status.value !== 'running')
      return
    // Our own timed retreat is already accounted for.
    if (control.edges[n - 1]?.source === 'programme')
      return
    onEdge()
  })

  /**
   * An edge was called. In an edged phase it ends the pass in progress (or,
   * called again while resting, restarts the rest) and the reel cuts to
   * calmer clips; anywhere else the clock holds while the edge does (see tick).
   */
  function onEdge() {
    const i = phaseIndex.value
    const l = liveEdges.value[i]
    const lp = shape.value?.live[i]
    const loc = where.value
    if (!l || !lp || lp.of <= 1 || !loc)
      return
    const now = loc.inPhase
    const resting = lp.pass >= lp.of || (now < lp.passStart && l.at.length > 0)
    const at = resting ? [...l.at.slice(0, -1), now] : [...l.at, now]
    liveEdges.value = liveEdges.value.map((x, j) => (j === i ? { ...l, at } : x))
    if (!resting) {
      toast(`Edge ${at.length} of ${lp.of}`, {
        detail: at.length < lp.of ? 'Easing off, then building again' : 'Last pass done',
        icon: 'i-carbon-roadmap',
        key: 'programme-edge',
      })
    }
    cutAndReplan()
  }

  let timedEdge = false

  /** Close phases that are over, and let a pass nobody edged retreat on its own. */
  function liveTick() {
    const sh = shape.value
    const loc = where.value
    if (!sh || !loc)
      return
    let changed = false
    const next = liveEdges.value.map((l, j) => {
      if (!l || l.closedAt !== undefined)
        return l
      if (j < loc.index) {
        changed = true
        return { ...l, closedAt: sh.bounds[j].dur }
      }
      const lp = sh.live[j]
      if (j === loc.index && lp && lp.dueAt !== null && loc.inPhase >= lp.dueAt) {
        changed = true
        timedEdge = true
        return { ...l, at: [...l.at, lp.dueAt] }
      }
      return l
    })
    if (!changed)
      return
    liveEdges.value = next
    if (timedEdge) {
      timedEdge = false
      // Everything else backs off with it, as for a real edge.
      control.edge('programme', { videoTime: player.currentTime, videoName: player.videoPath })
      cutAndReplan()
    }
  }

  // ─── Whole videos (fallback) ────────────────────────────────────────────────

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

  // ─── Clock ──────────────────────────────────────────────────────────────────

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
      detail: `Phase ${i + 1} of ${plan.value!.phases.length} · ${Math.round(bounds.value[i].dur / 60)} min${edgeCount(p) > 1 ? ` · ${edgeCount(p)} edges` : ''}`,
      icon: 'i-carbon-roadmap',
      key: 'programme-phase',
    })
    if (mode.value === 'videos' && plan.value!.video === 'phase')
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

    // An edge outside an edged phase holds the arc where it is until the hold
    // is over, so it does not keep climbing while you back off. (Edged phases
    // have the rest built into their passes.)
    control.tick()
    const holding = (control.phase === 'falling' || control.phase === 'holding') && !shape.value?.live[phaseIndex.value]
    if (!holding)
      elapsed.value += dt

    const loc = where.value!
    if (loc.done) {
      finished.value = true
      beginStop()
      return
    }
    liveTick()
    // Steer first: entering a phase may change video, and the pick should
    // suit the phase being entered, not the end of the last one.
    target.value = shapeAt(shape.value!, elapsed.value)
    if (mode.value === 'videos')
      director.steer.value = target.value
    if (loc.index !== enteredPhase)
      enterPhase(loc.index, true)
    writeIntensity(slew(output.value, target.value, FOLLOW_PER_SEC, dt))

    if (mode.value === 'videos' && plan.value.video === 'interval')
      intervalTick(plan.value.everyMin * 60)

    // A pass waiting on an edge pushes everything after it back; move the
    // planned clips with it so the times shown stay true.
    if (mode.value === 'reel') {
      const t = total.value
      if (lastTotal && Math.abs(t - lastTotal) >= 1) {
        reel.value = retime(reel.value, clipIndex.value + 1, (reel.value[clipIndex.value + 1]?.at ?? 0) + (t - lastTotal))
        lastTotal = t
      }
    }
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
    liveEdges.value = freshLive(clean)
    elapsed.value = 0
    log.value = []
    finished.value = false
    lastSwitchAt = 0
    switchAtVideoTime = null
    enteredPhase = -1
    userCeiling = motion.maxSpm
    writtenCeiling = null
    pausedVideo = false
    offReel.value = false
    prepared.clear()
    mode.value = clean.reel && poolReady.value && pool.value.length ? 'reel' : 'videos'

    target.value = shapeAt(shape.value!, 0)
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

    if (mode.value === 'reel') {
      director.steer.value = null
      // Use the preview the user has been looking at (locks, skips and all).
      if (reelFor.value !== p.id || !reel.value.length) {
        skipped = new Set()
        reel.value = []
        replanFrom(0, 0)
      }
      else {
        reel.value = reel.value.map(c => ({ ...c }))
      }
      reelFor.value = p.id
      clipIndex.value = -1
      lastTotal = total.value
      playback.setTakeover({ label: 'Programme', next: nextClip })
      void playClip(0)
    }
    else {
      director.steer.value = target.value
      if (player.videoUrl) {
        logCurrent()
      }
      else {
        // Open on something that suits the first phase, when there is something analysed.
        const pick = director.pickNext()
        if (pick)
          void playback.play(pick)
      }
    }

    toast(`${clean.name} started`, {
      detail: `${clean.phases.length} phases · ${Math.round(total.value / 60)} min${mode.value === 'reel' ? ` · ${reel.value.length} clips` : ''}`,
      icon: 'i-carbon-roadmap',
      key: 'programme',
    })
  }

  function pause() {
    if (status.value !== 'running')
      return
    status.value = 'paused'
    clearCutTimer()
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
    const i = phaseIndex.value
    const next = bounds.value[i + 1]
    if (!next) {
      stop()
      return
    }
    const l = liveEdges.value[i]
    if (l && where.value) {
      // An edged phase ends where it is; its length is what it ran.
      const at = where.value.inPhase
      liveEdges.value = liveEdges.value.map((x, j) => (j === i ? { ...l, closedAt: Math.max(1, at) } : x))
      elapsed.value = (shape.value?.bounds[i + 1]?.start ?? next.start)
    }
    else {
      elapsed.value = next.start
    }
    if (status.value === 'running')
      tick()
    cutAndReplan(3)
  }

  function extendPhase(seconds = EXTEND_SECONDS) {
    const i = phaseIndex.value
    if (i < 0 || (status.value !== 'running' && status.value !== 'paused'))
      return
    const next = [...extra.value]
    next[i] = (next[i] ?? 0) + seconds
    extra.value = next
    if (mode.value === 'reel') {
      const cur = currentClip.value
      replanFrom(clipIndex.value + 1, cur ? cur.at + clipSeconds(cur) : elapsed.value)
    }
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
    clearCutTimer()
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
    clearCutTimer()
    status.value = 'idle'
    director.steer.value = null
    if (playback.takeover?.label === 'Programme')
      playback.setTakeover(null)
    restoreCeiling()
    output.value = 0
    target.value = 0
    enteredPhase = -1
    switchingSince = 0
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
    // The next start plans afresh rather than replaying this reel.
    reelFor.value = null
    if (!finished.value)
      schedulePreview()
  }

  // ─── What played ────────────────────────────────────────────────────────────

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

  // Sync, so our own clip loads can be told apart from the user's.
  watch(() => playback.trackSeq, () => {
    if (status.value !== 'running' && status.value !== 'paused')
      return
    if (mode.value === 'reel') {
      if (selfLoad)
        return
      // Something else was played by hand: let it play, rejoin the reel after.
      offReel.value = true
      clearCutTimer()
      logCurrent()
      return
    }
    // Any change — the director at the end of a video, or a hand on Next —
    // restarts the interval, so it never cuts a video that just began.
    lastSwitchAt = elapsed.value
    switchAtVideoTime = null
    logCurrent()
  }, { flush: 'sync' })

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
    // chapter index
    pool,
    poolInfo,
    poolReady,
    scriptedCount,
    indexState,
    ensureIndex,
    cancelIndex,
    // run
    status,
    active,
    mode,
    plan,
    extra,
    liveEdges,
    elapsed,
    target,
    output,
    log,
    finished,
    shape,
    previewShape,
    bounds,
    total,
    where,
    phaseIndex,
    currentPhase,
    edgeState,
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
    // reel
    reel,
    reelFor,
    clipIndex,
    currentClip,
    clipProgress,
    canReel,
    shortfall,
    offReel,
    regenerate,
    toggleLock,
    skipClip,
    nextClip,
    keepLonger,
    planPreview,
  }
})
