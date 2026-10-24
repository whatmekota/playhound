/**
 * What the CYD face is told about the session, and how it should look.
 *
 * The desktop already pushes `{type:"state"}` to every remote in the room for
 * the phone's benefit. That frame is about controls (is it playing, is motion
 * on), it only moves on discrete changes, and it has no idea where the stroke
 * is. The face wants something different: a small, steady stream it can
 * animate from, plus a hint of which expression to wear, decided here — with
 * hysteresis — so every face renders the same mood and none of them flicker
 * at a band edge. See docs/face-protocol.md for the wire format.
 *
 * Pure: the composable (useFaceLink) samples the stores and the clock and
 * hands them in.
 */

export const FACE_PROTOCOL_VERSION = 1

export type FacePhase = 'idle' | 'entry' | 'build' | 'peak' | 'descent'
const PHASES: readonly FacePhase[] = ['idle', 'entry', 'build', 'peak', 'descent']

/**
 * Ordered roughly by arousal. `sleepy` and `shocked` sit outside the ladder:
 * one is "nothing has happened for a while", the other is panic.
 */
export type FaceExpression = 'sleepy' | 'calm' | 'focused' | 'excited' | 'flustered' | 'shocked'
export const FACE_EXPRESSIONS: readonly FaceExpression[] = ['sleepy', 'calm', 'focused', 'excited', 'flustered', 'shocked']

/** Where `intensity` came from, so a face can tell a script from a session. */
export type IntensitySource = 'session' | 'script' | 'motion' | 'none'

/** Optional fields; each can be switched off in the Face panel. */
export interface FaceSignals {
  intensity: boolean
  strokePos: boolean
  spm: boolean
  phase: boolean
  deviceConnected: boolean
  title: boolean
}

export const DEFAULT_SIGNALS: FaceSignals = {
  intensity: true,
  strokePos: true,
  spm: true,
  phase: true,
  deviceConnected: true,
  title: true,
}

/** One frame on the wire. Fields for switched-off signals are absent, not zeroed. */
export interface FaceMessage {
  type: 'face'
  v: typeof FACE_PROTOCOL_VERSION
  playing: boolean
  panic: boolean
  expr: FaceExpression
  intensity?: number
  src?: IntensitySource
  strokePos?: number
  spm?: number
  phase?: FacePhase
  deviceConnected?: boolean
  title?: string
}

/** A snapshot of the stores, taken by useFaceLink. */
export interface FaceInputs {
  videoPlaying: boolean
  /** Video file name, with or without path and extension. */
  title: string
  panicked: boolean
  deviceConnected: boolean
  /** The session engine (or a programme driving it) is running. */
  sessionActive: boolean
  sessionIntensity: number
  sessionPhase: string
  /** Stroke speed of the playing script as 0-1, or null with no script. */
  scriptIntensity: number | null
  scriptSpm: number | null
  /** Generated motion is on and driving the device. */
  motionRunning: boolean
  motionSpm: number
  motionMaxSpm: number
  /** Last commanded L0 position, 0-1, or null if nothing has been sent. */
  strokePos: number | null
}

/**
 * Long titles are cut to this many UTF-8 bytes: the firmware keeps the title
 * in a 64-byte buffer and parses each frame into a 512-byte JSON document.
 */
export const TITLE_MAX_BYTES = 60

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0)
const q2 = (v: number) => Math.round(clamp01(v) * 100) / 100

export function cleanTitle(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? ''
  const noExt = base.replace(/\.[a-z0-9]{2,5}$/i, '')
  // Underscores and dots are how file names spell spaces.
  const spaced = noExt.replace(/[_.]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (utf8Length(spaced) <= TITLE_MAX_BYTES)
    return spaced
  // Cut on code points so a multi-byte character is never split in half.
  let out = ''
  for (const ch of spaced) {
    if (utf8Length(out + ch) > TITLE_MAX_BYTES - 3)
      break
    out += ch
  }
  return `${out.trimEnd()}…`
}

function utf8Length(s: string): number {
  let n = 0
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4
  }
  return n
}

/** Whether anything is going on that the face should be awake for. */
export function isActive(i: FaceInputs): boolean {
  return i.videoPlaying || i.sessionActive || i.motionRunning
}

/**
 * The one intensity number, from whichever source is in charge.
 *
 * A running session wins: when it is driven by a script (the Binaural panel's
 * "follow script") or a programme it already carries that number. Otherwise a
 * playing script's stroke speed, otherwise generated motion's rate against its
 * own ceiling.
 */
export function deriveIntensity(i: FaceInputs): { value: number, src: IntensitySource, spm: number } {
  if (i.sessionActive)
    return { value: clamp01(i.sessionIntensity), src: 'session', spm: i.motionRunning ? i.motionSpm : (i.scriptSpm ?? 0) }
  if (i.videoPlaying && i.scriptIntensity !== null)
    return { value: clamp01(i.scriptIntensity), src: 'script', spm: i.scriptSpm ?? 0 }
  if (i.motionRunning)
    return { value: clamp01(i.motionSpm / Math.max(1, i.motionMaxSpm)), src: 'motion', spm: i.motionSpm }
  return { value: 0, src: 'none', spm: 0 }
}

export function derivePhase(i: FaceInputs): FacePhase {
  if (!i.sessionActive)
    return 'idle'
  return (PHASES as readonly string[]).includes(i.sessionPhase) ? i.sessionPhase as FacePhase : 'idle'
}

// ─── Expression ──────────────────────────────────────────────────────────────

/** calm → focused → excited → flustered, by intensity. */
const LADDER: readonly FaceExpression[] = ['calm', 'focused', 'excited', 'flustered']
/** Intensity needed to climb from LADDER[i] to LADDER[i+1]. */
export const EXPR_UP = [0.35, 0.6, 0.82] as const
/** How far below a step intensity has to fall before stepping back down. */
export const EXPR_BAND = 0.08

export const EXPR_TIMING = {
  /** A new expression has to be wanted this long before it is worn. */
  dwellMs: 1200,
  /** Nothing happening for this long, and the face nods off. */
  sleepAfterMs: 45_000,
  /** Shocked lingers this long after panic is lifted; it was a fright. */
  shockHoldMs: 2500,
} as const

export interface ExprState {
  expr: FaceExpression
  /** When `expr` was put on. */
  since: number
  /** What the inputs currently ask for, if different, and since when. */
  pending: FaceExpression | null
  pendingSince: number
  /** Last time anything was active, for sleepiness. */
  lastActiveAt: number
}

export function initialExprState(now: number): ExprState {
  return { expr: 'calm', since: now, pending: null, pendingSince: now, lastActiveAt: now }
}

/**
 * Ladder step for an intensity, given the step currently worn.
 *
 * Climbing needs the full threshold; falling back needs to drop EXPR_BAND
 * under it. Without the gap, an intensity hovering at 0.6 would flip between
 * focused and excited every frame.
 */
export function ladderStep(current: number, x: number): number {
  let step = Math.max(0, Math.min(LADDER.length - 1, current))
  while (step < LADDER.length - 1 && x >= EXPR_UP[step])
    step++
  while (step > 0 && x < EXPR_UP[step - 1] - EXPR_BAND)
    step--
  return step
}

/** What the inputs want right now, before any dwell. */
export function targetExpression(prev: ExprState, input: { active: boolean, intensity: number, panic: boolean }, now: number): FaceExpression {
  if (input.panic)
    return 'shocked'
  if (prev.expr === 'shocked' && now - prev.since < EXPR_TIMING.shockHoldMs)
    return 'shocked'
  if (!input.active)
    return now - prev.lastActiveAt >= EXPR_TIMING.sleepAfterMs ? 'sleepy' : 'calm'
  // Off the ladder (asleep, shocked), start from the bottom: the climb is
  // then decided by the thresholds alone, with nothing to be sticky about.
  const at = LADDER.indexOf(prev.expr)
  return LADDER[ladderStep(at < 0 ? 0 : at, clamp01(input.intensity))]
}

/**
 * Advance the expression one sample.
 *
 * Panic is the one change that does not wait. Everything else has to be asked
 * for continuously for `dwellMs` before it shows.
 */
export function stepExpression(prev: ExprState, input: { active: boolean, intensity: number, panic: boolean }, now: number): ExprState {
  const lastActiveAt = input.active || input.panic ? now : prev.lastActiveAt
  const base = { ...prev, lastActiveAt }
  const want = targetExpression(base, input, now)

  if (want === prev.expr) {
    // While panic holds, keep restarting the clock, so the linger after it
    // lifts is measured from the end of the panic rather than its start.
    const since = want === 'shocked' && input.panic ? now : prev.since
    return { ...base, since, pending: null, pendingSince: now }
  }
  if (want === 'shocked')
    return { expr: 'shocked', since: now, pending: null, pendingSince: now, lastActiveAt }
  if (prev.pending !== want)
    return { ...base, pending: want, pendingSince: now }
  if (now - prev.pendingSince >= EXPR_TIMING.dwellMs)
    return { expr: want, since: now, pending: null, pendingSince: now, lastActiveAt }
  return base
}

// ─── Message ─────────────────────────────────────────────────────────────────

export function buildFaceMessage(i: FaceInputs, expr: FaceExpression, signals: FaceSignals = DEFAULT_SIGNALS): FaceMessage {
  const level = deriveIntensity(i)
  const msg: FaceMessage = {
    type: 'face',
    v: FACE_PROTOCOL_VERSION,
    playing: i.videoPlaying,
    panic: i.panicked,
    expr,
  }
  // Panic hides what was on screen; the face should not keep announcing it.
  if (signals.intensity) {
    msg.intensity = i.panicked ? 0 : q2(level.value)
    msg.src = i.panicked ? 'none' : level.src
  }
  if (signals.strokePos && i.strokePos !== null && !i.panicked)
    msg.strokePos = q2(i.strokePos)
  if (signals.spm)
    msg.spm = i.panicked ? 0 : Math.max(0, Math.round(level.spm))
  if (signals.phase)
    msg.phase = derivePhase(i)
  if (signals.deviceConnected)
    msg.deviceConnected = i.deviceConnected
  if (signals.title)
    msg.title = i.panicked ? '' : cleanTitle(i.title)
  return msg
}

/** Smallest change in each continuous field worth a frame. */
export const SEND_EPSILON = { intensity: 0.02, strokePos: 0.02, spm: 2 } as const

/** Whether `next` differs from `prev` by enough to be worth sending. */
export function faceChanged(prev: FaceMessage | null, next: FaceMessage): boolean {
  if (!prev)
    return true
  const discrete = ['playing', 'panic', 'expr', 'src', 'phase', 'deviceConnected', 'title'] as const
  for (const k of discrete) {
    if (prev[k] !== next[k])
      return true
  }
  for (const k of ['intensity', 'strokePos', 'spm'] as const) {
    const a = prev[k]
    const b = next[k]
    if ((a === undefined) !== (b === undefined))
      return true
    if (a !== undefined && b !== undefined && Math.abs(a - b) >= SEND_EPSILON[k])
      return true
  }
  return false
}

/** Rates the panel offers; ten a second is plenty for eyes and kind to the ESP32. */
export const FACE_RATE_MIN = 1
export const FACE_RATE_MAX = 10

/**
 * Even with nothing changing, a frame this often tells a face that the
 * desktop is still there and still speaks this protocol, so it can fall back
 * to the plain `state` frame when it stops hearing them.
 */
export const FACE_KEEPALIVE_MS = 5000

/**
 * Throttle: send on change, never faster than the rate, and at least every
 * keepalive. `force` (a face just said hello) skips the rate limit.
 */
export function shouldSend(
  prev: FaceMessage | null,
  next: FaceMessage,
  now: number,
  lastSentAt: number,
  rateHz: number,
  force = false,
): boolean {
  if (force)
    return true
  const hz = Math.max(FACE_RATE_MIN, Math.min(FACE_RATE_MAX, rateHz || FACE_RATE_MAX))
  if (now - lastSentAt < 1000 / hz - 1)
    return false
  return faceChanged(prev, next) || now - lastSentAt >= FACE_KEEPALIVE_MS
}
