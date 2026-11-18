import type { ButtplugClientDevice } from 'buttplug'
import type { ToyMotor } from './useButtplug'
import type { SendGate, VibeSettings, VibeSource } from '~/lib/vibeMap'
import { computed, effectScope, ref, watch } from 'vue'
import { interpolatePosition } from '~/lib/funscriptParser'
import { clampLatency } from '~/lib/latency'
import { axisOfSource, DEFAULT_VIBE, knownSource, localSpeed, mapVibe, musicLevel, quantize, scriptFastSpeed, scriptSpeedLevel, shouldSend, smoothLevel, strokePulse, VIBE_LEAD_MAX } from '~/lib/vibeMap'
import { motionFilters } from '~/plugins/filters'
import { useAudioStore } from '~/stores/audio'
import { useMotionStore } from '~/stores/motionStore'
import { usePlayerStore } from '~/stores/playerStore'
import { useSafetyStore } from '~/stores/safetyStore'
import { useScriptStore } from '~/stores/scriptStore'
import { useSessionControlStore } from '~/stores/sessionControlStore'
import { useButtplug } from './useButtplug'
import { axisOutput, axisOutputAt } from './useTCode'
import { getBeatGrid } from './useVideoBeat'
import { useDeviceLatency } from './useVideoSync'

/**
 * Drives Buttplug vibrators (and rotators, oscillators) from the session.
 *
 * Each toy follows the source picked for it in the Device panel — script
 * speed by default — through its own range and curve, scaled last by the
 * session's effective intensity so the knob and an edge reach it like they
 * reach everything else. Runs beside the serial OSR: that one takes the
 * script's positions, these take how hard.
 *
 * A video's own vibe script (.vib, channel V0) wins over the stroke script
 * for the script sources. Each toy can lead by its own timing, for the lag
 * of its Bluetooth link, and a toy with several motors can give each its own
 * source (another axis's position, say: rotation from the twist script).
 *
 * Mounted once by the shell; loops only while Intiface is connected, output
 * is on and at least one toy can take a strength.
 */

/** How often levels are worked out. Sending is rate-limited separately. */
const TICK_MS = 50

let started = false
const running = ref(false)
/** The toy being lined up (its index): it buzzes with a click, apart from the session. */
const lineUpToy = ref<number | null>(null)
let startLineUpImpl: (d: ButtplugClientDevice) => void = () => {}
let stopLineUpImpl: () => void = () => {}

/** The playing <video>, for a playhead finer than timeupdate's four a second. */
function findVideo(src: string | null): HTMLVideoElement | null {
  // The player marks its own <video>; with an HLS stream its src is a blob.
  const main = document.querySelector<HTMLVideoElement>('video[data-ph-main]')
  if (main)
    return main
  const all = Array.from(document.querySelectorAll('video'))
  return (src ? all.find(v => v.src === src) : null) ?? null
}

export function useVibeSync() {
  if (!started) {
    started = true
    effectScope(true).run(setup)
  }
  return {
    running,
    lineUpToy,
    /** Click once a second and buzz the toy its timing ahead, to slide the timing until the two land together. */
    startLineUp: (d: ButtplugClientDevice) => startLineUpImpl(d),
    stopLineUp: () => stopLineUpImpl(),
  }
}

function setup() {
  const bp = useButtplug()
  const player = usePlayerStore()
  const scripts = useScriptStore()
  const audio = useAudioStore()
  const motion = useMotionStore()
  const safety = useSafetyStore()
  const session = useSessionControlStore()
  const latencyMs = useDeviceLatency()

  const active = computed(() => bp.connected.value && bp.enabled.value && bp.strengthToys.value.length > 0)

  /** The stroke script: L0 when there is one, else whatever is primary. */
  const stroke = computed(() =>
    scripts.activeScripts.find(s => s.channel === 'L0') ?? scripts.primaryScript ?? null)
  /** That script's own "fast" (scriptFastSpeed), measured once per script. */
  const fastSpeed = computed(() => {
    const actions = stroke.value?.parsed.actions
    return actions ? scriptFastSpeed(actions) : null
  })

  let video: HTMLVideoElement | null = null
  function playheadMs(): number {
    if (!video?.isConnected || (!video.hasAttribute('data-ph-main') && video.src !== player.videoUrl))
      video = findVideo(player.videoUrl)
    const t = video ? video.currentTime : player.currentTime
    return t * 1000
  }

  /** The video's own vibe script (.vib, V0), which the script sources follow when there is one. */
  const vibScript = computed(() => scripts.activeScripts.find(s => s.channel === 'V0' && s.parsed.actions.length) ?? null)

  /** A script's time at the playhead, with its offset, the latency the OSR gets and the toy's own lead. */
  function scriptTimeMs(s: { offsetMs?: number, parsed: { actions: unknown[] } } | null, leadMs: number): number | null {
    if (!s || !s.parsed.actions.length)
      return null
    const speed = video?.playbackRate || player.playbackSpeed || 1
    return playheadMs() + (s.offsetMs ?? 0) + (clampLatency(latencyMs.value) + leadMs) * speed
  }

  /**
   * One source's level, 0–1, or null when it has stopped (paused, nothing
   * loaded, session off) — null snaps the toy off rather than easing down.
   * `leadMs` reads a script that much ahead (the toy's timing).
   */
  function sample(source: VibeSource, leadMs = 0): number | null {
    const axis = axisOfSource(source)
    if (axis) {
      // What the axis is sent (script, linked, filled or generated), while anything moves.
      if (!(player.isPlaying || motion.running))
        return null
      const at = axisOutputAt[axis]
      return at !== undefined && performance.now() - at < 1000 ? axisOutput[axis] ?? null : null
    }
    switch (source) {
      case 'script-speed':
      case 'script-position': {
        if (!player.isPlaying)
          return null
        // Written for vibrators: it says exactly how hard, so it wins.
        const vib = vibScript.value
        if (vib) {
          const tv = scriptTimeMs(vib, leadMs)
          return tv === null ? null : interpolatePosition(vib.parsed.actions, tv)
        }
        const t = scriptTimeMs(stroke.value, leadMs)
        const actions = stroke.value?.parsed.actions
        if (t === null || !actions)
          return null
        // Plugins' motion filters reshape positions, so a toy following the
        // script's position follows the filtered one; its speed is the script's own.
        return source === 'script-speed'
          ? scriptSpeedLevel(localSpeed(actions, t), fastSpeed.value)
          : motionFilters.apply(interpolatePosition(actions, t), 'L0', t)
      }
      case 'music': {
        if (!player.isPlaying)
          return null
        const g = getBeatGrid()
        return g ? musicLevel(g.energy, g.beats - Math.floor(g.beats)) : null
      }
      case 'session':
        return audio.sessionActive.value || audio.isPlaying.value ? audio.intensity.value : null
      case 'motion':
        return motion.running ? (axisOutput.L0 ?? null) : null
      default:
        return null
    }
  }

  /** Per toy (its index) or per motor (`${index}:${feature}`): the smoothed level and what was last sent. */
  const state = new Map<number | string, { smooth: number, gate: SendGate }>()
  let timer: ReturnType<typeof setInterval> | null = null
  let lastTick = 0

  function stateOf(key: number | string) {
    let st = state.get(key)
    if (!st) {
      st = { smooth: 0, gate: { value: null, at: 0 } }
      state.set(key, st)
    }
    return st
  }

  function send(d: ButtplugClientDevice, v: number, now: number) {
    const st = state.get(d.index)
    if (st)
      st.gate = { value: v, at: now }
    void bp.sendStrength(d, v).catch(() => {})
  }

  /** A toy's motors with the source each follows, or none when they all follow the toy's. */
  function ownMotors(d: ButtplugClientDevice, cfg: VibeSettings): { motor: ToyMotor, source: VibeSource }[] {
    const picked = cfg.motors
    if (!picked || !Object.keys(picked).length)
      return []
    const motors = bp.motorsOf(d)
    if (motors.length < 2)
      return []
    const out = motors.map(m => ({ motor: m, source: knownSource(picked[String(m.feature)]) ?? cfg.source }))
    return out.some(m => m.source !== cfg.source) ? out : []
  }

  function tick() {
    const now = performance.now()
    const dt = lastTick ? Math.min(250, now - lastTick) : TICK_MS
    lastTick = now
    const intensity = session.effectiveIntensity
    const cache = new Map<string, number | null>()
    const sampled = (source: VibeSource, lead: number) => {
      const key = `${source}|${lead}`
      if (!cache.has(key))
        cache.set(key, sample(source, lead))
      return cache.get(key) ?? null
    }

    /** One source through the toy's lead, stroke pulse, range and smoothing: what to send. */
    const level = (key: number | string, source: VibeSource, cfg: VibeSettings) => {
      const st = stateOf(key)
      const lead = Math.max(0, Math.min(VIBE_LEAD_MAX, cfg.leadMs ?? 0))
      let v: number | null = safety.panicked ? null : sampled(source, lead)
      // Script speed with each stroke felt: the level dips toward the top of
      // every stroke. It has to fall within a stroke, so it eases off quicker.
      // (Not with a vibe script: that already says how hard.)
      const pulse = source === 'script-speed' && !vibScript.value ? (cfg.pulse ?? DEFAULT_VIBE.pulse ?? 0) : 0
      if (v !== null && pulse > 0) {
        const pos = sampled('script-position', lead)
        if (pos !== null)
          v = strokePulse(v, pos, pulse)
      }
      if (v === null) {
        st.smooth = 0
      }
      else {
        const target = mapVibe(v, cfg, intensity)
        st.smooth = pulse > 0 ? smoothLevel(st.smooth, target, dt, 30, 60) : smoothLevel(st.smooth, target, dt)
      }
      const out = quantize(st.smooth)
      return { st, out: out < 0.01 ? 0 : out }
    }

    for (const d of bp.strengthToys.value) {
      if (lineUpToy.value === d.index)
        continue
      const cfg = bp.vibeFor(d)
      const motors = ownMotors(d, cfg)
      if (!motors.length) {
        const { st, out } = level(d.index, cfg.source, cfg)
        if (shouldSend(st.gate, out, now))
          send(d, out, now)
        continue
      }
      // Each motor its own source; the toy's meter shows the strongest.
      let top = 0
      for (const { motor, source } of motors) {
        const { st, out } = level(`${d.index}:${motor.feature}`, source, cfg)
        top = Math.max(top, out)
        if (shouldSend(st.gate, out, now)) {
          st.gate = { value: out, at: now }
          void bp.sendMotor(d, motor, out)
        }
      }
      bp.levels[d.index] = top
    }
  }

  function stopToys() {
    const now = performance.now()
    // Every motor too: a stop reaches all of them, and each must be sent again after.
    for (const st of state.values()) {
      st.smooth = 0
      st.gate = { value: 0, at: now }
    }
    for (const d of bp.strengthToys.value)
      send(d, 0, now)
  }

  function start() {
    if (timer !== null)
      return
    lastTick = 0
    timer = setInterval(tick, TICK_MS)
    running.value = true
  }

  function stop() {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
    if (running.value && bp.connected.value)
      stopToys()
    state.clear()
    running.value = false
  }

  // ── Lining a toy up ─────────────────────────────────────────────────────
  // A click a second, and the toy buzzed its timing ahead of each, so the
  // user can slide the timing until the click and the buzz land together.
  // Its own timers rather than the 50 ms tick: the tick's step is about as
  // big as what is being measured.
  let lineUpTimers: ReturnType<typeof setTimeout>[] = []
  let lineUpAudio: AudioContext | null = null

  stopLineUpImpl = () => {
    for (const t of lineUpTimers)
      clearTimeout(t)
    lineUpTimers = []
    void lineUpAudio?.close().catch(() => {})
    lineUpAudio = null
    const idx = lineUpToy.value
    lineUpToy.value = null
    if (idx === null)
      return
    const d = bp.strengthToys.value.find(x => x.index === idx)
    if (d)
      void bp.sendStrength(d, 0).catch(() => {})
    state.delete(idx)
  }

  startLineUpImpl = (d) => {
    stopLineUpImpl()
    if (safety.panicked)
      return
    lineUpToy.value = d.index
    const ac = new AudioContext()
    lineUpAudio = ac
    const BEATS = 30
    const first = performance.now() + 600
    const later = (fn: () => void, at: number) => lineUpTimers.push(setTimeout(fn, Math.max(0, at - performance.now())))
    const click = (at: number) => {
      // Heard at `at`: the speakers' own delay taken off.
      const when = ac.currentTime + (at - performance.now()) / 1000 - (ac.outputLatency || ac.baseLatency || 0)
      if (when < ac.currentTime)
        return
      const osc = ac.createOscillator()
      const gain = ac.createGain()
      osc.frequency.value = 1200
      gain.gain.setValueAtTime(0.0001, when)
      gain.gain.exponentialRampToValueAtTime(0.5, when + 0.004)
      gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.06)
      osc.connect(gain).connect(ac.destination)
      osc.start(when)
      osc.stop(when + 0.08)
    }
    for (let k = 0; k < BEATS; k++) {
      const at = first + k * 1000
      // Each beat is set up just before it, so a timing slid meanwhile applies at once.
      later(() => {
        if (lineUpToy.value !== d.index)
          return
        const cfg = bp.vibeFor(d)
        const lead = Math.max(0, Math.min(VIBE_LEAD_MAX, cfg.leadMs ?? 0))
        click(at)
        const strength = Math.max(0.3, cfg.max)
        later(() => void bp.sendStrength(d, strength).catch(() => {}), at - lead)
        later(() => void bp.sendStrength(d, 0).catch(() => {}), at - lead + 150)
      }, at - VIBE_LEAD_MAX - 100)
    }
    later(() => stopLineUpImpl(), first + BEATS * 1000)
  }

  watch(active, (on) => {
    if (!on)
      stopLineUpImpl()
    if (on)
      start()
    else
      stop()
  }, { immediate: true })

  // Panic should not wait for the next tick or the rate limit.
  watch(() => safety.panicked, (p) => {
    if (p)
      stopLineUpImpl()
    if (p && running.value)
      stopToys()
  })

  // A toy that went away and came back gets a fresh index; forget the old one.
  watch(() => bp.strengthToys.value.map(d => d.index), (ids) => {
    for (const k of state.keys()) {
      if (!ids.includes(typeof k === 'number' ? k : Number(String(k).split(':')[0])))
        state.delete(k)
    }
    if (lineUpToy.value !== null && !ids.includes(lineUpToy.value))
      stopLineUpImpl()
  })
}
