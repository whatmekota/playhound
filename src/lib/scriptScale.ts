/**
 * The intensity knob for scripts: a gentler version of the same motion.
 *
 * Two things make a script intense — how far it travels and how fast — so the
 * knob turns both down, and neither ever moves an action in time: the strokes
 * still land on the beats the script was written to.
 *
 * 1. Range compression: every turning point is pulled toward the centre of
 *    its own stroke, so a full-length stroke becomes a shorter one around the
 *    same middle rather than a stroke squashed against one end.
 * 2. A speed cap, after funlib's limitPeakSpeed: wherever a stroke would
 *    still move faster than the cap, its travel shrinks until it does not.
 *
 * Points between two turning points keep their place along the stroke, so a
 * curved stroke stays curved. Positions are in whatever unit the script uses
 * (`range` is its full scale: 1 for normalised scripts, 100 for raw ones);
 * the cap is always in funscript units per second (0–100 per second).
 */

export interface ScaleAction {
  at: number
  pos: number
}

export interface IntensityParams {
  /** Travel kept around each stroke's centre, 0–1. */
  amplitude: number
  /** Fastest allowed movement, funscript units (0–100) per second. Infinity for none. */
  speedCap: number
}

export interface ScaledScript {
  /** Same `at` as the input, gentler `pos`. */
  actions: ScaleAction[]
  /** The stroke centre at each action, for backing off further at output time. */
  centres: number[]
  /** True when nothing was changed (knob at full), so callers can skip work. */
  identity: boolean
}

export const MIN_INTENSITY = 0.1

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/**
 * What a knob setting means. Full is untouched; turning down shortens the
 * strokes steadily, while the speed cap only starts to bite in the lower
 * half, where a fast script would otherwise still feel fast.
 *
 *   knob   amplitude   cap (units/s)
 *   1.0    100%        none
 *   0.8     85%        1020
 *   0.5     63%         300
 *   0.3     48%         163
 *   0.1     33%          87
 */
export function intensityParams(intensity: number): IntensityParams {
  const i = clamp(Number.isFinite(intensity) ? intensity : 1, MIN_INTENSITY, 1)
  if (i >= 0.999)
    return { amplitude: 1, speedCap: Number.POSITIVE_INFINITY }
  return {
    amplitude: 0.25 + 0.75 * i,
    speedCap: 60 + (240 * i) / (1 - i),
  }
}

/**
 * Indices of the turning points: the first and last actions, and every action
 * where the direction changes (including into and out of a hold). Between two
 * of them the script is monotone.
 */
export function turningPoints(actions: readonly ScaleAction[]): number[] {
  const n = actions.length
  if (n === 0)
    return []
  if (n === 1)
    return [0]
  const keys = [0]
  let prev = Math.sign(actions[1].pos - actions[0].pos)
  for (let i = 1; i < n - 1; i++) {
    const dir = Math.sign(actions[i + 1].pos - actions[i].pos)
    if (dir !== prev)
      keys.push(i)
    prev = dir
  }
  keys.push(n - 1)
  return keys
}

/**
 * Scale a script for a knob setting. Returns new arrays; the input is left
 * alone. O(n), meant to be run once per script per knob change, not per frame.
 */
export function scaleScript(
  actions: readonly ScaleAction[],
  params: IntensityParams,
  opts: { range?: number } = {},
): ScaledScript {
  const range = opts.range ?? 1
  const n = actions.length
  const amplitude = clamp(params.amplitude, 0, 1)
  const cap = params.speedCap

  const keys = turningPoints(actions)
  const m = keys.length
  const e = keys.map(k => actions[k].pos)

  // Each turning point's centre: the middle of the range it spans with its
  // neighbours. A turning point is always the top or the bottom of that span,
  // so pulling toward the centre always shortens the stroke.
  const c = e.map((v, k) => {
    const a = e[Math.max(0, k - 1)]
    const b = e[Math.min(m - 1, k + 1)]
    return (Math.max(a, v, b) + Math.min(a, v, b)) / 2
  })

  if (amplitude >= 1 && !Number.isFinite(cap)) {
    return {
      actions: actions.map(a => ({ at: a.at, pos: a.pos })),
      centres: centresAlong(actions, keys, c),
      identity: true,
    }
  }

  // 1. Range: every turning point toward its centre.
  const v = e.map((x, k) => c[k] + (x - c[k]) * amplitude)

  // 2. Travel and speed. Each stroke may travel at most `allowed[s]`: never
  // further than it did, and no further than puts its fastest segment,
  // scaled with the stroke, exactly on the cap. Centres differ a little from
  // one turning point to the next, so the first step alone could lengthen a
  // short stroke beside a long one; this catches that too.
  if (m > 1) {
    const capPerMs = Number.isFinite(cap) ? (Math.max(0, cap) * range) / 100 / 1000 : Number.POSITIVE_INFINITY
    const allowed: number[] = []
    for (let s = 0; s < m - 1; s++) {
      const span = Math.abs(e[s + 1] - e[s])
      let fastest = 0
      if (span > 0 && Number.isFinite(capPerMs)) {
        for (let j = keys[s]; j < keys[s + 1]; j++) {
          const d = actions[j + 1].at - actions[j].at
          const moved = Math.abs(actions[j + 1].pos - actions[j].pos)
          const speed = d > 0 ? moved / d : moved > 0 ? Number.POSITIVE_INFINITY : 0
          if (speed > fastest)
            fastest = speed
        }
      }
      allowed.push(fastest > 0 ? Math.min(span, (capPerMs * span) / fastest) : span)
    }

    // Shrink both ends of an offending stroke toward their centres, a few
    // times over, since shrinking one stroke also shortens its neighbours…
    for (let pass = 0; pass < 6; pass++) {
      let changed = false
      for (let s = 0; s < m - 1; s++) {
        const travel = Math.abs(v[s + 1] - v[s])
        if (travel > allowed[s] + 1e-12) {
          const f = allowed[s] / travel
          v[s] = c[s] + (v[s] - c[s]) * f
          v[s + 1] = c[s + 1] + (v[s + 1] - c[s + 1]) * f
          changed = true
        }
      }
      if (!changed)
        break
    }
    // …then make it a guarantee: walk forward and pull anything still too far
    // from its predecessor in. Each point moves toward the one before, which
    // is already final, so every stroke ends within its limit. Rarely needed.
    for (let s = 1; s < m; s++) {
      const lim = allowed[s - 1]
      v[s] = clamp(v[s], v[s - 1] - lim, v[s - 1] + lim)
    }
  }

  // 3. Points between turning points keep their place along the stroke.
  const out: ScaleAction[] = Array.from({ length: n })
  const centres: number[] = Array.from({ length: n })
  for (let s = 0; s < m; s++) {
    out[keys[s]] = { at: actions[keys[s]].at, pos: v[s] }
    centres[keys[s]] = c[s]
    if (s === m - 1)
      break
    const i0 = keys[s]
    const i1 = keys[s + 1]
    const span = e[s + 1] - e[s]
    const t0 = actions[i0].at
    const dt = actions[i1].at - t0
    for (let j = i0 + 1; j < i1; j++) {
      const u = span !== 0 ? (actions[j].pos - e[s]) / span : dt > 0 ? (actions[j].at - t0) / dt : 0
      out[j] = { at: actions[j].at, pos: v[s] + (v[s + 1] - v[s]) * u }
      centres[j] = c[s] + (c[s + 1] - c[s]) * u
    }
  }

  return { actions: out, centres, identity: false }
}

function centresAlong(actions: readonly ScaleAction[], keys: number[], c: number[]): number[] {
  const centres: number[] = Array.from({ length: actions.length })
  for (let s = 0; s < keys.length; s++) {
    centres[keys[s]] = c[s]
    if (s === keys.length - 1)
      break
    const i0 = keys[s]
    const i1 = keys[s + 1]
    const dt = actions[i1].at - actions[i0].at
    for (let j = i0 + 1; j < i1; j++) {
      const u = dt > 0 ? (actions[j].at - actions[i0].at) / dt : 0
      centres[j] = c[s] + (c[s + 1] - c[s]) * u
    }
  }
  return centres
}

/**
 * Position and stroke centre at `timeMs`, interpolated like the player does.
 * One search for both, since this runs every frame.
 */
export function sampleScaled(script: ScaledScript, timeMs: number): { pos: number, centre: number } {
  const a = script.actions
  const c = script.centres
  const n = a.length
  if (n === 0)
    return { pos: 0.5, centre: 0.5 }
  if (timeMs <= a[0].at)
    return { pos: a[0].pos, centre: c[0] }
  if (timeMs >= a[n - 1].at)
    return { pos: a[n - 1].pos, centre: c[n - 1] }
  let lo = 0
  let hi = n - 1
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1
    if (a[mid].at <= timeMs)
      lo = mid
    else
      hi = mid
  }
  const span = a[hi].at - a[lo].at
  const t = span > 0 ? (timeMs - a[lo].at) / span : 0
  return {
    pos: a[lo].pos + (a[hi].pos - a[lo].pos) * t,
    centre: c[lo] + (c[hi] - c[lo]) * t,
  }
}

/**
 * Back a position off toward its stroke centre — the edge button's hold.
 * Shrinks travel and speed together, and is smooth in `holdBack`, so it can
 * be applied per frame while the hold rises and falls.
 */
export function backOff(pos: number, centre: number, holdBack: number): number {
  return centre + (pos - centre) * (1 - clamp(holdBack, 0, 1))
}
