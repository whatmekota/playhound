/**
 * Rules: "when this happens, do that", for automation without a plugin.
 *
 * A rule has one trigger, any number of extra conditions (all must hold),
 * one or more actions and a cooldown. Triggers come in two shapes:
 *
 * - events, which happen at a moment: a video starts or ends, a chapter
 *   starts, an edge is called or ends, a finish is marked, a phase starts
 * - levels, which are true for a while: heart rate over 130, intensity at
 *   80% or more, 20 minutes into the session. A level fires when it *becomes*
 *   true, and has to go false again (past a small margin, for the noisy
 *   ones) before it can fire again
 *
 * Everything here is pure: `evaluate` takes the rules, a snapshot of the
 * session, the events since the last step and its own memory, and says
 * which rules fire. The composable (useRules) samples the stores, feeds it
 * and carries out the actions through the same functions the keyboard and
 * the phone use, so a rule can do nothing a key press could not.
 *
 * Loops are kept down three ways: each rule's cooldown, a cap on firings per
 * minute across all rules, and a rule never reacting to an event its own
 * action caused. Panic, or the master switch off, stops all firing, and
 * levels have to go false and true again afterwards before they fire.
 */

export type RulePhase = 'entry' | 'build' | 'peak' | 'descent'

export const RULE_PHASES: { value: RulePhase, label: string }[] = [
  { value: 'entry', label: 'Warm-up' },
  { value: 'build', label: 'Build' },
  { value: 'peak', label: 'Peak' },
  { value: 'descent', label: 'Cool-down' },
]

export function phaseLabel(p: RulePhase | null | undefined): string {
  return RULE_PHASES.find(x => x.value === p)?.label ?? 'none'
}

// ─── Triggers ─────────────────────────────────────────────────────────────────

export type TriggerKind
  = | 'heart-above' | 'heart-below' | 'heart-rising'
    | 'phase' | 'minutes'
    | 'video-start' | 'video-end' | 'chapter' | 'tag'
    | 'edge' | 'edge-end' | 'finish'
    | 'intensity-up' | 'intensity-down'
    | 'script-above'

export interface Trigger {
  kind: TriggerKind
  /** bpm, beats gained, minutes or percent, depending on the kind. */
  value?: number
  phase?: RulePhase
  tag?: string
}

/** What a field of a trigger, condition or action holds, for the editor. */
export type ParamKind = 'bpm' | 'rise' | 'minutes' | 'percent' | 'delta' | 'seconds' | 'phase' | 'tag' | 'text' | 'source' | null

interface KindDef<K extends string> {
  kind: K
  label: string
  param: ParamKind
  /** Default for the param when the kind is picked. */
  value?: number
  icon: string
}

export const TRIGGERS: readonly KindDef<TriggerKind>[] = [
  { kind: 'heart-above', label: 'Heart rate goes over', param: 'bpm', value: 130, icon: 'i-carbon-favorite' },
  { kind: 'heart-below', label: 'Heart rate drops under', param: 'bpm', value: 100, icon: 'i-carbon-favorite' },
  { kind: 'heart-rising', label: 'Heart rate climbs fast', param: 'rise', value: 12, icon: 'i-carbon-favorite' },
  { kind: 'phase', label: 'A phase starts', param: 'phase', icon: 'i-carbon-roadmap' },
  { kind: 'minutes', label: 'Minutes into the session', param: 'minutes', value: 20, icon: 'i-carbon-time' },
  { kind: 'video-start', label: 'A video starts', param: null, icon: 'i-carbon-play-filled-alt' },
  { kind: 'video-end', label: 'A video ends', param: null, icon: 'i-carbon-stop-filled-alt' },
  { kind: 'chapter', label: 'A chapter starts', param: null, icon: 'i-carbon-chart-line-data' },
  { kind: 'tag', label: 'A video with a tag starts', param: 'tag', icon: 'i-carbon-tag' },
  { kind: 'edge', label: 'An edge is called', param: null, icon: 'i-carbon-hourglass' },
  { kind: 'edge-end', label: 'An edge ends', param: null, icon: 'i-carbon-hourglass' },
  { kind: 'finish', label: 'You finish (I came)', param: null, icon: 'i-carbon-rain-drop' },
  { kind: 'intensity-up', label: 'Intensity rises to', param: 'percent', value: 80, icon: 'i-carbon-meter-alt' },
  { kind: 'intensity-down', label: 'Intensity falls to', param: 'percent', value: 40, icon: 'i-carbon-meter-alt' },
  { kind: 'script-above', label: 'The script gets more intense than', param: 'percent', value: 75, icon: 'i-carbon-fire' },
]

const EVENT_TRIGGERS = new Set<TriggerKind>(['phase', 'video-start', 'video-end', 'chapter', 'tag', 'edge', 'edge-end', 'finish'])

export function isEventTrigger(kind: TriggerKind): boolean {
  return EVENT_TRIGGERS.has(kind)
}

// ─── Conditions ───────────────────────────────────────────────────────────────

export type ConditionKind
  = | 'heart-above' | 'heart-below'
    | 'phase' | 'not-phase'
    | 'minutes-over' | 'minutes-under'
    | 'intensity-above' | 'intensity-below'
    | 'script-above' | 'script-below'
    | 'tag' | 'not-tag'
    | 'playing'

export interface Condition {
  kind: ConditionKind
  value?: number
  phase?: RulePhase
  tag?: string
}

export const CONDITIONS: readonly KindDef<ConditionKind>[] = [
  { kind: 'phase', label: 'Phase is', param: 'phase', icon: 'i-carbon-roadmap' },
  { kind: 'not-phase', label: 'Phase is not', param: 'phase', icon: 'i-carbon-roadmap' },
  { kind: 'heart-above', label: 'Heart rate over', param: 'bpm', value: 120, icon: 'i-carbon-favorite' },
  { kind: 'heart-below', label: 'Heart rate under', param: 'bpm', value: 110, icon: 'i-carbon-favorite' },
  { kind: 'minutes-over', label: 'Session longer than', param: 'minutes', value: 10, icon: 'i-carbon-time' },
  { kind: 'minutes-under', label: 'Session shorter than', param: 'minutes', value: 30, icon: 'i-carbon-time' },
  { kind: 'intensity-above', label: 'Intensity at least', param: 'percent', value: 50, icon: 'i-carbon-meter-alt' },
  { kind: 'intensity-below', label: 'Intensity at most', param: 'percent', value: 50, icon: 'i-carbon-meter-alt' },
  { kind: 'script-above', label: 'Script more intense than', param: 'percent', value: 60, icon: 'i-carbon-fire' },
  { kind: 'script-below', label: 'Script less intense than', param: 'percent', value: 40, icon: 'i-carbon-fire' },
  { kind: 'tag', label: 'Video has tag', param: 'tag', icon: 'i-carbon-tag' },
  { kind: 'not-tag', label: 'Video does not have tag', param: 'tag', icon: 'i-carbon-tag' },
  { kind: 'playing', label: 'A video is playing', param: null, icon: 'i-carbon-play-filled-alt' },
]

// ─── Actions ──────────────────────────────────────────────────────────────────

export type MotionSourceName = 'funscript' | 'session' | 'beat' | 'pulse' | 'music' | 'manual'

export const MOTION_SOURCE_NAMES: { value: MotionSourceName, label: string }[] = [
  { value: 'funscript', label: 'Script' },
  { value: 'music', label: 'Music' },
  { value: 'session', label: 'Session' },
  { value: 'beat', label: 'Beat' },
  { value: 'pulse', label: 'Pulse' },
  { value: 'manual', label: 'Manual' },
]

export type ActionKind
  = | 'edge'
    | 'intensity-set' | 'intensity-nudge'
    | 'motion-source'
    | 'next' | 'random' | 'random-tag'
    | 'binaural-start' | 'binaural-stop'
    | 'hypno-on' | 'hypno-off'
    | 'cool-down' | 'pause'
    | 'toast' | 'face'

export interface RuleAction {
  kind: ActionKind
  /** Percent for intensity, seconds for a cool-down. */
  value?: number
  source?: MotionSourceName
  tag?: string
  text?: string
}

export const ACTIONS: readonly KindDef<ActionKind>[] = [
  { kind: 'edge', label: 'Call an edge', param: null, icon: 'i-carbon-hourglass' },
  { kind: 'intensity-set', label: 'Set intensity to', param: 'percent', value: 60, icon: 'i-carbon-meter-alt' },
  { kind: 'intensity-nudge', label: 'Change intensity by', param: 'delta', value: 10, icon: 'i-carbon-meter-alt' },
  { kind: 'motion-source', label: 'Switch motion source to', param: 'source', icon: 'i-carbon-wave-height' },
  { kind: 'next', label: 'Play the next video', param: null, icon: 'i-carbon-skip-forward-filled' },
  { kind: 'random', label: 'Play a random video', param: null, icon: 'i-carbon-shuffle' },
  { kind: 'random-tag', label: 'Play a random video tagged', param: 'tag', icon: 'i-carbon-tag' },
  { kind: 'binaural-start', label: 'Start the binaural tone', param: null, icon: 'i-carbon-headphones' },
  { kind: 'binaural-stop', label: 'Stop the binaural tone', param: null, icon: 'i-carbon-headphones' },
  { kind: 'hypno-on', label: 'Turn the hypno overlay on', param: null, icon: 'i-carbon-circle-dash' },
  { kind: 'hypno-off', label: 'Turn the hypno overlay off', param: null, icon: 'i-carbon-circle-dash' },
  { kind: 'cool-down', label: 'Cool down, then pause', param: 'seconds', value: 20, icon: 'i-carbon-temperature-frigid' },
  { kind: 'pause', label: 'Pause the video', param: null, icon: 'i-carbon-pause-filled' },
  { kind: 'toast', label: 'Show a message', param: 'text', icon: 'i-carbon-chat' },
  { kind: 'face', label: 'Say a line on the face', param: 'text', icon: 'i-carbon-face-wink' },
]

// ─── Rules ────────────────────────────────────────────────────────────────────

export interface Rule {
  id: string
  name: string
  enabled: boolean
  trigger: Trigger
  conditions: Condition[]
  actions: RuleAction[]
  cooldownSec: number
}

export interface RulesConfig {
  /** Master switch: off, nothing fires. */
  enabled: boolean
  /** Across every rule. */
  maxPerMinute: number
  rules: Rule[]
}

export const MIN_COOLDOWN_SEC = 5
export const MAX_COOLDOWN_SEC = 3600
export const DEFAULT_COOLDOWN_SEC = 60
export const DEFAULT_MAX_PER_MINUTE = 6
export const MAX_PER_MINUTE_LIMIT = 30
export const MAX_RULES = 50
export const MAX_ACTIONS = 6
export const MAX_CONDITIONS = 6
export const MAX_TEXT = 120
/** Intensity a rule can set: the knob's own range. */
export const MIN_INTENSITY_PCT = 10
/** A cool-down takes this long at most. */
export const MAX_COOL_DOWN_SEC = 120

/** Margins a noisy level has to fall back past before it can fire again. */
export const HEART_MARGIN = 3
export const SCRIPT_MARGIN = 5

/** Events within this long of a rule's action are counted as caused by it. */
export const CAUSE_WINDOW_MS = 2500

let seq = 0
export function ruleId(): string {
  seq = (seq + 1) % 1e6
  return `r${Date.now().toString(36)}${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

// ─── Templates ────────────────────────────────────────────────────────────────

/** Starters, all off until switched on. Fixed ids so a reset finds them again. */
export const TEMPLATES: readonly Rule[] = [
  {
    id: 'tpl-heart-build',
    name: 'Heart rate over 130 during Build → edge',
    enabled: false,
    trigger: { kind: 'heart-above', value: 130 },
    conditions: [{ kind: 'phase', phase: 'build' }],
    actions: [{ kind: 'edge' }],
    cooldownSec: 90,
  },
  {
    id: 'tpl-twenty-minutes',
    name: 'After 20 minutes → intensity +10%',
    enabled: false,
    trigger: { kind: 'minutes', value: 20 },
    conditions: [],
    actions: [{ kind: 'intensity-nudge', value: 10 }, { kind: 'toast', text: '20 minutes in. A little more.' }],
    cooldownSec: 60,
  },
  {
    id: 'tpl-finish-cool',
    name: 'On finish → cool down and pause',
    enabled: false,
    trigger: { kind: 'finish' },
    conditions: [],
    actions: [{ kind: 'cool-down', value: 20 }],
    cooldownSec: 60,
  },
  {
    id: 'tpl-peak-hypno',
    name: 'Peak starts → hypno overlay on',
    enabled: false,
    trigger: { kind: 'phase', phase: 'peak' },
    conditions: [],
    actions: [{ kind: 'hypno-on' }],
    cooldownSec: 60,
  },
  {
    id: 'tpl-edge-breathe',
    name: 'Edge called → "breathe" on the face',
    enabled: false,
    trigger: { kind: 'edge' },
    conditions: [],
    actions: [{ kind: 'face', text: 'breathe' }],
    cooldownSec: 10,
  },
]

export function defaultRulesConfig(): RulesConfig {
  return {
    enabled: true,
    maxPerMinute: DEFAULT_MAX_PER_MINUTE,
    rules: TEMPLATES.map(cloneRule),
  }
}

export function cloneRule(r: Rule): Rule {
  return {
    ...r,
    trigger: { ...r.trigger },
    conditions: r.conditions.map(c => ({ ...c })),
    actions: r.actions.map(a => ({ ...a })),
  }
}

export function newRule(): Rule {
  return {
    id: ruleId(),
    name: 'New rule',
    enabled: false,
    trigger: { kind: 'edge' },
    conditions: [],
    actions: [{ kind: 'toast', text: 'Edge' }],
    cooldownSec: DEFAULT_COOLDOWN_SEC,
  }
}

// ─── Sanitising (storage and backups) ───────────────────────────────────────────

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

function num(v: unknown, lo: number, hi: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : fallback
}

function str(v: unknown, max = MAX_TEXT): string {
  return typeof v === 'string' ? v.slice(0, max) : ''
}

function phaseOf(v: unknown): RulePhase {
  return RULE_PHASES.some(p => p.value === v) ? v as RulePhase : 'build'
}

/** Normalised the way library tags are: lower case, single spaces. */
export function cleanTag(v: unknown): string {
  return str(v, 40).replace(/[",\s]+/g, ' ').trim().replace(/^#+\s*/, '').toLowerCase()
}

/** Range a param of each kind is kept in. */
function paramRange(p: ParamKind): [number, number] {
  switch (p) {
    case 'bpm': return [30, 230]
    case 'rise': return [2, 60]
    case 'minutes': return [1, 600]
    case 'percent': return [0, 100]
    case 'delta': return [-90, 90]
    case 'seconds': return [0, MAX_COOL_DOWN_SEC]
    default: return [0, 0]
  }
}

function sanitiseParams<T extends { value?: number, phase?: RulePhase, tag?: string, text?: string, source?: MotionSourceName }>(
  raw: Record<string, unknown>,
  def: KindDef<string>,
): Partial<T> {
  const out: Record<string, unknown> = {}
  switch (def.param) {
    case 'phase':
      out.phase = phaseOf(raw.phase)
      break
    case 'tag':
      out.tag = cleanTag(raw.tag)
      break
    case 'text':
      out.text = str(raw.text)
      break
    case 'source':
      out.source = MOTION_SOURCE_NAMES.some(s => s.value === raw.source) ? raw.source : 'funscript'
      break
    case null:
      break
    default: {
      const [lo, hi] = paramRange(def.param)
      out.value = Math.round(num(raw.value, lo, hi, def.value ?? lo))
    }
  }
  return out as Partial<T>
}

export function normaliseTrigger(raw: unknown): Trigger | null {
  const r = raw as Record<string, unknown> | null
  const def = TRIGGERS.find(t => t.kind === r?.kind)
  if (!r || !def)
    return null
  return { kind: def.kind, ...sanitiseParams<Trigger>(r, def) }
}

export function normaliseCondition(raw: unknown): Condition | null {
  const r = raw as Record<string, unknown> | null
  const def = CONDITIONS.find(t => t.kind === r?.kind)
  if (!r || !def)
    return null
  return { kind: def.kind, ...sanitiseParams<Condition>(r, def) }
}

export function normaliseAction(raw: unknown): RuleAction | null {
  const r = raw as Record<string, unknown> | null
  const def = ACTIONS.find(t => t.kind === r?.kind)
  if (!r || !def)
    return null
  const a: RuleAction = { kind: def.kind, ...sanitiseParams<RuleAction>(r, def) }
  if (a.kind === 'intensity-set')
    a.value = Math.max(MIN_INTENSITY_PCT, a.value ?? 60)
  return a
}

export function normaliseRule(raw: unknown): Rule | null {
  const r = raw as Record<string, unknown> | null
  if (!r || typeof r !== 'object')
    return null
  const trigger = normaliseTrigger(r.trigger)
  if (!trigger)
    return null
  const actions = (Array.isArray(r.actions) ? r.actions : [])
    .map(normaliseAction)
    .filter((a): a is RuleAction => !!a)
    .slice(0, MAX_ACTIONS)
  return {
    id: typeof r.id === 'string' && r.id ? r.id.slice(0, 64) : ruleId(),
    name: str(r.name, 80).trim() || 'Rule',
    enabled: r.enabled === true,
    trigger,
    conditions: (Array.isArray(r.conditions) ? r.conditions : [])
      .map(normaliseCondition)
      .filter((c): c is Condition => !!c)
      .slice(0, MAX_CONDITIONS),
    actions,
    cooldownSec: Math.round(num(r.cooldownSec, MIN_COOLDOWN_SEC, MAX_COOLDOWN_SEC, DEFAULT_COOLDOWN_SEC)),
  }
}

/** Whatever storage or a backup file holds, as a config that is safe to run. */
export function normaliseRulesConfig(raw: unknown): RulesConfig {
  const r = raw as Record<string, unknown> | null
  if (!r || typeof r !== 'object' || !Array.isArray(r.rules))
    return defaultRulesConfig()
  const seen = new Set<string>()
  const rules: Rule[] = []
  for (const x of r.rules) {
    const rule = normaliseRule(x)
    if (!rule)
      continue
    if (seen.has(rule.id))
      rule.id = ruleId()
    seen.add(rule.id)
    rules.push(rule)
    if (rules.length >= MAX_RULES)
      break
  }
  return {
    enabled: r.enabled !== false,
    maxPerMinute: Math.round(num(r.maxPerMinute, 1, MAX_PER_MINUTE_LIMIT, DEFAULT_MAX_PER_MINUTE)),
    rules,
  }
}

// ─── The session, as rules see it ───────────────────────────────────────────────

export interface RuleState {
  /** Wall clock, ms. */
  now: number
  /** Smoothed bpm, null with no monitor (or no reading). */
  bpm: number | null
  /** Beats gained over the last ~15 s. */
  heartRise: number | null
  /** The session engine's or a programme's phase; null when idle. */
  phase: RulePhase | null
  /** Minutes since the session started; null with no session. */
  sessionMinutes: number | null
  /** The intensity knob, percent. */
  intensity: number
  /** How hard the script is going right here against the rest of it, percent; null without one playing. */
  script: number | null
  /** The current video's tags, manual and automatic. */
  tags: readonly string[]
  playing: boolean
  panicked: boolean
}

export type RuleEventKind = 'phase' | 'video-start' | 'video-end' | 'chapter' | 'edge' | 'edge-end' | 'finish'

export interface RuleEvent {
  kind: RuleEventKind
  /** For `phase`. */
  phase?: RulePhase
  /** The rule whose action caused it, so that rule does not answer itself. */
  causedBy?: string | null
  /** Short words for the log: a video name, a chapter. */
  detail?: string
}

export interface RuleMemory {
  /** When each rule last fired, ms. */
  lastFired: Record<string, number>
  /** Level triggers: armed to fire on the next false → true. Missing means not yet seen. */
  armed: Record<string, boolean>
  /** When anything fired in the last minute, for the cap. */
  recent: number[]
  /** The last time the cap held something back, so the log says it once a minute. */
  cappedAt: number
}

export function emptyMemory(): RuleMemory {
  return { lastFired: {}, armed: {}, recent: [], cappedAt: 0 }
}

export interface Firing {
  rule: Rule
  /** Why, in words: "heart rate 134 bpm, over 130". */
  reason: string
}

export interface StepResult {
  fired: Firing[]
  /** Rules that would have fired but for the per-minute cap. */
  capped: Rule[]
  memory: RuleMemory
}

// ─── Levels ─────────────────────────────────────────────────────────────────────

/** Whether a level trigger is true now; null when it cannot be known (no monitor). */
export function levelOn(t: Trigger, s: RuleState): boolean | null {
  const v = t.value ?? 0
  switch (t.kind) {
    case 'heart-above': return s.bpm === null ? null : s.bpm > v
    case 'heart-below': return s.bpm === null ? null : s.bpm < v
    case 'heart-rising': return s.heartRise === null ? null : s.heartRise >= v
    case 'minutes': return s.sessionMinutes === null ? false : s.sessionMinutes >= v
    case 'intensity-up': return s.intensity >= v
    case 'intensity-down': return s.intensity <= v
    case 'script-above': return s.script === null ? null : s.script > v
    default: return null
  }
}

/** Whether a level has fallen back far enough to fire again. */
export function levelRearmed(t: Trigger, s: RuleState): boolean {
  const v = t.value ?? 0
  switch (t.kind) {
    case 'heart-above': return s.bpm === null || s.bpm <= v - HEART_MARGIN
    case 'heart-below': return s.bpm === null || s.bpm >= v + HEART_MARGIN
    case 'heart-rising': return s.heartRise === null || s.heartRise < v / 2
    case 'minutes': return s.sessionMinutes === null || s.sessionMinutes < v
    case 'intensity-up': return s.intensity < v
    case 'intensity-down': return s.intensity > v
    case 'script-above': return s.script === null || s.script <= v - SCRIPT_MARGIN
    default: return true
  }
}

export function conditionHolds(c: Condition, s: RuleState): boolean {
  const v = c.value ?? 0
  switch (c.kind) {
    case 'heart-above': return s.bpm !== null && s.bpm > v
    case 'heart-below': return s.bpm !== null && s.bpm < v
    case 'phase': return s.phase === c.phase
    case 'not-phase': return s.phase !== c.phase
    case 'minutes-over': return s.sessionMinutes !== null && s.sessionMinutes >= v
    case 'minutes-under': return s.sessionMinutes === null || s.sessionMinutes < v
    case 'intensity-above': return s.intensity >= v
    case 'intensity-below': return s.intensity <= v
    case 'script-above': return s.script !== null && s.script > v
    case 'script-below': return s.script !== null && s.script < v
    case 'tag': return !!c.tag && s.tags.includes(c.tag)
    case 'not-tag': return !c.tag || !s.tags.includes(c.tag)
    case 'playing': return s.playing
  }
}

/** Whether an event is the one a trigger waits for. */
export function eventMatches(t: Trigger, e: RuleEvent, s: RuleState): boolean {
  switch (t.kind) {
    case 'phase': return e.kind === 'phase' && e.phase === t.phase
    case 'tag': return e.kind === 'video-start' && !!t.tag && s.tags.includes(t.tag)
    case 'video-start':
    case 'video-end':
    case 'chapter':
    case 'edge':
    case 'edge-end':
    case 'finish':
      return e.kind === t.kind
    default:
      return false
  }
}

// ─── Words ──────────────────────────────────────────────────────────────────────

function fmtMin(m: number): string {
  return m === 1 ? '1 minute' : `${m} minutes`
}

/** "heart rate goes over 130 bpm" */
export function describeTrigger(t: Trigger): string {
  const v = t.value ?? 0
  switch (t.kind) {
    case 'heart-above': return `heart rate goes over ${v} bpm`
    case 'heart-below': return `heart rate drops under ${v} bpm`
    case 'heart-rising': return `heart rate climbs ${v} bpm in a few seconds`
    case 'phase': return `${phaseLabel(t.phase)} starts`
    case 'minutes': return `the session reaches ${fmtMin(v)}`
    case 'video-start': return 'a video starts'
    case 'video-end': return 'a video ends'
    case 'chapter': return 'a chapter starts'
    case 'tag': return `a video tagged "${t.tag || '?'}" starts`
    case 'edge': return 'an edge is called'
    case 'edge-end': return 'an edge ends'
    case 'finish': return 'you finish'
    case 'intensity-up': return `intensity rises to ${v}%`
    case 'intensity-down': return `intensity falls to ${v}%`
    case 'script-above': return `the script gets more intense than ${v}%`
  }
}

export function describeCondition(c: Condition): string {
  const v = c.value ?? 0
  switch (c.kind) {
    case 'heart-above': return `heart rate over ${v}`
    case 'heart-below': return `heart rate under ${v}`
    case 'phase': return `in ${phaseLabel(c.phase)}`
    case 'not-phase': return `not in ${phaseLabel(c.phase)}`
    case 'minutes-over': return `${fmtMin(v)} or more in`
    case 'minutes-under': return `under ${fmtMin(v)} in`
    case 'intensity-above': return `intensity ${v}% or more`
    case 'intensity-below': return `intensity ${v}% or less`
    case 'script-above': return `script over ${v}%`
    case 'script-below': return `script under ${v}%`
    case 'tag': return `tagged "${c.tag || '?'}"`
    case 'not-tag': return `not tagged "${c.tag || '?'}"`
    case 'playing': return 'a video playing'
  }
}

export function describeAction(a: RuleAction): string {
  const v = a.value ?? 0
  switch (a.kind) {
    case 'edge': return 'edge'
    case 'intensity-set': return `intensity to ${v}%`
    case 'intensity-nudge': return `intensity ${v >= 0 ? '+' : ''}${v}%`
    case 'motion-source': return `motion from ${MOTION_SOURCE_NAMES.find(s => s.value === a.source)?.label ?? a.source}`
    case 'next': return 'next video'
    case 'random': return 'random video'
    case 'random-tag': return `random "${a.tag || '?'}" video`
    case 'binaural-start': return 'binaural on'
    case 'binaural-stop': return 'binaural off'
    case 'hypno-on': return 'hypno on'
    case 'hypno-off': return 'hypno off'
    case 'cool-down': return `cool down ${v}s and pause`
    case 'pause': return 'pause'
    case 'toast': return `say "${a.text || '…'}"`
    case 'face': return `face says "${a.text || '…'}"`
  }
}

/** One line for the list: "When heart rate goes over 130 bpm, in Build: edge". */
export function describeRule(r: Rule): string {
  const when = describeTrigger(r.trigger)
  const cond = r.conditions.map(describeCondition).join(', ')
  const then = r.actions.length ? r.actions.map(describeAction).join(', ') : 'nothing yet'
  return `When ${when}${cond ? `, ${cond}` : ''}: ${then}`
}

/** What made a trigger fire, with the reading that did it. */
export function firingReason(t: Trigger, s: RuleState, e?: RuleEvent): string {
  switch (t.kind) {
    case 'heart-above':
    case 'heart-below':
      return `Heart rate ${s.bpm ?? '?'} bpm (${t.kind === 'heart-above' ? 'over' : 'under'} ${t.value})`
    case 'heart-rising':
      return `Heart rate up ${Math.round(s.heartRise ?? 0)} bpm in a few seconds`
    case 'minutes':
      return `${Math.floor(s.sessionMinutes ?? 0)} minutes into the session`
    case 'intensity-up':
    case 'intensity-down':
      return `Intensity at ${Math.round(s.intensity)}%`
    case 'script-above':
      return `Script at ${Math.round(s.script ?? 0)}% here`
    case 'phase':
      return `${phaseLabel(e?.phase)} started`
    case 'tag':
      return `Tagged "${t.tag}"${e?.detail ? `: ${e.detail}` : ''}`
    case 'video-start':
      return `Started${e?.detail ? `: ${e.detail}` : ''}`
    case 'video-end':
      return `Ended${e?.detail ? `: ${e.detail}` : ''}`
    case 'chapter':
      return `Chapter${e?.detail ? `: ${e.detail}` : ''}`
    case 'edge':
      return `Edge called${e?.detail ? ` (${e.detail})` : ''}`
    case 'edge-end':
      return 'Edge over'
    case 'finish':
      return 'Finish marked'
  }
}

// ─── The step ───────────────────────────────────────────────────────────────────

const MINUTE = 60_000

/**
 * One step: given the session now and what happened since the last step,
 * which rules fire. Pure; the returned memory replaces the old one.
 */
export function evaluate(
  cfg: RulesConfig,
  state: RuleState,
  events: readonly RuleEvent[],
  memory: RuleMemory,
): StepResult {
  const mem: RuleMemory = {
    lastFired: { ...memory.lastFired },
    armed: { ...memory.armed },
    recent: memory.recent.filter(t => state.now - t < MINUTE),
    cappedAt: memory.cappedAt,
  }
  const fired: Firing[] = []
  const capped: Rule[] = []
  // Off, or in a panic: nothing fires, and every level has to go false and
  // true again afterwards, so nothing goes off the moment it is resumed.
  const live = cfg.enabled && !state.panicked

  for (const rule of cfg.rules) {
    const t = rule.trigger
    const event = isEventTrigger(t.kind)

    if (!live || !rule.enabled) {
      if (!event)
        mem.armed[rule.id] = false
      continue
    }

    let reason: string | null = null
    if (event) {
      const e = events.find(x => x.causedBy !== rule.id && eventMatches(t, x, state))
      if (e)
        reason = firingReason(t, state, e)
    }
    else {
      const on = levelOn(t, state)
      const seen = rule.id in mem.armed
      if (!seen) {
        // First look: true already is not a crossing.
        mem.armed[rule.id] = on !== true
        continue
      }
      if (!mem.armed[rule.id]) {
        if (levelRearmed(t, state))
          mem.armed[rule.id] = true
        continue
      }
      if (on === true)
        reason = firingReason(t, state)
    }
    if (reason === null)
      continue

    // Held back by a condition or the cooldown, a level stays armed and fires
    // as soon as they allow while it is still true; an event is simply missed.
    if (!rule.conditions.every(c => conditionHolds(c, state)))
      continue
    const last = mem.lastFired[rule.id]
    if (last !== undefined && state.now - last < rule.cooldownSec * 1000)
      continue
    if (!rule.actions.length)
      continue
    if (mem.recent.length >= cfg.maxPerMinute) {
      if (state.now - mem.cappedAt >= MINUTE) {
        mem.cappedAt = state.now
        capped.push(rule)
      }
      continue
    }

    mem.lastFired[rule.id] = state.now
    mem.recent.push(state.now)
    if (!event)
      mem.armed[rule.id] = false
    fired.push({ rule, reason })
  }

  // Forget rules that are gone.
  const ids = new Set(cfg.rules.map(r => r.id))
  for (const id of Object.keys(mem.armed)) {
    if (!ids.has(id))
      delete mem.armed[id]
  }
  for (const id of Object.keys(mem.lastFired)) {
    if (!ids.has(id))
      delete mem.lastFired[id]
  }
  return { fired, capped, memory: mem }
}

// ─── Log ──────────────────────────────────────────────────────────────────────

export interface RuleLogEntry {
  at: number
  ruleId: string
  name: string
  reason: string
  /** What it did, or why it could not. */
  did: string
  tone: 'ok' | 'warn' | 'muted'
}

export const LOG_MAX = 50

export function pushLog(log: readonly RuleLogEntry[], entry: RuleLogEntry): RuleLogEntry[] {
  const next = [entry, ...log]
  return next.length > LOG_MAX ? next.slice(0, LOG_MAX) : next
}

// ─── Intensity ramps ───────────────────────────────────────────────────────────

/** How fast a rule moves the intensity knob, per second (0–1 scale). */
export const RAMP_PER_SEC = 0.05

/** The knob's next value on the way from `from` to `to`, `dt` seconds on. */
export function rampStep(from: number, to: number, dt: number, perSec = RAMP_PER_SEC): number {
  const step = Math.max(0, perSec * dt)
  if (Math.abs(to - from) <= step)
    return to
  return from + Math.sign(to - from) * step
}

/** Where a set or nudge takes the knob (0.1–1), from where it is now. */
export function intensityTarget(a: RuleAction, current: number): number {
  const v = (a.value ?? 0) / 100
  const raw = a.kind === 'intensity-set' ? v : current + v
  return Math.min(1, Math.max(MIN_INTENSITY_PCT / 100, Math.round(raw * 100) / 100))
}
