import type { RuleAction, RuleEvent, RuleLogEntry, RuleMemory, RulesConfig, RuleState } from '~/lib/rules'
import type { VideoEntry } from '~/stores/libraryStore'
import { useLocalStorage } from '@vueuse/core'
import { computed, effectScope, ref, watch } from 'vue'
import { sampleEnvelope } from '~/lib/funscriptAnalysis'
import { KEYS } from '~/lib/persist'
import {
  CAUSE_WINDOW_MS,
  defaultRulesConfig,
  describeAction,
  emptyMemory,
  evaluate,
  intensityTarget,
  MIN_INTENSITY_PCT,
  MOTION_SOURCE_NAMES,
  normaliseRulesConfig,
  pushLog,
  RAMP_PER_SEC,
  rampStep,
} from '~/lib/rules'
import { momentIntensity, speedDistribution } from '~/lib/scriptIntensity'
import { summaryFor, tagSet } from '~/lib/tags'
import { useAudioStore } from '~/stores/audio'
import { useHypnoStore } from '~/stores/hypnoStore'
import { useLibraryStore } from '~/stores/libraryStore'
import { useMotionStore } from '~/stores/motionStore'
import { usePlaybackStore } from '~/stores/playbackStore'
import { usePlayerStore } from '~/stores/playerStore'
import { useSafetyStore } from '~/stores/safetyStore'
import { useSessionControlStore } from '~/stores/sessionControlStore'
import { useStatsStore } from '~/stores/statsStore'
import { useAutoDirector } from './useAutoDirector'
import { useBinauralBeats } from './useBinauralBeats'
import { sayOnFaceScreen } from './useFaceScreen'
import { heartRate } from './useHeartRate'
import { useScriptAnalysis } from './useScriptAnalysis'
import { useSessionActions } from './useSessionActions'
import { useSessionEngine } from './useSessionEngine'

/**
 * Runs the rules from the Rules panel against the live session.
 *
 * The deciding is in ~/lib/rules (pure, tested). This samples the stores
 * twice a second, turns what happens into events, and carries out what fires
 * through the same functions a key press, the phone or a programme use:
 * edges through the session actions, the intensity knob through the session
 * control store, videos through playbackStore. Nothing here touches the speed
 * ceiling or turns generated motion on, and in a panic nothing runs at all.
 *
 * Started once by the shell; the panel reads the same state.
 */

const STEP_MS = 500
/** Ticks of the intensity ramp. */
const RAMP_TICK_MS = 100

const config = useLocalStorage<RulesConfig>(KEYS.rules.key, defaultRulesConfig(), {
  serializer: {
    read: (v) => {
      try {
        return normaliseRulesConfig(JSON.parse(v))
      }
      catch {
        return defaultRulesConfig()
      }
    },
    write: v => JSON.stringify(v),
  },
})

const log = ref<RuleLogEntry[]>([])
/** Firings since the app started. */
const firedCount = ref(0)
/** When each rule last fired, for the panel. */
const lastFired = ref<Record<string, number>>({})

const SOURCE_WORDS: Record<string, string> = {
  key: 'key',
  gamepad: 'gamepad',
  remote: 'phone',
  heart: 'heart rate',
  programme: 'programme',
  ui: 'button',
  rule: 'rule',
}

let started = false
let tryRule: (id: string) => void = () => {}

function addLog(entry: Omit<RuleLogEntry, 'at'>) {
  log.value = pushLog(log.value, { at: Date.now(), ...entry })
}

function start() {
  if (started)
    return
  started = true

  effectScope(true).run(() => {
    const ctl = useSessionControlStore()
    const player = usePlayerStore()
    const playback = usePlaybackStore()
    const library = useLibraryStore()
    const motion = useMotionStore()
    const hypno = useHypnoStore()
    const safety = useSafetyStore()
    const stats = useStatsStore()
    const audio = useAudioStore()
    const director = useAutoDirector()
    const binaural = useBinauralBeats()
    const engine = useSessionEngine()
    const actions = useSessionActions()
    const { analysis, source } = useScriptAnalysis()

    let memory: RuleMemory = emptyMemory()
    let pending: RuleEvent[] = []
    /** The rule whose action ran last, while what it did may still be arriving as events. */
    let cause: { id: string, until: number } | null = null

    function causedBy(): string | null {
      return cause && Date.now() < cause.until ? cause.id : null
    }

    // ─── What the session looks like now ─────────────────────────────────────

    const distributions = new WeakMap<object, Float64Array>()
    function scriptLevel(): number | null {
      const a = analysis.value
      const s = source.value
      if (!a || !s || !a.envelope.length)
        return null
      const sample = sampleEnvelope(a.envelope, player.currentTime * 1000 + (s.offsetMs ?? 0))
      if (!sample)
        return null
      let sorted = distributions.get(a)
      if (!sorted) {
        sorted = speedDistribution(a.envelope)
        distributions.set(a, sorted)
      }
      return Math.round(momentIntensity(sample.speed, sorted) * 100)
    }

    const summaryOf = (name: string) => director.summaries.value[name]
    function tagsOf(entry: VideoEntry | null): string[] {
      return entry ? [...tagSet(entry, summaryFor(entry, summaryOf))] : []
    }

    function snapshot(): RuleState {
      const now = Date.now()
      const start = stats.sessionStartedAt(now)
      const phase = audio.phase.value
      return {
        now,
        bpm: heartRate.bpm,
        heartRise: heartRate.bpm === null ? null : heartRate.rise,
        phase: phase === 'idle' ? null : phase,
        sessionMinutes: start === null ? null : (now - start) / 60_000,
        intensity: Math.round(ctl.intensityScale * 100),
        script: player.isPlaying ? scriptLevel() : null,
        tags: tagsOf(playback.currentEntry),
        playing: player.isPlaying,
        panicked: safety.panicked,
      }
    }

    // ─── Events ───────────────────────────────────────────────────────────────

    let queued = false
    function push(e: RuleEvent) {
      pending.push(e)
      if (!queued) {
        queued = true
        queueMicrotask(() => {
          queued = false
          step()
        })
      }
    }

    const videoName = () => {
      const p = player.videoPath
      return p ? (p.split(/[\\/]/).pop() ?? p).replace(/\.[^.]+$/, '') : undefined
    }

    watch(audio.phase, (p, was) => {
      if (p !== 'idle' && p !== was)
        push({ kind: 'phase', phase: p, causedBy: causedBy() })
    })

    watch(() => playback.trackSeq, () => {
      push({ kind: 'video-start', detail: videoName(), causedBy: causedBy() })
    })

    // A video that ran to its end: the playhead reached the duration while playing.
    let wasNearEnd = false
    watch(() => [player.currentTime, player.isPlaying, player.videoPath] as const, ([t, playing, path], old) => {
      const dur = player.videoDuration
      const near = !!dur && t >= dur - 0.6
      if (old && path !== old[2]) {
        wasNearEnd = false
        return
      }
      if (near && !wasNearEnd && (playing || old?.[1])) {
        wasNearEnd = true
        push({ kind: 'video-end', detail: videoName(), causedBy: causedBy() })
      }
      else if (!near) {
        wasNearEnd = false
      }
    })

    // Chapters: moving into the next one while playing. Loading a video or
    // seeking about does not count.
    const chapterHere = computed(() => {
      const list = actions.chapters.value
      if (list.length < 2)
        return -1
      const ms = player.currentTime * 1000
      let i = -1
      for (let k = 0; k < list.length && list[k].start <= ms; k++)
        i = k
      return i
    })
    let chapterPath: string | null = null
    watch(chapterHere, (i, was) => {
      const path = player.videoPath
      const sameVideo = path === chapterPath
      chapterPath = path
      if (!sameVideo || !player.isPlaying || i < 0 || i !== was + 1)
        return
      push({ kind: 'chapter', detail: actions.chapters.value[i]?.name, causedBy: causedBy() })
    })

    // Edges arrive through the session control log, whoever called them.
    let edgesSeen = ctl.edges.length
    let edgeRule: { id: string, at: number } | null = null
    watch(() => ctl.edges.length, (n) => {
      if (n < edgesSeen)
        edgesSeen = 0
      for (const e of ctl.edges.slice(edgesSeen, n)) {
        const byRule = e.source === 'rule' && edgeRule && e.at - edgeRule.at < CAUSE_WINDOW_MS ? edgeRule.id : null
        push({ kind: 'edge', detail: SOURCE_WORDS[e.source] ?? e.source, causedBy: byRule })
      }
      edgesSeen = n
    })

    watch(() => ctl.phase, (p, was) => {
      if (p === 'idle' && was !== 'idle')
        push({ kind: 'edge-end', causedBy: causedBy() })
    })

    watch(() => stats.finishSeq, () => push({ kind: 'finish', causedBy: causedBy() }))

    // ─── Intensity ramps ──────────────────────────────────────────────────────

    let ramp: ReturnType<typeof setInterval> | null = null
    let coolTimer: ReturnType<typeof setTimeout> | null = null

    function stopRamp() {
      if (ramp !== null)
        clearInterval(ramp)
      ramp = null
    }

    /**
     * Move the knob to `target` a step at a time. Someone else moving it
     * meanwhile (a key, the phone) takes over: the ramp just stops.
     */
    function startRamp(target: number, perSec = RAMP_PER_SEC, onDone?: () => void) {
      stopRamp()
      let value = ctl.intensityScale
      let written = value
      let t = performance.now()
      ramp = setInterval(() => {
        if (safety.panicked || Math.abs(ctl.intensityScale - written) > 0.001) {
          stopRamp()
          return
        }
        const now = performance.now()
        value = rampStep(value, target, (now - t) / 1000, perSec)
        t = now
        ctl.setIntensityScale(value)
        written = ctl.intensityScale
        if (value === target) {
          stopRamp()
          onDone?.()
        }
      }, RAMP_TICK_MS)
    }

    watch(() => safety.panicked, (p) => {
      if (!p)
        return
      stopRamp()
      if (coolTimer !== null)
        clearTimeout(coolTimer)
      coolTimer = null
      if (config.value.enabled && config.value.rules.some(r => r.enabled))
        addLog({ ruleId: '', name: 'Panic', reason: 'Rules are paused', did: 'Nothing fires until you resume', tone: 'warn' })
    })

    function pct(v: number) {
      return `${Math.round(v * 100)}%`
    }

    function coolDown(seconds: number, name: string): string {
      const floor = MIN_INTENSITY_PCT / 100
      const from = ctl.intensityScale
      const finish = () => {
        if (safety.panicked)
          return
        playback.pause()
        // Generated motion stops the way it always does: depth eases out
        // and the axes go home. A script stops with the video.
        if (motion.enabled && motion.isGenerated)
          motion.enabled = false
        actions.notify({ icon: 'i-carbon-temperature-frigid', text: 'Cooled down', sub: `${name} · intensity left at ${pct(ctl.intensityScale)}` }, 'rule-cool')
      }
      if (seconds <= 0 || from <= floor) {
        ctl.setIntensityScale(Math.min(from, floor))
        finish()
        return 'paused'
      }
      startRamp(floor, Math.max(RAMP_PER_SEC, (from - floor) / seconds), finish)
      return `easing to ${pct(floor)} over ${seconds}s, then pausing`
    }

    function randomTagged(tag: string): VideoEntry | null {
      const current = playback.currentEntry?.name
      const pool = library.videos.filter(v => v.name !== current && tagsOf(v).includes(tag))
      return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null
    }

    // ─── Doing it ─────────────────────────────────────────────────────────────

    function perform(a: RuleAction, ruleId: string, name: string): { did: string, ok: boolean } {
      if (safety.panicked)
        return { did: 'skipped: panic', ok: false }
      switch (a.kind) {
        case 'edge':
          edgeRule = { id: ruleId, at: Date.now() }
          actions.edge('rule')
          return { did: 'edge called', ok: true }
        case 'intensity-set':
        case 'intensity-nudge': {
          const target = intensityTarget(a, ctl.intensityScale)
          if (target === ctl.intensityScale)
            return { did: `intensity already ${pct(target)}`, ok: true }
          startRamp(target, RAMP_PER_SEC, () => actions.notify({
            icon: 'i-carbon-meter-alt',
            text: pct(ctl.intensityScale),
            sub: `Intensity · ${name}`,
            level: ctl.intensityScale,
          }, 'intensity'))
          return { did: `intensity ${pct(ctl.intensityScale)} → ${pct(target)}`, ok: true }
        }
        case 'motion-source': {
          const src = a.source ?? 'funscript'
          motion.source = src
          const label = MOTION_SOURCE_NAMES.find(s => s.value === src)?.label ?? src
          return motion.enabled || src === 'funscript'
            ? { did: `motion from ${label}`, ok: true }
            : { did: `motion from ${label} (generated motion is off, so nothing moves until you start it)`, ok: true }
        }
        case 'next':
          void playback.next()
          return { did: 'next video', ok: true }
        case 'random':
          void playback.random()
          return { did: 'random video', ok: true }
        case 'random-tag': {
          const pick = a.tag ? randomTagged(a.tag) : null
          if (!pick)
            return { did: `no other video tagged "${a.tag}"`, ok: false }
          void playback.play(pick)
          return { did: `playing ${pick.basename}`, ok: true }
        }
        case 'binaural-start':
          if (audio.isPlaying.value)
            return { did: 'binaural already on', ok: true }
          binaural.start(audio.baseFrequency.value, audio.beatDelta.value, audio.volume.value, audio.waveType.value)
          audio.isPlaying.value = true
          return { did: 'binaural on', ok: true }
        case 'binaural-stop':
          if (!audio.isPlaying.value)
            return { did: 'binaural already off', ok: true }
          audio.isPlaying.value = false
          binaural.fadeOut(2)
          if (engine.isRunning())
            engine.stopSession()
          return { did: 'binaural off', ok: true }
        case 'hypno-on':
        case 'hypno-off':
          hypno.enabled = a.kind === 'hypno-on'
          return { did: a.kind === 'hypno-on' ? 'hypno on' : 'hypno off', ok: true }
        case 'cool-down':
          return { did: coolDown(a.value ?? 20, name), ok: true }
        case 'pause':
          playback.pause()
          return { did: 'paused', ok: true }
        case 'toast':
          actions.notify({ icon: 'i-carbon-rule', text: a.text || name, sub: a.text ? name : undefined }, `rule-${ruleId}`)
          return { did: `said "${a.text}"`, ok: true }
        case 'face':
          return sayOnFaceScreen(a.text || name)
            ? { did: `face said "${a.text}"`, ok: true }
            : { did: 'no face window open', ok: false }
      }
    }

    function run(ruleId: string, reason: string) {
      const rule = config.value.rules.find(r => r.id === ruleId)
      if (!rule)
        return
      cause = { id: rule.id, until: Date.now() + CAUSE_WINDOW_MS }
      const results = rule.actions.map(a => perform(a, rule.id, rule.name))
      firedCount.value++
      lastFired.value = { ...lastFired.value, [rule.id]: Date.now() }
      addLog({
        ruleId: rule.id,
        name: rule.name,
        reason,
        did: results.map(r => r.did).join(' · ') || rule.actions.map(describeAction).join(' · '),
        tone: results.every(r => r.ok) ? 'ok' : 'warn',
      })
    }

    function step() {
      const events = pending
      pending = []
      const res = evaluate(config.value, snapshot(), events, memory)
      memory = res.memory
      for (const r of res.capped) {
        addLog({
          ruleId: r.id,
          name: r.name,
          reason: `${config.value.maxPerMinute} rules fired in the last minute`,
          did: 'Held back by the limit',
          tone: 'warn',
        })
      }
      for (const f of res.fired)
        run(f.rule.id, f.reason)
    }

    tryRule = (id: string) => {
      if (safety.panicked) {
        addLog({ ruleId: id, name: config.value.rules.find(r => r.id === id)?.name ?? 'Rule', reason: 'Tried from the panel', did: 'skipped: panic', tone: 'warn' })
        return
      }
      run(id, 'Tried from the panel')
    }

    setInterval(step, STEP_MS)
  })
}

/**
 * Rules, as the Rules panel sees them. The shell calls this once at startup
 * so they run whichever panel is open.
 */
export function useRules() {
  start()
  const safety = useSafetyStore()
  const paused = computed(() => safety.panicked)
  return {
    config,
    log,
    firedCount,
    lastFired,
    paused,
    tryRule: (id: string) => tryRule(id),
    clearLog: () => (log.value = []),
  }
}
