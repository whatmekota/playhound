/**
 * The first-run setup: whether this install still has it to come, and how its
 * steps are walked.
 *
 * Only a fresh install gets it. That is decided once, at the first start of a
 * version that has the setup, before anything else writes to storage: main.ts
 * asks before the migrations, which stamp the layout version even on a fresh
 * install. Nothing of ours in localStorage means nobody has used playhound
 * here yet. Anything at all (a setting, a playlist, the layout version any
 * earlier version wrote) means an existing install, which is marked done
 * without a word, so an update never brings the setup up.
 *
 * The answer is kept. A first start closed before the setup is finished or
 * skipped gets it again next time, though the stores have written keys of
 * their own by then.
 */
import { isOwnKey, KEYS } from './persist'

export type SetupState = 'pending' | 'done'

/** What a start does about the setup, from the stored state and every key in storage. */
export function setupStateOnStart(stored: string | null, keys: Iterable<string>): SetupState {
  if (stored === 'pending' || stored === 'done')
    return stored
  for (const k of keys) {
    if (k !== KEYS.setup.key && isOwnKey(k))
      return 'done'
  }
  return 'pending'
}

function keysOf(s: Storage): string[] {
  const out: string[] = []
  for (let i = 0; i < s.length; i++) {
    const k = s.key(i)
    if (k !== null)
      out.push(k)
  }
  return out
}

/** Decide (once) and keep whether this install gets the setup. Call before anything writes to storage. */
export function noteFirstRun(s: Storage = localStorage): SetupState {
  try {
    const state = setupStateOnStart(s.getItem(KEYS.setup.key), keysOf(s))
    s.setItem(KEYS.setup.key, state)
    return state
  }
  catch {
    // Storage that can't be read or written can't keep any answer either:
    // better no setup than one on every start.
    return 'done'
  }
}

export function setupPending(s: Storage = localStorage): boolean {
  try {
    return s.getItem(KEYS.setup.key) === 'pending'
  }
  catch {
    return false
  }
}

export function markSetupDone(s: Storage = localStorage) {
  try {
    s.setItem(KEYS.setup.key, 'done')
  }
  catch {}
}

// ─── Steps ────────────────────────────────────────────────────────────────────

export interface StepLike {
  id: string
  /** Whether the step applies where playhound runs now; left out, it always does. */
  available?: () => boolean
}

const applies = (s: StepLike) => s.available?.() ?? true

/** The steps that apply here, in order. */
export function stepsHere<T extends StepLike>(steps: readonly T[]): T[] {
  return steps.filter(applies)
}

/**
 * The step after `current` that applies here, or null when it was the last.
 * Counted from where `current` sits in the full list, so a step that stopped
 * applying while it was open still moves on to the right one.
 */
export function nextStep<T extends StepLike>(steps: readonly T[], current: string | null): T | null {
  const from = current === null ? -1 : steps.findIndex(s => s.id === current)
  for (let i = from + 1; i < steps.length; i++) {
    if (applies(steps[i]))
      return steps[i]
  }
  return null
}

/** The step before `current` that applies here, or null on the first. */
export function prevStep<T extends StepLike>(steps: readonly T[], current: string): T | null {
  const from = steps.findIndex(s => s.id === current)
  for (let i = from - 1; i >= 0; i--) {
    if (applies(steps[i]))
      return steps[i]
  }
  return null
}
