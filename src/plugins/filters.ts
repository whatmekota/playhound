import type { MotionFilter } from './types'
import { ref } from 'vue'

/**
 * Plugins' motion filters: positions reshaped on their way to the device
 * during script playback (ctx.motion.filter).
 *
 * One filter per plugin, chained in the order the plugins are listed. A
 * filter that throws, or answers with something that isn't a number, is taken
 * out at once and the plugin is told in the console: it runs every frame, and
 * a broken one must neither stop the device loop nor leave it guessing.
 *
 * The user's controls stay on top of whatever a filter does: the knob and
 * edges and the axis range are applied after it, and capMove keeps a filter
 * from making the device move faster than the script itself does or than the
 * speed ceiling allows, whichever is more.
 */

export interface FilterChain {
  /** Set (or replace) a plugin's filter. */
  set: (owner: string, fn: MotionFilter) => void
  remove: (owner: string) => void
  /** The plugins in list order; filters run in this order. */
  setOrder: (owners: string[]) => void
  /** Whether any filter is set. */
  active: () => boolean
  /** Run a position (0–1) through every filter. */
  apply: (pos: number, axis: string, t: number) => number
}

export function createFilterChain(opts: { onChange?: () => void, onError?: (owner: string, err: unknown) => void } = {}): FilterChain {
  const filters = new Map<string, MotionFilter>()
  let order: string[] = []
  /** Filters in run order; rebuilt when either changes, not per call. */
  let run: [string, MotionFilter][] = []

  function rebuild() {
    const ranked = new Map(order.map((id, i) => [id, i]))
    run = [...filters].sort(([a], [b]) => (ranked.get(a) ?? Infinity) - (ranked.get(b) ?? Infinity))
    opts.onChange?.()
  }

  function drop(owner: string, err: unknown) {
    filters.delete(owner)
    rebuild()
    opts.onError?.(owner, err)
  }

  return {
    set(owner, fn) {
      filters.set(owner, fn)
      rebuild()
    },
    remove(owner) {
      if (filters.delete(owner))
        rebuild()
    },
    setOrder(owners) {
      order = [...owners]
      rebuild()
    },
    active: () => run.length > 0,
    apply(pos, axis, t) {
      let p = pos
      for (const [owner, fn] of run) {
        let out: unknown
        try {
          out = fn(p, { axis, t })
        }
        catch (err) {
          drop(owner, err)
          continue
        }
        if (typeof out !== 'number' || !Number.isFinite(out)) {
          drop(owner, new Error(`the filter returned ${String(out)}, not a number`))
          continue
        }
        p = Math.min(1, Math.max(0, out))
      }
      return p
    },
  }
}

/** Travel per ms (0–1 units) at the speed ceiling: a full stroke, down and up, at `maxSpm`. */
export function ceilingPerMs(maxSpm: number): number {
  return (2 * Math.max(1, maxSpm)) / 60_000
}

/**
 * A filtered move from `from` to `to` over `ms`, held to the larger of the
 * script's own travel over the same stretch (`rawFrom` → `rawTo`) and the
 * speed ceiling. The end is pulled back toward `from` if it is too far.
 */
export function capMove(from: number, to: number, rawFrom: number, rawTo: number, ms: number, perMs: number): number {
  const allowed = Math.max(Math.abs(rawTo - rawFrom), perMs * Math.max(0, ms))
  const d = to - from
  if (Math.abs(d) <= allowed)
    return to
  return from + Math.sign(d) * allowed
}

/**
 * A whole script's points through the chain, for a device that plays points
 * rather than frames (the Handy). Each step between points is held by capMove
 * against the original step. Positions 0–1.
 */
export function filterActions<A extends { at: number, pos: number }>(actions: A[], axis: string, apply: (pos: number, axis: string, t: number) => number, perMs: number): A[] {
  const out: A[] = []
  let prev: { at: number, pos: number, raw: number } | null = null
  for (const a of actions) {
    let pos = apply(a.pos, axis, a.at)
    if (prev)
      pos = capMove(prev.pos, pos, prev.raw, a.pos, a.at - prev.at, perMs)
    out.push({ ...a, pos })
    prev = { at: a.at, pos, raw: a.pos }
  }
  return out
}

/** The app's one chain. `version` moves whenever a filter is set or removed. */
export const motionFilterVersion = ref(0)
export const motionFilters = createFilterChain({
  onChange: () => motionFilterVersion.value++,
  onError: (owner, err) => console.error(`[plugin ${owner}] motion filter removed: it failed`, err),
})
