import type { Ref } from 'vue'
import type { ExprState, FaceExpression, FaceInputs, FaceMessage, FaceSignals } from '~/lib/faceState'
import { useLocalStorage } from '@vueuse/core'
import { computed, effectScope, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, shallowRef, watch } from 'vue'
import {
  buildFaceMessage,
  DEFAULT_SIGNALS,
  deriveIntensity,
  FACE_PROTOCOL_VERSION,
  initialExprState,
  isActive,
  shouldSend,
  stepExpression,
} from '~/lib/faceState'
import { sampleEnvelope } from '~/lib/funscriptAnalysis'
import { KEYS } from '~/lib/persist'
import { momentIntensity, speedDistribution } from '~/lib/scriptIntensity'
import { useAudioStore } from '~/stores/audio'
import { useDeviceStore } from '~/stores/deviceStore'
import { useMotionStore } from '~/stores/motionStore'
import { usePlayerStore } from '~/stores/playerStore'
import { useSafetyStore } from '~/stores/safetyStore'
import { useScriptStore } from '~/stores/scriptStore'
import { useButtplug } from './useButtplug'
import { useRemoteStatus } from './useRemoteStatus'
import { analyseActions, analysisKey } from './useScriptAnalysis'
import { axisOutput } from './useTCode'

export interface FaceLinkSettings {
  enabled: boolean
  /** Most frames per second, 1-10. */
  rateHz: number
  signals: FaceSignals
}

const DEFAULTS: FaceLinkSettings = { enabled: false, rateHz: 10, signals: { ...DEFAULT_SIGNALS } }

/**
 * How often the stores are sampled. The expression's dwell and the send
 * throttle both run off this, so it is the ceiling, not the send rate.
 */
const SAMPLE_MS = 100

/** A face that said hello or pinged within this long counts as present. */
const FACE_SEEN_MS = 25_000

// ── Singleton ────────────────────────────────────────────────────────────────
// The shell starts this once (via useRemoteHost); the Face panel reads it.

let settings: Ref<FaceLinkSettings> | null = null
let started = false

const preview = shallowRef<FaceMessage | null>(null)
const expression = ref<FaceExpression>('calm')
const pendingExpression = ref<FaceExpression | null>(null)
const sentCount = ref(0)
const lastSentAt = ref(0)
/** Last time a frame from the face identified itself (see docs/face-protocol.md). */
const faceSeenAt = ref(0)
const now = ref(0)
const previewers = ref(0)

let lastSent: FaceMessage | null = null
let expr: ExprState = initialExprState(0)
let forceNext = false

function getSettings(): Ref<FaceLinkSettings> {
  settings ??= useLocalStorage<FaceLinkSettings>(KEYS.faceLink.key, DEFAULTS, {
    // Nested, so a new signal added later still gets its default.
    mergeDefaults: (stored, defaults) => ({
      ...defaults,
      ...stored,
      signals: { ...defaults.signals, ...(stored?.signals ?? {}) },
    }),
  })
  return settings
}

function start() {
  if (started)
    return
  started = true

  // Detached: the link lives as long as the app, whichever component first
  // asked for it.
  effectScope(true).run(() => {
    const cfg = getSettings()
    const status = useRemoteStatus()
    const player = usePlayerStore()
    const scripts = useScriptStore()
    const motion = useMotionStore()
    const audio = useAudioStore()
    const safety = useSafetyStore()
    const device = useDeviceStore()
    const bp = useButtplug()

    /** Each script's sorted speeds, kept as long as its shared analysis is. */
    const distributions = new WeakMap<object, Float64Array>()

    /** How hard the primary script is going around the playhead, against the rest of it. */
    function scriptLevel(): { intensity: number, spm: number } | null {
      const s = scripts.primaryScript ?? scripts.activeScripts[0]
      if (!s || !s.parsed.actions.length)
        return null
      const a = analyseActions(s.parsed.actions, analysisKey(s.filename, s.channel, s.parsed.actions.length))
      const sample = sampleEnvelope(a.envelope, player.currentTime * 1000 + (s.offsetMs ?? 0))
      if (!sample)
        return null
      let sorted = distributions.get(a)
      if (!sorted) {
        sorted = speedDistribution(a.envelope)
        distributions.set(a, sorted)
      }
      return { intensity: momentIntensity(sample.speed, sorted), spm: sample.spm }
    }

    function snapshot(): FaceInputs {
      const sl = player.isPlaying ? scriptLevel() : null
      return {
        videoPlaying: player.isPlaying,
        title: player.videoPath ?? '',
        panicked: safety.panicked,
        deviceConnected: device.connected || bp.connected.value,
        sessionActive: audio.sessionActive.value,
        sessionIntensity: audio.intensity.value,
        sessionPhase: audio.phase.value,
        scriptIntensity: sl?.intensity ?? null,
        scriptSpm: sl?.spm ?? null,
        motionRunning: motion.running,
        motionSpm: motion.currentSpm,
        motionMaxSpm: motion.maxSpm,
        // Only worth following while something is actually moving it.
        strokePos: player.isPlaying || motion.running ? (axisOutput.L0 ?? null) : null,
      }
    }

    /** Somebody besides the desktop is in the room to hear it. */
    const audience = computed(() => status.connected.value && status.peers.value.remotes > 0)

    function tick() {
      const t = performance.now()
      now.value = t
      const input = snapshot()
      expr = stepExpression(expr, { active: isActive(input), intensity: deriveIntensity(input).value, panic: input.panicked }, t)
      expression.value = expr.expr
      pendingExpression.value = expr.pending

      const msg = buildFaceMessage(input, expr.expr, cfg.value.signals)
      preview.value = msg

      const send = status.send.value
      if (!cfg.value.enabled || !send || !audience.value)
        return
      if (!shouldSend(lastSent, msg, t, lastSentAt.value, cfg.value.rateHz, forceNext))
        return
      send(msg)
      lastSent = msg
      lastSentAt.value = t
      forceNext = false
      sentCount.value++
    }

    let timer: ReturnType<typeof setInterval> | null = null
    const wanted = computed(() => cfg.value.enabled || previewers.value > 0)
    watch(wanted, (on) => {
      if (on && timer === null) {
        expr = initialExprState(performance.now())
        timer = setInterval(tick, SAMPLE_MS)
        tick()
      }
      else if (!on && timer !== null) {
        clearInterval(timer)
        timer = null
      }
    }, { immediate: true })

    // A face (re)joining asks for state with `hello`: answer at once rather
    // than at the next change. Anything that names itself a face also counts
    // as a sign of life, which is the only way to tell it from a phone.
    status.onMessage((msg) => {
      if (msg?.client === 'face')
        faceSeenAt.value = performance.now()
      if (msg?.type === 'hello')
        forceNext = true
    })

    watch(() => status.peers.value.remotes, (n, was) => {
      if (n > (was ?? 0))
        forceNext = true
      // Nobody listening: the next listener gets a full frame, not a diff.
      if (n === 0)
        lastSent = null
    })
    watch(status.connected, (c) => {
      if (!c)
        lastSent = null
    })

    // Say goodbye when switched off, so a face can go back to reading the
    // plain `state` frame now rather than after a keepalive goes missing.
    watch(() => cfg.value.enabled, (on, was) => {
      if (on) {
        forceNext = true
        return
      }
      if (was && audience.value)
        status.send.value?.({ type: 'face.bye', v: FACE_PROTOCOL_VERSION })
      lastSent = null
    })
  })
}

/**
 * Publishes the session to the CYD face over the remote relay.
 *
 * Rides the phone remote's host socket (see useRemoteStatus): the face is one
 * more remote in the room, so the remote relay must be on for it to hear
 * anything. With no face around this costs a timer and no traffic — frames
 * only go out while some remote is in the room.
 */
export function useFaceLink() {
  start()
  const status = useRemoteStatus()

  const faceSeen = computed(() => faceSeenAt.value > 0 && now.value - faceSeenAt.value < FACE_SEEN_MS)

  /**
   * Keep sampling while a panel shows the preview, even with the link off.
   * Call from a component's setup.
   */
  function watchPreview() {
    let holding = false
    const hold = () => {
      if (!holding) {
        holding = true
        previewers.value++
      }
    }
    const release = () => {
      if (holding) {
        holding = false
        previewers.value--
      }
    }
    onMounted(hold)
    onActivated(hold)
    onDeactivated(release)
    onBeforeUnmount(release)
  }

  return {
    settings: getSettings(),
    preview,
    expression,
    pendingExpression,
    sentCount,
    lastSentAt,
    now,
    faceSeen,
    relayConnected: status.connected,
    peers: status.peers,
    watchPreview,
  }
}
