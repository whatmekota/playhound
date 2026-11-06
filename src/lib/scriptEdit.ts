/**
 * Point editing for funscripts: selection, moving a selection as a group,
 * inserting and deleting, snapping, speed checks and undo. Pure functions
 * over sorted action arrays (positions 0–1, times in whole ms), so the
 * editor component only maps pixels and calls these.
 *
 * Every edit returns a new array and leaves the input alone; unchanged
 * points keep their objects, which keeps undo patches small.
 */

export interface Pt {
  at: number
  pos: number
}

/** Two points never share a millisecond: a funscript is a function of time. */
export const MIN_GAP_MS = 1

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

// ─── Lookup ───────────────────────────────────────────────────────────────────

/** Index of the first point at or after `t` (points.length when none). */
export function lowerBound(points: readonly Pt[], t: number): number {
  let lo = 0
  let hi = points.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (points[mid].at < t)
      lo = mid + 1
    else
      hi = mid
  }
  return lo
}

/** The script's position at `t`, interpolated the way devices play it (0.5 for an empty script). */
export function positionAt(points: readonly Pt[], t: number): number {
  const n = points.length
  if (!n)
    return 0.5
  if (t <= points[0].at)
    return points[0].pos
  if (t >= points[n - 1].at)
    return points[n - 1].pos
  const i = lowerBound(points, t)
  const a = points[i - 1]
  const b = points[i]
  return a.pos + (b.pos - a.pos) * ((t - a.at) / (b.at - a.at))
}

// ─── Selection ────────────────────────────────────────────────────────────────

/** Sorted, de-duplicated indices that exist in `points`. */
export function cleanSelection(sel: Iterable<number>, count: number): number[] {
  return [...new Set(sel)].filter(i => Number.isInteger(i) && i >= 0 && i < count).sort((a, b) => a - b)
}

/** Indices of points inside a time × position box (edges included, corners in any order). */
export function selectInBox(points: readonly Pt[], t0: number, t1: number, p0: number, p1: number): number[] {
  const [ta, tb] = t0 <= t1 ? [t0, t1] : [t1, t0]
  const [pa, pb] = p0 <= p1 ? [p0, p1] : [p1, p0]
  const out: number[] = []
  for (let i = lowerBound(points, ta); i < points.length && points[i].at <= tb; i++) {
    if (points[i].pos >= pa && points[i].pos <= pb)
      out.push(i)
  }
  return out
}

/** How a click or a box changes the selection: replace it, add to it, or flip the hits. */
export type SelectMode = 'replace' | 'add' | 'toggle'

export function combineSelection(current: readonly number[], hits: readonly number[], mode: SelectMode): number[] {
  if (mode === 'replace')
    return [...new Set(hits)].sort((a, b) => a - b)
  const set = new Set(current)
  for (const i of hits) {
    if (mode === 'toggle' && set.has(i))
      set.delete(i)
    else
      set.add(i)
  }
  return [...set].sort((a, b) => a - b)
}

/**
 * The point nearest a pointer, in screen space: `x(at)` and `y(pos)` map to
 * pixels. Only points within `radius` px count; null when none does. Looks
 * only at points whose time is within reach, so it is cheap on long scripts.
 */
export function hitTest(
  points: readonly Pt[],
  px: number,
  py: number,
  x: (at: number) => number,
  y: (pos: number) => number,
  radius: number,
  tAt: (px: number) => number,
): number | null {
  const from = lowerBound(points, Math.min(tAt(px - radius), tAt(px + radius)))
  let best: number | null = null
  let bestD = radius * radius
  for (let i = from; i < points.length; i++) {
    const dx = x(points[i].at) - px
    if (dx > radius)
      break
    const dy = y(points[i].pos) - py
    const d = dx * dx + dy * dy
    if (d <= bestD) {
      bestD = d
      best = i
    }
  }
  return best
}

// ─── Moving a selection ───────────────────────────────────────────────────────

export interface MoveLimits {
  /** Smallest and largest time shift (ms) that keeps every point in order and at ≥ 0. */
  dtMin: number
  dtMax: number
  /** Smallest and largest position shift that keeps every point within 0–1. */
  dpMin: number
  dpMax: number
}

/**
 * How far a selection can move as a group. Selected points keep their order
 * among themselves (they all move by the same amount); what limits them is
 * the nearest unselected neighbour on each side of every run of selected
 * points, which they may not reach or pass, and time zero.
 */
export function moveLimits(points: readonly Pt[], sel: readonly number[]): MoveLimits {
  if (!sel.length)
    return { dtMin: 0, dtMax: 0, dpMin: 0, dpMax: 0 }
  const chosen = new Set(sel)
  let dtMin = Number.NEGATIVE_INFINITY
  let dtMax = Number.POSITIVE_INFINITY
  let minPos = 1
  let maxPos = 0
  for (const i of sel) {
    const p = points[i]
    if (p.pos < minPos)
      minPos = p.pos
    if (p.pos > maxPos)
      maxPos = p.pos
    // Start of a run: the unselected point before it is a wall (or time zero).
    if (!chosen.has(i - 1)) {
      const wall = i > 0 ? points[i - 1].at + MIN_GAP_MS : 0
      dtMin = Math.max(dtMin, wall - p.at)
    }
    // End of a run: the unselected point after it is a wall.
    if (!chosen.has(i + 1) && i + 1 < points.length)
      dtMax = Math.min(dtMax, points[i + 1].at - MIN_GAP_MS - p.at)
  }
  // Points sharing a millisecond in a messy file would leave no room; never allow a negative range.
  if (dtMin > 0)
    dtMin = 0
  if (dtMax < 0)
    dtMax = 0
  return { dtMin, dtMax, dpMin: -minPos, dpMax: 1 - maxPos }
}

/** Move the selected points by (dt ms, dp position), clamped to what the limits allow. */
export function moveSelection(points: readonly Pt[], sel: readonly number[], dt: number, dp: number, limits = moveLimits(points, sel)): Pt[] {
  const t = clamp(Math.round(dt), Math.ceil(limits.dtMin), Math.floor(limits.dtMax))
  const p = clamp(dp, limits.dpMin, limits.dpMax)
  if (!sel.length || (t === 0 && p === 0))
    return points.slice()
  const out = points.slice()
  for (const i of sel)
    out[i] = { at: points[i].at + t, pos: clamp(points[i].pos + p, 0, 1) }
  return out
}

export interface Snap {
  /** Whole funscript positions (0–100). */
  positions: boolean
  /** Video frames at `fps`; off when 0. */
  fps: number
}

export const NO_SNAP: Snap = { positions: false, fps: 0 }

/** The nearest frame boundary, in whole ms. */
export function snapTime(t: number, fps: number): number {
  if (!(fps > 0))
    return Math.round(t)
  const frame = 1000 / fps
  return Math.round(Math.round(t / frame) * frame)
}

/** The nearest whole funscript position. */
export function snapPos(p: number): number {
  return clamp(Math.round(p * 100) / 100, 0, 1)
}

/**
 * A drag of the selection, as the pointer moved (rawDt ms, rawDp position)
 * from where it grabbed point `anchor`. With snapping, the grabbed point
 * lands on a frame or whole position and the rest of the selection follows
 * it by the same amount, so their spacing never changes. Then the group is
 * clamped to its limits.
 */
export function dragSelection(
  original: readonly Pt[],
  sel: readonly number[],
  anchor: number,
  rawDt: number,
  rawDp: number,
  snap: Snap = NO_SNAP,
  limits = moveLimits(original, sel),
): Pt[] {
  const a = original[anchor]
  let dt = rawDt
  let dp = rawDp
  if (a) {
    if (snap.fps > 0)
      dt = snapTime(a.at + rawDt, snap.fps) - a.at
    if (snap.positions)
      dp = snapPos(a.pos + rawDp) - a.pos
  }
  return moveSelection(original, sel, dt, dp, limits)
}

// ─── Inserting and deleting ───────────────────────────────────────────────────

/**
 * Put a point at `at`. A point already in that millisecond is moved to
 * `pos` instead of doubled. Returns the new array and the point's index.
 */
export function insertPoint(points: readonly Pt[], at: number, pos: number): { points: Pt[], index: number } {
  const t = Math.max(0, Math.round(at))
  const p = clamp(pos, 0, 1)
  const i = lowerBound(points, t)
  const out = points.slice()
  if (i < points.length && points[i].at === t)
    out[i] = { at: t, pos: p }
  else
    out.splice(i, 0, { at: t, pos: p })
  return { points: out, index: i }
}

export function deletePoints(points: readonly Pt[], sel: readonly number[]): Pt[] {
  if (!sel.length)
    return points.slice()
  const drop = new Set(sel)
  return points.filter((_, i) => !drop.has(i))
}

// ─── Speed ────────────────────────────────────────────────────────────────────

/** Speed between two points in funscript units (0–100) per second. */
export function segmentSpeed(a: Pt, b: Pt): number {
  const dt = b.at - a.at
  const dp = Math.abs(b.pos - a.pos) * 100
  if (dt <= 0)
    return dp > 0 ? Number.POSITIVE_INFINITY : 0
  return (dp / dt) * 1000
}

/**
 * Segments faster than `limit` units/s among points [from, to): each index
 * i means the segment from point i to point i + 1.
 */
export function fastSegments(points: readonly Pt[], limit: number, from = 0, to = points.length): number[] {
  const out: number[] = []
  const end = Math.min(points.length - 1, to)
  for (let i = Math.max(0, from); i < end; i++) {
    if (segmentSpeed(points[i], points[i + 1]) > limit)
      out.push(i)
  }
  return out
}

// ─── Undo ─────────────────────────────────────────────────────────────────────

/**
 * What one edit changed: from `start`, `removed` points were replaced by
 * `inserted` ones. Found by trimming the common head and tail, so moving a
 * few points in a 100k-point script stores a few points, not the script.
 */
export interface Patch {
  start: number
  removed: Pt[]
  inserted: Pt[]
}

const samePt = (a: Pt, b: Pt) => a === b || (a.at === b.at && a.pos === b.pos)

export function diffPoints(before: readonly Pt[], after: readonly Pt[]): Patch | null {
  const n = Math.min(before.length, after.length)
  let head = 0
  while (head < n && samePt(before[head], after[head]))
    head++
  if (head === before.length && head === after.length)
    return null
  let tail = 0
  while (tail < n - head && samePt(before[before.length - 1 - tail], after[after.length - 1 - tail]))
    tail++
  return {
    start: head,
    removed: before.slice(head, before.length - tail),
    inserted: after.slice(head, after.length - tail),
  }
}

export function applyPatch(points: readonly Pt[], p: Patch, reverse = false): Pt[] {
  const out = points.slice()
  if (reverse)
    out.splice(p.start, p.inserted.length, ...p.removed)
  else
    out.splice(p.start, p.removed.length, ...p.inserted)
  return out
}

interface HistoryEntry {
  patch: Patch
  selBefore: number[]
  selAfter: number[]
  /** Which document state this entry leads from and to, for "is it saved?". */
  from: number
  to: number
}

/**
 * Undo and redo for one script. Each entry is a patch plus the selection on
 * either side of it, so undo brings back what was selected too. States are
 * numbered, which makes "unsaved" exact: undo back to what was saved and
 * the script is clean again.
 */
export class EditHistory {
  private undoStack: HistoryEntry[] = []
  private redoStack: HistoryEntry[] = []
  private seq = 0
  /** The state the document is in now. */
  state = 0
  /** The state that was last saved (or loaded). */
  saved = 0

  constructor(private limit = 300) {}

  get canUndo() {
    return this.undoStack.length > 0
  }

  get canRedo() {
    return this.redoStack.length > 0
  }

  get dirty() {
    return this.state !== this.saved
  }

  /** Record an edit from `before` to `after`. Returns false when nothing changed. */
  record(before: readonly Pt[], after: readonly Pt[], selBefore: readonly number[], selAfter: readonly number[]): boolean {
    const patch = diffPoints(before, after)
    if (!patch)
      return false
    const to = ++this.seq
    this.undoStack.push({ patch, selBefore: [...selBefore], selAfter: [...selAfter], from: this.state, to })
    this.state = to
    this.redoStack = []
    if (this.undoStack.length > this.limit)
      this.undoStack.shift()
    return true
  }

  undo(points: readonly Pt[]): { points: Pt[], selection: number[] } | null {
    const e = this.undoStack.pop()
    if (!e)
      return null
    this.redoStack.push(e)
    this.state = e.from
    return { points: applyPatch(points, e.patch, true), selection: e.selBefore }
  }

  redo(points: readonly Pt[]): { points: Pt[], selection: number[] } | null {
    const e = this.redoStack.pop()
    if (!e)
      return null
    this.undoStack.push(e)
    this.state = e.to
    return { points: applyPatch(points, e.patch), selection: e.selAfter }
  }

  markSaved() {
    this.saved = this.state
  }
}
