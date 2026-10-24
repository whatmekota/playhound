/**
 * Programmes: a planned session laid out as phases on one clock.
 *
 * Everything here is pure — timing, the target-intensity curve, edge passes,
 * templates and the sanitiser for stored programmes — so it can be tested
 * without a store, a timer or a video. The runtime that feeds the curve into
 * the audio store and the director lives in ~/stores/programmeStore.
 */

import type { SessionPhase } from '~/stores/audio'

export type PhaseKind = 'warmup' | 'build' | 'peak' | 'cooldown'

export interface ProgrammePhase {
  id: string
  name: string
  kind: PhaseKind
  minutes: number
  /** Target intensity at the start and end of the phase, 0–1. Equal for a plateau. */
  from: number
  to: number
  /**
   * Build–hold–retreat passes inside the phase. 0 or 1 is a plain ramp; with
   * more, each pass climbs from `from` a little higher than the last, holds,
   * and drops back, and the final pass holds at `to` until the phase ends.
   */
  edges: number
  /** Ceiling for generated motion during this phase, spm. Null leaves the Motion panel's own. */
  capSpm: number | null
  /** Binaural beat band for this phase, Hz. Null uses the session engine's band for the kind. */
  beat: [number, number] | null
}

/** When the programme changes video. */
export type VideoSwitch = 'ended' | 'phase' | 'interval'

export interface Programme {
  id: string
  name: string
  builtin?: boolean
  phases: ProgrammePhase[]
  video: VideoSwitch
  /** Minutes between changes when `video` is 'interval'. */
  everyMin: number
  /** Start the binaural tone with the programme (and fade it out after). */
  tone: boolean
}

export interface PhaseBounds {
  start: number
  end: number
  dur: number
}

export const PHASE_KINDS: { value: PhaseKind, label: string }[] = [
  { value: 'warmup', label: 'Warm-up' },
  { value: 'build', label: 'Build' },
  { value: 'peak', label: 'Peak' },
  { value: 'cooldown', label: 'Cool-down' },
]

/** Each kind borrows a session-engine phase for its beat band, noise level and colour. */
export const KIND_SESSION_PHASE: Record<PhaseKind, Exclude<SessionPhase, 'idle'>> = {
  warmup: 'entry',
  build: 'build',
  peak: 'peak',
  cooldown: 'descent',
}

export const MIN_PHASE_MINUTES = 1
export const MAX_PHASE_MINUTES = 120
export const MAX_EDGES = 8
export const MAX_PHASES = 12

/** How far below the user's ceiling a phase cap may go; lower than this is not a stroke. */
export const MIN_CAP_SPM = 10

/** Share of an edge pass spent climbing, then holding; the rest is the retreat. */
const EDGE_RISE = 0.6
const EDGE_HOLD = 0.2
/** The first pass reaches this share of the way from `from` to `to`; later ones climb evenly to `to`. */
const EDGE_FIRST_REACH = 0.8

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

const clamp01 = (v: number) => clamp(v, 0, 1)
const smoothstep = (p: number) => p * p * (3 - 2 * p)
/** Fast at first, then settling — a retreat that lets go quickly. */
const easeOut = (p: number) => 1 - (1 - p) ** 3

// ─── Timing ───────────────────────────────────────────────────────────────────

export function phaseSeconds(p: ProgrammePhase): number {
  return clamp(p.minutes, MIN_PHASE_MINUTES, MAX_PHASE_MINUTES) * 60
}

/**
 * Start and end of every phase, in programme seconds. `extra` adds seconds to
 * individual phases — that is how "extend" works without rewriting the plan.
 */
export function timeline(phases: ProgrammePhase[], extra: number[] = []): PhaseBounds[] {
  let t = 0
  return phases.map((p, i) => {
    const dur = phaseSeconds(p) + Math.max(0, extra[i] ?? 0)
    const b = { start: t, end: t + dur, dur }
    t += dur
    return b
  })
}

export function totalSeconds(phases: ProgrammePhase[], extra: number[] = []): number {
  const b = timeline(phases, extra)
  return b.length ? b[b.length - 1].end : 0
}

export interface Location {
  /** Index of the phase `t` falls in; the last phase once the programme is over. */
  index: number
  /** Seconds into that phase. */
  inPhase: number
  phaseLeft: number
  totalLeft: number
  done: boolean
}

export function locate(bounds: PhaseBounds[], t: number): Location {
  if (!bounds.length)
    return { index: -1, inPhase: 0, phaseLeft: 0, totalLeft: 0, done: true }
  const total = bounds[bounds.length - 1].end
  const at = Math.max(0, t)
  let index = bounds.findIndex(b => at < b.end)
  const done = index < 0
  if (done)
    index = bounds.length - 1
  const b = bounds[index]
  const inPhase = Math.min(b.dur, at - b.start)
  return {
    index,
    inPhase,
    phaseLeft: Math.max(0, b.end - at),
    totalLeft: Math.max(0, total - at),
    done,
  }
}

// ─── Intensity curve ──────────────────────────────────────────────────────────

export type SegmentKind = 'ramp' | 'rise' | 'hold' | 'retreat'

export interface Segment {
  /** Seconds into the phase. */
  t0: number
  t1: number
  from: number
  to: number
  kind: SegmentKind
  /** Which edge pass this belongs to, 0-based; 0 for a plain ramp. */
  pass: number
}

export function edgeCount(p: ProgrammePhase): number {
  return clamp(Math.round(p.edges || 0), 0, MAX_EDGES)
}

/** The height pass `i` of `n` reaches: most of the way on the first, all of it on the last. */
export function edgeTop(p: ProgrammePhase, i: number, n: number): number {
  const reach = n <= 1 ? 1 : EDGE_FIRST_REACH + (1 - EDGE_FIRST_REACH) * (i / (n - 1))
  return clamp01(p.from + (p.to - p.from) * reach)
}

/**
 * The phase as a list of segments. A plain phase is one eased ramp; an edged
 * one is n passes of rise → hold → retreat, the last pass holding at the top
 * instead of retreating, so whatever follows starts from the peak.
 */
export function expandPhase(p: ProgrammePhase, dur = phaseSeconds(p)): Segment[] {
  const n = edgeCount(p)
  const from = clamp01(p.from)
  const to = clamp01(p.to)
  if (n <= 1)
    return [{ t0: 0, t1: dur, from, to, kind: 'ramp', pass: 0 }]

  const cycle = dur / n
  const segs: Segment[] = []
  for (let i = 0; i < n; i++) {
    const c0 = i * cycle
    const top = edgeTop(p, i, n)
    const last = i === n - 1
    const riseEnd = c0 + cycle * EDGE_RISE
    segs.push({ t0: c0, t1: riseEnd, from, to: top, kind: 'rise', pass: i })
    if (last) {
      segs.push({ t0: riseEnd, t1: dur, from: top, to: top, kind: 'hold', pass: i })
    }
    else {
      const holdEnd = riseEnd + cycle * EDGE_HOLD
      segs.push({ t0: riseEnd, t1: holdEnd, from: top, to: top, kind: 'hold', pass: i })
      segs.push({ t0: holdEnd, t1: c0 + cycle, from: top, to: from, kind: 'retreat', pass: i })
    }
  }
  return segs
}

function segmentValue(s: Segment, t: number): number {
  const span = s.t1 - s.t0
  const p = span > 0 ? clamp01((t - s.t0) / span) : 1
  const eased = s.kind === 'retreat' ? easeOut(p) : smoothstep(p)
  return s.from + (s.to - s.from) * eased
}

/** Target intensity `t` seconds into a phase of `dur` seconds. */
export function phaseIntensityAt(p: ProgrammePhase, t: number, dur = phaseSeconds(p)): number {
  const segs = expandPhase(p, dur)
  const at = clamp(t, 0, dur)
  const seg = segs.find(s => at < s.t1) ?? segs[segs.length - 1]
  return clamp01(segmentValue(seg, at))
}

/** Where an edged phase is: which pass, and whether it is climbing, holding or retreating. */
export function edgeStateAt(p: ProgrammePhase, t: number, dur = phaseSeconds(p)): { pass: number, of: number, kind: SegmentKind } | null {
  const n = edgeCount(p)
  if (n <= 1)
    return null
  const segs = expandPhase(p, dur)
  const at = clamp(t, 0, dur)
  const seg = segs.find(s => at < s.t1) ?? segs[segs.length - 1]
  return { pass: seg.pass, of: n, kind: seg.kind }
}

/** Target intensity at programme time `t`. Zero before it starts and after it ends. */
export function intensityAt(phases: ProgrammePhase[], t: number, extra: number[] = []): number {
  const bounds = timeline(phases, extra)
  if (!bounds.length || t < 0)
    return 0
  const loc = locate(bounds, t)
  if (loc.done)
    return 0
  return phaseIntensityAt(phases[loc.index], loc.inPhase, bounds[loc.index].dur)
}

/** `n` evenly spaced samples of the whole curve, for drawing. */
export function sampleCurve(phases: ProgrammePhase[], n: number, extra: number[] = []): number[] {
  const total = totalSeconds(phases, extra)
  if (!total || n < 2)
    return []
  const bounds = timeline(phases, extra)
  return Array.from({ length: n }, (_, i) => {
    // Sample just inside the end so the last point belongs to the last phase.
    const t = Math.min(total - 1e-6, (i / (n - 1)) * total)
    const loc = locate(bounds, t)
    return phaseIntensityAt(phases[loc.index], loc.inPhase, bounds[loc.index].dur)
  })
}

/**
 * Move `current` toward `target` by at most `perSec * dt`. The curve itself
 * can step at a phase boundary (a cool-down that starts lower than the peak
 * ended); this is what turns that step into a glide.
 */
export function slew(current: number, target: number, perSec: number, dt: number): number {
  const step = Math.max(0, perSec) * Math.max(0, dt)
  if (Math.abs(target - current) <= step)
    return target
  return current + Math.sign(target - current) * step
}

/**
 * The motion ceiling for a phase: its own cap, but never above the user's.
 * A programme can only ever make the device slower than it was allowed to be.
 */
export function phaseCeiling(userMaxSpm: number, capSpm: number | null): number {
  if (capSpm === null || !Number.isFinite(capSpm))
    return userMaxSpm
  return Math.min(userMaxSpm, Math.max(MIN_CAP_SPM, capSpm))
}

/**
 * When to change video once an interval is due: at the next chapter boundary
 * if one comes within `maxWait` seconds, so a change lands between sections
 * rather than in the middle of one; otherwise now. Times are video seconds.
 */
export function switchPoint(now: number, boundaries: number[], maxWait: number): number {
  const next = boundaries
    .filter(b => b > now + 0.5)
    .sort((a, b) => a - b)[0]
  return next !== undefined && next - now <= maxWait ? next : now
}

// ─── Building programmes ──────────────────────────────────────────────────────

let seq = 0
export function uid(prefix = 'p'): string {
  seq = (seq + 1) % 1e6
  return `${prefix}-${Date.now().toString(36)}-${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

const KIND_DEFAULTS: Record<PhaseKind, Omit<ProgrammePhase, 'id' | 'kind'>> = {
  warmup: { name: 'Warm-up', minutes: 8, from: 0.15, to: 0.35, edges: 0, capSpm: 80, beat: null },
  build: { name: 'Build', minutes: 12, from: 0.35, to: 0.7, edges: 0, capSpm: null, beat: null },
  peak: { name: 'Peak', minutes: 8, from: 0.7, to: 0.92, edges: 0, capSpm: null, beat: null },
  cooldown: { name: 'Cool-down', minutes: 5, from: 0.4, to: 0.05, edges: 0, capSpm: 70, beat: null },
}

export function newPhase(kind: PhaseKind, over: Partial<ProgrammePhase> = {}): ProgrammePhase {
  return { id: uid('ph'), kind, ...KIND_DEFAULTS[kind], ...over }
}

function phase(kind: PhaseKind, over: Partial<ProgrammePhase>, id: string): ProgrammePhase {
  return { ...KIND_DEFAULTS[kind], kind, ...over, id }
}

/** Built-in starting points. Fixed ids, so a selection survives reloads. */
export const TEMPLATES: Programme[] = [
  {
    id: 'tpl-short',
    name: 'Short',
    builtin: true,
    video: 'ended',
    everyMin: 5,
    tone: false,
    phases: [
      phase('warmup', { minutes: 5, from: 0.2, to: 0.4, capSpm: 80 }, 'tpl-short-1'),
      phase('build', { minutes: 7, from: 0.4, to: 0.7 }, 'tpl-short-2'),
      phase('peak', { minutes: 5, from: 0.75, to: 0.9 }, 'tpl-short-3'),
      phase('cooldown', { minutes: 3, from: 0.4, to: 0.1, capSpm: 70 }, 'tpl-short-4'),
    ],
  },
  {
    id: 'tpl-classic',
    name: 'Classic',
    builtin: true,
    video: 'ended',
    everyMin: 8,
    tone: false,
    phases: [
      phase('warmup', { minutes: 10, from: 0.15, to: 0.35, capSpm: 70 }, 'tpl-classic-1'),
      phase('build', { minutes: 15, from: 0.35, to: 0.7, capSpm: 110 }, 'tpl-classic-2'),
      phase('peak', { minutes: 12, from: 0.7, to: 0.95 }, 'tpl-classic-3'),
      phase('cooldown', { minutes: 8, from: 0.45, to: 0.05, capSpm: 60 }, 'tpl-classic-4'),
    ],
  },
  {
    id: 'tpl-edging',
    name: 'Edging',
    builtin: true,
    video: 'phase',
    everyMin: 8,
    tone: false,
    phases: [
      phase('warmup', { minutes: 10, from: 0.15, to: 0.35, capSpm: 70 }, 'tpl-edging-1'),
      phase('build', { minutes: 15, from: 0.35, to: 0.65, capSpm: 110 }, 'tpl-edging-2'),
      phase('peak', { name: 'Edge', minutes: 25, from: 0.5, to: 0.95, edges: 5 }, 'tpl-edging-3'),
      phase('peak', { name: 'Release', minutes: 5, from: 0.9, to: 1 }, 'tpl-edging-4'),
      phase('cooldown', { minutes: 5, from: 0.4, to: 0.05, capSpm: 60 }, 'tpl-edging-5'),
    ],
  },
]

/** A user-owned copy with fresh ids, ready to edit. */
export function cloneProgramme(p: Programme, name = `${p.name} copy`): Programme {
  return {
    ...p,
    id: uid('prog'),
    name,
    builtin: false,
    phases: p.phases.map(ph => ({ ...ph, id: uid('ph'), beat: ph.beat ? [ph.beat[0], ph.beat[1]] : null })),
  }
}

// ─── Stored programmes ────────────────────────────────────────────────────────

const KINDS = new Set<PhaseKind>(['warmup', 'build', 'peak', 'cooldown'])
const SWITCHES = new Set<VideoSwitch>(['ended', 'phase', 'interval'])
const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

/**
 * Bring a stored phase back into range, or drop it. Storage is hand-editable
 * and older builds may have written other shapes; a bad value here would
 * otherwise reach the device as an intensity.
 */
export function normalisePhase(raw: unknown): ProgrammePhase | null {
  if (!raw || typeof raw !== 'object')
    return null
  const r = raw as Record<string, unknown>
  const kind = KINDS.has(r.kind as PhaseKind) ? r.kind as PhaseKind : null
  if (!kind)
    return null
  const d = KIND_DEFAULTS[kind]
  const beatRaw = Array.isArray(r.beat) ? r.beat : null
  const beat: [number, number] | null = beatRaw && beatRaw.length === 2 && beatRaw.every(b => typeof b === 'number' && Number.isFinite(b))
    ? [clamp(Math.min(beatRaw[0], beatRaw[1]), 0.5, 35), clamp(Math.max(beatRaw[0], beatRaw[1]), 0.5, 35)]
    : null
  const cap = r.capSpm === null || r.capSpm === undefined ? null : num(r.capSpm, Number.NaN)
  return {
    id: typeof r.id === 'string' && r.id ? r.id : uid('ph'),
    name: typeof r.name === 'string' && r.name.trim() ? r.name.slice(0, 40) : d.name,
    kind,
    minutes: clamp(Math.round(num(r.minutes, d.minutes)), MIN_PHASE_MINUTES, MAX_PHASE_MINUTES),
    from: clamp01(num(r.from, d.from)),
    to: clamp01(num(r.to, d.to)),
    edges: clamp(Math.round(num(r.edges, 0)), 0, MAX_EDGES),
    capSpm: cap === null || Number.isNaN(cap) ? null : clamp(Math.round(cap), MIN_CAP_SPM, 400),
    beat,
  }
}

export function normaliseProgramme(raw: unknown): Programme | null {
  if (!raw || typeof raw !== 'object')
    return null
  const r = raw as Record<string, unknown>
  const phases = (Array.isArray(r.phases) ? r.phases : [])
    .map(normalisePhase)
    .filter((p): p is ProgrammePhase => !!p)
    .slice(0, MAX_PHASES)
  if (!phases.length)
    return null
  return {
    id: typeof r.id === 'string' && r.id ? r.id : uid('prog'),
    name: typeof r.name === 'string' && r.name.trim() ? r.name.slice(0, 60) : 'Programme',
    builtin: false,
    phases,
    video: SWITCHES.has(r.video as VideoSwitch) ? r.video as VideoSwitch : 'ended',
    everyMin: clamp(Math.round(num(r.everyMin, 8)), 1, 60),
    tone: r.tone === true,
  }
}
